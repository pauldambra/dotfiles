#!/usr/bin/env bash
#
# Entry point for remote machines (PostHog devboxes, herdr machines).
# Coder's dotfiles support clones this repo and runs this file.
# Sets up agent instructions, skills and commands only: no git identity
# or signing (those point at keys on the Mac), and no Claude memories.

set -euo pipefail

cd "$(dirname "$0")"
DOTFILES_ROOT=$(pwd -P)

SKIP_CLAUDE_MEMORY=1 bash "$DOTFILES_ROOT/ai/install"

# Codex reads ~/.codex/AGENTS.md. Not linked on the Mac, where PostHog Code
# also scans ~/.codex and would load the instructions twice.
mkdir -p "$HOME/.codex"
ln -sfn "$DOTFILES_ROOT/ai/AGENTS.md" "$HOME/.codex/AGENTS.md"
echo "Linked AGENTS.md to $HOME/.codex/AGENTS.md"

# Claude Code's user-level instructions file, loaded whatever the working directory.
mkdir -p "$HOME/.claude"
ln -sfn "$DOTFILES_ROOT/ai/AGENTS.md" "$HOME/.claude/CLAUDE.md"
echo "Linked AGENTS.md to $HOME/.claude/CLAUDE.md"
