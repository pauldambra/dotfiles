---
name: drop commits that only touch frontend/snapshots.yml
description: When adopting/rebasing a PR, filter out any commits whose only changed file is frontend/snapshots.yml
type: feedback
originSessionId: 019db968-da76-7219-ad3a-572494e1cec7
---
When adopting another author's PR (checking out, rebasing onto master, pushing), drop any commit whose diff touches **only** `frontend/snapshots.yml`.

**Why:** `frontend/snapshots.yml` is updated by the visual-review / Pixelhog workflow automatically. Commits that only touch it are bot churn and should not be carried forward into a human-reviewed history when adopting a PR.

**How to apply:**
- Before rebasing, enumerate the PR's commits (`git log <merge-base>..<branch> --name-only`) and identify any whose sole changed file is `frontend/snapshots.yml`.
- During the rebase, drop those commits (interactive rebase `drop`, or pass `--exec` / git-filter / `gt` equivalent).
- After the rebase, verify no such commit remains: `git log master..HEAD --name-only | awk` check.
- If there are none in the PR (as in PR #55324), still keep the filter in the plan as a defensive step so it's applied consistently.
