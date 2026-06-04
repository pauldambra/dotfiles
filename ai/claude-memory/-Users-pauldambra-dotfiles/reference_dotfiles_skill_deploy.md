---
name: reference_dotfiles_skill_deploy
description: How dotfiles skills deploy to ~/.claude/skills and the worktree gotcha when editing them
metadata: 
  node_type: memory
  type: reference
  originSessionId: 019e8e87-514e-7288-9054-dd5ee99a0023
---

Local Claude skills live in `~/dotfiles/ai/skills/<name>/SKILL.md` and deploy to `~/.claude/skills/` via per-skill symlinks created by `~/dotfiles/ai/install` (loops over `ai/skills/*` and symlinks every dir that contains a `SKILL.md`).

- **New skill dirs auto-deploy**: create `ai/skills/<name>/SKILL.md`, then re-run `ai/install` to create the `~/.claude/skills/<name>` symlink. No manual linking. (`ai/install` is run directly — `script/install` only runs `*.sh` installers, and this file is named `install`.)
- The symlinks point at the **main checkout** `/Users/pauldambra/dotfiles`, NOT at git worktrees. So when editing a skill inside a worktree (e.g. `~/.posthog-code/worktrees/NNNN/dotfiles`), the live `~/.claude/skills/*` keep the main-checkout version until the change lands there. To make edits live: push/merge to `main`, then `git -C ~/dotfiles merge --ff-only origin/main`, then (for brand-new skills) re-run `ai/install`. Existing-skill edits go live on the ff alone; only new skills need the extra symlink.
- A shared `_shared/` dir across sibling skills is NOT viable: the installer only symlinks dirs containing a `SKILL.md`, so a `_shared/` dir is unreachable at `~/.claude/skills/`. Cross-skill content is handled by ownership/duplication, or by reading a sibling skill's own file (e.g. `~/.claude/skills/<name>/SKILL.md`), the way qa-swarm loads its reviewers.
- Commits in this repo are SSH-signed via the 1Password agent (`op-ssh-sign`, `commit.gpgsign true`). If a commit fails with "1Password: agent returned an error / failed to write commit object", the agent is locked — unlock 1Password and retry (do not bypass signing).

Publishing the same skills to the PostHog skill store: see [[reference_posthog_skill_store_writes]].
