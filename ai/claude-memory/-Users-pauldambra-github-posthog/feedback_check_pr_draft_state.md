---
name: Check PR draft state before applying stamphog
description: stamphog/PR Approval Agent workflow silently skips on draft PRs — verify isDraft=false before adding the label or expecting an automated review
type: feedback
originSessionId: 019dc8f8-ce6d-7265-8fe4-e0b002488706
---
When applying the `stamphog` label or running pr-shepherd, **first verify `gh pr view <n> --json isDraft` returns `false`**. If the PR is a draft, run `gh pr ready <n>` before (or instead of) adding the label.

**Why:** The `.github/workflows/pr-approval-agent.yml` job condition is gated on `!github.event.pull_request.draft`. On a draft PR the workflow run is created on `labeled`/`synchronize` events but every job is skipped at the if-gate, with no comment, no failure, and no log output beyond `Result: false` in the job's `system.txt`. From the outside it looks identical to "stamphog hasn't run yet" — you'll wait indefinitely. Observed on PR #56366 (2026-04-26): label sat for ~17 min on a draft PR with two `labeled` events firing skipped runs before `gh pr ready` flipped `pull_request.draft` to false and the next event finally satisfied the gate.

**How to apply:** In pr-shepherd Step 7 (and any time you're about to `gh pr edit --add-label stamphog`), include `isDraft` in the `gh pr view --json` query and refuse to add the label when draft is true — instead either prompt the user to flip ready, or auto-run `gh pr ready` (the user has indicated this is the intended state when they say "open a PR"). When investigating "stamphog applied but no review", check the workflow run's `review/system.txt` log for `Expanded: ...!true...` — that's the draft-flag tell. Note: `gh pr create` in this repo defaults to draft, so PRs the shepherd opens via the no-PR fallback in Step 1 are likely to land as drafts.
