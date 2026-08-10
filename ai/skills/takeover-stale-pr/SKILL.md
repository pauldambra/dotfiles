---
name: takeover-stale-pr
description: >
  Pick up a stale or abandoned PR that someone (often you) started and stopped,
  bring it back to a shippable state, and hand it off to pr-shepherd for the
  active review loop. Use when the user says "take over this PR",
  "takeover and complete this PR", "continue <PR URL>", or pastes a PR URL
  and asks to finish it. Accepts a PR number or URL as argument.
  Distinct from pr-shepherd: the PR is dormant, not in an active review cycle.
---

# Takeover a stale PR

A stale PR is one that was opened, received some work or review, and then
went quiet for days or weeks. The branch is usually behind `master`, there
are unresolved review comments, and CI is red or outdated.

This skill drives the **one-time recovery** needed before handing off to
`pr-shepherd`. Once the branch is current, green, and every outstanding
review comment has been triaged, it calls `pr-shepherd` and exits.

## Narration — one line per step

Emit a short line before each step so the user can follow progress:

```
[takeover] step 1 — resolving PR #53004
[takeover] step 2 — branch is BEHIND master by 142 commits, updating from base
[takeover] step 3 — 4 unresolved review threads, 1 actionable, 2 nit, 1 ambiguous
[takeover] step 4 — running hogli test --changed
[takeover] step 5 — handing off to pr-shepherd
```

## Workflow

### Step 1: Resolve the PR and pull it down

Parse `$ARGUMENTS` as a PR number or URL. If unset or unparseable, ask the
user for one and stop.

```bash
gh pr view <pr_number> --json number,headRefName,baseRefName,url,headRefOid,state,author,mergeStateStatus,title
gh repo view --json owner,name
```

Stop immediately if:

- PR state is `MERGED` or `CLOSED` — nothing to take over.
- The branch author is not the current user AND there is no visible signal
  they've abandoned it (recent commits, active reviews). Ask the user to
  confirm they intend to take it over before proceeding.

Check out the PR branch locally with `gh pr checkout <pr_number>`.

### Step 2: Bring the branch up to date with its base

```bash
gh pr view <pr_number> --json mergeable,mergeStateStatus \
  --jq '{mergeable, status: .mergeStateStatus}'
```

If `status` is `BEHIND`, run `gh pr update-branch <pr_number>` to merge the
current base (usually `master`) into the PR branch, then `git fetch` and
fast-forward the local branch (`git merge --ff-only @{u}`). The HEAD SHA has
changed — re-read it with `gh pr view --json headRefOid`.

If `mergeable == "CONFLICTING"` or `status` is `DIRTY`, the branch conflicts
with its base and `update-branch` cannot merge through it:

1. Print the conflicting files.
2. **Stop.** Ask the user to resolve, then rerun this skill.

A clean base is the whole point of the takeover — do not push broken merges.

### Step 3: Triage unresolved review threads

Fetch all unresolved review threads (same GraphQL query as `review-triage`
Step 3). For each thread:

Classify as **Actionable**, **NIT / non-actionable**, or **Ambiguous**,
using the same judgement rules documented in `review-triage` §"Judgement
rules for auto-actioning a comment" — including its human-participation
gate: a thread a real person authored or replied in is deferred, never
auto-fixed and never auto-resolved. The thresholds are identical — do not
re-derive them here.

**This skill never posts a comment to GitHub.** It never replies to a
thread — not a human's (responses to humans come from the PR author), not a
bot's. Threads it acts on are resolved silently; the reasoning lives in the
final summary instead of in-thread.

Handle each class:

- **Actionable** — apply the edit, commit with a message like
  `fix: address stale review comment <short summary>`, `git push`, then
  resolve the thread — no reply; the commit SHA and a one-line description
  go in the final summary.
- **NIT** — resolve the thread — no reply; record the one-line reason
  ("intentional — <reason>" / "out of scope" / "disagree — <reason>") in
  the final summary.
- **Ambiguous** — leave unresolved. Surface in the final summary as
  "needs-human".

### Step 4: Sanity-check the branch

Run the impacted test set to confirm the base update didn't break anything
obvious:

```bash
hogli test --changed
```

If tests fail:

- Print the failing tests.
- **Stop.** Ask the user how to proceed. A stale-PR takeover is the wrong
  moment to guess at test repairs.

If tests pass (or the repo doesn't support `hogli`), continue.

### Step 5: Hand off to pr-shepherd

At this point:

- Branch is up to date with `master`.
- Conflicts are resolved.
- Each unresolved review thread is either resolved or explicitly deferred.
- Impacted tests pass.

Print a short handoff summary:

```
[takeover] complete — sha=<short_sha> resolved=<n> deferred=<n>
[takeover] handing off to pr-shepherd to run the active review loop
```

Then invoke `Skill("pr-shepherd", args="<pr_number>")` and exit. The
shepherd takes over from here and owns the ongoing qa-swarm / CI /
stamphog loop.

## Terminal conditions (stop cleanly, do not hand off)

- PR is merged or closed.
- The branch conflicts with its base and needs manual resolution.
- Test suite fails after the base update.
- More than **3** review threads are classified ambiguous — the PR needs
  a real human conversation, not a shepherd. Print them and stop.
- The user interrupts.

Always print a final summary before stopping: commits pushed, threads
resolved, threads deferred, reason for stopping.

## Final summary format

```
[takeover] done
  branch:   <branch> @ <short_sha>
  base:     <updated|current|conflict>
  commits:  <n pushed> (<short_sha> <message>, ...)
  threads:  <resolved>/<deferred>
  tests:    <passed|failed|skipped>
  next:     <handed off to pr-shepherd|needs human — <reason>>
```

## Dependencies

- `git` for commit/push; `gh` CLI for PR checkout, metadata, `pr
  update-branch`, and review-thread GraphQL.
- `hogli test --changed` when working inside the posthog monorepo.
- `Skill("pr-shepherd")` for the active review loop.

## Graceful degradation

- **No `hogli`:** skip the changed-tests step, surface that the branch was
  not test-verified in the handoff summary.
- **No pr-shepherd skill:** stop at end of Step 4 and print the handoff
  summary as a manual checklist for the user.
