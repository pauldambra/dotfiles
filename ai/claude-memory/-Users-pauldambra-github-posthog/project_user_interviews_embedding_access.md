---
name: user_interviews embedding access — team-only isolation, no per-scope RBAC
description: Product decision (2026-05-14) on who can read user_interviews transcript/summary content via the document_embeddings HogQL surface.
type: project
originSessionId: 019e2781-d042-7345-a69e-2cc4fcc3cd08
---
For user_interviews transcripts and summaries written to `document_embeddings`,
team membership is the only enforced isolation. Anyone on a team with `query:read`
can read that team's interview content directly via HogQL
(`SELECT content FROM document_embeddings WHERE product = 'user_interviews'`),
even without `user_interview:read`. Cross-team access is *not* allowed and is
enforced by `team_id` filtering on the table.

**Why:** matches the existing pattern for signals and error_tracking (both
already store raw text in `document_embeddings`). Per-scope redaction at the
HogQL layer would need a platform-level change, not a per-product one. The
product owner explicitly accepted this trade-off when veria-ai flagged it on
PR #58599 — within-team visibility for analytics-token holders is fine; the
real boundary that matters is cross-team.

**How to apply:** if a future reviewer flags HogQL-readable interview content
under `query:read` as a leak, point them here — it's a known and accepted
trade-off, not a missed control. If platform-level HogQL row-level scope
filtering ever lands, that's the moment to revisit; we don't need to do it
product-by-product first.
