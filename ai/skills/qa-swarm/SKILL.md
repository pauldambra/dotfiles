---
name: qa-swarm
description: >
  Orchestrates a cheap-first PR review: a single router reviewer (GLM-5.2)
  does the first pass and delegates to stronger models (qa-team,
  paul-reviewer, xp-reviewer, security-audit on opus/fable/gpt-sol/kimi-k3)
  only for the parts it judges complex or dangerous, posting findings as
  inline GitHub comments. Use when the user asks for "qa-swarm", "swarm
  review", or wants a multi-perspective review posted to their PR. Accepts an
  optional PR number or base branch as argument.
---

# QA Swarm: Multi-Perspective PR Review

Runs four independent review perspectives in parallel and posts findings as
inline PR comments. Each reviewer operates independently — none knows about
the others.

## Bot identifier — REQUIRED on every posted comment

Every comment this skill posts to GitHub (inline review comments, review
body, top-level PR comments, thread replies — **every single one**) must
begin with the bot-identifier header so a human reader can tell at a
glance that it was not written by a person:

```markdown
> [!NOTE]
> 🤖 Automated comment by **QA Swarm** — not written by a human
```

Do not skip this header under any circumstance. If the comment body is
constructed in multiple places, apply the header at the outermost point
where the body is assembled. The existing templates in Step 5 already
include a compliant header; keep it in place when adapting them.

On public repositories (e.g. PostHog/posthog), never put absolute production
counts — raw event, user, or revenue numbers — in a finding or comment. Cite
percentages or ratios instead; the repo is public and absolute counts leak
operational scale.

## Workflow

### Step 1: Detect PR & gather diff

If `$ARGUMENTS` looks like a PR number or URL, use that. Otherwise detect the
current PR:

```bash
gh pr view --json number,headRefName,baseRefName,url
```

