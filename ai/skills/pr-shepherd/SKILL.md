---
name: pr-shepherd
description: >
  Shepherd a PR through review, simplification, review triage, branch updates,
  CI diagnosis and repair, and stamphog approval. Resolves a cheapest-first
  model ladder against what the harness can actually dispatch, and passes
  runners the diff rather than making them re-read it. Use for /pr-shepherd,
  babysitting, or driving the full PR review and CI loop.
---

# PR Shepherd

Drives a PR through the review loop by orchestrating four focused sub-skills and
managing the `stamphog` approval label on top of them:

- **`qa-swarm`** — multi-reviewer bug/quality pass that posts PR comments.
- **`review-triage`** — triages qa-swarm + bot threads (fix / resolve / defer),
  with `paul-pair`'s autonomy ladder folded into the ambiguous bucket.
- **`simplify`** — reuse/simplification/efficiency/altitude pass that edits the
  working tree. It posts no comments; this skill owns its commit.
- **`ci-shepherd`** — keeps the branch current, diagnoses CI, fixes PR-caused
  failures, reruns likely flaky jobs once.

The first three run together in a **quality loop** (Step 2) so a fix made in
round 1 gets re-reviewed in round 2 within the same iteration. On top of those,
this skill resolves the PR, applies `stamphog` on each new SHA and reports its
verdict, and prints the iteration summary. It defers anything genuinely ambiguous
to the user.

Each sub-skill is independently invocable (`/review-triage`, `/ci-shepherd`) when
you only want that slice. This skill is the full loop.

**One invocation = one iteration.** The skill does not sleep or self-loop. State
carries between invocations via `$ARGUMENTS` or the surrounding conversation.

## Bundled files — fetch only when you need them

| file | fetch when |
|---|---|
| `references/dispatch.md` | before the first sub-skill dispatch of the iteration |
| `references/narration.md` | if unsure of the narration format |
| `references/summary-format.md` | at Step 5 |
| `references/degradation.md` | when something is missing or failing |

Use `skill-file-get`. Do not pull all four up front.

The body itself is paginated. Page it with `body_offset` and `body_length` and
follow `body_next_offset` until it is `null`. Other keys (`offset`, `limit`) are
silently ignored and return page one again, which reads like progress.

## Where to run this

Run one iteration per session, in a session that has **not** just done the
implementation work.

Cost here is `calls × context`, and every dispatch's result lands back in this
loop's context. Starting the shepherd on top of a long implementation
conversation multiplies every dispatch by that conversation for the rest of the
run. If you are being invoked at the tail of the session that wrote the code, say
so and offer to run in a fresh session or as a top-level subagent instead.

## Model policy — cheapest that the harness can actually dispatch

Resolve the ladder against the models this harness will actually accept for a
subagent, then start every runner at the bottom of it:

- **PostHog Desktop:** `gpt-sol` → `kimi` → `opus` → `fable`.
- **Cloud task on the Claude runtime:** `haiku` → `sonnet` → `opus` → `fable`.

**Check which ladder applies before dispatching.** If you cannot enumerate the
models the `Agent` tool accepts, assume the cloud-task ladder. Do not fall
straight through to `opus` because a Desktop alias was rejected — silently
landing every runner on the session model is the exact failure this ladder exists
to prevent, and it is the difference between a loop that fits its budget and one
that does not.

Get a concrete result from the cheapest available model first, then validate it:

1. Prefer deterministic proof: tests, type checks, linters, the final diff,
   direct evidence from GitHub or CI.
2. For a risky or uncertain decision, ask the next model up to validate the
   finding or fix. Give it the evidence and the narrow question. Do not ask it to
   repeat the whole task.
3. Move up one model at a time. Stop as soon as the evidence is clear.
4. If a model is unavailable, try the next. Record the model that ran.

A second-model validation is **required** before an autonomous change affecting
authentication, permissions, billing, data loss, migrations, concurrency, a
public API, or a broad shared abstraction; and when reviewers disagree or the
available checks cannot prove the change safe. Low-risk mechanical work does not
need a stronger model when deterministic checks prove it. A stronger model never
replaces tests.

