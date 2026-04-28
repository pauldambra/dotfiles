---
name: Prefer listeners over kea-subscriptions
description: In kea logics, prefer listeners (or afterMount + propsChanged for prop-derived values) over kea-subscriptions
type: feedback
originSessionId: 019dc049-33ca-7669-b7c5-f9bb60ea6dbc
---
In PostHog kea logics, prefer `listeners` over `kea-subscriptions`. When the
value comes from props rather than an action, use `afterMount` for the initial
fire and `propsChanged` for updates — both run in the kea event loop without
the extra redux-subscription overhead.

**Why:** kea-subscriptions install a redux subscription that re-runs on every
dispatch and ends up slower than listener-based reactions. The user
explicitly called this out as a project-wide preference, not just one file.

**How to apply:** when reaching for `subscriptions(...)` to react to a value,
ask first whether a listener on the action that changed it (or
`afterMount`/`propsChanged` for prop-derived values) covers the same case.
Only fall back to `kea-subscriptions` if there's truly no other hook.