If no PR exists, fall back to diffing against `master` (or `main` if `master`
doesn't exist). In this case, skip PR commenting and output the report to the
terminal only.

Gather context:

```bash
git diff <base>...HEAD --name-only
git diff <base>...HEAD
git log <base>...HEAD --oneline
git rev-parse HEAD
```

Store: PR number, owner/repo (from `gh repo view --json owner,name`), base
branch, changed file list, full diff, commit log, and HEAD SHA.

### Step 2: Load skill content

Load the four reviewer bodies up front so they're ready if the router
delegates to them. qa-team is on disk; paul-reviewer and xp-reviewer resolve
local-first then from the PostHog skill store; security-audit is store-only.
If any reviewer's content is unavailable (not on disk or in the store), warn
the user and mark it unavailable — the router will route around it (see
*Graceful degradation*).

Issue all four loads in **parallel** (single message, four tool calls) so the
MCP round-trip does not serialize with the on-disk reads. The router (Step 3a)
runs on GLM-5.2 and has no body to load — it's a direct prompt.

**qa-team** (try these paths in order, stop at first hit):
1. `<repo_root>/.agents/skills/qa-team/SKILL.md` (use `git rev-parse --show-toplevel`)
2. `~/github/posthog/.agents/skills/qa-team/SKILL.md`

If found, also read from the same directory:
- `references/personas.md`
- `references/incident-patterns.md`

**paul-reviewer** and **xp-reviewer** — resolve each local-first, then from the
PostHog skill store:

1. **Local:** if `~/.claude/skills/<name>/SKILL.md` exists, read it plus its
   bundled reference from the same dir — `references/real-review-examples.md`
   for paul-reviewer, `c2wiki-wisdom.md` for xp-reviewer.
2. **Store fallback:** otherwise fetch from the store —
   `call llma-skill-get {"skill_name":"<name>"}` for the body, then for each
   entry in the returned `files[]` manifest
   `call llma-skill-file-get {"skill_name":"<name>","file_path":"<path>"}` to
   pull the reference content (in the store the xp wisdom file is
   `references/c2wiki-wisdom.md`).

**security-audit** (PostHog MCP — network-dependent, more likely to fail than
the on-disk reads above):

Invoke the PostHog MCP `exec` tool:

```
mcp__posthog__exec command="call llma-skill-get {\"skill_name\": \"security-audit\"}"
```

The response's `body` field is the full skill markdown. Store it as
`security_audit_body`. If the call errors, times out, or the MCP server is
unavailable, log `security-audit: skip (MCP unavailable)` and mark it
unavailable — the router won't be able to delegate to it.

### Step 3: Cost-aware review — router pass, then conditional delegation

Review is the reasoning-heavy, expensive part of the loop. The previous fixed
split (fable for qa-team/security, opus for paul/xp — always four agents) was
sharp but costly. The new default is **cheap-first**: a single router reviewer
does the first pass on the cheapest available model, then delegates to a
stronger model only for the parts it judges complex or dangerous. Running the
review more than once with different models is explicitly fine when it lowers
overall cost — a cheap pass to screen, then a strong pass only on what
survived.

#### Model roster

- **Router (cheap):** `@cf/zai-org/glm-5.2` — the entry reviewer. Pin it
  explicitly on the router Agent. If the harness rejects the non-Claude model
  string, **omit `model`** so the router inherits the session model, and run
  the shepherd session on glm-5.2 (`/model @cf/zai-org/glm-5.2`) so
  inheritance lands on glm-5.2. Either path gives a cheap first pass. If
  glm-5.2 is unavailable at all, fall back to `sonnet` for the router.
- **Delegation targets (stronger), the router's choice** — pick the least
  expensive target that can cover the concern; reserve the deepest for when
  the cheaper tier wouldn't catch it:
  - `opus` — voice/style/logic lens (paul-reviewer, xp-reviewer). Claude
    enum, always pinnable.
  - `fable` — deepest technical lens (qa-team specialists, security-audit).
    Claude enum, always pinnable. If the harness rejects `'fable'` (older
    Claude Code), fall back to `'opus'` for that agent.
  - `gpt-sol` — soon; another strong option for the opus lenses. When its
    pin string is known and accepted, the router may choose it; otherwise it
    falls back to `opus`.
  - `kimi-k3` — soon; another deep option for the fable lenses; falls back
    to `fable` when not pinnable.

#### 3a. Router pass

Dispatch ONE router agent on the router model. Pass it the diff, the
changed-file list, and the commit log. Tell it:

- You are the sole first-pass reviewer. Review the full diff for
  correctness, bugs, security, and style. Read surrounding code context for
  each change (at least 50 lines above/below) before judging.
- After reviewing, assess the change's **danger/complexity** (blast
  radius): LOW / MEDIUM / HIGH / CRITICAL, using the rubric below.
- Decide whether to **delegate** part or all of the review to a stronger
  model, and if so which model + which reviewer lens + which scope.
  Minimise cost: delegate only what your own pass can't safely cover, scoped
  to the concerning files/hunks. Delegating nothing (low danger, high
  confidence) is the cheap path working as intended — do not pad the plan.
- Return your own findings in STRUCTURED_FINDINGS form, then a
  DELEGATION_PLAN block.

**Danger rubric** — any of these raises blast radius and pushes toward
delegation:

- Touches auth, authorization, session, secrets, or crypto.
- Touches data ingestion, migration, schema, or destructive DB writes.
- Touches concurrency, locking, or shared mutable state.
- Touches billing, payments, or anything with direct revenue / blast impact.
- Diff is large (>~400 lines) or spans many files with non-obvious
  cross-file effects.
- Uses patterns you are uncertain about (unfamiliar framework, subtle async,
  off-by-one-prone loops).
- You found a HIGH/CRITICAL finding you want a stronger model to confirm.

**Delegation plan format** (router returns this after its OVERALL_SUMMARY):

```
DELEGATION_PLAN:
danger: <LOW|MEDIUM|HIGH|CRITICAL>
confidence: <HIGH|MEDIUM|LOW>
delegations:
- model: <opus|fable|gpt-sol|kimi-k3> | reviewer: <qa-team|paul-reviewer|xp-reviewer|security-audit|general> | scope: <file paths / hunks / "full"> | reason: <one line>
...
(empty list if no delegation)
```

