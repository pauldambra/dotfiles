---
name: Use Graphite MCP for git operations on stacks
description: Always use Graphite MCP tools (gt commands) instead of raw git for any operations on Graphite-managed branches/stacks
type: feedback
---

Always use the Graphite MCP (`mcp__graphite__run_gt_cmd`) for all git operations on Graphite-managed branches and stacks — including rebasing, pushing, and restacking.

**Why:** Raw git commands (rebase, push --force-with-lease) bypass Graphite's branch metadata and base-branch tracking, which caused a PR to end up with a stale `graphite-base/` ref instead of being properly retargeted to master.

**How to apply:** Whenever working with branches that are part of a Graphite stack (identifiable by Graphite branch naming or `gt state` output), use `gt restack`, `gt submit`, `gt sync`, etc. instead of `git rebase`, `git push`, etc. Only fall back to raw git if a specific gt command is unavailable for the operation.
