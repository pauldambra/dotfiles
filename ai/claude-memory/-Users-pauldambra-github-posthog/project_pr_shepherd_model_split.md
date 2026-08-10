---
name: project_pr_shepherd_model_split
description: "How pr-shepherd tiers models — mechanical subagents pinned to Sonnet, reviews cheap-first behind a GLM-5.2 router — and why the loop must be launched on GLM-5.2"
metadata: 
  node_type: memory
  type: project
  originSessionId: 019e9368-4d30-704d-afb2-cfbd30e215e7
---

Paul wants pr-shepherd's mechanical work cheap and its reviews cheap-first, escalating only when the change warrants it. The skill (`~/dotfiles/ai/skills/pr-shepherd/SKILL.md`, symlinked into posthog-code plugins and published to the PostHog skill store) implements this:

- `review-triage`, `ci-shepherd`, and `simplify` are dispatched as `model: 'sonnet'` Agent subagents — pinned, caller-independent.
- `qa-swarm` does **cheap-first review**: a single router reviewer on `@cf/zai-org/glm-5.2` takes the first pass and decides whether to delegate part or all of the review to a stronger model (`opus`/`fable`, soon `gpt-sol`/`kimi-k3`) based on the change's danger/complexity. Low-danger diffs can run entirely on the router — that's the saving. If the harness rejects the non-Claude model string on a subagent, qa-swarm omits the pin and the router inherits the session model.
- The top-level orchestration (PR resolve, quality-loop rounds, qa-swarm coordination, stamphog, summary) runs in the **main loop** and inherits the **session model**. A skill CANNOT switch its own session model, and main-loop SKILL.md does not support a `model:` frontmatter field (only subagent `agents/*.md` defs do).

**Why:** the orchestration — and the router when its pin falls back to inheritance — both pay the session model's rate, so launching the session on an expensive model wastes money on turns that need no deep reasoning. Originally spotted as 100% Opus main-loop sessions (opus:700+ turns) when the loop was launched on Opus; the subagent split was already correct, only the orchestration was overpaying.

**How to apply:** launch the loop session on GLM-5.2 — `/model @cf/zai-org/glm-5.2` then `/loop 5m /pr-shepherd <pr>`. Reviews still escalate to fable/opus automatically when the router judges the change worth it. On a Sonnet session the subagent pins still hold, but the orchestration and router-inheritance fallback pay Sonnet rates instead. Verified via LLMA in project 2 ([[reference_paul_llm_analytics_identity]]) scoped by person.properties.email.
