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

A harness copy is a snapshot, and it can be older than the store. On PR 108166
a local `review-triage` resolved threads with no reply, a day after the store
version started to require one. So put each rule the loop depends on in the
skill-specific delta below, not only in the sub-skill.

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

Spawn the simplify runner with the **simplify wrapper brief** and have it do the
checks itself. Do not tell it to invoke `Skill("simplify")`: that skill starts
its own reviewer agents in the background, and a runner that invokes it ends its
turn with nothing returned. Observed twice (PRs 106341 and 106366), each time
forcing a rerun on the next model. The runner edits the working tree, does not
commit or push, and reports the files it changed.

Spawn any runner that edits code in the caller's own working tree. Never give it
`isolation: "worktree"`. A fresh worktree can start from the base branch rather
than the PR's HEAD, so the runner reviews the wrong tree, and anything it does
edit is invisible to the caller that has to commit it. One observed simplify
runner reported the PR's own existing commit as its changed files while the
caller's tree stayed clean. Confirm any file-change claim with
`git status --porcelain` in your own tree before you commit for it.

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
> Report step and nothing after it. Any sub-agent you spawn must run with
> `run_in_background: false`, so it finishes inside your turn. A router, validator, or
> single-scope reviewer never spawns sub-agents at all; do the work in your own turn.
> Never end your turn
> waiting on background work — no notification will reach you, and the dispatch is
> lost. If a nested skill would background work you cannot wait on, do not invoke
> it; do the analysis directly instead.

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
  cheapest runner has resolved a rule-citing P1 as a nit before. Before you
  resolve any thread, reply in it with your automated-comment header and the
  reason: the fix commit SHA, or why it needs no change. If the reply fails,
  leave the thread open. Return the reply URL with each resolve. Inputs: PR number, owner/repo, base,
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
  branch, which moves HEAD. Before you classify a changed or new snapshot, call
  `visual-review-runs-snapshot-history-list` for it. When the same change already
  appears on the base branch or `master`, classify it as inherited from the base,
  not PR-caused, and do not approve it on the PR. Any other changed or new
  snapshot stays needs-decision. A compat-test-results warning
  that names a test this PR adds for a new option is PR-caused and mechanical:
  add the `compat-skips.ts` entry with reason `<option> added in #<pr>` and range
  `<` the version the changeset will produce; confirm from the job log that the
  old bundle only lacked the feature and did not break existing behaviour."
  Validate what it returns before you trust it: `ci` must carry
  `{pass,pending,fail,failing}`, and `base_update.status` must be `updated`,
  `current`, `conflict`, or `stacked`. A stacked layer returns `stacked`: the
  runner did not touch the base on purpose. A malformed shape is evidence the runner skipped the
  real steps, not a formatting slip. One observed runner never called
  `gh pr checks` or `gh pr view --json mergeable` at all. It substituted local
  `mypy`, `ruff`, and pytest runs, then returned `ci` as an array of stage
  objects and `base_update.status: "not_attempted"`, and the caller had to redo
  the whole CI read. Reissue at the next model up rather than accepting it.
- **simplify wrapper:** "Do not invoke the `simplify` skill or spawn any agent.
  Review the diff at `<diff_path>` (base `<base>` to current HEAD) on PR
  `<pr_number>` in `<owner>/<repo>` yourself, in your own turn, for four things:
  reuse (an existing helper or component already does this), simplification
  (less code or fewer branches for the same behaviour), efficiency (wasted
  work, repeated queries or renders), and altitude (logic in the wrong layer).
  Prefer an extracted, well-named function or a test over an explanatory
  comment. Apply only behaviour-preserving fixes to the working tree. Before you remove an import, grep the file
  for the imported name or run the type check. A linter pass alone does not prove
  the name is unused. Do not commit or push — the caller does
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
and `gh` — **unless the environment blocks them.** A harness that requires
signed commits rejects `git commit`, `git push`, and `git push --force`
outright, and offers a tool in their place. Establish which applies before the
first dispatch, and when they are blocked, name the working mechanism in every
brief that may commit. A runner that discovers this mid-task either fails its
commit or reports a file change it never landed.

**PostHog Desktop worktrees.** Commits are unsigned unless you pass `-S`. A
push that changes `.github/workflows` files is refused over HTTPS, so push over
SSH. A blobless worktree can stall a rebase while it scans for missing objects.
In that case read the blobs through the GitHub API, replay the change with `git
merge-tree`, then write the commit with `git commit-tree -S`. Name the method you
use in every brief that may commit or push.
