---
name: reference_stamphog_anthropic_key_auth
description: "stamphog PR-approval agent — ANTHROPIC_API_KEY is an org-level GitHub secret; the opaque SDK error \"Claude Code returned an error result: success\" means CLI auth failed"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 019e7dec-9212-720d-a36a-8932875c906a
---

The `stamphog` label (PR Approval Agent, `tools/pr-approval-agent/`, workflow `.github/workflows/pr-approval-agent.yml`) runs deterministic gates then a Claude Agent SDK review.

When the whole fleet of reviews suddenly fails, suspect the **`STAMPHOG_ANTHROPIC_API_KEY`** GitHub Actions secret first. stamphog uses its own dedicated Anthropic key (org-level secret on the `posthog` org, granted to `PostHog/posthog`), separate from the shared `ANTHROPIC_API_KEY`, so a rotation of the shared key no longer breaks stamphog. The workflow still exposes it to the script under the env var name `ANTHROPIC_API_KEY` (what the SDK reads). All PostHog Actions secrets live at org level — you can't read their metadata without org-admin.

Diagnostic signature of an auth/credentials failure: the SDK raises `Claude Code returned an error result: success` — the bundled `claude` CLI exited non-zero with an empty error payload (`is_error=True`, `subtype` defaulting to "success"). It's instant and 100% reproducible, distinct from a real review verdict. You can't reproduce it on an OAuth-logged-in Mac — the login keychain credentials mask a bad `ANTHROPIC_API_KEY` regardless of `HOME`/config dir.

After the May 2026 incident, an LLM-backend failure returns a distinct `ERROR` verdict that **keeps** the label (instead of stripping it like REFUSE/ESCALATE). The workflow's `Run review` step `success` masks this — check `final_verdict`/`reviewer.issues` in the uploaded `review.json` artifact, not the job conclusion.
