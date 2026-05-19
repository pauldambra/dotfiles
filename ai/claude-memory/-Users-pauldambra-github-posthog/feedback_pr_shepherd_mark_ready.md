---
name: pr-shepherd marks draft PRs ready
description: When running pr-shepherd, mark draft PRs as ready for review automatically before starting the loop
type: feedback
originSessionId: 019df720-573c-72ae-a9c6-d4930ac76485
---
When the user invokes `/user-skills:pr-shepherd` (or asks to shepherd a PR) and the PR is in draft state, mark it ready for review (`gh pr ready <num>`) and proceed with the loop. Do not stop early just because the PR is draft.

**Why:** The user explicitly asked for this on 2026-05-05 — invoking pr-shepherd is itself the signal that the PR is ready for stamphog/autonomous review. Stopping silently because of draft state was annoying.

**How to apply:** In Step 1 of pr-shepherd, if `isDraft == true`, call `gh pr ready <num>` then continue Steps 2–8 normally. Narrate the action (e.g. `[shepherd] step 1 — PR is draft, marking ready before continuing`).
