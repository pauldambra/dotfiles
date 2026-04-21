---
name: qa-swarm
description: >
  Orchestrates three review skills (qa-team, paul-reviewer, xp-reviewer) into a
  single comprehensive PR review with inline GitHub comments. Use when the user
  asks for "qa-swarm", "swarm review", or wants a full multi-perspective review
  posted to their PR. Accepts an optional PR number or base branch as argument.
---

# QA Swarm: Multi-Perspective PR Review

Runs three independent review perspectives in parallel and posts findings as
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

Read the following files. If any skill's files are missing, warn the user and
skip that reviewer — the others still run.

**qa-team** (try these paths in order, stop at first hit):
1. `<repo_root>/.agents/skills/qa-team/SKILL.md` (use `git rev-parse --show-toplevel`)
2. `~/github/posthog/.agents/skills/qa-team/SKILL.md`

If found, also read from the same directory:
- `references/personas.md`
- `references/incident-patterns.md`

**paul-reviewer:**
- `~/.claude/skills/paul-reviewer/SKILL.md`
- `~/.claude/skills/paul-reviewer/references/real-review-examples.md`

**xp-reviewer:**
- `~/.claude/skills/xp-reviewer/SKILL.md`
- `~/.claude/skills/xp-reviewer/c2wiki-wisdom.md`

### Step 3: Launch 3 review agents in parallel

Launch ALL agents in a **single message** with multiple Agent tool calls so
they run in true parallel.

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

Collect all findings from the three agents.

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
> Multi-perspective review: qa-team (specialists + generalists), paul-reviewer, xp-reviewer

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

---
*Automated by QA Swarm — not a human review*
EOF
)"
```

### Graceful degradation

- **qa-team files not found:** Skip qa-team agent. Warn user. Run paul + xp only.
- **paul-reviewer not found:** Skip paul agent. Warn user. Run qa-team + xp only.
- **xp-reviewer not found:** Skip xp agent. Warn user. Run qa-team + paul only.
- **No PR detected:** Run all reviews, output report to terminal only. Offer to post if user provides a PR number.
- **Only one reviewer available:** Still run it and post findings. Better than nothing.
