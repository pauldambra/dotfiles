---
name: never give time estimates for tasks
description: Don't use phrases like "one-day change" or "~1 hour" for task sizing; estimate by complexity (LOC, files touched, surface area) instead
type: feedback
originSessionId: 019db84a-451a-73b2-bf31-9bae13bb1e08
---
Never give time estimates for tasks. Avoid phrases like "this is a one-day change", "~1 hour of work", "quick fix", "couple of days", or comparisons framed in time ("the refactor takes longer than the patch").

**Why:** My training comes from humans talking about how long things take humans. I don't work at human speed, and the user can't usefully act on time estimates from me. They sound authoritative but aren't grounded in anything real.

**How to apply:** When sizing work, describe complexity instead:
- lines of code or files touched
- number of call sites that need to change
- whether the change is local vs cross-cutting
- whether it needs perf benchmarking, schema migration, coordinated rollout, etc.
- surface area of user-visible behaviour that could regress

Concrete examples of substitutions:
- ❌ "this is a one-day change" → ✅ "three call sites, one hook signature change, no perf-sensitive paths"
- ❌ "~1 hour of tooling" → ✅ "small CDP helper script, one new method to add"
- ❌ "quick fix vs big refactor" → ✅ "one-line patch vs touching N files and the public API of the hook"
