---
name: reference_posthog_skill_store_writes
description: "How to write skills to the PostHog skill store (llma-skill-*) reliably — do it from the main session, not sub-agents, and escape bodies with jq"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 019e8e87-514e-7288-9054-dd5ee99a0023
---

Writing to the PostHog skill store (the `llma-skill-*` tools, routed through `mcp__posthog__exec`):

- **Do store writes from the MAIN session, not a sub-agent.** Sub-agents spawned via the Agent tool do NOT inherit the PostHog MCP interactive auth — `llma-skill-create/update` calls from a sub-agent fail with `401 Authentication required` (observed: a sub-agent burned ~12 min then 401'd). The main session's auth works. Read-only/local work (Read, Bash, jq) can still be delegated.
- **`exec` uses strict `JSON.parse` — it rejects literal newlines inside string values** ("Bad control character in string literal"). Never hand-escape multi-KB bodies. Build the payload with `jq` (write the text to a temp file via heredoc/Write, then `jq --rawfile`), and pass the jq output as the `call <tool> <json>` argument. Structural (between-token) newlines from pretty-print are fine; only newlines *inside* strings must be `\n`.
- **Prefer `edits` (find/replace) over full-body replace** for surgical changes: smaller payload to emit, and it FAILS SAFE — a non-matching/non-unique `old` is rejected rather than silently corrupting. Each `old` must match the store body exactly once. Always pass `base_version` (get the current `version` from `llma-skill-get` or the previous write's response).
- The store `body` field excludes YAML frontmatter (name/description are separate fields); the store also strips one trailing newline, so a `wc -c` parity check vs the local SKILL.md body will differ by 1.
- The shepherd-family skills (`pr-shepherd` v6+, `review-triage` v2+, `ci-shepherd`) are published here and mirror the dotfiles `ai/skills/<name>/SKILL.md` sources. See [[reference_dotfiles_skill_deploy]] for how local skills deploy. Tooling guidance lives in the `working-with-skills` skill.
