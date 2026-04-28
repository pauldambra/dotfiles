---
name: prompt before bypassing an available skill or tool
description: When a relevant MCP skill/tool is available but I'm tempted to take a different path (raw API, custom script, manual work), stop and ask Paul to decide rather than silently bypassing it.
type: feedback
originSessionId: 019dd411-2426-7408-8202-41d0946ef3f2
---
If a skill or tool is already available that fits the job, default to using it. If I think a different path is better (escaping concerns, missing capability, simpler with raw API, etc.), surface the choice to Paul before acting — don't silently route around the skill.

**Why:** Paul gave this feedback after I uploaded skills to the PostHog skill store via a direct REST POST to `/api/environments/2/llm_skills/` instead of using the discovered `skill-create` MCP tool. My reason was JSON-escape anxiety over a ~10-13KB markdown body inside a doubly-nested JSON command string. Paul's stance: that's a decision for him, not me — bypassing an available skill is a meaningful choice and he wants to weigh in.

**How to apply:** When I notice "there is a skill / MCP tool for X but I'm about to do X another way," pause and ask first. Phrase it as "skill `foo` exists for this; I was going to do `bar` instead because [reason] — okay to skip the skill, or use it?". Applies to skills surfaced in available-skills lists, MCP tools discovered via search, and any deferred tool I've loaded the schema for.