Apply the same ladder to every sub-skill, and pass it to `qa-swarm` as a caller
override. The top-level loop inherits the session model — do not ask the user to
switch it.

## State carried between invocations

Not stored on disk — passed via `$ARGUMENTS`, or carried in the surrounding
conversation when iterations run back-to-back. This skill owns all of it; the
sub-skills receive what they need and return updates, but never persist state.

- `qa_swarm_marker_sha` — HEAD when qa-swarm last ran. `null` initially.
- `simplify_marker_sha` — HEAD when `simplify` last ran. `null` initially.
- `stamphog_applied_for_sha` — HEAD when `stamphog` was last applied. `null`
  initially.
- `deferred_threads` — review-thread IDs already surfaced to the user, so
  `review-triage` skips them and stops nagging.
- `last_updated_at` — the PR's `updatedAt` at the end of the previous iteration.
  Step 1's fast path compares against it. `null` initially.

## Workflow — one iteration

The mechanical work lives in the sub-skills; this skill owns the decisions.

- **qa-swarm runs in this main loop** (inside Step 2), via `Skill("qa-swarm")` —
  not inside a sub-skill runner — so its reviewer agents are not nested.
- **`review-triage`, `ci-shepherd`, and `simplify` each run as one `Agent`
  subagent** at the bottom of the ladder. Isolation keeps their tool output out
  of this context. See `references/dispatch.md`.
- **Sequential within a round, not parallel.** All three mutate the same working
  tree and push, so concurrent runs would race the index and the remote ref. Run
  qa-swarm, then review-triage, then simplify. `ci-shepherd` starts from the
  quality loop's *final* HEAD.
- This skill owns Step 1, round control, the stamphog step, the summary, and the
  only `AskUserQuestion` paths (no PR found in Step 1; qa-swarm-skip confirm in
  Step 2, round 1 only). Runners **never** call `AskUserQuestion`.

**HEAD-SHA threading.** Every round can move HEAD and the stamphog "apply once
per SHA" gate keys off it, so thread HEAD forward and stamp the *final* one:

```
H0 = Step 1 HEAD
Step 2  rounds r = 1..N (N <= 4, stop when a round is dry):
          H(r).0 = H(r-1).final
          qa-swarm when warranted (at H(r).0; comments only, HEAD unchanged)
          review-triage(head_sha_in = H(r).0) -> new_head_sha = H(r).1
          simplify when warranted (at H(r).1); commit+push if it changed files
            -> H(r).final ; else H(r).final = H(r).1
        H1 = H(N).final
Step 3  ci-shepherd(head_sha_in = H1) -> new_head_sha = H2
Step 4  apply stamphog iff stamphog_applied_for_sha != H2; read + report verdict
```

Passing `H0` instead of `H1` to ci-shepherd would diagnose CI against a stale
tree. Thread it.

### Step 1: Resolve PR, fast-path check, capture baseline

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise resolve
everything in **one** call — always `--jq` so only the needed fields reach
context, and derive owner/repo from `url` rather than a second `gh repo view`:

```bash
gh pr view --json number,url,headRefName,baseRefName,headRefOid,state,isDraft,updatedAt,labels \
  --jq '{number, url, base: .baseRefName, head_sha: .headRefOid, state, isDraft, updatedAt, labels: [.labels[].name]}'
```

Record: PR number, owner/repo, base branch, HEAD SHA (`H0`), state, draft state,
`updatedAt`, label names. If state is `MERGED` or `CLOSED`, **terminate** with a
final status.

**Fast path.** On a re-invocation with carried state, if `H0` == the previous
HEAD *and* `updatedAt` == `last_updated_at` *and* `stamphog` is present, make one
`gh pr checks` query. No failed checks → narrate `[shepherd] step 1 — no change
since <short_sha>, stamphog present, no failing CI — skipping iteration`, print
the state line, exit. Any failure → narrate that CI is failing and continue. CI
status changes may not advance `updatedAt`, so they must pass this gate.

