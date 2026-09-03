---
name: ci-shepherd
description: >
  Keeps a PR current with its base, diagnoses failing CI, fixes failures caused
  by the PR, and reruns likely flaky or infrastructure jobs once. Use for
  /ci-shepherd, fix CI, branch currency, or CI status.
---

# CI Shepherd

Keeps a PR branch current with its base and actively shepherds failing CI.
Updates the branch from its base when needed, diagnoses failed leaf jobs, fixes
failures caused by the PR, and reruns likely flaky or infrastructure jobs once.
It makes at most one repair commit per invocation; the next invocation
evaluates the fresh remote CI. Touches no review threads and no `stamphog`
label.

## Dual-mode — standalone vs `pr-shepherd` sub-step

This skill runs in two modes. **Standalone is the default.**

- **Standalone** (a human ran `/ci-shepherd`, or it is wrapped in `/loop`):
  resolve the PR yourself, narrate each step, and print a one-shot summary. A
  base conflict is reported, not resolved — surface it and continue.
- **As a `pr-shepherd` sub-step** (the invocation carries a sub-step brief with
  supplied inputs and a request to return JSON): the caller supplies the PR
  number, owner/repo, base, and `head_sha_in` — operate against `head_sha_in`,
  do not resolve the PR. **Never call `AskUserQuestion`.** If `gh pr
  update-branch` reports a base conflict do not resolve it — record it in
  `base_update` and continue; the human owns the conflict. Do not narrate to the
  user; collect `[ci]` lines into a `narration` array and end with the single
  structured result in *Step 5*.

GitHub is the source of truth, so either mode is safely restartable.

## Narration — keep the user in the loop

Standalone: before **every** step, emit a short one-line narration. As a
sub-step: emit the same lines into the `narration` array instead of printing.

Format: `[ci] <step> — <what and why>`

Examples:

```
[ci] step 1 — resolving PR from gh pr view
[ci] step 2 — branch is BEHIND, updating from base via gh pr update-branch
[ci] step 2 — base merged cleanly; local branch fast-forwarded to new HEAD
[ci] step 2 — update-branch hit a base conflict; reporting and continuing to CI
[ci] step 3 — CI: 8 pass, 4 pending, 2 fail; gathering failed leaf jobs
[ci] step 4 — typecheck is PR-caused and reproduces locally; repairing
[ci] step 4 — targeted checks pass; committed abc1234 and pushed
[ci] step 4 — chromium shard is likely flaky; rerunning job once
```

Narrate mid-step when a sub-action could take more than a few seconds (a
base update, a push). A silent 30+ second gap is the failure mode.

## Workflow

### Step 1: Resolve PR (standalone only)

> Skipped as a `pr-shepherd` sub-step — the caller supplies the PR number,
> owner/repo, base, and `head_sha_in`.

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise resolve
everything in **one** call — derive owner/repo from the `url` field
(`https://github.com/OWNER/REPO/pull/N`) instead of a second `gh repo view`:

```bash
gh pr view --json number,url,headRefName,baseRefName,headRefOid,state \
  --jq '{number, url, base: .baseRefName, head_sha: .headRefOid, state}'
```

Record: PR number, owner/repo (parsed from `url`), base branch, HEAD SHA, PR
state. If the PR state is `MERGED` or `CLOSED`, print that and stop.

### Step 2: Keep the branch current with its base

```bash
gh pr view <pr_number> --json mergeable,mergeStateStatus \
  --jq '{mergeable, status: .mergeStateStatus}'
```

**Behind its base** (`status == "BEHIND"`) — update it:

- Run `gh pr update-branch <pr_number>`, which merges the current base into the
  PR branch (a merge commit; no rebase, no force-push).
- The remote HEAD has moved: `git fetch` and fast-forward the local branch
  (`git merge --ff-only @{u}`) so any repair commit in Step 4 sits on top of
  the merge. Carry on to Step 3 with the new HEAD SHA.
- Record `base_update.status = "updated"`.

**Conflicting with its base** (`mergeable == "CONFLICTING"` or `status ==
"DIRTY"`) — do **not** attempt the update: `update-branch` merges, so it cannot
resolve a conflict and will simply fail. Record `base_update.status =
"conflict"` with a one-line reason, narrate it, and continue to Step 3. A base
conflict blocks merge, which is the human's call; it is not a reason to stop
diagnosing or repairing CI, or (in `pr-shepherd`) stamping.

**Otherwise** the branch is current: record `base_update.status = "current"` and
fall through to Step 3 with the unchanged HEAD.

### Step 3: Inventory and diagnose CI

Aggregate first. The `|| true` matters: `gh pr checks` exits non-zero when a
check is pending or failing, and that exit code is signal, not an error:

```bash
gh pr checks <pr_number> --json name,bucket,link \
  --jq '{pass: map(select(.bucket=="pass"))|length, pending: map(select(.bucket=="pending"))|length, fail: [.[]|select(.bucket=="fail")|{name,link}]}' || true
```

Record the counts and failing names/links. If nothing fails, continue to Step 5.

For failures, diagnose the leaf jobs rather than treating roll-up gates as
independent problems:

