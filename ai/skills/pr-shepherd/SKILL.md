---
name: pr-shepherd
description: >
  Shepherds a PR through the repetitive loop: triage the review conversation
  (review-triage), keep the branch current and report CI (ci-shepherd), apply
  the `stamphog` label on each new commit, and report stamphog's verdict. Use
  when the user says "/pr-shepherd", "shepherd this PR", "babysit this PR", or
  wants the whole review loop driven automatically. Accepts an optional PR
  number or URL as argument.
---

# PR Shepherd

Drives a PR through the review loop by orchestrating two focused sub-skills and
managing the stamphog approval label on top of them:

- **`review-triage`** — runs qa-swarm and triages the qa-swarm + bot review
  threads (fix / resolve / defer).
- **`ci-shepherd`** — keeps the branch current with its base and reports CI.

On top of those, this skill resolves the PR, decides when qa-swarm should run,
applies the `stamphog` label on each new SHA and reports stamphog's verdict, and
prints the iteration summary. It defers anything ambiguous to the user.

Each sub-skill is also independently invocable (`/review-triage`, `/ci-shepherd`)
when you only want that slice. This skill is the full loop.

**One invocation = one iteration.** The skill does not sleep or self-loop in
practice — the model exits after a single pass. For hands-off cadence, run it
under the `loop` skill (e.g. `/loop 5m /pr-shepherd <pr>`). For ad-hoc nudges,
re-invoke manually. State is carried between invocations via `$ARGUMENTS` or via
the surrounding conversation when iterations run back-to-back inside one Claude
session.

## Run the loop session on Sonnet

This loop is built to keep **mechanical work on Sonnet** and **review work on
Opus**, but only the subagents can be pinned — the orchestration cannot:

- `review-triage` and `ci-shepherd` are dispatched as `model: 'sonnet'` Agent
  subagents (Steps 3-4) — pinned, model-independent of the caller.
- qa-swarm pins its four reviewer agents to `model: 'opus'` regardless of the
  caller (Step 2) — reviews stay sharp even on a cheaper session.
- The top-level orchestration (PR resolution, the qa-swarm decision, qa-swarm's
  own coordination, stamphog, the summary) runs in the **main loop**, so it
  inherits the **session model**. A skill cannot switch its own session model.

So launch the session on Sonnet — `/model sonnet` before
`/loop 5m /pr-shepherd <pr>` — to get mechanical-on-Sonnet, reviews-on-Opus end
to end. On an Opus session the split still holds for the subagents and the
reviews, but the orchestration loop pays Opus rates for work that does not need
it.

## Narration — keep the user in the loop

Skills run silently unless the assistant prints text between tool calls. Before
**every** step below, emit a short one-line narration so the user can see what's
happening without watching raw tool output. Keep it terse — one sentence,
present tense. Relay each dispatched sub-skill's returned `narration` lines
verbatim (they already carry their own `[triage]` / `[ci]` prefix).

Format: `[shepherd] <step> — <what and why>`

Examples:

```
[shepherd] step 1 — resolving PR from gh pr view
[shepherd] step 1 — no change since a1b2c3d, stamphog present — skipping iteration
[shepherd] step 1 — PR is draft, marking ready before continuing
[shepherd] step 2 — diff since a1b2c3d touches src/foo.ts, running qa-swarm
[shepherd] step 3 — dispatching review-triage (sonnet runner)
[shepherd] step 4 — dispatching ci-shepherd against H1=def4567
[shepherd] step 5 — applying stamphog at def4567; verdict so far: changes requested
[shepherd] iter done — handing back; re-invoke or let /loop drive the next pass
```

A silent 30+ second gap is the failure mode — err on the side of more lines.

GitHub itself is the source of truth so the loop is restartable across
invocations.

## State carried between invocations

State is **not** stored on disk. It is passed via `$ARGUMENTS` on re-invocation,
or carried in the surrounding conversation when iterations run back-to-back
inside one Claude session. When taking over from a previous iteration, expect
the previous values to be quoted in the invocation or visible in the recent
conversation; when finishing an iteration, print the values so the next caller
can re-supply them. This skill owns all of them — the sub-skills receive the
ones they need as inputs and return updated values, but never persist state
themselves.