If `isDraft == true`, run `gh pr ready <pr_number>` and carry on — invoking the
shepherd is itself the signal that the PR is ready. Do not stop on draft.

If `gh pr view` finds no PR, do **not** terminate silently. Ask the user
(`AskUserQuestion`) to paste a PR number/URL, have the shepherd open one via
`gh pr create`, or cancel. `gh pr create` defaults to draft in this repo, so
re-run the `isDraft` check on anything it opens.

### Step 2: Quality loop — qa-swarm, review-triage, simplify

Run until a round is **dry**, capped at **4 rounds**. Normally that means at
least 2 rounds, so round 1's fixes get re-reviewed. The exception: if round 1 is
dry *and* qa-swarm actually ran in it, there is nothing to re-review — stop at
one round and say so.

For round `r`, against the previous round's HEAD (`H0` for round 1):

**a. qa-swarm when warranted.** Run when `qa_swarm_marker_sha` is `null`, or the
round's starting HEAD != `qa_swarm_marker_sha` and the diff
`qa_swarm_marker_sha..HEAD` carries a substantive change — not just `*.md` or
`*.txt` files, whitespace, or comment-only hunks (a docstring turned into a `#`
comment is not a review trigger; a second router pass on that cost ~32k tokens
for nothing). Invoke from the harness first, then the store. Pass the PR number,
the diff path, and the model policy. Afterwards set `qa_swarm_marker_sha = HEAD`
— qa-swarm only comments, it never moves HEAD.

Skipping despite qualifying changes needs an `AskUserQuestion` confirm, **round 1
only**. Do not skip silently; "review fatigue" is not grounds.

**b. review-triage.** Dispatch as an `Agent` at the bottom of the ladder. Pass
`head_sha_in` = this round's starting HEAD, the PR number / owner / repo / base,
the diff path, `qa_swarm_marker_sha`, and `deferred_threads`. Relay its
`narration` verbatim, prefixed with the round number. Record `new_head_sha`,
`deferred_threads`, `unresolved_actionable_remaining`, `resolved`, `actioned`,
`promoted`.

**c. simplify when warranted.** Same gate shape, keyed off `simplify_marker_sha`
and the post-triage HEAD. Dispatch an `Agent` with the simplify wrapper brief
against the diff between base and current HEAD. It edits the working tree but
does not commit — if it changed files, `git add`, commit
(`refactor: apply simplify pass`), push. Set `simplify_marker_sha = HEAD` either
way.

**d. Dryness and loop control.** A round is **dry** iff review-triage reported
`resolved == 0 and actioned == 0 and promoted == 0`, its returned
`deferred_threads` added nothing, simplify changed 0 files, and no
`validation_request` is pending.

- Dry, and (`r >= 2` or qa-swarm ran this round): stop. This round's final HEAD
  is `H1`.
- `r == 4`: stop regardless — narrate `[shepherd] step 2 — round cap (4)
  reached` — and use this round's final HEAD as `H1`. Convergence by round 2-3 is
  expected.
- Otherwise increment `r` and run against this round's final HEAD.

### Step 3: Dispatch ci-shepherd

Dispatch as an `Agent` at the bottom of the ladder, with `head_sha_in = H1`, the
PR number / owner / repo / base, and the diff path. Relay its `narration`
verbatim. Record `new_head_sha` as `H2`, the observed `ci` buckets, and the
`repair` result. The CI buckets are the pre-repair snapshot when a repair moved
HEAD; fresh remote CI is evaluated next iteration.