If `delegations` is empty, skip 3b — the router's findings ARE the review.
This is the cheap default and the common case for small, low-danger diffs.

#### 3b. Delegation pass (only when the router delegated)

For each entry in the delegation plan, dispatch the named reviewer on the
chosen model, scoped to the entry's `scope`. Run independent delegations in
parallel (single message, multiple Agent calls) so they run in true parallel.
Each returns STRUCTURED_FINDINGS.

The four subsections below are the **delegation targets** — their prompt
shapes, reused verbatim when the router delegates to that reviewer. Pin the
chosen model on each Agent (opus/fable directly; gpt-sol/kimi-k3 when
pinnable, else their Claude fallback). Scope the diff material you pass to
each reviewer to its `scope` rather than the whole PR diff. Each delegated
reviewer is told it is the sole reviewer for its scope — no mention of other
reviewers or the router (same independence rule as before).

Multi-pass is allowed: if a delegation's findings suggest a different lens
would help, the router may issue a second delegation to a different model.
Cap total delegations at 6 as a backstop.

Each reviewer must return findings in the structured format described in
"Reviewer output format" below.

#### Reviewer target 1: qa-team

Pass the full qa-team SKILL.md content into the agent prompt, but tell it the
diff is already gathered (skip its Step 1). Include the personas and incident
patterns inline in the prompt. The agent follows the qa-team workflow from
Step 2 onward (classify files, launch its own sub-agents, synthesize). When
delegated from the router, restrict its scope to the delegation's `scope`.

Tell it to return its final findings list (not the QAREPORT.md file) in the
structured output format below, with `reviewer` tags like `qa-team/security`,
`qa-team/database`, etc.

#### Reviewer target 2: paul-reviewer

Pass the full paul-reviewer SKILL.md content and real-review-examples into the
agent prompt, along with the diff (scoped when delegated). Tell it to review
the diff in Paul's voice and return structured findings with `reviewer: paul`.

#### Reviewer target 3: xp-reviewer

Pass the full xp-reviewer SKILL.md content and c2wiki-wisdom into the agent
prompt, along with the diff (scoped when delegated). Tell it to review the
diff in the XP voice and return structured findings with `reviewer: xp`.

#### Reviewer target 4: security-audit

Skip this agent if `security_audit_body` is unset (MCP fetch failed in
Step 2).

Pass `security_audit_body` into the agent prompt along with the diff and the
following framing. The body is written for a standalone audit session — the
prompt must override the sections that do not apply in a qa-swarm context:

- **Suppress the "Input" section.** The diff, base branch, PR ref, and HEAD
  SHA are already gathered in Step 1. Tell the agent: "Do not run `git diff`
  or `gh pr diff` — your target is the diff supplied below."
- **Suppress the "Before you start" clarifying questions.** Tell the agent:
  "Do not ask clarifying questions. If authentication, tenant derivation, or
  reachability is unclear from the diff, state your assumption inline in the
  finding's `Confidence` line and proceed."
- **Suppress the "After reporting" interactive fix loop.** Tell the agent:
  "Do not offer to fix findings. qa-swarm is the orchestrator — your output
  becomes PR comments. End your response immediately after the structured
  findings block."
- **Suppress the "Reproducer tests" section.** Tell the agent: "Do not write
  reproducer tests. This is a PR-review context, not a local-branch audit."

Tell the agent to return findings in qa-swarm's `STRUCTURED_FINDINGS` format
(see "Reviewer output format" below) with these mappings:

- `reviewer:` tag is `security-audit/<category>` where `<category>` is the
  finding's lowercased, hyphenated `Category` field (e.g.
  `security-audit/idor`, `security-audit/ssrf`,
  `security-audit/sql-injection`, `security-audit/prompt-injection`). Fall
  back to a flat `security-audit` when `Category` is missing. Sub-tagging
  preserves the audit's taxonomy in inline-comment headers and makes the
  convergent template (`qa-team/security` + `security-audit/idor`) more
  readable than two flat tags would be.