- `qa_swarm_marker_sha` — HEAD SHA the last time qa-swarm ran. `null` initially.
- `stamphog_applied_for_sha` — HEAD SHA at which `stamphog` was last applied.
  `null` initially.
- `deferred_threads` — set of review-thread IDs already surfaced to the user as
  needing their judgement. Passed into `review-triage` so they're skipped on
  subsequent iterations to avoid nagging.
- `last_updated_at` — the PR's `updatedAt` timestamp observed at the end of the
  previous iteration. The Step 1 fast path compares against it to detect whether
  anything changed since. `null` initially.

## Workflow — one iteration

### Dispatch model — orchestrate qa-swarm + two sub-skill runners

The mechanical work lives in the two sub-skills; this skill owns the decisions.

- **qa-swarm runs in this main loop** (Step 2), via `Skill("qa-swarm")` — *not*
  inside a sub-skill runner. qa-swarm itself spawns four `opus` reviewer agents,
  and we keep that out of a dispatched subagent to avoid nesting agent spawns
  (the same reason the previous single-runner design kept qa-swarm in the main
  loop).
- **`review-triage` and `ci-shepherd` each run as a single `model: 'sonnet'`
  `Agent` subagent.** They carry the bulk of this loop's tool calls and need no
  deep reasoning, so a cheaper model with a tight per-call brief keeps the loop
  inexpensive. Dispatch them by **load-then-spawn** (see *Dispatch mechanism*
  below), not `Skill()` — `Skill()` would run them inline in this conversation
  and dump their full body + tool chatter into context, losing the isolation
  that makes the loop cheap.
- **Sequential, not parallel.** Both sub-skills mutate the working tree and push
  (review-triage commits fixes; ci-shepherd restacks), so concurrent runs would
  race the index / worktree / remote ref. And ci-shepherd must start from
  review-triage's post-fix HEAD. Run review-triage, then ci-shepherd.
- This skill owns Steps 1, 2, 5, 6 — the qa-swarm decision, the stamphog
  apply/verdict step, the summary, and the only `AskUserQuestion` paths (no PR
  found in Step 1, qa-swarm-skip confirm in Step 2). The sub-skill runners
  **never call `AskUserQuestion`**; they return structured results.

**HEAD-SHA threading.** Both sub-skills move HEAD, and the stamphog "apply once
per SHA" gate keys off it, so thread the HEAD forward and apply stamphog against
the *final* HEAD:

```
H0 = Step 1 HEAD
Step 2  run qa-swarm when warranted (at H0; qa-swarm only comments, HEAD stays H0)
Step 3  review-triage(head_sha_in = H0) -> new_head_sha = H1   (H1 != H0 iff fixes pushed)
Step 4  ci-shepherd(head_sha_in = H1)   -> new_head_sha = H2   (thread H1, NOT H0)
        if restack_needs_decision: TERMINATE (hand back the file list; skip Step 5)
HEAD_SHA := H2                                                 (the final head)
Step 5  apply stamphog iff stamphog_applied_for_sha != H2; read + report its verdict
```

The trap this avoids: passing `H0` instead of `H1` to ci-shepherd would restack
/ report CI against a stale tree.

**Fields consumed from the runner results.** From `review-triage`:
`new_head_sha`, `deferred_threads`, plus `resolved` / `actioned` /
`unresolved_actionable_remaining` for the summary. From `ci-shepherd`:
`new_head_sha`, `ci` buckets, `restack_needs_decision` + `restack_decision_files`.
(Each runner's full result schema is defined in its own *Report* step — the body
you pass it carries that schema.)

### Step 1: Resolve PR, fast-path check, and capture baseline

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise:

```bash
gh pr view --json number,headRefName,baseRefName,url,headRefOid,state,isDraft,updatedAt,labels
gh repo view --json owner,name
```

Record: PR number, owner/repo, base branch, HEAD SHA (`H0`), PR state, draft
state, `updatedAt`, labels.

