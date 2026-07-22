---
name: pr-shepherd
description: >
  Shepherds a PR through the repetitive loop: run qa-swarm review and the
  simplify pass in convergence rounds, triage the review conversation
  (review-triage), keep the branch current and repair CI (ci-shepherd), apply
  the `stamphog` label on each new commit, and report stamphog's verdict. Use
  when the user says "/pr-shepherd", "shepherd this PR", "babysit this PR", or
  wants the whole review loop driven automatically. Accepts an optional PR
  number or URL as argument.
---

# PR Shepherd

Drives a PR through the review loop by orchestrating three focused sub-skills
and managing the stamphog approval label on top of them:

- **`qa-swarm`** — four-reviewer bug/quality pass that posts PR comments.
- **`simplify`** — reuse/simplification/efficiency/altitude pass that applies
  its fixes directly to the working tree (built-in skill, no PR comments).
- **`review-triage`** — triages the qa-swarm + bot review threads (fix /
  resolve / defer), with `paul-pair`'s autonomy ladder folded into the
  ambiguous bucket so only genuine stop-and-ask cases still defer to the user.
- **`ci-shepherd`** — keeps the branch current, diagnoses CI, fixes PR-caused
  failures, and reruns likely flaky/infrastructure jobs once.

`qa-swarm`, `simplify`, and `review-triage` run together in a **quality loop**
(Step 2) — at least twice, continuing until a round finds nothing new — so a
fix made in round 1 gets re-reviewed and re-simplified in round 2 within the
same iteration, instead of waiting for the next external invocation.

On top of those, this skill resolves the PR, applies the `stamphog` label on
each new SHA and reports stamphog's verdict, and prints the iteration summary.
It defers anything genuinely ambiguous to the user.

Each sub-skill is also independently invocable (`/review-triage`,
`/ci-shepherd`) when you only want that slice. This skill is the full loop.

**One invocation = one iteration.** The skill does not sleep or self-loop in
practice — the model exits after a single pass. For hands-off cadence, run it
under the `loop` skill (e.g. `/loop 5m /pr-shepherd <pr>`). For ad-hoc nudges,
re-invoke manually. State is carried between invocations via `$ARGUMENTS` or via
the surrounding conversation when iterations run back-to-back inside one Claude
session.

## Run the loop session on GLM-5.2 (cheap-first reviews)

This loop is built to keep **mechanical work on Sonnet** and **review work
cheap-first on GLM-5.2**, escalating to Fable/Opus only when a change is
complex or dangerous. Only the subagents can be pinned — the orchestration
cannot:

