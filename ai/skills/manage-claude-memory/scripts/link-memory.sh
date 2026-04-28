#!/usr/bin/env bash
#
# Symlink each per-project memory dir under the PostHog Code app's storage
# at the source of truth in ~/dotfiles/ai/claude-memory/<project-key>/.
#
# Usage:
#   link-memory.sh             # link every project key found in dotfiles
#   link-memory.sh <key>       # link a single project key

set -euo pipefail

DOT_BASE="${HOME}/dotfiles/ai/claude-memory"
CODE_BASE="${HOME}/Library/Application Support/@posthog/posthog-code/claude/projects"

link_one() {
  local key="$1"
  local source="${DOT_BASE}/${key}"
  local target="${CODE_BASE}/${key}/memory"

  if [[ ! -d "$source" ]]; then
    echo "  skip ${key}: dotfiles source missing (${source})"
    return 0
  fi

  if [[ -L "$target" ]]; then
    if [[ "$(readlink "$target")" == "$source" ]]; then
      echo "  ok   ${key}: already linked"
      return 0
    fi
    echo "  relink ${key}: was -> $(readlink "$target")"
    rm "$target"
  elif [[ -e "$target" ]]; then
    if [[ -d "$target" ]]; then
      if [[ -z "$(ls -A "$target" 2>/dev/null)" ]]; then
        rmdir "$target"
      else
        echo "  REFUSE ${key}: ${target} is a non-empty real dir." >&2
        echo "         move its contents into ${source} first, then rerun." >&2
        return 1
      fi
    else
      echo "  REFUSE ${key}: ${target} exists and is not a dir." >&2
      return 1
    fi
  fi

  mkdir -p "$(dirname "$target")"
  ln -s "$source" "$target"
  echo "  link ${key}: ${target} -> ${source}"
}

if [[ $# -eq 1 ]]; then
  link_one "$1"
elif [[ $# -eq 0 ]]; then
  if [[ ! -d "$DOT_BASE" ]]; then
    echo "no claude-memory dir at ${DOT_BASE}" >&2
    exit 1
  fi
  shopt -s nullglob
  for dir in "$DOT_BASE"/*/; do
    key="$(basename "$dir")"
    link_one "$key"
  done
else
  echo "usage: $0 [<project-key>]" >&2
  exit 2
fi