If PR state is `MERGED` or `CLOSED`, **terminate** with a final status.

**Fast path — skip the iteration when nothing changed.** On a re-invocation
(carried state present), if **all** of:

- `H0` == the previous iteration's HEAD,
- `updatedAt` == `last_updated_at` (no commit, comment, review, or label event
  since you finished last time), and
- the `stamphog` label is present,

then there is no new work. Emit `[shepherd] step 1 — no change since
<short_sha>, stamphog present — skipping iteration`, print the state line (Step
6), and exit **without dispatching review-triage or ci-shepherd**. The PR's
`updatedAt` advances on any commit / comment / review / label event, so a match
means the PR is genuinely idle. (CI-only status changes may not move it — that's
acceptable: CI is non-gating, and the next real event triggers a full pass.)

If `isDraft == true`, mark it ready before continuing — invoking the shepherd is
itself the signal that the PR is ready for autonomous review:

```bash
gh pr ready <pr_number>
```

Narrate `[shepherd] step 1 — PR is draft, marking ready before continuing`, then
carry on. Do **not** stop early just because the PR is a draft.

If `gh pr view` finds no PR for the current branch, **do not terminate
silently**. Ask the user (with `AskUserQuestion`) whether they want to:

- paste a PR number or URL to shepherd, or
- have the shepherd open a PR for the current branch via `gh pr create` (then
  continue the loop against the new PR), or
- cancel.

Only proceed once the user picks one. If they cancel, terminate cleanly. Note:
`gh pr create` in this repo defaults to draft, so a PR opened via this fallback
will land as a draft — re-run the `isDraft` check above and `gh pr ready` it
before continuing.

### Step 2: Run qa-swarm when warranted

Run qa-swarm when **either**:

- `qa_swarm_marker_sha` is `null` (first iteration), **or**
- `H0` != `qa_swarm_marker_sha` **and** the diff `qa_swarm_marker_sha..H0`
  touches at least one non-doc file (i.e. something other than `*.md`, `*.txt`,
  or pure whitespace changes).

Invoke qa-swarm, resolved local-first then from the store (see the local-first /
store fallback rule under *Dispatch mechanism*): run `Skill("qa-swarm",
args="<pr_number>")` if it's installed locally, otherwise fetch its body from the
store and follow it inline. It handles diff gathering and comment posting. After
it completes set `qa_swarm_marker_sha = H0`.

If skipping qa-swarm, log `qa-swarm: skip (no substantive changes since <sha>)`.

The non-doc-files rule is firm. If you want to skip qa-swarm despite qualifying
changes (e.g. the new commits only address prior qa-swarm findings, or the run
would be pure churn), use `AskUserQuestion` to confirm before skipping. Do not
silently override — a quiet skip hides judgement calls the user may want to
challenge. "Review fatigue" alone is not sufficient grounds.

### Step 3: Dispatch review-triage

Load-then-spawn `review-triage` as a `model: 'sonnet'` `Agent` subagent (see
*Dispatch mechanism*). Pass it `head_sha_in = H0`, the PR number / owner / repo /
base, `qa_swarm_marker_sha`, and `deferred_threads`, with the **review-triage
sub-step override brief** (see *Dispatch mechanism*).

Relay its `narration` verbatim. Record `new_head_sha` as `H1`, and carry forward
`deferred_threads`, `unresolved_actionable_remaining`, `resolved`, and
`actioned`.

### Step 4: Dispatch ci-shepherd

Load-then-spawn `ci-shepherd` as a `model: 'sonnet'` `Agent` subagent. Pass it
`head_sha_in = H1`, the PR number / owner / repo / base, with the **ci-shepherd
sub-step override brief**.

Relay its `narration` verbatim. Record `new_head_sha` as `H2` and the `ci`
buckets.

If it returns `restack_needs_decision: true`, **terminate** this iteration: hand
the `restack_decision_files` list back to the user with the one-line reasons.
Skip Step 5 (a needs-decision conflict is a Step 4 terminal condition).

### Step 5: Apply `stamphog` and read its verdict

