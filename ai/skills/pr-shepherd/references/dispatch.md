# Dispatch mechanism

How to resolve a sibling skill, spawn its runner, and brief it. Fetch this file
when you are about to dispatch for the first time in an iteration.

## Resolving a sibling skill

Resolve `review-triage`, `ci-shepherd`, `qa-swarm`, and `simplify` from the
current harness first, then from the PostHog skill store.

1. **Harness:** use `Skill("<name>")` when the harness exposes it. If the harness
   exposes a readable local body instead, use that body for load-then-spawn.
2. **Store fallback:** fetch with `skill-get` and pass the body to the Agent.
   Follow `qa-swarm` inline — it coordinates its own reviewer agents.

### Store-fetch traps

These cost real money when you hit them. All four were observed in one run.

- `skill-list` returns the skill's `name`; `skill-get` takes `skill_name`. The
  keys differ, so copying the field straight across fails.
- **Search one term at a time.** `{"search": "qa-swarm review-triage ci-shepherd"}`
  returns zero rows; `{"search": "qa-swarm"}` returns three. A zero-row result
  from a multi-term search is not evidence the skill is missing.
- **Page with `body_offset` and `body_length`**, and keep going from the returned
  `body_next_offset` until it is `null`. Other pagination keys (`offset`,
  `limit`) are silently ignored — the call succeeds and hands you page one again,
  which reads like progress. Always compare what you hold against
  `body_total_length` before acting on it.
- A partially loaded skill omits its own terminal conditions and degradation
  rules, which are at the end. If you cannot finish loading a sub-skill, treat it
  as missing (see `references/degradation.md`) rather than running a fragment.
- On `fetch failed`, retry once before declaring the skill missing.

## Load-then-spawn

Dispatch `review-triage` and `ci-shepherd` by load-then-spawn: pass the sub-skill
body, the override brief, and the inputs to an `Agent`.

Resolve `simplify` from the harness first, then the store. Spawn an Agent whose
prompt carries the **simplify wrapper brief** and tells it to invoke
`Skill("simplify")` when the harness provides it; otherwise fetch the store skill
and load-then-spawn its body with the same wrapper. The runner edits the working
tree, does not commit or push, and reports the files it changed.

Run `review-triage` first. Run `ci-shepherd` after the quality loop converges.

**Prefer letting the child fetch its own body.** When the Agent can call
`skill-get` itself, give it the skill name and let it load its own instructions.
Fetching the body into this loop first pays for it twice — once here, where it
then sits in context for the rest of the session, and once in the child. Only
load-then-spawn when the child cannot reach the store.

## Give runners the diff, not just a SHA

Write the diff once per round and pass the path. Take it from GitHub, not from a
local base ref:

```bash
gh pr diff <pr_number> > /tmp/shepherd-diff-<short_sha>.patch
```

In a worktree the local base branch is usually stale, and `git diff master...HEAD`
against a stale `master` once produced a 4.7M-line patch that nobody noticed until
a runner was handed it. If you must diff locally, `git fetch origin <base>` first
and use `origin/<base>...<head>`.

A runner handed only a SHA re-reads the files from disk. Observed cost of that:
one reviewer spent ~38k tokens re-reading a 1,722-line file the caller had
already read and edited twenty times. Pass the patch path in every brief, and
tell the runner to read files only where the patch is not enough.

## Sub-step contract — prepend to every brief

> Sub-step, not standalone. Operate on the inputs supplied. Do not resolve or
> rediscover them. Never call `AskUserQuestion`. Do not narrate to the user.
> Collect narration lines in a `narration` array. Follow the caller model policy.
> Make low-risk changes only when deterministic checks can validate them. Before
> a risky change, return a `validation_request` and do not edit, commit, or push
> that change. Read the supplied diff before reading any file; read a file only
> where the diff is insufficient. End with the single structured result from your
> Report step and nothing after it.

Simplify has no Report step, so its wrapper must add `validation_request` to its
normal file-change result when needed.

## Skill-specific deltas

- **review-triage:** "Skip your Step 1 (resolve) and Step 2 (run qa-swarm) — the
  caller already did both this round. Triage existing threads only; genuinely
  ambiguous threads (after applying your paul-pair gate) go to
  `deferred_threads` and never terminate. A thread that cites a repo rule
  (AGENTS.md, a linter, a documented convention) is actionable, not a nit —
  apply the fix when it is a deterministic one-file change, otherwise defer it;
  never resolve it without acting. Resolving a thread is a change too, and the
  cheapest runner has resolved a rule-citing P1 as a nit before. Inputs: PR number, owner/repo, base,
  `head_sha_in`, `qa_swarm_marker_sha`, `deferred_threads`, `diff_path`. Narrate
  `[triage]` lines."
- **ci-shepherd:** "Inputs: PR number, owner/repo, base, `head_sha_in`,
  `diff_path` — operate against `head_sha_in`. Narrate `[ci]` lines. Diagnose
  every failing leaf job, perform at most one verified repair commit, rerun
  likely flaky/infrastructure jobs once, and do not wait for fresh remote CI. On
  a base conflict do not resolve it — record it in `base_update` and continue;
  the human owns the conflict. Fetch each failing job's log once and keep it; do
  not re-fetch the same job with a different grep. A visual review run whose
  only diff is `removed` snapshots (0 changed, 0 new) for stories the PR itself
  deletes is PR-caused and mechanical: finalize it with
  `visual-review-runs-finalize-create` (`approve_all: true`,
  `commit_to_github: true`); the server commits the trimmed baseline to the
  branch, which moves HEAD. Any changed or new snapshot stays needs-decision."
- **simplify wrapper:** "Invoke the `simplify` skill (`Skill` tool,
  `skill: 'simplify'`) — or, when this brief carries the store-fetched simplify
  body, follow that body instead — against the diff at `<diff_path>` (base
  `<base>` to current HEAD) on PR `<pr_number>` in `<owner>/<repo>`. Let it apply
  its own fixes to the working tree. Do not commit or push — the caller does
  that. Report back: the list of files changed (or 'no changes' if it found
  nothing to simplify), and a one-line summary per file."

## Second-model validation

When the model policy requires validation, the first runner must not make the
risky change. It returns a `validation_request` with the file, the proposed
change, the evidence, and the risk. Spawn a new Agent on the next available
model and pass only that request and the narrow validation question. The
validator returns `accept`, `reject`, or `needs-more-evidence` with a short
reason.

If it accepts, re-dispatch the original sub-skill with the accepted request and
permission to apply only that change. If it rejects, leave the code unchanged.
If it needs more evidence, gather the evidence or move up one model. Do not apply
or push a risky fix until a validator accepts it and the available checks pass. A
pending `validation_request` means the quality-loop round is not dry.

Keep the sub-skill instructions in the sub-skill itself. This skill adds only the
inputs, the model policy, and the sub-step override. Git work uses plain `git`
and `gh`.
