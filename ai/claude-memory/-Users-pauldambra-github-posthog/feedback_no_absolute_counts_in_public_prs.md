---
name: No absolute production counts in PostHog PR descriptions
description: PostHog/posthog is a public OSS repo; PR descriptions and commit messages must justify decisions with percentages or ratios, not absolute production counts (events, users, revenue, etc.)
type: feedback
originSessionId: 019e26e7-dc22-745f-8cf2-4430748b2e2e
---
In PR descriptions and commit messages on PostHog/posthog (public OSS repo), justify decisions with **percentages or ratios**, not absolute production counts. Drop raw event counts, user counts, revenue figures, and similar operational scale numbers. Aggregates ("84% bounce", "0.9% return on 5+ days", "1000x more traffic") are fine; "13,959 clicks / 8,360 users / 73 returners" is not.

**Why:** The repo is public. CLAUDE.md explicitly forbids leaking private operational scale; absolute counts from production telemetry give competitors / observers a snapshot of dogfood-project usage and, by inference, customer-base activity. Paul reinforced this after I posted an initial v1 of the saved-insights Home tab removal PR (#58612) with raw 30-day click/user/returning-user numbers from project 2 — he asked me to swap them for percentages on the v2. Same data internally, much safer publicly.

**How to apply:** When writing PR descriptions, agent-context sections, or commit messages that cite telemetry to justify a decision, convert every absolute count to a percentage of an unstated denominator before posting. Keep the absolute numbers in agent-internal context (e.g. `/Users/pauldambra/Documents/*.md` saved files) where useful, but never in anything that goes through `gh pr create`, `gh pr edit --body`, `gh issue create`, or any commit message. If a percentage doesn't carry the point on its own, restructure the framing rather than reaching for the raw number ("most users bounce" + "~1% are habitual" beats "8,360 users / 73 returners"). Same rule applies to revenue: percentages and ratios OK, dollar amounts and customer counts not.