`stamphog` is PostHog/posthog's PR Approval Agent. It re-reviews on every push,
so the shepherd's whole job here is to keep the label on the current SHA and
report the verdict. There is **no dismissal-detection or re-request dance** —
re-applying the label on each new SHA is itself what re-triggers a review, so we
just always apply it when the SHA is new.

Apply the label when `stamphog_applied_for_sha != H2`. First re-read two fields
to guard against a draft PR and an out-of-band push since Step 4:

```bash
gh pr view <pr_number> --json isDraft,headRefOid
```

- If `headRefOid != H2`, HEAD moved under us (a human or stamphog pushed between
  Step 4 and now). **Skip applying this iteration** and let the next pass
  re-baseline — narrate `[shepherd] step 5 — HEAD moved since H2, skipping
  stamphog; next pass re-baselines`.
- If `isDraft == true`, run `gh pr ready <pr_number>` first — a draft PR makes
  every PR-Approval-Agent job skip at its `!draft` gate with no comment and no
  log, which looks identical to "stamphog hasn't run yet".

Then:

```bash
gh pr edit <pr_number> --add-label stamphog
```

Set `stamphog_applied_for_sha = H2`. If `stamphog_applied_for_sha == H2` already,
skip — the label is current for this SHA.

**Read the verdict** for the summary (informational — never gates, never
prompts):

```bash
gh pr view <pr_number> --json reviewDecision,latestReviews
```

Report stamphog's current state — approved, changes requested, or dismissed —
plus a one-line reason from its latest review body when present. Surfacing *why*
stamphog is unhappy helps the user decide; the shepherd does not act on it beyond
reporting (the actionable review *threads* were already triaged in Step 3).

This step is independent of CI state. Stamphog evaluates in parallel; there is no
benefit to waiting.

### Step 6: Iteration summary and hand-back

Print a one-line **summary** of the iteration (on top of the per-step narration
and the relayed sub-skill narration from earlier):

```
[shepherd] iter done — sha=<short_sha> qa-swarm=<ran|skip> resolved=<n> actioned=<n> deferred=<n> ci=<pass=N pending=N fail=N> stamphog=<applied|already|skipped> verdict=<approved|changes|dismissed|pending>
```

If there are deferred threads, print their `file:line` and one-line reason under
the status line. If any CI checks are failing, print their names + links on a
separate line (informational — not a termination). If stamphog requested changes
or dismissed, print its one-line reason.

Then print the state values so the next caller (the user, or the `loop` skill)
can re-supply them:

```
[shepherd] state — qa_swarm_marker_sha=<sha|null> stamphog_applied_for_sha=<sha|null> deferred_threads=[<id>,...] last_updated_at=<iso8601|null>
```

Set `last_updated_at` to the PR's `updatedAt` re-read at the end of this
iteration (after your actions), so the next fast-path check compares against a
post-action baseline.

Hand back. The skill does not sleep or self-loop. For hands-off cadence wrap
this skill in `/loop` (e.g. `/loop 5m /pr-shepherd <pr>`); otherwise re-invoke
manually when ready for the next iteration.

## Terminal conditions (stop the loop)

Stop cleanly and print a final summary when **any** of:

- PR is `MERGED` or `CLOSED`.
- A base-branch conflict needs a human decision (ci-shepherd returned
  `restack_needs_decision` — see Step 4).
- `stamphog` is applied for the current SHA, no new bot threads have appeared
  since the last iteration, and the only remaining unresolved threads are in
  `deferred_threads` — nothing autonomous left to do (CI state, pass or fail,
  does not factor in). The Step 1 fast path short-circuits this case on
  re-invocation.
- The user interrupts.

CI failures are **not** a terminal condition. They are reported in the iteration
summary and the loop continues — the user decides whether to investigate.
Likewise, ambiguous review findings are **not** a terminal condition; they go to
`deferred_threads` and the loop keeps polling.

The final summary lists:

- commits pushed (with short SHAs and messages),
- threads resolved (count, grouped by "fixed" / "replied"),
- threads deferred (with file:line and one-line reason each),
- final CI state, stamphog verdict, label state, and PR merge state.

## Dispatch mechanism

