---
name: Use Graphite MCP for git operations on stacks
description: Always use Graphite MCP tools (gt commands) instead of raw git for any operations on Graphite-managed branches/stacks
type: feedback
originSessionId: 019e3299-0a68-70b4-a3cd-85cbb0e90648
---
Always use the Graphite MCP (`mcp__graphite__run_gt_cmd`) for all git operations on Graphite-managed branches and stacks — including rebasing, pushing, and restacking.

**Why:** Raw git commands (rebase, push --force-with-lease) bypass Graphite's branch metadata and base-branch tracking, which caused a PR to end up with a stale `graphite-base/` ref instead of being properly retargeted to master.

**How to apply:** Whenever working with branches that are part of a Graphite stack (identifiable by Graphite branch naming or `gt state` output), use `gt restack`, `gt submit`, `gt sync`, etc. instead of `git rebase`, `git push`, etc. **Including force-pushes after a restack — that's `gt submit`, not `git push --force-with-lease`.** Only fall back to raw git if a specific gt command is genuinely unavailable for the operation.
