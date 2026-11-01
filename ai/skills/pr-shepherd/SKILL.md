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

- **`qa-swarm`** — routed bug/quality review that posts PR comments and, when
  evidence warrants it, delegates a systems-thinking lens for shared causes.
- **`review-triage`** — triages qa-swarm + bot threads (fix / resolve / defer),
  with `paul-pair`'s autonomy ladder folded into the ambiguous bucket.
- **`simplify`** — reuse/simplification/efficiency/altitude pass that edits the
  working tree. It posts no comments; this skill owns its commit.
- **`ci-shepherd`** — keeps the branch current, reads the shared CI report,
  diagnoses failed checks and report warnings, fixes PR-caused issues, and reruns
  likely flaky jobs once.

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
| `references/multi-pr.md` | when one session coordinates more than one PR toward a shared goal |

Use `skill-file-get`. Do not pull all five up front.

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
- **Cloud task on the Claude runtime:** `sonnet` → `opus` → `fable`. Do not start
  runners on `haiku`: `haiku` runners skipped real steps often enough that the
  reruns cost more than they saved. `opus` costs 2x `sonnet` per input and output
  token, so start on `sonnet` and move up only when the evidence needs it.

In both ladders, `opus` means Opus 5.5 (`claude-opus-5-5`) and `sonnet` means
Sonnet 5 (`claude-sonnet-5`). If the harness takes a full model ID, pass the ID,
not the short name.

**Check which ladder applies before dispatching.** If you cannot enumerate the
models the `Agent` tool accepts, try the first Desktop alias; if the harness
rejects it, use the cloud-task ladder. On Desktop, do not fall straight through
to `opus` because one alias was rejected — try the next Desktop alias first.
Landing every Desktop runner on the session model is the exact failure this
ladder exists to prevent, and it is the difference between a loop that fits its
budget and one that does not.

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
- `bot_reviews_pending` — set by Step 1 when it flips a draft ready, cleared in
  Step 2d once every expected bot has posted. `false` initially.
- `expected_bots` — bot logins that already posted on this PR, each with a count
  of iterations it has stayed silent since the ready flip. Set by Step 1 with
  `bot_reviews_pending`. `[]` initially.

In a stack, keep all of the state above **per layer**, keyed by PR number. A
marker for one layer says nothing about another layer, and a restack gives every
layer above the change a new HEAD.

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
gh pr view --json number,url,headRefName,baseRefName,headRefOid,state,isDraft,isCrossRepository,updatedAt,labels \
  --jq '{number, url, base: .baseRefName, head_sha: .headRefOid, state, isDraft, isCrossRepository, updatedAt, labels: [.labels[].name]}'
