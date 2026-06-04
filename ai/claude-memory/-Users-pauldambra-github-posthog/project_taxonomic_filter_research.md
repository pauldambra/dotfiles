---
name: project_taxonomic_filter_research
description: Ongoing replay-vision scanner + user-interview research into taxonomic-filter friction (project 2)
metadata: 
  node_type: memory
  type: project
  originSessionId: 019e8c44-94ee-763c-991f-99324e481a23
---

Paul is researching friction in PostHog's taxonomic filter (the events/properties/cohorts picker), in project 2 (PostHog App + Website).

Pipeline set up 2026-06-03:
- Replay vision **classifier scanner** id `019e8d01-4d6d-75d2-a3e2-28df82515bc8` ("Taxonomic filter: success vs struggle"), tags success/struggled/abandoned, triggered on event `taxonomic filter add filter clicked`, 3% sample (~1.5k/mo vs 3000/mo org quota).
- User-interview **topic** id `019e8d53-b2b0-0000-dd12-fdf531d1129c` targeting the 7 struggled/abandoned users found, with per-interviewee context attached.

Early findings (n~19 classified): ~63% success / 32% struggled / 5% abandoned. Recurring friction themes: popover closes on outside-click forcing re-opens; person-property discoverability (users search "email/name/person"); category-tab confusion on breakdowns.

Taxonomic-filter usage is captured via events `taxonomic filter add filter clicked` and `taxonomic filter category selected` (from eventUsageLogic.ts). Nav entry gated by feature flag `replay-vision`.

Session-only cron `7e89853e` polls the scanner every 10 min (dies when that session ends).
