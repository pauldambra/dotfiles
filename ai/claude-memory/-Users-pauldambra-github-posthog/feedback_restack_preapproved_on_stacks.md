---
name: feedback_restack_preapproved_on_stacks
description: "When working on a Graphite stack, restacking is pre-approved — don't ask before gt restack/submit to propagate base changes upstack"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 019e89aa-0b8f-718f-b07d-26c7e0ce1802
---

When working on a Graphite stack, restacking is pre-approved. Don't ask before running `gt restack` (and the follow-up `gt submit`) to propagate a base-branch change up to the dependent branches — just do it.

**Why:** Paul confirmed this explicitly after I fixed CI on the base of a stack and asked whether to restack the upstack PRs. On a stack, propagating base fixes upward is the expected, routine move.

**How to apply:** After committing a fix to a lower branch in a tracked stack, run `gt restack` then `gt submit` to update the dependent branches without pausing for confirmation. Relates to [[feedback_use_graphite_mcp]].