```

Record: PR number, owner/repo, base branch, HEAD SHA (`H0`), state, draft state, fork state,
`updatedAt`, label names. If state is `MERGED` or `CLOSED`, **terminate** with a
final status.

**Stack check.** Find out if the PR is a layer in a stack. Its base is another
open PR's branch when `gh pr list --repo <owner>/<repo> --head <base> --state
open --json number --jq length` is above 0. Another PR can also use this PR's
head as its base. Read the whole stack with `gh api
repos/<owner>/<repo>/pulls/<n> --jq .stack`. In a Desktop worktree `gh stack
view` can say "not part of a stack" when the stack exists, so trust the API.
To work on a layer locally, use `gh stack checkout <n>`. Never run `gh stack
merge`: it lands the chain outside the merge queue. Record the layers bottom to
top. Run Steps 2 to 4 for one layer at a time, bottom first.

**Fast path.** On a re-invocation with carried state, if `H0` == the previous
HEAD *and* `updatedAt` == `last_updated_at` *and* `stamphog` is present *and* `bot_reviews_pending` is false, query
`gh pr checks` and read the shared CI report as in `ci-shepherd` Step 3. Skip only
when no check fails and no report warning needs work. Then narrate `[shepherd]
step 1 — no change since <short_sha>, stamphog present, no CI or report work —
skipping iteration`, print the state line, and exit. Otherwise narrate that CI or
its report needs work and continue. CI status and report changes may not advance
`updatedAt`, so they must pass this gate.

**Fork PRs are review-only.** Read `isCrossRepository` in the same `gh pr view`
call. When it is `true`, the head branch belongs to someone outside the repo, so
never push to it, even when `maintainerCanModify` allows it. In this mode:

- qa-swarm runs and posts as usual.
- review-triage only replies. It makes no fix commits. Defer every thread that
  needs a code change to the author, with a reply that says what to change.
- simplify does not run.
- ci-shepherd diagnoses and reruns flaky jobs once. It makes no repair commit
  and no base update. Put each PR-caused failure in the summary for the author.

Say `[shepherd] step 1 — fork PR, review only` so the reader knows why nothing
was pushed.

If `isDraft == true`, run `gh pr ready <pr_number>` and carry on — invoking the
shepherd is itself the signal that the PR is ready. Do not stop on draft.

Flipping a draft ready is also what *triggers* the repo's bot reviewers, and they
take minutes to post. Set `bot_reviews_pending = true` when you flip it, so round
1 does not read a not-yet-reviewed PR as a clean one. In the same step, set
`expected_bots` to the `[bot]` logins that already posted a review, a review
comment or an issue comment on the PR. One review per bot on an earlier head is
enough to expect it again.

If `gh pr view` finds no PR, do **not** terminate silently. Ask the user
(`AskUserQuestion`) to paste a PR number/URL, have the shepherd open one via
`gh pr create`, or cancel. `gh pr create` defaults to draft in this repo, so
re-run the `isDraft` check on anything it opens.

### Step 2: Quality loop — qa-swarm, review-triage, simplify

Run until a round is **dry**, capped at **4 rounds**. Normally that means at
least 2 rounds, so round 1's fixes get re-reviewed. The exception: if round 1 is
dry *and* qa-swarm actually ran in it, there is nothing to re-review — stop at
one round and say so.

**SDK changes.** When the diff changes an SDK implementation, public API, or
runtime dependency, load Dustin's [`sdk-dustin-sdk-review`](https://us.posthog.com/project/2/llm-analytics/skills/sdk-dustin-sdk-review)
from the skill store and run it before review-triage. Check package boundaries,
including SDK packages in a monorepo; do not use the repository name alone.
Use the same substantive-change gate as qa-swarm, reuse a completed review that
covers the same SDK diff, and record its reviewed SHA. After SDK fixes, review
the changed paths again. Use this skill's model ladder and diff-first dispatch.
Bring calibrated findings into this quality loop and deduplicate them against
qa-swarm and existing threads. Keep Dustin's draft-then-approve posting gate;
invoking pr-shepherd does not authorize publication of that review's drafts.
If the skill is unavailable, report the missing SDK review; do not claim it ran.

For round `r`, against the previous round's HEAD (`H0` for round 1):

**a. qa-swarm when warranted.** When `qa_swarm_marker_sha` is `null`, first read
the PR's `<!-- qa-swarm-summary -->` comment in one call (`gh api
repos/<owner>/<repo>/issues/<pr>/comments --jq` with the body capped at 400
chars). If its verdict line names the round's starting HEAD (`@ <short_sha>`),
set `qa_swarm_marker_sha` to that HEAD and do not run qa-swarm again: that
review already covers this tree. Otherwise run when `qa_swarm_marker_sha` is
`null`, or the round's starting HEAD != `qa_swarm_marker_sha` and the diff
`qa_swarm_marker_sha..HEAD` carries a substantive change — not just `*.md` or
`*.txt` files, whitespace, or comment-only hunks (a docstring turned into a `#`
comment is not a review trigger; a second router pass on that cost ~32k tokens
for nothing). Invoke from the harness first, then the store. Pass the PR number,
the diff path, the model policy, and any concrete related defects/PRs already
known from this task; qa-swarm decides whether a systems-thinking lens is
warranted. Do not launch a separate systems reviewer here or in review-triage.
Afterwards set `qa_swarm_marker_sha = HEAD`
— qa-swarm only comments, it never moves HEAD.

A round whose only new commit is the previous round's simplify commit does not
need a router when that diff is under about 20 lines and the type check and
linter pass on it. Review it in this turn instead: confirm it keeps the same
behaviour, then set `qa_swarm_marker_sha = HEAD`. A router that re-checked a
6-line formatter extraction, which the checks had already proved, cost ~40k
tokens and found nothing.

Skipping despite qualifying changes needs an `AskUserQuestion` confirm, **round 1
only**. Do not skip silently; "review fatigue" is not grounds.