- `review-triage` and `ci-shepherd` are dispatched as `model: 'sonnet'` Agent
  subagents (inside Step 2's quality loop, and Step 3) — pinned,
  model-independent of the caller.
- `simplify` is also dispatched as a `model: 'sonnet'` Agent subagent (Step
  2's quality loop) — it's a built-in skill with no body to load-then-spawn,
  so the subagent's prompt just tells it to invoke `Skill("simplify")` itself.
  It shares review-triage/ci-shepherd's mechanical tier, not qa-swarm's
  reviewer tier — see *Dispatch mechanism*.
- qa-swarm now does **cheap-first review**: a single router reviewer on
  `@cf/zai-org/glm-5.2` does the first pass and decides whether to delegate
  part or all of the review to a stronger model (`opus`/`fable`, soon
  `gpt-sol`/`kimi-k3`) based on the change's danger/complexity. Low-danger
  diffs may run entirely on the router — that's the cost saving. See qa-swarm's
  *Step 3*. The router is pinned to glm-5.2 explicitly; if the harness rejects
  the non-Claude model string on a subagent, qa-swarm omits the pin so the
  router inherits the session model — which is why the session should itself
  be on glm-5.2.
- The top-level orchestration (PR resolution, the quality-loop rounds,
  qa-swarm's own coordination, stamphog, the summary) runs in the **main
  loop**, so it inherits the **session model**. A skill cannot switch its own
  session model.

So launch the session on GLM-5.2 — `/model @cf/zai-org/glm-5.2` before
`/loop 5m /pr-shepherd <pr>` — so the orchestration loop and the router
reviewer (when its pin falls back to inheritance) both run cheaply, while
qa-swarm's delegated reviewers still escalate to fable/opus only when the
router judges the change worth it. On a Sonnet session the subagent pins still
hold, but the orchestration and the router-inheritance fallback pay Sonnet
rates instead of GLM-5.2's.

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
[shepherd] step 1 — no change since a1b2c3d, stamphog present, no failing CI — skipping iteration
[shepherd] step 1 — PR is draft, marking ready before continuing
[shepherd] step 2 round 1 — diff since a1b2c3d touches src/foo.ts, running qa-swarm
[shepherd] step 2 round 1 — dispatching review-triage (sonnet runner)
[shepherd] step 2 round 1 — dispatching simplify (sonnet runner)
[shepherd] step 2 round 2 — fixes landed in round 1, re-running qa-swarm + simplify
[shepherd] step 2 — round 2 dry, quality loop converged after 2 rounds
[shepherd] step 3 — dispatching ci-shepherd against H1=def4567
[shepherd] step 4 — applying stamphog at def4567; verdict so far: changes requested
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
- `simplify_marker_sha` — HEAD SHA the last time `simplify` ran. `null`
  initially. Tracked the same way as `qa_swarm_marker_sha`, updated once per
  quality-loop round.
- `stamphog_applied_for_sha` — HEAD SHA at which `stamphog` was last applied.
  `null` initially.
- `deferred_threads` — set of review-thread IDs already surfaced to the user as
  needing their judgement. Passed into `review-triage` so they're skipped on
  subsequent iterations to avoid nagging.
- `last_updated_at` — the PR's `updatedAt` timestamp observed at the end of the
  previous iteration. The Step 1 fast path compares against it to detect whether
  anything changed since. `null` initially.

## Workflow — one iteration

### Dispatch model — orchestrate the quality loop + three sub-skill runners

The mechanical work lives in the sub-skills; this skill owns the decisions.

- **qa-swarm runs in this main loop** (inside Step 2's quality loop), via
  `Skill("qa-swarm")` — *not* inside a sub-skill runner. qa-swarm itself
  spawns a router reviewer (GLM-5.2) plus any delegation targets it escalates
  to (`opus`/`fable`/`gpt-sol`/`kimi-k3`), and we keep that out of a dispatched
  subagent to avoid nesting agent spawns (the same reason the previous
  single-runner design kept qa-swarm in the main loop).
- **`review-triage`, `ci-shepherd`, and `simplify` each run as a single
  `model: 'sonnet'` `Agent` subagent.** They carry the bulk of this loop's tool
  calls and need no deep reasoning, so a cheaper model with a tight per-call
  brief keeps the loop inexpensive. Dispatch `review-triage`/`ci-shepherd` by
  **load-then-spawn** (see *Dispatch mechanism* below), since their SKILL.md is
  readable; `simplify` has no readable body (it's a built-in skill), so its
  Agent prompt just instructs it to call `Skill("simplify")` itself. Don't call
  `Skill()` directly on any of the three from the main loop — that would run
  them inline in this conversation and dump their full body + tool chatter into
  context, losing the isolation that makes the loop cheap.
- **Sequential within a round, not parallel.** qa-swarm, review-triage, and
  simplify all read/mutate the same working tree and push (review-triage
  commits its own fixes; this skill commits simplify's), so concurrent runs
  would race the index / worktree / remote ref. Run qa-swarm, then
  review-triage, then simplify, in that order, within each round — and
  ci-shepherd must start from the quality loop's *final* HEAD once it
  converges.
- This skill owns Step 1, the quality-loop round control (Step 2), the
  stamphog apply/verdict step, the summary, and the only `AskUserQuestion`
  paths (no PR found in Step 1, qa-swarm-skip confirm in Step 2, round 1
  only). The sub-skill runners **never call `AskUserQuestion`**; they return
  structured results.

**HEAD-SHA threading.** Every sub-skill/round in Step 2 can move HEAD, and the
stamphog "apply once per SHA" gate keys off it, so thread the HEAD forward
through every round and apply stamphog against the *final* HEAD:

```
H0 = Step 1 HEAD
Step 2  quality loop, rounds r = 1..N (N <= 4, converges when a round is dry):
          H(r).0 = H(r-1).final
          run qa-swarm when warranted (at H(r).0; comments only, HEAD unchanged)
          review-triage(head_sha_in = H(r).0) -> new_head_sha = H(r).1
          run simplify when warranted (at H(r).1); commit+push if it changed
            files -> H(r).final ; else H(r).final = H(r).1
          round dry iff review-triage reported resolved=0, actioned=0,
            promoted=0, and its returned deferred_threads has no entries
            beyond what was passed in, AND simplify changed 0 files
        H1 = H(N).final                                       (loop's final head)
Step 3  ci-shepherd(head_sha_in = H1)   -> new_head_sha = H2   (thread H1, NOT H0)
        if restack_needs_decision: TERMINATE (hand back the file list; skip Step 4)
HEAD_SHA := H2                                                 (the final head)
Step 4  apply stamphog iff stamphog_applied_for_sha != H2; read + report its verdict
```

The trap this avoids: passing `H0` instead of the quality loop's final `H1` to
ci-shepherd would restack / diagnose CI against a stale tree — same trap as
before, just with more hops feeding into `H1`.

**Fields consumed from the runner results.** From `review-triage`:
`new_head_sha`, `deferred_threads`, plus `resolved` / `actioned` / `promoted` /
`unresolved_actionable_remaining` for the summary and round-dryness check. From
`simplify`'s wrapping Agent: the list of files changed (or none) — used only
for round-dryness and the summary, no formal JSON schema since it's a plain
`Agent` call, not a load-then-spawned sub-skill. From `ci-shepherd`:
`new_head_sha`, observed `ci` buckets, the `repair` result, and
`restack_needs_decision` + `restack_decision_files`.
(Each sub-skill's full result schema is defined in its own *Report* step — the
body you pass it carries that schema.)

### Step 1: Resolve PR, fast-path check, and capture baseline

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise resolve
everything in **one** call — always pass `--jq` so only the needed fields reach
context, and derive owner/repo from the `url` field
(`https://github.com/OWNER/REPO/pull/N`) instead of a second `gh repo view`:

```bash
gh pr view --json number,url,headRefName,baseRefName,headRefOid,state,isDraft,updatedAt,labels \
  --jq '{number, url, base: .baseRefName, head_sha: .headRefOid, state, isDraft, updatedAt, labels: [.labels[].name]}'
```

Record: PR number, owner/repo (parsed from `url`), base branch, HEAD SHA
(`H0`), PR state, draft state, `updatedAt`, label names.

If PR state is `MERGED` or `CLOSED`, **terminate** with a final status.

**Fast path — skip the iteration when nothing changed.** On a re-invocation
(carried state present), if **all** of:

- `H0` == the previous iteration's HEAD,
- `updatedAt` == `last_updated_at` (no commit, comment, review, or label event
  since you finished last time), and
- the `stamphog` label is present,

then make one lightweight `gh pr checks` query before skipping. If it reports
no failed checks, emit `[shepherd] step 1 — no change since <short_sha>,
stamphog present, no failing CI — skipping iteration`, print the state line
(Step 5), and exit. If any check fails, narrate `[shepherd] step 1 — PR content
is unchanged but CI is failing; continuing to ci-shepherd` and continue the
iteration. CI-only status changes may not advance `updatedAt`, so they must be
allowed through this gate.

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

### Step 2: Quality loop — qa-swarm, review-triage, simplify

Run this loop for **at least 2 rounds**, continuing until a round is dry
(finds/fixes nothing new), capped at **4 rounds** as a safety backstop. Each
round's fixes become the next round's input — qa-swarm and simplify re-check
the diff *after* review-triage's and simplify's own fixes land, all within
this one pr-shepherd iteration, rather than waiting for the next invocation.

For round `r` (starting at 1), against the HEAD left by the previous round
(`H0` for round 1):

**a. Run qa-swarm when warranted.** Run qa-swarm when **either**:

- `qa_swarm_marker_sha` is `null` (first round of the first iteration), **or**
- the round's starting HEAD != `qa_swarm_marker_sha` **and** the diff
  `qa_swarm_marker_sha..HEAD` touches at least one non-doc file (i.e. something
  other than `*.md`, `*.txt`, or pure whitespace changes).

Invoke qa-swarm, resolved local-first then from the store (see the local-first
/ store fallback rule under *Dispatch mechanism*): run `Skill("qa-swarm",
args="<pr_number>")` if it's installed locally, otherwise fetch its body from
the store and follow it inline. It handles diff gathering and comment posting.
After it completes set `qa_swarm_marker_sha = HEAD` (the round's starting HEAD
— qa-swarm only comments, it never moves HEAD itself).

If skipping qa-swarm, log `qa-swarm: skip (no substantive changes since <sha>)`.

The non-doc-files rule is firm. If you want to skip qa-swarm despite qualifying
changes (e.g. the new commits only address prior qa-swarm findings, or the run
would be pure churn), use `AskUserQuestion` to confirm before skipping — **only
on round 1**; subsequent rounds within the same iteration never call
`AskUserQuestion` (there's no new human-visible decision to make there — see
*Dispatch model*). Do not silently override — a quiet skip hides judgement
calls the user may want to challenge. "Review fatigue" alone is not sufficient
grounds.

**b. Dispatch review-triage.** Load-then-spawn `review-triage` as a
`model: 'sonnet'` `Agent` subagent (see *Dispatch mechanism*). Pass it
`head_sha_in` = this round's starting HEAD, the PR number / owner / repo /
base, `qa_swarm_marker_sha`, and `deferred_threads`, with the **review-triage
sub-step override brief**.

Relay its `narration` verbatim (prefix with the round number, e.g.
`[shepherd] step 2 round <r> — <line>`). Record `new_head_sha`, and carry
forward `deferred_threads`, `unresolved_actionable_remaining`, `resolved`,
`actioned`, and `promoted` (count of ambiguous threads review-triage resolved
via `paul-pair`'s ladder instead of deferring — see review-triage's own docs).

**c. Run simplify when warranted.** Same gate shape as qa-swarm, keyed off its
own marker: run simplify when `simplify_marker_sha` is `null`, or the current
HEAD (post review-triage) != `simplify_marker_sha` and the diff
`simplify_marker_sha..HEAD` touches a non-doc file.

Dispatch a plain `Agent` (`model: 'sonnet'`, no load-then-spawn body — see
*Dispatch mechanism*) with the **simplify wrapper brief**: invoke
`Skill("simplify")` against the diff between the PR's base branch and the
current HEAD; apply its fixes directly to the working tree (that's simplify's
own job); **not** commit or push (this skill owns that); and report back the
list of files it changed (or that it found nothing to simplify). Never call
`AskUserQuestion`.

If it changed any files: stage via Graphite MCP, commit
(`refactor: apply simplify pass`), push via Graphite MCP. HEAD moves. Narrate
`[shepherd] step 2 round <r> — simplify changed <n> file(s), committed
<short_sha>` or `[shepherd] step 2 round <r> — simplify found nothing to
change`. Set `simplify_marker_sha = HEAD` either way.

**d. Check dryness and loop control.** A round is **dry** iff review-triage
reported `resolved == 0 and actioned == 0 and promoted == 0` and its returned
`deferred_threads` has no entries beyond what you passed in (diff the two
lists — no separate field for this), **and** simplify changed 0 files.

- If `r >= 2` and the round is dry: stop looping. This round's final HEAD
  becomes `H1` for Step 3.
- If `r == 4` (cap reached): stop looping regardless of dryness — narrate
  `[shepherd] step 2 — round cap (4) reached, stopping quality loop` — and use
  this round's final HEAD as `H1`. This is a safety backstop; convergence by
  round 2-3 is the expected case.
- Otherwise: increment `r`, and run the next round against this round's final
  HEAD (fixes from review-triage and simplify are now part of the diff the
  next round's qa-swarm/simplify gates see — this is what lets a round's fixes
  feed back into the loop immediately).

### Step 3: Dispatch ci-shepherd

Load-then-spawn `ci-shepherd` as a `model: 'sonnet'` `Agent` subagent. Pass it
`head_sha_in = H1` (the quality loop's final HEAD from Step 2), the PR number /
owner / repo / base, with the **ci-shepherd sub-step override brief**.

Relay its `narration` verbatim. Record `new_head_sha` as `H2`, the observed `ci`
buckets, and the `repair` result (attempted/committed/fixed/rerun/unresolved).
The CI buckets are explicitly the pre-repair snapshot when a repair moved HEAD;
fresh remote CI is evaluated by the next shepherd iteration.

If it returns `restack_needs_decision: true`, **terminate** this iteration: hand
the `restack_decision_files` list back to the user with the one-line reasons.
Skip Step 4 (a needs-decision conflict is a Step 3 terminal condition).

### Step 4: Apply `stamphog` and read its verdict

`stamphog` is PostHog/posthog's PR Approval Agent. It re-reviews on every push,
so the shepherd's whole job here is to keep the label on the current SHA and
report the verdict. There is **no dismissal-detection or re-request dance** —
re-applying the label on each new SHA is itself what re-triggers a review, so we
just always apply it when the SHA is new.

Apply the label when `stamphog_applied_for_sha != H2`. First re-read two fields
to guard against a draft PR and an out-of-band push since Step 3:

```bash
gh pr view <pr_number> --json isDraft,headRefOid
```

- If `headRefOid != H2`, HEAD moved under us (a human or stamphog pushed between
  Step 3 and now). **Skip applying this iteration** and let the next pass
  re-baseline — narrate `[shepherd] step 4 — HEAD moved since H2, skipping
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
prompts). Run this read unconditionally at the end of Step 4 — even when the
label apply was skipped — and in **one** call that also re-reads `updatedAt`
for Step 5. The 400-char body cap matters: full review bodies can be tens of
KB and never need to enter context:

```bash
gh pr view <pr_number> --json reviewDecision,latestReviews,updatedAt \
  --jq '{reviewDecision, updatedAt, reviews: [.latestReviews[] | {author: .author.login, state, body: .body[:400]}]}'
```

Report stamphog's current state — approved, changes requested, or dismissed —
plus a one-line reason from its latest review body when present. Surfacing *why*
stamphog is unhappy helps the user decide; the shepherd does not act on it beyond
reporting (the actionable review *threads* were already triaged in Step 2's
quality loop).

This step is independent of CI state. Stamphog evaluates in parallel; there is no
benefit to waiting.

### Step 5: Iteration summary and hand-back

Print a one-line **summary** of the iteration (on top of the per-step narration
and the relayed sub-skill narration from earlier):

```
[shepherd] iter done — sha=<short_sha> qa-swarm=<ran|skip> rounds=<n> resolved=<n> actioned=<n> promoted=<n> simplify=<changed n files|clean> deferred=<n> ci=<pass=N pending=N fail=N> ci-repair=<committed|none|blocked> rerun=<n> stamphog=<applied|already|skipped> verdict=<approved|changes|dismissed|pending>
```

`rounds` is how many quality-loop rounds ran this iteration (1-4). `resolved` /
`actioned` / `promoted` / `deferred` are summed across all rounds. CI counts are
the snapshot observed before any repair push. If there are
deferred threads, print their `file:line` and one-line reason under the status
line. Summarize fixed root causes and validation, queued reruns, and unresolved
CI failures with their classifications. If stamphog requested changes or
dismissed, print its one-line reason.

Then print the state values so the next caller (the user, or the `loop` skill)
can re-supply them:

```
[shepherd] state — qa_swarm_marker_sha=<sha|null> simplify_marker_sha=<sha|null> stamphog_applied_for_sha=<sha|null> deferred_threads=[<id>,...] last_updated_at=<iso8601|null>
```

Set `last_updated_at` from the `updatedAt` returned by Step 4's combined
verdict read — it runs after your actions, so the next fast-path check compares
against a post-action baseline. No separate re-read is needed.

Hand back. The skill does not sleep or self-loop. For hands-off cadence wrap
this skill in `/loop` (e.g. `/loop 5m /pr-shepherd <pr>`); otherwise re-invoke
manually when ready for the next iteration.

## Terminal conditions (stop the loop)

Stop cleanly and print a final summary when **any** of:

- PR is `MERGED` or `CLOSED`.
- A base-branch conflict needs a human decision (ci-shepherd returned
  `restack_needs_decision` — see Step 3).
- `stamphog` is applied for the current SHA, CI has no failures requiring an
  autonomous repair, no new bot threads have appeared
  since the last iteration, and the only remaining unresolved threads are in
  `deferred_threads` — nothing autonomous remains. CI failures already
  classified as unrelated or needs-decision do not force unsafe repeated
  edits, but they must be surfaced. The Step 1 fast path checks CI before
  short-circuiting this case on re-invocation.
- The user interrupts.

CI failures are **not** report-only. `ci-shepherd` must diagnose them and exhaust
the safe repair/rerun action for this iteration before handing back. A repair
push is evaluated on the next iteration; unrelated and needs-decision failures
are surfaced with evidence.
Likewise, ambiguous review findings are **not** a terminal condition; they go to
`deferred_threads` and the loop keeps polling.

Reaching the quality loop's 4-round cap (Step 2d) is also **not** a terminal
condition for the whole iteration — it stops the *loop*, but the iteration
still proceeds to ci-shepherd and stamphog with whatever HEAD the loop landed
on.

The final summary lists:

- commits pushed (with short SHAs and messages),
- threads resolved (count, grouped by "fixed" / "nit", each with the reason or
  commit SHA — resolves carry no reply, so this is the only audit trail),
- threads deferred (with file:line and one-line reason each),
- final CI state, stamphog verdict, label state, and PR merge state.

## Dispatch mechanism

Dispatch `review-triage` and `ci-shepherd` by **load-then-spawn** — the same
pattern `qa-swarm` uses for its reviewers. Pass the sub-skill's body, plus the
override brief and inputs, into a `model: 'sonnet'` `Agent` subagent —
`review-triage` first, then (after the quality loop converges) `ci-shepherd`.

`simplify` is dispatched differently: it's a **built-in** skill with no
SKILL.md file to read, so there's no body to inject into a subagent brief.
Instead, spawn a plain `model: 'sonnet'` `Agent` whose entire prompt is the
**simplify wrapper brief** below, telling it to invoke `Skill("simplify")`
itself against the current diff, apply its own fixes, not commit/push, and
report back which files it changed.

**Resolve each sibling skill local-first, then the store.** This covers
`review-triage`, `ci-shepherd`, and `qa-swarm` (Step 2) — not `simplify`,
which has no store fallback to resolve (it's built into the harness, not a
dotfiles/store skill):

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
  this round. Triage existing threads only. Never call `AskUserQuestion`;
  genuinely ambiguous threads (after applying your paul-pair gate) go to
  `deferred_threads` and never terminate. Inputs supplied: PR number,
  owner/repo, base, `head_sha_in`, `qa_swarm_marker_sha`, `deferred_threads`.
  Do not narrate to the user — collect `[triage]` lines into `narration`.
  Return the structured result from your *Step 5: Report* and stop."
- **simplify wrapper:** "Invoke the `simplify` skill (`Skill` tool,
  `skill: 'simplify'`) against the diff between `<base>` and the current HEAD
  on PR `<pr_number>` in `<owner>/<repo>`. Let it apply its own fixes to the
  working tree. Do not commit or push — the caller does that. Never call
  `AskUserQuestion`. Report back: the list of files changed (or 'no changes'
  if it found nothing to simplify), and a one-line summary per file."
- **ci-shepherd:** "Sub-step, not standalone. Never call `AskUserQuestion`. On a
  needs-decision conflict do not prompt — abort the restack cleanly and return
  `restack_needs_decision: true` with `restack_decision_files`; the orchestrator
  owns the hand-back. Inputs supplied: PR number, owner/repo, base,
  `head_sha_in` — operate against `head_sha_in`. Do not narrate to the user —
  collect `[ci]` lines into `narration`. Return the structured result from your
  *Step 5: Report* and stop. Diagnose every failing leaf job, perform at most one
  verified repair commit, rerun likely flaky/infrastructure jobs once, and do
  not wait for fresh remote CI."

## Dependencies

- **`review-triage`** sub-skill (Step 2) — runs qa-swarm thread + bot thread
  triage, owns the *Judgement rules for auto-actioning a comment*, and folds
  in the `paul-pair` autonomy ladder for its ambiguous bucket.
- **`ci-shepherd`** sub-skill (Step 3) — branch-currency restack + CI diagnosis,
  repair, and bounded flaky-job rerun.
- **`qa-swarm`** (Step 2) — orchestrates the cheap-first review (router on
  GLM-5.2 + delegated reviewers on `opus`/`fable`/`gpt-sol`/`kimi-k3` as
  warranted); resolved local-first, then the store (see *Dispatch
  mechanism*). Run in this main loop so its reviewer agents aren't nested
  inside a dispatched subagent.
- **`simplify`** (Step 2) — built-in reuse/simplification/efficiency pass;
  dispatched as a plain `model: 'sonnet'` `Agent` that calls `Skill("simplify")`
  itself, since there's no SKILL.md body to load-then-spawn.
- `gh` CLI (repo, pr, api, label commands).
- Graphite MCP for git operations (used inside the sub-skills, and to commit
  `simplify`'s changes). Fall back to `gh`/`git` only when Graphite doesn't
  cover a case.
- The `Agent` tool with `model: 'sonnet'` for the three sub-skill runners.

## Graceful degradation

- **`review-triage` skill missing:** warn and continue with `ci-shepherd` +
  stamphog. You lose the triage signal (resolved/deferred counts), but stamphog
  is still applied and its verdict still read.
- **`ci-shepherd` skill missing:** warn and skip the restack + CI repair; run
  the quality loop and apply stamphog against `H1` (no further HEAD movement).
  Report CI as unknown.
- **`qa-swarm` skill missing:** warn and skip the qa-swarm gate for every
  round; review-triage still triages whatever bot threads exist, and simplify
  still runs.
- **`simplify` unavailable** (older harness without the built-in skill): warn
  and skip Step 2c for every round — the quality loop still runs qa-swarm +
  review-triage, it just never applies a simplification pass.
- **`Agent` can't be spawned:** for `review-triage`/`ci-shepherd`, fall back to
  running the sub-skill body inline in the main loop (read the SKILL.md and
  follow it directly). For `simplify`, fall back to `Skill("simplify")` called
  directly inline in the main loop instead of via a wrapping Agent — you lose
  the sonnet pin (it runs at session model) but it's still functional either
  way.
- **No PR detected:** prompt the user (see Step 1) to paste a PR number/URL or
  let the shepherd open a PR via `gh pr create`. Only stop if the user cancels.
- **User interrupts mid-iteration:** stop at the next natural checkpoint and
  print the final summary.