- `severity:` maps directly: Critical -> CRITICAL, High -> HIGH,
  Medium -> MEDIUM, Low -> LOW. security-audit has no NIT tier; never emit
  NIT from this agent.
- `file:` and `line:` come from the finding's `Location` field
  (`file.py:LINE`). If `Location` lists multiple refs, use the primary
  location and surface the additional refs inside `body`.
- `body:` is a compact rendering of the native `## Finding N` block,
  preserving exactly these fields in this order: Description, Data flow,
  Exploit, Fix, Confidence. Drop the `## Finding N — <title>` header,
  Severity, Category, and Location lines — they are already encoded in the
  inline-comment chrome (tag, severity emoji, file/line anchor). Keep the
  field labels (`Description:`, `Data flow:`, `Exploit:`, `Fix:`,
  `Confidence:`) so the audit's structured shape survives into the PR
  comment.

If the agent has no findings, return the `(none)` form described in the
"Reviewer output format" section below.

#### Reviewer output format

Every reviewer (router and any delegation target) must end its response with
findings in this exact format:

```
STRUCTURED_FINDINGS:
- file: <path> | line: <number or "general"> | severity: <CRITICAL|HIGH|MEDIUM|LOW|NIT> | reviewer: <tag> | body: <the review comment text>
- file: <path> | line: <number or "general"> | severity: <CRITICAL|HIGH|MEDIUM|LOW|NIT> | reviewer: <tag> | body: <the review comment text>
...

OVERALL_SUMMARY:
<1 paragraph assessment>
```

If an agent has no findings, it returns:

```
STRUCTURED_FINDINGS:
(none)

OVERALL_SUMMARY:
<1 paragraph assessment>
```

### Step 4: Synthesize

Collect the router's findings and any delegated reviewers' findings.

**Deduplication:** If multiple reviewers flagged the same file+line (within 5
lines) or clearly the same concern, merge them into a single finding. Note the
convergence — convergent findings carry higher confidence.

**Verdict** (using qa-team risk scoring if the qa-team reviewer ran —
otherwise apply the same tiers to whatever findings the router and
delegations produced):
- CRITICAL: Any CRITICAL finding → overall CRITICAL
- HIGH: 2+ HIGH findings, or 1 HIGH + 2 MEDIUM → overall HIGH
- MEDIUM: 1 HIGH, or 3+ MEDIUM → overall MEDIUM
- LOW: Only LOW/NIT/none → overall LOW

Map to verdict:
- ✅ **APPROVE** — LOW, no actionable findings
- 💬 **APPROVE WITH NITS** — MEDIUM, minor suggestions
- ⚠️ **REQUEST CHANGES** — HIGH, fixes needed before merge
- 🚫 **BLOCKED** — CRITICAL, blocking issues

### Step 5: Post to PR

If no PR was detected, output the full report to the terminal and stop.

#### 5a: Inline comments

For each finding with a specific file and line number, post an inline review
comment. Use the GitHub pull request review API to post all comments as a
single review (not individual comments):

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
  --method POST \
  -f event="COMMENT" \
  -f body="QA Swarm review complete. See inline comments." \
  -f commit_id="{HEAD_SHA}" \
  --jq '.id' \
  -f 'comments[]={path: "<file>", line: <line>, body: "<comment_body>"}'
```

If the review API is awkward to construct with many comments, fall back to
posting individual comments:

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
  --method POST \
  -f path="<file>" \
  -f line=<line> \
  -f commit_id="{HEAD_SHA}" \
  -f body="<comment_body>"
```

Each inline comment body uses this format:

```markdown
> [!NOTE]
> 🤖 Automated comment by **QA Swarm** — not written by a human

**[<reviewer_tag>]** <severity emoji> <severity>

<the finding body text>
```

Severity emojis: 🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM, 🟢 LOW, ⚪ NIT