**b. review-triage.** First read the unresolved threads in one GraphQL call, plus
the resolved threads whose last comment is not a reply from the shepherd or a
human. Read them on this PR and on any merged PR in the same work. A thread
resolved with no reply is still open work: on PR 117550 two Codex findings were
resolved with no reply or fix, and the PR merged with both bugs. If
that set equals `deferred_threads` and no review landed since the round began,
record `resolved=0 actioned=0 promoted=0` and skip the runner. If at most two threads remain and every file they cite is
already in this loop's context from this iteration, triage them inline in this
turn instead of dispatching: a runner would re-read those files, which is the
"same work twice" defect Step 6 checks for. Apply the `review-triage` rules as
written and record the same fields. Otherwise dispatch as an `Agent` at the
bottom of the ladder. Pass
`head_sha_in` = this round's starting HEAD, the PR number / owner / repo / base,
the diff path, `qa_swarm_marker_sha`, and `deferred_threads`. Relay its
`narration` verbatim, prefixed with the round number. Record `new_head_sha`,
`deferred_threads`, `unresolved_actionable_remaining`, `resolved`, `actioned`,
`promoted`.

Check each newly deferred thread before you add it to `deferred_threads`. Read
the cited lines once. If the code already answers the finding, reply with that
evidence, resolve the thread, and count it in `resolved`. Defer only a thread
that needs a decision the code cannot answer. A runner that defers because
`paul-pair` is unavailable has made no judgement, so always check those.

**c. simplify when warranted.** Same gate shape, keyed off `simplify_marker_sha`
and the post-triage HEAD. Dispatch an `Agent` with the simplify wrapper brief
from `references/dispatch.md` against the diff between base and current HEAD.
Copy the brief; do not write your own. Never tell the runner to invoke
`Skill("simplify")`: that skill starts its reviewers in the background, so the
runner ends its turn with no report. It edits the working tree but
does not commit — if it changed files, `git add`, commit
(`refactor: apply simplify pass`), push. Set `simplify_marker_sha = HEAD` either
way.

**d. Dryness and loop control.** A round is **dry** iff review-triage reported
`resolved == 0 and actioned == 0 and promoted == 0`, its returned
`deferred_threads` added nothing, simplify changed 0 files, no
`validation_request` is pending, and `bot_reviews_pending` is false.

When `bot_reviews_pending` is true the round cannot be dry — the threads that
matter have not been posted yet. Before the next round's triage, poll once:
`gh pr view <pr_number> --json latestReviews --jq '[.latestReviews[] | {login: .author.login, at: .submittedAt}]'`.
If an expected bot has not posted since the ready flip, wait ~90s and poll once
more. Clear the flag when every login in `expected_bots` has posted a review or
comment newer than the ready flip. When `expected_bots` is empty, clear it as
soon as any bot review lands. Never wait past the second poll. If a bot is still
missing, keep the flag set, finish the iteration, and hand back, so the next
iteration polls again. Add one to each missing bot's silent count and drop a bot
after two silent iterations, so a reviewer that never posts cannot hold the PR
open.

Run both polls inline, in this loop's own turn. Never hand the poll to `Monitor`,
to a background `Agent`, or to anything with `run_in_background: true`, and never
end your turn waiting on its result. Nothing reports back, so the iteration
strands and a human has to restart it. The sub-step contract forbids this for
runners; it binds the top-level loop the same way.

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
`repair` result, including its CI-report warning inventory. The CI buckets are
the pre-repair snapshot when a repair moved HEAD; fresh remote CI is evaluated
next iteration.

