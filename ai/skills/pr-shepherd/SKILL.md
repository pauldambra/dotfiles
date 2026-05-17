---
name: pr-shepherd
description: >
  Shepherds a PR through the repetitive loop: run qa-swarm when there are
  substantive changes, triage qa-swarm findings, triage AI/bot review
  comments, keep the branch current with its base, report CI state, and
  apply the `stamphog` label whenever the actionable-thread state is
  clean (independent of CI). Use when the user says "/pr-shepherd",
  "shepherd this PR", "babysit this PR", or wants the whole review loop
  driven automatically. Accepts an optional PR number or URL as argument.
---

# PR Shepherd

Drives a PR through the review loop. Runs qa-swarm, triages qa-swarm
and bot review comments, keeps the branch current, watches CI, and
applies `stamphog` whenever the actionable-thread state is clean —
then re-triages the bot's response on the next iteration. Defers
anything ambiguous to the user.

**One invocation = one iteration.** The skill does not sleep or
self-loop in practice — the model exits after a single pass. For
hands-off cadence, run it under the `loop` skill (e.g.
`/loop 5m /pr-shepherd <pr>`). For ad-hoc nudges, re-invoke manually.
State is carried between invocations via `$ARGUMENTS` or via the
surrounding conversation when iterations run back-to-back inside one
Claude session.

## Bot identifier — REQUIRED on every posted comment

Every comment this skill posts to GitHub (thread replies when resolving,
fix-notification replies, top-level PR comments, status comments — **every
single one**) must begin with the bot-identifier header so a human reader
can tell at a glance that it was not written by a person:

```markdown
> [!NOTE]
> 🤖 Automated comment by **PR Shepherd** — not written by a human
```

Apply this header as the first lines of the comment body, before any
other content. Do not skip it. Example reply when resolving a NIT:

```markdown
> [!NOTE]
> 🤖 Automated comment by **PR Shepherd** — not written by a human

Intentional — matches the convention used elsewhere in this file.
```

Example reply when posting a fix:

```markdown
> [!NOTE]
> 🤖 Automated comment by **PR Shepherd** — not written by a human

Fixed in `abc1234` — renamed `foo` to `bar` in `src/foo.ts`.
```

## Narration — keep the user in the loop

Skills run silently unless the assistant prints text between tool calls.
Before **every** step below, emit a short one-line narration so the user
can see what's happening without watching raw tool output. Keep it
terse — one sentence, present tense.

Format: `[shepherd] <step> — <what and why>`

Examples:

```
[shepherd] step 1 — resolving PR from gh pr view
[shepherd] step 2 — diff since a1b2c3d touches src/foo.ts, running qa-swarm
[shepherd] step 2 — skip qa-swarm, only doc-only changes since a1b2c3d
[shepherd] step 3 — found 4 qa-swarm threads: 1 actionable, 2 nit, 1 ambiguous
[shepherd] step 3 — applying fix for thread #42 (rename foo to bar in src/foo.ts)
[shepherd] step 5 — branch is BEHIND, restacking via graphite
[shepherd] step 5 — restack hit conflicts in pnpm-lock.yaml, src/foo.ts; classifying
[shepherd] step 5 — pnpm-lock.yaml trivial (regen), src/foo.ts non-overlapping — resolving
[shepherd] step 5 — resolved 2 conflicts, continuing restack
[shepherd] step 5 — conflict in src/auth.ts needs a decision (both sides edit getToken) — deferring
[shepherd] step 6 — CI: 8 pass, 4 pending, 0 fail — recording in summary
[shepherd] step 7 — applying stamphog label (independent of CI state)
[shepherd] iter done — handing back; re-invoke or let /loop drive the next pass
```

Also narrate mid-step when a sub-action could take more than a few
seconds (qa-swarm invocation, graphite restack, pushing a fix). A silent
30+ second gap is the failure mode — err on the side of more lines, not
fewer.

GitHub itself is the source of truth so the loop is restartable across
invocations.

## State carried between invocations

State is **not** stored on disk. It is passed via `$ARGUMENTS` on
re-invocation, or carried in the surrounding conversation when
iterations run back-to-back inside one Claude session. When taking
over from a previous iteration, expect the previous values to be
quoted in the invocation or visible in the recent conversation; when
finishing an iteration, print the values so the next caller can
re-supply them.

