---
name: project_pr_shepherd_model_split
description: "How pr-shepherd splits Opus (reviews) vs Sonnet (mechanical), and why the loop must be launched on Sonnet"
metadata: 
  node_type: memory
  type: project
  originSessionId: 019e9368-4d30-704d-afb2-cfbd30e215e7
---

Paul wants pr-shepherd reviews on Opus but mechanical work on Sonnet. The skill (`~/dotfiles/ai/skills/pr-shepherd/SKILL.md`, symlinked into posthog-code plugins) already implements this:

- `review-triage` + `ci-shepherd` are dispatched as `model: 'sonnet'` Agent subagents (Steps 3-4) — pinned, caller-independent.
- `qa-swarm` pins its 4 reviewer agents to `model: 'opus'` regardless of caller (its Step 3 says so explicitly) — reviews stay sharp on a cheaper session.
- The top-level orchestration (PR resolve, qa-swarm decision + coordination, stamphog, summary) runs in the **main loop** and inherits the **session model**. A skill CANNOT switch its own session model, and main-loop SKILL.md does not support a `model:` frontmatter field (only subagent `agents/*.md` defs do).

**Why:** runs were showing 100% Opus main-loop sessions (opus:700+ turns) because the loop session was launched on Opus. The subagents/reviews split was already correct; only the orchestration paid Opus rates needlessly.

**How to apply:** launch the loop session on Sonnet — `/model sonnet` then `/loop 5m /pr-shepherd <pr>`. Reviews still run on Opus automatically. Added a "Run the loop session on Sonnet" section to the skill to document this. Verified via LLMA in project 2 ([[reference_paul_llm_analytics_identity]]) scoped by person.properties.email.