If `base_update.status == "conflict"`, surface the one-line reason and
**continue** to Step 4 — a base conflict blocks merge (the human's call), not
review or stamping.

### Step 4: Apply `stamphog` and read its verdict

`stamphog` is PostHog/posthog's PR Approval Agent. It re-reviews on every push,
so re-applying the label on each new SHA is itself what re-triggers it. There is
no dismissal-detection dance.

Apply when `stamphog_applied_for_sha != H2`. First guard against a draft PR and
an out-of-band push:

```bash
gh pr view <pr_number> --json isDraft,headRefOid
```

- `headRefOid != H2` → HEAD moved under us. Skip this iteration and let the next
  pass re-baseline; narrate it.
- `isDraft == true` → `gh pr ready <pr_number>` first. A draft makes every
  PR-Approval-Agent job skip at its `!draft` gate with no comment and no log,
  which looks identical to "stamphog hasn't run yet".

Then `gh pr edit <pr_number> --add-label stamphog` and set
`stamphog_applied_for_sha = H2`.

**Read the verdict** unconditionally at the end of Step 4 — even when the apply
was skipped — in **one** call that also re-reads `updatedAt` for Step 5. The
400-char cap matters; full review bodies run to tens of KB and never need to
enter context:

```bash
gh pr view <pr_number> --json reviewDecision,latestReviews,updatedAt \
  --jq '{reviewDecision, updatedAt, reviews: [.latestReviews[] | {author: .author.login, state, body: .body[:400]}]}'
```

Report approved / changes requested / dismissed plus a one-line reason. This step
is independent of CI; stamphog evaluates in parallel.

### Step 5: Iteration summary and hand-back

Print the iteration summary and the state line — formats in
`references/summary-format.md`. Then hand back. For hands-off cadence, wrap this
skill in `/loop` (e.g. `/loop 5m /pr-shepherd <pr>`).

### Step 6: Reflect on this skill — terminal conditions only

At a terminal condition only, after Step 5's summary and before handing back.
Not on an ordinary hand-back between iterations — this is a whole-PR
retrospective, not a per-round one.

Reflect from what is already in context. Do not re-read files, re-fetch this
skill, or spawn an agent for it: a retrospective that costs a round of the loop
it is critiquing has failed on its own terms.

One question — did following this skill cost more, or achieve less, than it
should have? Each of these is a defect in the skill, not in the PR:

- a sub-skill could not be resolved, or loaded only partially, and the loop
  carried on degraded
- a runner ran on a costlier model than the ladder intended
- the quality loop hit the 4-round cap without converging
- the same work happened twice — a file re-read, a diff re-fetched, a check
  re-run
- an instruction was ambiguous enough that you had to guess, and the guess was
  wrong
- a thread was deferred to the user who then resolved it in one line, or
  auto-actioned something they reverted

If none fired, say `[shepherd] reflect — nothing to change` and stop. Do not
invent an improvement to have something to say.

If one did, give the user three things: what happened, which instruction allowed
it, and the smallest edit that would prevent it. Then **offer** to publish that
edit — never publish unprompted:

```text
call skill-update {"skill_name": "pr-shepherd", "base_version": <current>,
  "edits": [{"old": "...", "new": "..."}],
  "version_description": "<what changed and why>"}
```

Use `file_edits` when the fix belongs in a `references/` file. Keep it to one
behaviour per version, and put the evidence in the version description so the
history says why.

## Terminal conditions

Stop cleanly and print the final summary when **any** of:

- PR is `MERGED` or `CLOSED`.
- `stamphog` is applied for the current SHA, CI has no failures needing an
  autonomous repair, no new bot threads since last iteration, and the only
  unresolved threads are in `deferred_threads`.
- The user interrupts.

CI failures are **not** report-only: `ci-shepherd` must diagnose them and exhaust
the safe repair/rerun action before handing back. Ambiguous review findings are
not terminal either; they go to `deferred_threads` and the loop keeps polling.
Hitting the 4-round cap stops the *loop*, not the iteration — Steps 3 and 4 still
run.

When you stop for good, run Step 6 before handing back.

## Dependencies

`review-triage`, `ci-shepherd`, `qa-swarm`, `simplify`; the `gh` CLI (repo, pr,
api, label, `pr update-branch`); `git`; and the `Agent` tool with model selection
where available. Missing pieces are handled in `references/degradation.md`.
