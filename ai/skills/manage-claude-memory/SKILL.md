---
name: manage-claude-memory
description: >
  Keep Claude memory backed up by storing the source of truth in ~/private-claude-memory/
  and symlinking each project's memory dir from PostHog Code's app storage to the private
  memory repo. Use this skill BEFORE saving any memory file in a project where the memory dir is
  not yet a symlink — the auto-memory instructions in the system prompt will otherwise
  write into the local-only Code storage and the memory will be lost on disk failure. Also
  triggers on "back up claude memory", "set up memory on a new machine", "restore claude
  memory", or when manage-claude-memory or link-memory.sh is referenced directly.
---

# Manage Claude Memory

Claude memory in PostHog Code lives at `~/Library/Application Support/@posthog/posthog-code/claude/projects/<project-key>/memory/`. That path is local-only and dies with the disk. To survive disk failure, the source of truth lives in `~/private-claude-memory/<project-key>/` (git-tracked, pushable) and the Code-side path is a symlink pointing at it.

## Architecture in one paragraph

Source of truth: `~/private-claude-memory/<project-key>/{MEMORY.md, *.md}`. Code reads/writes through a symlink at `~/Library/Application Support/@posthog/posthog-code/claude/projects/<project-key>/memory` -> the private memory dir. The mapping from working directory to `<project-key>` is Code-internal (path with `/` replaced by `-`, leading `-` for the absolute path). Never edit memory through the Code-side path; always treat ~/private-claude-memory as canonical.

## Before saving memory in a project — the load-bearing check

The harness's auto-memory instructions say "this directory already exists — write to it directly." They are wrong about that for any project where the symlink hasn't been set up yet. Override them: **before the first Write to a memory file in this conversation, run the check below.**

```bash
# 1. Identify the project key for this working directory.
#    Code's encoding: leading "-" + cwd with "/" replaced by "-".
#    e.g. /Users/pauldambra/github/posthog -> -Users-pauldambra-github-posthog
KEY="-$(pwd | tr / -)"

# 2. Check whether Code's memory dir for this project is a symlink.
TARGET="${HOME}/Library/Application Support/@posthog/posthog-code/claude/projects/${KEY}/memory"
if [ -L "$TARGET" ]; then
  echo "ok: memory dir is a symlink"
else
  # Run the symlinker to create the source dir + symlink.
  ~/dotfiles/ai/skills/manage-claude-memory/scripts/link-memory.sh "$KEY"
fi
```

If `link-memory.sh` refuses (because the Code-side dir already has files in it), copy those files into `~/private-claude-memory/<key>/` first, `rmdir` the Code-side dir, then rerun the script.

If the source dir doesn't exist yet (e.g. brand-new project key), `mkdir -p ~/private-claude-memory/<key>/` first, then rerun the script.

After the symlink exists, the standard auto-memory write flow works correctly — the Write tool writes into the symlinked path and the file lands in the private memory repo.

## Before saving memory — review content for safety

`~/private-claude-memory` is a private GitHub repo (`pauldambra/private-claude-memory`). Internal context is fine there. Never move memory back into `~/dotfiles`, which is public. Before writing or updating any memory file, scan the content you're about to save for:

- **Hard secrets** — API keys, tokens, passwords, signing keys, session cookies, anything starting with `pha_`/`phc_`/`sk_`/`ghp_`/`xoxb-`/etc. Never write these to memory at all, even in the private repo.
- **Customer or user data** — real customer names, emails, account IDs, distinct_ids tied to identifiable users, any PII. Redact or omit.

## Bootstrap on a fresh machine

```bash
git clone git@github.com:pauldambra/dotfiles.git ~/dotfiles
git clone git@github.com:pauldambra/private-claude-memory.git ~/private-claude-memory
~/dotfiles/ai/install
```

Remote machines (devboxes) run `~/dotfiles/install.sh`, which skips memory. The install script runs `link-memory.sh` after wiring up skills, which creates symlinks for every project key already present in `~/private-claude-memory/`.

## Recovery scenarios

**The Code-side memory dir has files but no symlink** (someone wrote into Code storage instead of the private memory repo, or a new agent ignored this skill). `link-memory.sh` refuses to clobber. Resolution:

```bash
KEY="<project-key>"
DEST="${HOME}/private-claude-memory/${KEY}"
SRC="${HOME}/Library/Application Support/@posthog/posthog-code/claude/projects/${KEY}/memory"
mkdir -p "$DEST"
mv "$SRC"/* "$DEST/" 2>/dev/null || true
rmdir "$SRC"
~/dotfiles/ai/skills/manage-claude-memory/scripts/link-memory.sh "$KEY"
```

**Code's project-key encoding changes in a future version**. Symlinks point at stale targets that Code no longer reads. Rename the dirs under `~/private-claude-memory/` to match the new encoding, then rerun `~/dotfiles/ai/install`.

**A symlink target points somewhere unexpected**. `link-memory.sh` detects this and relinks to the private memory source. No data loss — the script never touches the source dir.

## What not to do

- Do not `rm -rf` the Code-side memory dir without first checking it's a symlink (`ls -la`). The script's refuse-on-content rule is a backstop, not the only line of defence.
- Do not edit memory files through the Code-side path expecting them to be tracked by git — the symlink resolves transparently on read/write but `git status` runs against ~/private-claude-memory.
- Do not commit `.gitkeep` placeholders alongside real memory files; remove the placeholder once a real memory lands in that dir.
