---
name: ci-shepherd
description: >
  Keeps a PR's branch current with its base (fast-forward trunk + restack via
  the Graphite MCP, with a trivial-vs-needs-decision conflict-resolution
  sub-workflow) and reports CI state without ever gating on it. Use when the
  user says "/ci-shepherd", "restack this PR", "is my branch behind?", "keep
  this branch current", or "what's CI saying?". Accepts an optional PR number or
  URL as argument. Reads no review or stamphog state.
---

# CI Shepherd

Keeps a PR branch current with its base and reports CI. Restacks the branch when
it falls behind or conflicts, resolving the mechanical conflicts autonomously
and deferring only the ones that need a human decision. Then reports CI status —
**purely informational, never a gate**. Touches no review threads and no
`stamphog` label.

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
  array and end with the single structured result in *Step 4*.

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
[ci] step 3 — CI: 8 pass, 4 pending, 0 fail
```

Narrate mid-step when a sub-action could take more than a few seconds (a
graphite restack, a push). A silent 30+ second gap is the failure mode.

## Workflow

### Step 1: Resolve PR (standalone only)

> Skipped as a `pr-shepherd` sub-step — the caller supplies the PR number,
> owner/repo, base, and `head_sha_in`.

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise:

```bash
gh pr view --json number,headRefName,baseRefName,url,headRefOid,state
gh repo view --json owner,name
```

Record: PR number, owner/repo, base branch, HEAD SHA, PR state. If the PR state
is `MERGED` or `CLOSED`, print that and stop.

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

### Step 3: Check CI (report only, never gate)

```bash
gh pr checks <pr_number> --json name,state,bucket,link
```

Count buckets and record them for the report:

- `bucket == "pass"` count
- `bucket == "pending"` count
- `bucket == "fail"` count + names + links

CI state is **never** a gate and **never** a terminal condition. This skill
reports it; whatever consumes the report (a human, or `pr-shepherd`) decides
what to do. There is no waiting for green here.

Fall through to Step 4.

### Step 4: Report

**Standalone:** print a one-line summary —

```
[ci] done — sha=<short_sha> restacked=<yes|no> ci=<pass=N pending=N fail=N>
```

If any CI checks are failing, print their names + links on a separate line
(informational). If a restack was deferred, print the needs-decision file list
with one-line reasons and stop. Then hand back (wrap in `/loop` for cadence).

**As a `pr-shepherd` sub-step:** end with exactly this structured result and
nothing after it —

```json
{
  "head_sha_in": "<HEAD when this skill started>",
  "new_head_sha": "<HEAD after restack; == head_sha_in if none>",
  "restacked": false,
  "ci": {"pass": 0, "pending": 0, "fail": 0, "failing": [{"name": "", "link": ""}]},
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
- The branch is current and CI has been reported — nothing autonomous left to
  do.
- The user interrupts.

A CI failure is **not** a terminal condition; it is reported and the run ends
normally.

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
with an error along the lines of *"trunk branch is out of date"*. Two paths
forward:

1. Run the Graphite MCP "sync trunk" / "restack" cycle first, then retry `gt
   submit`.
2. If you only need to push the head ref of the current branch and nothing else
   in the stack has shifted, fall back to a direct `git push origin <branch>` —
   it preserves the remote ref without requiring trunk to be current locally.

Don't loop on `gt submit` retries — they will keep failing for the same reason.
Choose one of the two paths above and move on.
