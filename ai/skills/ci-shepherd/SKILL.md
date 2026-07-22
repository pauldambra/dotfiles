---
name: ci-shepherd
description: >
  Keeps a PR current with its base, diagnoses failing CI, fixes failures caused
  by the PR, and reruns likely flaky or infrastructure jobs once. Use when the
  user says "/ci-shepherd", "fix CI", "restack this PR", "is my branch
  behind?", "keep this branch current", or "what's CI saying?". Accepts an
  optional PR number or URL. Reads no review or stamphog state.
---

# CI Shepherd

Keeps a PR branch current with its base and actively shepherds failing CI.
Restacks the branch when needed, diagnoses failed leaf jobs, fixes failures
caused by the PR, and reruns likely flaky or infrastructure jobs once. It makes
at most one repair commit per invocation; the next invocation evaluates the
fresh remote CI. Touches no review threads and no `stamphog` label.

## Dual-mode — standalone vs `pr-shepherd` sub-step

This skill runs in two modes. **Standalone is the default.**

- **Standalone** (a human ran `/ci-shepherd`, or it is wrapped in `/loop`):
  resolve the PR yourself, narrate each step, and print a one-shot summary. A
  needs-decision conflict is a clean stop — hand the file list back to the user.
- **As a `pr-shepherd` sub-step** (the invocation carries a sub-step brief with
  supplied inputs and a request to return JSON): the caller supplies the PR
  number, owner/repo, base, and `head_sha_in` — operate against `head_sha_in`,
  do not resolve the PR. **Never call `AskUserQuestion`.** On a needs-decision
  conflict do not prompt — abort the restack cleanly and return
  `restack_needs_decision: true` with the file list; the orchestrator owns the
  hand-back. Do not narrate to the user; collect `[ci]` lines into a `narration`
  array and end with the single structured result in *Step 5*.

GitHub is the source of truth, so either mode is safely restartable.

## Narration — keep the user in the loop

Standalone: before **every** step, emit a short one-line narration. As a
sub-step: emit the same lines into the `narration` array instead of printing.

Format: `[ci] <step> — <what and why>`

Examples:

```
[ci] step 1 — resolving PR from gh pr view
[ci] step 2 — branch is BEHIND, restacking via graphite
[ci] step 2 — restack hit conflicts in pnpm-lock.yaml, src/foo.ts; classifying
[ci] step 2 — pnpm-lock.yaml trivial (regen), src/foo.ts non-overlapping — resolving
[ci] step 2 — resolved 2 conflicts, continuing restack
[ci] step 2 — conflict in src/auth.ts needs a decision (both sides edit getToken) — deferring
[ci] step 3 — CI: 8 pass, 4 pending, 2 fail; gathering failed leaf jobs
[ci] step 4 — typecheck is PR-caused and reproduces locally; repairing
[ci] step 4 — targeted checks pass; committed abc1234 and pushed
[ci] step 4 — chromium shard is likely flaky; rerunning job once
```

Narrate mid-step when a sub-action could take more than a few seconds (a
graphite restack, a push). A silent 30+ second gap is the failure mode.

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
gh pr view <pr_number> --json mergeable,mergeStateStatus
```

If `mergeable == "CONFLICTING"` or `mergeStateStatus` in {`DIRTY`, `BEHIND`}:

- Fetch and fast-forward the local trunk (base branch) first — do this
  autonomously, no need to ask. Use the Graphite MCP where possible, falling
  back to `git fetch origin <base>` + `git branch -f <base> origin/<base>` (or
  `git checkout <base> && git pull --ff-only`).
- Then use the Graphite MCP to update/restack the PR branch onto the refreshed
  base.
- On success, the HEAD SHA has changed — carry on to Step 3 with the new SHA.
- If Graphite reports conflicts it cannot resolve automatically, **try to
  resolve them yourself** before handing back. Do **not** terminate on the first
  conflict — most conflicts with the base branch are mechanical and safe to
  resolve autonomously.

Conflict-resolution sub-workflow:

1. List conflicted files (`git status --porcelain` — look for `UU`, `AA`, `DU`,
   `UD`, `AU`, `UA`).
2. Classify every conflicted file as **trivial** or **needs-decision** using the
   rules below.
3. If **every** conflict is trivial: resolve each in-place, `git add` the
   resolved files, continue the restack (Graphite MCP's continue step, or `git
   rebase --continue` as a fallback), then push. Carry on to Step 3 with the new
   HEAD SHA.
4. If **any** conflict is needs-decision: abort the restack cleanly (`git rebase
   --abort` or the Graphite equivalent), surface the file list with a one-line
   reason per file. Standalone: **terminate** and hand back to the user. As a
   sub-step: return `restack_needs_decision: true` with `restack_decision_files`
   and stop (do not run Step 3).

When in doubt, classify as needs-decision. A short pause is cheaper than a wrong
merge.

**Trivial** (resolve autonomously) — all of these qualify:

- Lockfiles / generated files: `pnpm-lock.yaml`, `yarn.lock`,
  `package-lock.json`, `Cargo.lock`, `poetry.lock`, `*.snap`, generated schema
  or codegen output. Resolution: take the base side and regenerate with the
  project's package manager / codegen command, or accept the union if
  regeneration isn't available.
- Non-overlapping edits inside the same hunk — both sides touched different
  lines and only conflicted by textual proximity. Resolution: keep both sets of
  edits, drop the conflict markers.
- Pure import-order, formatting, or whitespace conflicts. Resolution: union then
  let the project's formatter sort it.
- Append-only lists (changelog / `whatsnew` entries, enum members, feature-flag
  lists where both branches appended a new item). Resolution: keep both entries.

**Needs-decision** (defer to the user) — any one of these:

- Both sides changed the same logical line(s) with different intent (two renames
  of the same symbol to different names; two different edits to the same
  conditional).
- Resolution requires knowing which behaviour is desired (two competing bug
  fixes, two different refactors of the same function).
- The conflict spans a refactor boundary — e.g. a function moved on one side and
  was edited on the other.
- Any doubt at all — prefer deferring.

If the branch is already current (not `CONFLICTING`/`DIRTY`/`BEHIND`), do
nothing here and fall through to Step 3 with the unchanged HEAD.

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
   and push through Graphite. Include the repository's required commit trailers.
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
[ci] done — sha=<short_sha> restacked=<yes|no> repair=<committed|none|blocked> rerun=<N> observed_ci=<pass=N pending=N fail=N>
```

