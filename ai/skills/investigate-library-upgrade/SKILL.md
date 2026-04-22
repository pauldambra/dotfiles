---
name: investigate-library-upgrade
description: >
  Investigate what it would take to upgrade a library from its currently
  pinned version to a target version (or "latest"). Produces a migration
  assessment — version delta, breaking changes that apply to us, impacted
  files, estimated blast radius, suggested rollout — and STOPS there.
  Does not perform the upgrade unless the user explicitly asks.
  Use when the user says "investigate updating <pkg> from X to Y",
  "investigate updating <pkg> to latest", "we are behind on <pkg>",
  or "let's update <pkg> to version N".
---

# Investigate a library upgrade

The user says "investigate" deliberately. The output of this skill is a
**written assessment**, not a code change. If the assessment looks good
the user will explicitly ask for the upgrade to be performed — at that
point exit this skill and do the work as a normal task.

## Narration — one line per step

```
[upgrade] step 1 — current @posthog/rrweb pinned at 0.0.42
[upgrade] step 2 — fetching release notes for 0.0.43 .. 0.0.54
[upgrade] step 3 — 28 import sites found across 14 files
[upgrade] step 4 — classifying impact per site
[upgrade] step 5 — writing assessment
```

## Workflow

### Step 1: Identify current pinned version

Parse `$ARGUMENTS` for the package name and target version (or "latest").
If either is missing, ask the user.

Find the current pinned version by searching the right manifest(s) for
the ecosystem:

| Ecosystem | Manifest(s) |
| --- | --- |
| Node / pnpm | `package.json`, `pnpm-lock.yaml` |
| Python | `pyproject.toml`, `uv.lock`, `requirements*.txt` |
| Rust | `Cargo.toml`, `Cargo.lock` |
| Go | `go.mod`, `go.sum` |

Prefer the lockfile for the **actually installed** version, not the
manifest range. In a pnpm monorepo, check every workspace — the same
package may be pinned to different versions in different workspaces.
List each distinct pinned version and which workspace uses it.

If "latest" was requested, resolve it:

- npm: `npm view <pkg> version`
- pypi: `pip index versions <pkg>` or the JSON API
- crates: `cargo search <pkg> --limit 1`
- go: `go list -m -versions <pkg>`

Record: `current_version`, `target_version`, per-workspace mapping if
applicable.

### Step 2: Fetch release notes / changelog

Prefer sources in this order:

1. `CHANGELOG.md` in the upstream repo, between tags.
2. GitHub Releases API:
   `gh api repos/<owner>/<repo>/releases --paginate --jq '...'`
   filtered to tags between current and target.
3. npm/pypi release pages as a fallback.

Extract, for each intermediate release:

- Breaking changes (look for `BREAKING`, `!:`, MAJOR bumps).
- Deprecations.
- New features that matter for our usage.
- Bug fixes that could silently change our behaviour.

Summarise in chronological order so the user can see the path from X to Y.

### Step 3: Find every usage in our repo

Grep for import sites and direct references:

- Node: `import .* from ['"]<pkg>(/.*)?['"]`, `require\(['"]<pkg>`
- Python: `^import <pkg>`, `^from <pkg>`
- Rust: `use <pkg>(::|;)` and `<pkg> = ` in `Cargo.toml`
- Go: `"<pkg>"` imports block

Do not stop at import lines — for each file, also capture the specific
APIs used (exported names referenced). The blast radius question is
"which APIs changed AND which do we call", not "which files import the
package".

Record, per file: list of APIs used.

### Step 4: Classify each usage against the changelog

For every file-API pair from Step 3, cross-reference with the breaking
changes from Step 2. Classify as:

- **Safe** — no breaking change touches this API path.
- **Needs change** — API is renamed, signature changed, or default
  behaviour changed. The required edit is mechanical and clear.
- **Breaks** — API removed or semantics changed in a way that requires a
  design decision, not just an edit.

If an API is hard to verify against the changelog (e.g. internal type
that isn't documented), mark it **Unclear** and surface that explicitly.

### Step 5: Write the assessment

Write the assessment to stdout (do **not** create a file unless the user
asked). Use this shape:

```markdown
# Upgrade assessment: <pkg> <current> → <target>

## Version delta
- <N minor releases, M patch releases, K breaking changes> between versions
- Highlights: <one-line bullets of what matters>

## Breaking changes that affect us
- <change 1> — impacts <count> files (see table below)
- <change 2> — impacts <count> files
- (if none: "No breaking changes apply to our current usage.")

## Files needing edits
| File | APIs used | Category | What changes |
| --- | --- | --- | --- |
| src/foo.ts | `bar`, `baz` | needs change | `bar` renamed to `barv2` |
| ... | ... | ... | ... |

## Unclear / needs human eyes
- <file:api> — <why unclear>

## Estimated blast radius
- <N> files edited, <M> "breaks" requiring design decisions.
- Confidence: <high|medium|low> based on changelog completeness.

## Suggested rollout
- <single PR | staged PR 1: X, PR 2: Y | behind a feature flag | ...>
- Rationale: <one sentence>

## Next step
Reply "go ahead" to perform the upgrade, or ask for changes to the plan.
```

### Step 6: Stop

Do **not** start editing files, bump versions, or open a PR. The skill
ends at the printed assessment. If the user replies with approval, the
ordinary work flow handles the implementation from there.

## Terminal conditions

Always stop (with the best assessment you can produce) when:

- The changelog is missing or incomplete (mark confidence `low` and say
  which releases you couldn't find notes for).
- The package is used in more than ~200 files (say so, suggest a sampling
  approach, stop before trying to classify each).
- The user interrupts.

## Judgement rules

- When in doubt between "safe" and "needs change", mark **needs change**.
  The user would rather see a false positive than miss a real break.
- When in doubt between "needs change" and "breaks", mark **breaks**.
  Signals to the user that a design decision is needed.
- Never invent APIs. If an API appears in our code but not in the
  changelog's breaking-changes list, that's **safe** — don't manufacture
  a concern.

## Dependencies

- `gh` CLI for GitHub Releases.
- `npm` / `pip` / `cargo` / `go` CLIs for latest-version resolution.
- Ripgrep (via `Grep` tool) for usage discovery.

## Graceful degradation

- **No internet / can't fetch changelog:** proceed with file-level
  analysis only, mark confidence `low`, list what you couldn't fetch.
- **Ambiguous package name:** if the package name matches multiple
  sources (e.g. a rename from `foo` to `@scope/foo`), ask the user to
  disambiguate rather than guess.