For convergent findings (flagged by 2+ reviewers independently):

```markdown
> [!NOTE]
> 🤖 Automated comment by **QA Swarm** — not written by a human

**[convergent: <reviewer1> + <reviewer2>]** <severity emoji> <severity>

<merged finding body>
```

#### 5b: Summary comment — one sticky comment per PR, upserted

qa-swarm maintains exactly **one** top-level summary comment per PR, marked
with `<!-- qa-swarm-summary -->`. Re-runs (re-review rounds, later shepherd
iterations) **update that comment in place** instead of posting a new one —
multiple bot comments per PR is exactly the noise this repo is trying to kill.
The comment always shows the LATEST verdict; earlier rounds collapse into a
`<details>` history block so the audit trail survives without the length.

First find any existing summary comment:

```bash
gh api "repos/{owner}/{repo}/issues/{pr_number}/comments" --paginate \
  --jq '[.[] | select(.body | contains("<!-- qa-swarm-summary -->"))][0].id'
```

Build the body in this shape (current verdict on top, prior rounds folded):

```markdown
<!-- qa-swarm-summary -->
> [!NOTE]
> 🤖 Automated comment by **QA Swarm** — not written by a human
>
> Multi-perspective review: router (cheap-first pass) + delegated reviewers (qa-team, paul-reviewer, xp-reviewer, security-audit as warranted)

## Verdict: <emoji> <VERDICT> <sub>(round <N> @ <short_sha>)</sub>

<1-2 sentences explaining the verdict>

### Key findings

<bulleted list of the top findings, grouped by severity — current round only>

### Convergence

<findings flagged independently by 2+ reviewers — these are highest confidence>

### Reviewer summaries

| Reviewer | Assessment |
| --- | --- |
| 🧭 router | <1 sentence + danger/complexity assessment + what it delegated> |
<one row per reviewer that actually ran this round — omit rows for reviewers not delegated>

<details>
<summary>Previous rounds (<n>)</summary>

<for each prior round, one compact line: `round <N> @ <short_sha> — <verdict>: <1-line disposition>`.
When updating, derive these lines from the existing comment's current-verdict
header plus its own history block — the previous round's detail collapses to
one line, it is not carried verbatim.>

</details>

---
*Automated by QA Swarm — not a human review*
EOF
```

If a comment id was found, update in place; otherwise create:

```bash
# update
gh api "repos/{owner}/{repo}/issues/comments/{comment_id}" -X PATCH -F body=@/tmp/qa-summary.md
# create (no existing comment)
gh pr comment {pr_number} --body-file /tmp/qa-summary.md
```

The inline review comments from 5a are unaffected — they are threaded,
per-finding, and resolvable. Only the top-level summary is deduplicated.

### Graceful degradation

- **Router model (`@cf/zai-org/glm-5.2`) unavailable or rejected by the
  harness:** Run the router with no `model` pin (inherits the session model)
  if the session is already on glm-5.2; otherwise fall back to `sonnet` for
  the router. The router still produces a delegation plan; only the cost of
  the first pass changes.
- **A delegation target's body not found (qa-team files, paul-reviewer,
  xp-reviewer disk/store, security-audit MCP):** Skip that delegation target,
  warn the user, and let the router re-route that concern to another target
  if one fits (e.g. route a security concern the router itself can cover,
  since security-audit is unavailable). If the router can't safely cover it,
  surface it as a HIGH finding noting the reviewer was unavailable.
- **security-audit not found / PostHog MCP unavailable:** Skip
  security-audit delegation. Warn user (`security-audit: skip (MCP
  unavailable)`). This case is more likely than the on-disk skips above
  because it depends on a network call to the PostHog MCP server — treat it
  as the expected fallback when running offline or against a degraded MCP
  endpoint.
- **No PR detected:** Run all reviews, output report to terminal only. Offer to post if user provides a PR number.
- **Only the router available (no delegation targets):** Still post the
  router's findings. Better than nothing — the cheap pass is a real review.