List repaired root causes and their validation commands, queued reruns, and
unresolved/needs-decision failures with one-line evidence. If a restack was
deferred, print the needs-decision file list and stop. Then hand back (wrap in
`/loop` for cadence).

**As a `pr-shepherd` sub-step:** end with exactly this structured result and
nothing after it —

```json
{
  "head_sha_in": "<HEAD when this skill started>",
  "new_head_sha": "<HEAD after restack/repair; == head_sha_in if none>",
  "restacked": false,
  "ci": {"snapshot": "pre_repair", "pass": 0, "pending": 0, "fail": 0, "failing": [{"name": "", "link": ""}]},
  "repair": {
    "attempted": false,
    "committed": false,
    "commit_sha": null,
    "fixed": [{"root_cause": "", "checks": [""], "validation": [""]}],
    "rerun": [{"name": "", "link": "", "job_id": "", "status": "queued|already-retried"}],
    "unresolved": [{"name": "", "link": "", "classification": "unrelated|needs-decision|unresolved", "reason": ""}]
  },
  "restack_needs_decision": false,
  "restack_decision_files": [{"path": "", "reason": ""}],
  "narration": ["<one [ci] line per step taken>"]
}
```

## Terminal conditions (standalone only)

Stop cleanly and print the summary when **any** of:

- PR is `MERGED` or `CLOSED`.
- A base-branch conflict needs a human decision (see Step 2 rules) — hand back
  the file list.
- The branch is current and CI is passing/pending, or every failure has been
  repaired, rerun once, or classified with no autonomous action remaining.
- The user interrupts.

A CI failure must be diagnosed before the run ends normally. A needs-decision or
unresolved failure is a clean hand-back after safe repair/rerun work is exhausted.

## Dependencies

- Graphite MCP for git operations (sync trunk / restack / continue / push). Fall
  back to `gh`/`git` only when Graphite doesn't cover a case.
- `gh` CLI (pr view, pr checks).

## Graceful degradation

- **Graphite MCP unavailable:** fall back to `git fetch` + `git rebase` for the
  restack and `git push` for the push. If even that can't proceed cleanly, warn
  and report CI only.
- **No PR detected (standalone):** print a short note asking the user to pass a
  PR number or URL, then stop.
- **User interrupts mid-run:** stop at the next natural checkpoint and print the
  summary.

## Pitfalls observed in the wild

### Posting via Graphite — `gt submit` "trunk branch is out of date"

After a restack, `gt submit --no-interactive --no-edit --publish` can refuse
with an error along the lines of *"trunk branch is out of date"*. Run the
Graphite MCP "sync trunk" / "restack" cycle first, then retry `gt submit` once.

Stay on Graphite for the push. Do **not** fall back to a raw `git push` (or
`git push --force-with-lease`) after a restack — it bypasses Graphite's
base-branch tracking and can leave the PR pointing at a stale `graphite-base/`
ref instead of the real base. Sync trunk, restack, then `gt submit`; don't loop
on retries.
