---
name: PostHog $pageview is auth-only on us/eu.posthog.com
description: $pageview events captured on PostHog's own app (us.posthog.com / eu.posthog.com) only fire for authenticated users
type: project
originSessionId: 019e6024-2562-71fc-b2a5-e5099f69a197
---
`$pageview` events in project 2 (and its EU twin) only fire for authenticated PostHog users. Login pages, signup pages, and any other unauthenticated traffic to us.posthog.com / eu.posthog.com do not capture `$pageview`.

**Why:** PostHog dogfoods its own SDK and the instrumentation is gated so only authenticated sessions are tracked. This keeps the data set focused on actual customer usage.

**How to apply:** When analyzing PostHog usage data (project 2), `$pageview`-based cohorts and active-user counts can be treated as authenticated-PostHog-user counts. Do not caveat them as "noisy from unauthenticated traffic" — that's wrong. The same probably applies to most analytics events on the PostHog app since they all run in the same auth-gated context.