Dispatch each sub-skill by **load-then-spawn** — the same pattern `qa-swarm` uses
for its reviewers. Pass the sub-skill's body, plus the override brief and inputs,
into a `model: 'sonnet'` `Agent` subagent — `review-triage` first, then
`ci-shepherd`.

**Resolve each sibling skill local-first, then the store.** This covers
`review-triage`, `ci-shepherd`, and `qa-swarm` (Step 2):

1. **Local:** if `~/.claude/skills/<name>/SKILL.md` exists, use it — read the
   file for the load-then-spawn brief (`review-triage`, `ci-shepherd`), or
   `Skill("<name>")` for an invocable skill (`qa-swarm`).
2. **Store fallback:** otherwise fetch it and use the returned `body` —
   `mcp__posthog__exec command='call llma-skill-get {"skill_name":"<name>"}'`.
   Pass that body as the `Agent` brief for `review-triage`/`ci-shepherd`, or
   follow it inline for `qa-swarm`.

The on-disk SKILL.md and the store skill are the same content, so the sub-brief
lives OnceAndOnlyOnce — this skill just sources it from whichever location is
present.

Append the matching **override brief** so the runner behaves as a sub-step, not
a standalone session (parallel to how qa-swarm overrides its security-audit
body):

- **review-triage:** "Sub-step, not standalone. Skip your Step 1 (resolve) and
  Step 2 (run qa-swarm) — the caller already resolved the PR and ran qa-swarm
  this iteration. Triage existing threads only. Never call `AskUserQuestion`;
  ambiguous threads go to `deferred_threads` and never terminate. Inputs
  supplied: PR number, owner/repo, base, `head_sha_in`, `qa_swarm_marker_sha`,
  `deferred_threads`. Do not narrate to the user — collect `[triage]` lines into
  `narration`. Return the structured result from your *Step 5: Report* and stop."
- **ci-shepherd:** "Sub-step, not standalone. Never call `AskUserQuestion`. On a
  needs-decision conflict do not prompt — abort the restack cleanly and return
  `restack_needs_decision: true` with `restack_decision_files`; the orchestrator
  owns the hand-back. Inputs supplied: PR number, owner/repo, base,
  `head_sha_in` — operate against `head_sha_in`. Do not narrate to the user —
  collect `[ci]` lines into `narration`. Return the structured result from your
  *Step 4: Report* and stop."

## Dependencies

- **`review-triage`** sub-skill (Step 3) — runs qa-swarm thread + bot thread
  triage and owns the *Judgement rules for auto-actioning a comment*.
- **`ci-shepherd`** sub-skill (Step 4) — branch-currency restack + CI report.
- **`qa-swarm`** (Step 2) — orchestrates the four review agents; resolved
  local-first, then the store (see *Dispatch mechanism*). Run in this main loop
  so its `opus` reviewer agents aren't nested inside a dispatched subagent.
- `gh` CLI (repo, pr, api, label commands).
- Graphite MCP for git operations (used inside the sub-skills). Fall back to
  `gh`/`git` only when Graphite doesn't cover a case.
- The `Agent` tool with `model: 'sonnet'` for the two sub-skill runners.

## Graceful degradation

- **`review-triage` skill missing:** warn and continue with `ci-shepherd` +
  stamphog. You lose the triage signal (resolved/deferred counts), but stamphog
  is still applied and its verdict still read.
- **`ci-shepherd` skill missing:** warn and skip the restack + CI report; run
  review-triage and apply stamphog against `H1` (no further HEAD movement).
  Report CI as unknown.
- **`qa-swarm` skill missing:** warn and skip Step 2; review-triage still
  triages whatever bot threads exist.
- **`Agent` can't be spawned:** fall back to running the sub-skill body inline in
  the main loop (read the SKILL.md and follow it directly). Slower and costlier,
  but functional.
- **No PR detected:** prompt the user (see Step 1) to paste a PR number/URL or
  let the shepherd open a PR via `gh pr create`. Only stop if the user cancels.
- **User interrupts mid-iteration:** stop at the next natural checkpoint and
  print the final summary.
