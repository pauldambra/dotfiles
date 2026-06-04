---
name: reference_paul_llm_analytics_identity
description: "In project 2 LLM analytics, Paul is identified by person.properties.email, not distinct_id"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 019e8f85-fdd7-744c-9ea8-e2c36ce8be11
---

In PostHog project 2 ("PostHog App + Website") LLM analytics, Paul (paul@posthog.com) is identified by `person.properties.email = 'paul@posthog.com'`, NOT by `distinct_id`. His distinct_id is an opaque token (e.g. `PqMBBFBfKo638PwvjCWTSZ6dnswYzJ3RtH8VIHCBWAy`) and filtering `distinct_id = 'paul@posthog.com'` returns nothing.

When scoping `$ai_generation`/`$ai_embedding` cost or usage queries to "my usage", filter on `person.properties.email`. Person-on-events is enabled so this works directly on the events table.
