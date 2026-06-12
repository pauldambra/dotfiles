---
description: Shepherd a PR — orchestration on Sonnet, deep reviews on Fable
argument-hint: [pr-number-or-url]
model: sonnet
---

Invoke the `pr-shepherd` skill (via the Skill tool) with `$ARGUMENTS` and follow it.

This command exists only to pin the shepherd's orchestration loop to Sonnet so I
do not have to remember to `/model sonnet` first. The split is preserved:

- The orchestration (PR resolve, qa-swarm decision, stamphog, summary) runs in
  this command's loop, which `model: sonnet` pins to Sonnet.
- Reviews keep their own pins regardless of the calling model — `qa-swarm` runs
  qa-team and security-audit on `fable`, paul-reviewer and xp-reviewer on
  `opus`.
- `review-triage` and `ci-shepherd` already run as `model: sonnet` subagents.

For hands-off cadence: `/loop 5m /shepherd <pr>`.