- `qa_swarm_marker_sha` — HEAD SHA the last time qa-swarm ran. `null`
  initially.
- `stamphog_applied_for_sha` — HEAD SHA at which `stamphog` was last
  applied. `null` initially.
- `deferred_threads` — set of review-thread IDs already surfaced to the
  user as needing their judgement. Skipped on subsequent iterations to
  avoid nagging.
- `stamphog_dismissed_on_sha` — transient, re-derived every iteration
  from the current PR state (comments and labels — see Step 4). Set
  when stamphog has dismissed at the current HEAD. Not persisted
  across iterations.

## Workflow — one iteration

### Step 1: Resolve PR and capture baseline

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise:

```bash
gh pr view --json number,headRefName,baseRefName,url,headRefOid,state
gh repo view --json owner,name
```

Record: PR number, owner/repo, base branch, HEAD SHA, PR state.

If PR state is `MERGED` or `CLOSED`, **terminate** with a final status.

If `gh pr view` finds no PR for the current branch, **do not terminate
silently**. Ask the user (with `AskUserQuestion`) whether they want to:

- paste a PR number or URL to shepherd, or
- have the shepherd open a PR for the current branch via `gh pr create`
  (then continue the loop against the new PR), or
- cancel.

Only proceed once the user picks one. If they cancel, terminate cleanly.

### Step 2: Run qa-swarm when warranted

Run qa-swarm when **either**:

- `qa_swarm_marker_sha` is `null` (first iteration), **or**
- HEAD SHA != `qa_swarm_marker_sha` **and** the diff
  `qa_swarm_marker_sha..HEAD` touches at least one non-doc file (i.e.
  something other than `*.md`, `*.txt`, or pure whitespace changes).

Invoke via `Skill("qa-swarm", args="<pr_number>")` so the existing skill
handles diff gathering and comment posting. After it completes set
`qa_swarm_marker_sha = HEAD_SHA`.

If skipping qa-swarm, log `qa-swarm: skip (no substantive changes since
<sha>)`.

The non-doc-files rule is firm. If you want to skip qa-swarm despite
qualifying changes (e.g. you believe the new commits only address
prior qa-swarm findings, or the run would be pure churn), use
`AskUserQuestion` to confirm before skipping. Do not silently
override -- a quiet skip hides judgement calls the user may want to
challenge. "Review fatigue" alone is not sufficient grounds.

### Step 3: Triage qa-swarm review threads

Fetch all review threads on the PR:

```bash
gh api graphql -f query='
  query($owner:String!, $repo:String!, $num:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$num) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first:20) {
              nodes {
                databaseId
                author { login __typename }
                body
                path
                line
              }
            }
          }
        }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F num=<pr_number>
```

For each thread where `isResolved=false`, `isOutdated=false`, the first
comment's body contains `🤖 Automated comment by **QA Swarm**`, and
thread id is not in `deferred_threads`:

Classify the thread body:

- **Actionable & clear** — concrete single-file fix, severity HIGH or
  CRITICAL (convergent findings count as higher confidence), scope
  tight and unambiguous.
- **NIT / non-actionable** — style-only, speculative, duplicate, or
  already addressed.
- **Ambiguous** — architectural judgement, broad scope, or requires
  design decisions.

Handle each class:

- **Actionable:** apply the edit with `Edit`/`Write`, stage via Graphite
  MCP, commit with a message like `fix: address qa-swarm <short
  description>`, push via Graphite MCP, then resolve the thread and
  leave a short reply noting the commit SHA.
