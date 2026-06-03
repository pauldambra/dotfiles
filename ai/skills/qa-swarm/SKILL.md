---
name: qa-swarm
description: >
  Orchestrates four review skills (qa-team, paul-reviewer, xp-reviewer,
  security-audit) into a single comprehensive PR review with inline GitHub
  comments. Use when the user asks for "qa-swarm", "swarm review", or wants a
  full multi-perspective review posted to their PR. Accepts an optional PR
  number or base branch as argument.
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

Load the four reviewer bodies. qa-team is on disk; paul-reviewer and xp-reviewer
resolve local-first then from the PostHog skill store; security-audit is
store-only. If any reviewer's content is unavailable (not on disk or in the
store), warn the user and skip that reviewer — the others still run.

Issue all four loads in **parallel** (single message, four tool calls) so the
MCP round-trip does not serialize with the on-disk reads.

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
unavailable, log `security-audit: skip (MCP unavailable)` and continue with
the other three reviewers.

### Step 3: Launch 4 review agents in parallel

Launch ALL agents in a **single message** with multiple Agent tool calls so
they run in true parallel.

Spawn every one of these review agents with `model: 'opus'`. Review is the
reasoning-heavy part of the loop and must stay sharp even when the caller
(e.g. pr-shepherd's runner) is on a cheaper model. Pin the model explicitly
on each Agent call rather than inheriting the session/caller model.

Each agent is told it is the sole reviewer. Each must return findings in the
structured format described in "Agent output format" below.

#### Agent 1: qa-team

Pass the full qa-team SKILL.md content into the agent prompt, but tell it the
diff is already gathered (skip its Step 1). Include the personas and incident
patterns inline in the prompt. The agent follows the qa-team workflow from
Step 2 onward (classify files, launch its own sub-agents, synthesize).

Tell it to return its final findings list (not the QAREPORT.md file) in the
structured output format below, with `reviewer` tags like `qa-team/security`,
`qa-team/database`, etc.

#### Agent 2: paul-reviewer

Pass the full paul-reviewer SKILL.md content and real-review-examples into the
agent prompt, along with the diff. Tell it to review the diff in Paul's voice
and return structured findings with `reviewer: paul`.

#### Agent 3: xp-reviewer

Pass the full xp-reviewer SKILL.md content and c2wiki-wisdom into the agent
prompt, along with the diff. Tell it to review the diff in the XP voice and
return structured findings with `reviewer: xp`.

#### Agent 4: security-audit

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
(see "Agent output format" below) with these mappings:

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
"Agent output format" section below.

#### Agent output format

Every agent must end its response with findings in this exact format:

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

Collect all findings from the four agents.

**Deduplication:** If multiple reviewers flagged the same file+line (within 5
lines) or clearly the same concern, merge them into a single finding. Note the
convergence — convergent findings carry higher confidence.

**Verdict** (using qa-team risk scoring if the qa-team agent ran):
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

#### 5b: Summary comment

Post a single top-level PR comment with the overall report:

```bash
gh pr comment {pr_number} --body "$(cat <<'EOF'
> [!NOTE]
> 🤖 Automated comment by **QA Swarm** — not written by a human
>
> Multi-perspective review: qa-team (specialists + generalists), paul-reviewer, xp-reviewer, security-audit

## Verdict: <emoji> <VERDICT>

<1-2 sentences explaining the verdict>

### Key findings

<bulleted list of the top findings, grouped by severity>

### Convergence

<list any findings flagged independently by 2+ reviewers — these are highest confidence>

### Reviewer summaries

| Reviewer | Assessment |
| --- | --- |
| 🔍 qa-team | <1 sentence> |
| 👤 paul | <1 sentence> |
| 📐 xp | <1 sentence> |
| 🛡 security-audit | <1 sentence> |

---
*Automated by QA Swarm — not a human review*
EOF
)"
```

### Graceful degradation

- **qa-team files not found:** Skip qa-team agent. Warn user. Run the other three.
- **paul-reviewer not found (disk or store):** Skip paul agent. Warn user. Run the other three.
- **xp-reviewer not found (disk or store):** Skip xp agent. Warn user. Run the other three.
- **security-audit not found / PostHog MCP unavailable:** Skip security-audit
  agent. Warn user (`security-audit: skip (MCP unavailable)`). Run the other
  three. This case is more likely than the on-disk skips above because it
  depends on a network call to the PostHog MCP server — treat it as the
  expected fallback when running offline or against a degraded MCP endpoint.
- **No PR detected:** Run all reviews, output report to terminal only. Offer to post if user provides a PR number.
- **Only one reviewer available:** Still run it and post findings. Better than nothing.