If `base_update.status == "conflict"`, surface the one-line reason and
**continue** to Step 4 — a base conflict blocks merge (the human's call), not
review or stamping.

When the merge queue removed the PR, read Trunk's failure and run that test
locally, even when the PR's own checks are green. Jest selection on the PR can
skip a test that the queue's full run executes.

**Stacked PRs.** When the PR's base is another PR's branch, tell the runner not
to base-update, restack, or force-push, and do not bring a base in for a lower
layer either: the merge commit that creates breaks restack semantics, and a
signed-history rewrite refuses a history containing one. Restacking is the
caller's job and it is not optional — a commit you land on any layer leaves
every layer above it on a stale base. Rebase them bottom-up yourself, and
republish each one **onto the layer below it**, never onto the merge-base with
the default branch: that default re-creates the lower commits under fresh SHAs,
so a branch stops containing its own base and the stack silently detaches. Then
re-read every head, because each republish assigns a new one and Step 4's
`headRefOid` guard compares against it.

**Restack recipe.** For each layer above the changed one, bottom-up:

```bash
git rebase --onto <new base> <old base sha> <layer branch>
git push --force-with-lease=<layer branch>:<remote sha> origin <layer branch>
```

`<old base sha>` is the head the layer below had **before** it changed. Take the
lease sha from the remote head you read just before the rebase. Restack the next
layer only after this push succeeds.

**One layer at a time.** Dispatch the work for each layer as its own top-level
`Agent`, in sequence, never nested and never in parallel: all layers share one
working tree and one remote. Restack between layers, then re-read the heads, then
start the next layer with its new `head_sha_in`.

**Two guards before you touch a layer.** First, never sync, rebase, or push a
layer that is in the merge queue: a force-push removes the PR from the queue.
That includes a restack of any layer whose base is queued. Report it and wait.
Second, run `git fetch` and fast-forward the layer branch just before every
rebase. Bots push to layer branches, and a lease push over a stale local copy
will either fail or destroy their commit.

Do not trust a runner's claim that a layer is clean. Query the review threads
for that layer directly (one GraphQL call) before you stamp it. When a runner
defers a thread, answer it yourself, and quote the sha of the commit that fixes
it.

Before judging that a branch needs its base at all, check whether the repo
actually gates on it. A `mergeStateStatus` of `BLOCKED` is a missing approval,
not a stale base; `BEHIND` is the one that means out-of-date-and-required. Where
a merge queue tests the merge itself, updating a behind-but-unblocked branch buys
nothing and costs a restack and a CI fan-out per layer.

### Step 4: Apply `stamphog` and read its verdict

`stamphog` is PostHog/posthog's PR Approval Agent. It re-reviews on every push,
so re-applying the label on each new SHA is itself what re-triggers it. There is
no dismissal-detection dance.

First check that the repo runs stamphog at all: `gh api repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name'` and grep the workflow files for `stamphog`. When none mentions it, skip this step's apply and verdict read, narrate `[shepherd] step 4 — repo has no stamphog workflow; approval is a human's`, and treat the stamphog part of the terminal condition as met.

Skip the apply, narrate why, and go straight to reading the verdict when the PR already has a human approval (`reviewDecision` is `APPROVED`), or when the last stamphog review refused on the size gate. A new commit cannot change a size refusal, so another label only buys another refused run. Otherwise apply when `stamphog_applied_for_sha != H2`. First guard against a draft PR and
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
`stamphog_applied_for_sha = H2`. When the label is already on the PR, adding it
again changes nothing and triggers no review: run `--remove-label stamphog`
first, then `--add-label stamphog`.

A push to a PR that carries the label starts a stamphog run by itself. When you
resolve a thread or edit the PR after that push, wait for that run to post its
verdict, then re-add the label. The run read the PR before your change. When it
refuses, it removes the label, so a re-add made while it runs is lost. Poll
`latestReviews` for a stamphog review newer than the push, then apply. On PR
114947 a re-add 9 seconds before the push run finished was lost, and the label
had to go on a third time.

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
- `stamphog` is applied for the current SHA (or skipped under the Step 4 rule), CI has no failed checks or
  CI-report warnings needing an autonomous repair, `bot_reviews_pending` is
  false, no new bot threads since last iteration, and the only unresolved threads are in `deferred_threads`.
- The user interrupts.

CI failures are **not** report-only: `ci-shepherd` must diagnose them and exhaust
the safe repair/rerun action before handing back. Ambiguous review findings are
not terminal either; they go to `deferred_threads` and the loop keeps polling.
Hitting the 4-round cap stops the *loop*, not the iteration — Steps 3 and 4 still
run.

When you stop for good, run Step 6 before handing back.

## Dependencies

`review-triage`, `ci-shepherd`, `qa-swarm`, `simplify`; for SDK changes,
`sdk-dustin-sdk-review` from the skill store; the `gh` CLI (repo, pr,
api, label, `pr update-branch`); `git`; and the `Agent` tool with model selection
where available. Missing pieces are handled in `references/degradation.md`.