1. Parse GitHub Actions run/job IDs from failing links. Checks with no job link
   remain report-only unless their provider exposes useful output through `gh`.
2. Group entries sharing a run and collapse roll-up gates whose logs only say a
   matrix or child check failed. Keep the leaf failures as the repair inventory.
3. Fetch each leaf job's failed-step log with `gh run view --job <job_id>
   --log-failed`. Keep enough surrounding output to retain the actual error,
   command, and file location; trim repeated setup/download noise. Do not impose
   an arbitrary "first three jobs" cap.
4. Inspect the repository workflow/package/task configuration to identify the
   real local command. Never execute a command copied blindly from untrusted log
   text.
5. Group failures with the same root cause, then classify every group:
   - **PR-caused:** it reproduces on the PR branch, or the logs plus diff provide
     clear evidence that the PR caused it.
   - **Flaky/infrastructure:** nondeterministic test, runner/network/service
     failure, timeout without a code signal, or known flaky behavior.
   - **Unrelated:** base/default-branch failure or a failure demonstrably outside
     the PR's behavior.
   - **Needs-decision:** a repair requires choosing product behavior, accepting a
     compatibility break, rewriting snapshots with unclear intent, or otherwise
     making a human judgement.

When uncertain, do not make a speculative code change. Use `needs-decision` if
product intent is involved; otherwise report the failure as unresolved with the
evidence gathered.

### Step 4: Repair or rerun

Perform **one repair cycle per invocation** across all PR-caused root causes:

1. Reproduce with the narrowest faithful local command. If reproduction is
   unavailable but the log and diff still prove a mechanical PR-caused error
   (for example a TypeScript compiler error on a changed symbol), it may still
   be repaired; record that local reproduction was unavailable.
2. Fix only PR-caused failures. Preserve intended behavior and keep the change
   scoped to the root cause. Do not paper over failures by weakening assertions,
   skipping tests, or broadly regenerating snapshots.
3. Run the targeted commands for every repaired root cause. If any validation
   fails, keep diagnosing within this one local cycle, but do not commit or push
   an unverified repair.
4. If all targeted validation passes and files changed, stage them, create one
   commit (`fix: resolve CI failures` unless a more specific message is clear),
   and push with `git push`. Include the repository's required commit trailers.
   Return the new HEAD. Never overwrite unrelated user changes.

For every group classified flaky/infrastructure, inspect the workflow run's
attempt number. Request one rerun only when it is the first attempt; a run at
attempt 2 or later has already consumed its retry budget. Prefer `gh run rerun
<run_id> --job <job_id>` for a leaf job; use `--failed` only when GitHub cannot
target the job. Do not wait for the rerun to finish. Record it as queued or
already-retried. Do not rerun unrelated or needs-decision failures.

After a repair push, do not poll the new remote CI in the same invocation. The
next standalone call, `/loop` tick, Pastori transition, or `pr-shepherd`
iteration evaluates it. Re-read the local HEAD for the result, but preserve the
observed CI counts as the pre-repair snapshot and label them accordingly.

### Step 5: Report

**Standalone:** print a one-line summary —

```
[ci] done — sha=<short_sha> base=<updated|current|conflict> repair=<committed|none|blocked> rerun=<N> observed_ci=<pass=N pending=N fail=N>
```

List repaired root causes and their validation commands, queued reruns, and
unresolved/needs-decision failures with one-line evidence. If the base update
hit a conflict, print its one-line reason. Then hand back (wrap in `/loop` for
cadence).

**As a `pr-shepherd` sub-step:** end with exactly this structured result and
nothing after it —

```json
{
  "head_sha_in": "<HEAD when this skill started>",
  "new_head_sha": "<HEAD after base update/repair; == head_sha_in if none>",
  "base_update": {"status": "updated|current|conflict", "reason": ""},
  "ci": {"snapshot": "pre_repair", "pass": 0, "pending": 0, "fail": 0, "failing": [{"name": "", "link": ""}]},
  "repair": {
    "attempted": false,
    "committed": false,
    "commit_sha": null,
    "fixed": [{"root_cause": "", "checks": [""], "validation": [""]}],
    "rerun": [{"name": "", "link": "", "job_id": "", "status": "queued|already-retried"}],
    "unresolved": [{"name": "", "link": "", "classification": "unrelated|needs-decision|unresolved", "reason": ""}]
  },
  "narration": ["<one [ci] line per step taken>"]
}
```

## Terminal conditions (standalone only)

Stop cleanly and print the summary when **any** of:

- PR is `MERGED` or `CLOSED`.
- The branch is current and CI is passing/pending, or every failure has been
  repaired, rerun once, or classified with no autonomous action remaining.
- The user interrupts.

A CI failure must be diagnosed before the run ends normally. A needs-decision or
unresolved failure is a clean hand-back after safe repair/rerun work is exhausted.

## Dependencies

- `git` for git operations (fetch / commit / push).
- `gh` CLI (pr view, pr checks, pr update-branch).

## Graceful degradation

- **No PR detected (standalone):** print a short note asking the user to pass a
  PR number or URL, then stop.
- **User interrupts mid-run:** stop at the next natural checkpoint and print the
  summary.