- **NIT:** resolve the thread with a one-line reply explaining why
  ("intentional — <reason>" / "out of scope — follow-up" / "disagree
  — <reason>").
- **Ambiguous:** add thread id to `deferred_threads`. Do not resolve.
  Include in the end-of-iteration status.

To resolve a thread + reply:

`<reply_body>` MUST begin with the bot-identifier header — no
exceptions, including for NITs and ambiguous replies. See *Bot
identifier — REQUIRED on every posted comment* above.

```bash
# reply
gh api graphql -f query='
  mutation($thread_id:ID!, $body:String!) {
    addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread_id, body:$body}) {
      comment { id }
    }
  }' -F thread_id=<id> -F body=<reply_body>

# resolve
gh api graphql -f query='
  mutation($thread_id:ID!) {
    resolveReviewThread(input:{threadId:$thread_id}) {
      thread { id }
    }
  }' -F thread_id=<id>
```

**Ambiguous threads never cause termination.** They are added to
`deferred_threads` and surfaced in the iteration summary. The loop
continues so CI watching, branch-currency, and stamphog management
keep running while the user decides on the architectural questions
in their own time.

### Step 4: Triage bot review threads

Same procedure as Step 3, but for unresolved threads where the first
comment's `author.__typename == "Bot"` **or** `author.login` ends with
`[bot]`, **and** the body does *not* start with the qa-swarm header
(those were handled in Step 3).

This covers stamphog/posthog-code, Claude review apps, Cursor bot,
CodeRabbit, Dependabot comment threads, etc.

#### Skip stale bot reviews

Before classifying a bot review as actionable, check whether it is
against the current HEAD:

- inline review thread comments -- already filtered by
  `isOutdated=false` in the GraphQL query.
- top-level PR comments (e.g. Greptile review summaries) -- scan the
  body for a commit SHA reference. Common patterns: "reviewing commit
  `<sha>`", "in `<sha>`", or a GitHub commit link of the form
  `/commit/<sha>`. If a referenced SHA is present and != HEAD_SHA,
  skip the comment as stale. The bot will re-evaluate the new HEAD
  shortly.

When in doubt (no SHA reference but the review predates the latest
commit by more than one push), prefer skipping to acting -- a stale
fix is worse than a small wait.

#### Detect stamphog approval dismissal

Stamphog removes its own approval and its `stamphog` label whenever
new commits are pushed after a prior approval, and posts:

> New commits pushed — stamphog approval dismissed. Re-apply the
> stamphog label to request a re-review.

This is a protocol signal, not a review thread to reply to or
resolve. Scan **all four** surfaces where stamphog may signal it:

- top-level PR issue comments —
  `gh api repos/<owner>/<repo>/issues/<pr_number>/comments`
- dismissed review bodies —
  `gh api repos/<owner>/<repo>/pulls/<pr_number>/reviews`,
  looking for entries where `state == "DISMISSED"` from a bot author
- inline review thread comments — already fetched by the GraphQL
  query in Step 3
- current PR labels —
  `gh pr view <pr_number> --json labels`. Treat the dismissal as
  detected when `stamphog_applied_for_sha == HEAD_SHA` but `stamphog`
  is **not** in the returned labels. This catches the silent-removal
  case where stamphog's verdict is unchanged from a previous explicit
  dismissal (e.g. a hard size gate) and the label disappears without
  a new comment.

Match any bot-authored comment body containing the phrase
`stamphog approval dismissed`, **or** the silent-removal condition
above. On match, set the transient iteration flag
`stamphog_dismissed_on_sha = HEAD_SHA` and log
`[shepherd] step 4 — stamphog dismissal detected on <short_sha>`
(append `(silent label removal)` when the label-state surface
triggered it). Do **not** reply to or resolve the dismissal comment —
Step 6.5 decides what to do about it.

### Step 5: Keep the branch current with its base

```bash
gh pr view <pr_number> --json mergeable,mergeStateStatus
```

If `mergeable == "CONFLICTING"` or `mergeStateStatus` in {`DIRTY`,
`BEHIND`}:

- Fetch and fast-forward the local trunk (base branch) first — do this
  autonomously, no need to ask. Use the Graphite MCP where possible,
  falling back to `git fetch origin <base>` + `git branch -f <base>
  origin/<base>` (or `git checkout <base> && git pull --ff-only`).
- Then use the Graphite MCP to update/restack the PR branch onto the
  refreshed base.
- On success, the HEAD SHA has changed — carry on to Step 6 with the
  new SHA.
- If Graphite reports conflicts it cannot resolve automatically, **try
  to resolve them yourself** before handing back to the user. Do
  **not** terminate on the first conflict — most conflicts with the
  base branch are mechanical and safe to resolve autonomously.

Conflict-resolution sub-workflow:

1. List conflicted files (`git status --porcelain` — look for `UU`,
   `AA`, `DU`, `UD`, `AU`, `UA`).
2. Classify every conflicted file as **trivial** or
   **needs-decision** using the rules below.
3. If **every** conflict is trivial: resolve each in-place, `git add`
   the resolved files, continue the restack (Graphite MCP's continue
   step, or `git rebase --continue` as a fallback), then push. Carry
   on to Step 6 with the new HEAD SHA.
4. If **any** conflict is needs-decision: abort the restack cleanly
   (`git rebase --abort` or the Graphite equivalent), surface the
   file list with a one-line reason per file, and **terminate** —
   hand back to the user.

When in doubt, classify as needs-decision. A short pause is cheaper
than a wrong merge.

**Trivial** (resolve autonomously) — all of these qualify:

- Lockfiles / generated files: `pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json`, `Cargo.lock`, `poetry.lock`, `*.snap`,
  generated schema or codegen output. Resolution: take the base side
  and regenerate with the project's package manager / codegen
  command, or accept the union if regeneration isn't available.
- Non-overlapping edits inside the same hunk — both sides touched
  different lines and only conflicted by textual proximity.
  Resolution: keep both sets of edits, drop the conflict markers.
- Pure import-order, formatting, or whitespace conflicts.
  Resolution: union then let the project's formatter sort it.
- Append-only lists (changelog / `whatsnew` entries, enum members,
  feature-flag lists where both branches appended a new item).
  Resolution: keep both entries.

**Needs-decision** (defer to the user) — any one of these:

- Both sides changed the same logical line(s) with different intent
  (two renames of the same symbol to different names; two different
  edits to the same conditional).
- Resolution requires knowing which behaviour is desired (two
  competing bug fixes, two different refactors of the same function).
- The conflict spans a refactor boundary — e.g. a function moved on
  one side and was edited on the other.
- Any doubt at all — prefer deferring.

### Step 6: Check CI (report only, never gate)

```bash
gh pr checks <pr_number> --json name,state,bucket,link
```

Count buckets and record them for the iteration summary:

- `bucket == "pass"` count
- `bucket == "pending"` count
- `bucket == "fail"` count + names + links

CI state does **not** gate `stamphog`. Stamphog re-reviews on every
push and runs its own evaluation in parallel — there is no value in
waiting for CI to go green before applying the label. A CI failure
is also not a terminal condition for this loop; it gets surfaced in
the summary and the user decides whether to fix it. The shepherd's
job is review-loop management, not CI custody.

Fall through to Step 6.5.

### Step 6.5: Handle stamphog dismissal before re-requesting review

Only runs when `stamphog_dismissed_on_sha == HEAD_SHA` (detected in
Step 4).

Decide automatically or prompt the user:

- **Auto re-apply** when *all* of:
  - `deferred_threads` is empty, and
  - no unresolved actionable qa-swarm or bot threads remain on the
    PR (i.e. every unresolved thread has been classified as NIT and
    resolved, or was never actionable to begin with).

  In that case clear `stamphog_applied_for_sha` (set it to `null`) so
  Step 7 will re-apply the label. Narrate:
  `[shepherd] step 6.5 — stamphog dismissal, clean state, re-requesting review`.

- **Prompt the user** (via `AskUserQuestion`) whenever any
  `deferred_threads` are still open. The human deferred those
  deliberately — re-requesting review now would ignore their
  judgement. Offer two choices:
  1. re-apply `stamphog` now anyway (clear
     `stamphog_applied_for_sha` and fall through to Step 7),
  2. leave it dismissed and **terminate** so the human can handle
     the deferred threads first.

  Narrate:
  `[shepherd] step 6.5 — stamphog dismissal with <n> deferred threads, asking user`.

If `stamphog_dismissed_on_sha` is unset, skip this step entirely and
fall through to Step 7.

### Step 7: Apply `stamphog` once per SHA

Only if `stamphog_applied_for_sha != HEAD_SHA`:

```bash
gh pr edit <pr_number> --add-label stamphog
```

Then set `stamphog_applied_for_sha = HEAD_SHA`. The stamphog review
will appear as new bot comments on the next iteration's Step 4.

If `stamphog_applied_for_sha == HEAD_SHA`, skip — already stamped.

This step is intentionally independent of CI state. Stamphog evaluates
in parallel; there is no benefit to waiting.

### Step 8: Iteration summary and hand-back

Print a one-line **summary** of the iteration (on top of the per-step
narration from earlier):

```
[shepherd] iter done — sha=<short_sha> qa-swarm=<ran|skip> resolved=<n> actioned=<n> deferred=<n> ci=<pass=N pending=N fail=N> stamphog=<applied|already|waiting|dismissed|re-requested>
```

If there are deferred threads, print their file:line and one-line
reason under the status line. If any CI checks are failing, print
their names + links on a separate line (informational — not a
termination).

Then print the four state values so the next caller (the user, or
the `loop` skill) can re-supply them:

```
[shepherd] state — qa_swarm_marker_sha=<sha|null> stamphog_applied_for_sha=<sha|null> deferred_threads=[<id>,...] stamphog_dismissed_on_sha=<sha|null>
```

Hand back to the runner. The skill does not sleep or self-loop. For
hands-off cadence wrap this skill in `/loop` (e.g.
`/loop 5m /pr-shepherd <pr>`); otherwise re-invoke manually when ready
for the next iteration.

## Terminal conditions (stop the loop)

Stop cleanly and print a final summary when **any** of:

- PR is `MERGED` or `CLOSED`.
- A base-branch conflict needs a human decision (see Step 5 rules).
- `stamphog` is already applied for the current SHA, no new bot
  threads have appeared since the last iteration, and the only
  remaining unresolved threads are in `deferred_threads` — nothing
  autonomous left to do (CI state, pass or fail, does not factor in).
- The user interrupts.

CI failures are **not** a terminal condition. They are reported in
the iteration summary and the loop continues — the user decides
whether to investigate. Likewise, ambiguous review findings are
**not** a terminal condition; they go to `deferred_threads` and the
loop keeps polling.

The final summary lists:

- commits pushed (with short SHAs and messages),
- threads resolved (count, grouped by "fixed" / "replied"),
- threads deferred (with file:line and one-line reason each),
- final CI state, label state, and PR merge state.

## Judgement rules for auto-actioning a comment

A thread is **actionable** only if **all** of these hold:

- Severity is HIGH or CRITICAL (or it's a convergent finding across
  reviewers — those carry higher confidence).
- The fix is described concretely enough that a reader knows exactly
  what to change (a specific rename, a missing null check, a typo, a
  forgotten await, an obvious off-by-one).
- The change is localised — a single file, or at most a small set of
  tightly related edits.
- Applying it does not require new design decisions, new dependencies,
  or altering the PR's scope.

Otherwise the thread is either a NIT (auto-resolve with reply) or
**ambiguous** (defer to the user). When in doubt, defer — a nagging
status line is cheaper than a wrong push.

## Dependencies

- `Skill("qa-swarm")` — ships alongside this skill.
- `gh` CLI (repo, pr, api, label commands).
- Graphite MCP for git operations (commit/push/restack). Fall back to
  `gh`/`git` only when Graphite doesn't cover a case.

## Graceful degradation

- **qa-swarm skill missing:** warn and continue with Steps 3–7 (bot
  triage, branch update, CI, label). The shepherd still provides
  value.
- **No PR detected:** prompt the user (see Step 1) to paste a PR
  number/URL or let the shepherd open a PR via `gh pr create`. Only
  stop if the user cancels.
- **User interrupts mid-iteration:** stop at the next natural
  checkpoint and print the final summary.

## Pitfalls observed in the wild

Real things that have gone wrong while running this loop. When you hit
one of these, recognise the pattern and apply the fix below rather than
retrying blindly or terminating.

### Posting fixes via Graphite — `gt submit` "trunk branch is out of date"

After amending a commit on a stacked branch, `gt submit
--no-interactive --no-edit --publish` can refuse with an error along
the lines of *"trunk branch is out of date"*. Two paths forward:

1. Run the Graphite MCP "sync trunk" / "restack" cycle first, then
   retry `gt submit`.
2. If you only need to push the head ref of the current branch and
   nothing else in the stack has shifted, fall back to a direct
   `git push origin <branch>` — it preserves the remote ref without
   requiring trunk to be current locally.

Don't loop on `gt submit` retries — they will keep failing for the same
reason. Choose one of the two paths above and move on.
