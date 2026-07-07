---
name: review-triage
description: >
  Triages the review conversation on a PR: runs qa-swarm when there are
  substantive changes, classifies every unresolved review thread (qa-swarm,
  AI/bot, and human) as actionable / nit / ambiguous, applies the clear
  single-file fixes, resolves nits silently (reasons go in the report), runs
  ambiguous AI/bot threads through paul-pair's autonomy ladder before
  deferring so only genuine stop-and-ask cases reach a human, and defers any
  thread with human participation. It never posts thread replies — responses
  to humans always come from the PR author. Use when the user says
  "/review-triage", "triage the review comments", "deal with the bot
  comments", or "address the review feedback". Accepts an optional PR number
  or URL as argument. Does not touch the branch base or the stamphog label.
---

# Review Triage

Triages the review threads on a PR. Runs qa-swarm when there are substantive
changes, classifies every unresolved review thread (qa-swarm, bot, and human),
applies the fixes that are clear and localised, resolves nits silently, runs
ambiguous AI/bot threads through `paul-pair`'s autonomy ladder before
deferring (see *Judgement rules for auto-actioning a comment*), and always
defers threads with human participation to a human. Does **not** restack the
branch, watch CI, or manage the `stamphog` label — that is `ci-shepherd`'s and
`pr-shepherd`'s job.

**This skill never posts a comment to GitHub.** It never replies to a thread —
not to a human's (responses to humans always come from the PR author), not to
another bot's, not to its own. Bot threads it acts on are resolved silently;
the reasoning lives in the run report and narration instead of in-thread.

## Dual-mode — standalone vs `pr-shepherd` sub-step

This skill runs in two modes. **Standalone is the default.**

- **Standalone** (a human ran `/review-triage`, or it is wrapped in `/loop`):
  resolve the PR yourself, run qa-swarm when warranted (Step 2), narrate each
  step to the user, use `AskUserQuestion` when a genuine choice arises, and
  print a one-shot summary at the end.
- **As a `pr-shepherd` sub-step** (the invocation carries a sub-step brief with
  supplied inputs and a request to return JSON): the caller has already
  resolved the PR and already run qa-swarm this iteration, so **skip Steps 1
  and 2**. Triage existing threads only. **Never call `AskUserQuestion`** — you
  have no user to ask; ambiguous threads go to `deferred_threads` and never
  terminate. Do not narrate to the user; collect `[triage]` lines into a
  `narration` array and end with the single structured result in *Step 5*.

GitHub is the source of truth, so either mode is safely restartable.

## Narration — keep the user in the loop

Standalone: before **every** step below, emit a short one-line narration so the
user can see what's happening without watching raw tool output. Keep it terse —
one sentence, present tense. As a sub-step: emit the same lines into the
`narration` array instead of printing them.

Format: `[triage] <step> — <what and why>`

Examples:

```
[triage] step 1 — resolving PR from gh pr view
[triage] step 2 — diff since a1b2c3d touches src/foo.ts, running qa-swarm
[triage] step 2 — skip qa-swarm, only doc-only changes since a1b2c3d
[triage] step 3 — found 4 qa-swarm threads: 1 actionable, 2 nit, 1 ambiguous
[triage] step 3 — applying fix for thread #42 (rename foo to bar in src/foo.ts)
[triage] step 4 — 7 other threads: 3 greptile + 2 veria bot (2 nit resolved, 3 deferred), 2 human deferred
```

Narrate mid-step when a sub-action could take more than a few seconds (qa-swarm
invocation, pushing a fix). A silent 30+ second gap is the failure mode — err on
the side of more lines, not fewer.

## Workflow

### Step 1: Resolve PR + diff baseline (standalone only)

> Skipped as a `pr-shepherd` sub-step — the caller supplies the PR number,
> owner/repo, base, `head_sha_in`, `qa_swarm_marker_sha`, and `deferred_threads`.

If `$ARGUMENTS` looks like a PR number or URL, use it. Otherwise resolve
everything in **one** call — derive owner/repo from the `url` field
(`https://github.com/OWNER/REPO/pull/N`) instead of a second `gh repo view`:

```bash
gh pr view --json number,url,headRefName,baseRefName,headRefOid,state \
  --jq '{number, url, base: .baseRefName, head_sha: .headRefOid, state}'
```

Record: PR number, owner/repo (parsed from `url`), base branch, HEAD SHA, PR
state. If the PR state is `MERGED` or `CLOSED`, there is nothing to triage —
print that and stop.

Standalone, `qa_swarm_marker_sha` is your own per-run state (`null` on the first
pass; the HEAD you last ran qa-swarm at on subsequent passes within a `/loop`).

### Step 2: Run qa-swarm when warranted (standalone only)

> Skipped as a `pr-shepherd` sub-step — the orchestrator runs qa-swarm in its
> own main loop *before* dispatching this skill, to avoid nesting agent spawns.

Run qa-swarm when **either**:

- `qa_swarm_marker_sha` is `null` (first iteration), **or**
- HEAD SHA != `qa_swarm_marker_sha` **and** the diff
  `qa_swarm_marker_sha..HEAD` touches at least one non-doc file (i.e.
  something other than `*.md`, `*.txt`, or pure whitespace changes).

Invoke qa-swarm, resolved local-first then from the store so this works for
anyone: run `Skill("qa-swarm", args="<pr_number>")` if it's installed locally;
otherwise fetch its body from the PostHog skill store (`mcp__posthog__exec
command='call llma-skill-get {"skill_name":"qa-swarm"}'`) and follow it inline to
gather the diff and post the four-reviewer findings. After it completes set
`qa_swarm_marker_sha = HEAD_SHA`.

If skipping qa-swarm, log `qa-swarm: skip (no substantive changes since <sha>)`.

The non-doc-files rule is firm. If you want to skip qa-swarm despite qualifying
changes (e.g. you believe the new commits only address prior qa-swarm findings,
or the run would be pure churn), use `AskUserQuestion` to confirm before
skipping. Do not silently override -- a quiet skip hides judgement calls the
user may want to challenge. "Review fatigue" alone is not sufficient grounds.

### Step 3: Triage qa-swarm review threads

Fetch all review threads on the PR. Filter to unresolved, non-outdated threads
and trim each body to 1500 chars at the jq layer — bot reviews (qa-swarm, claude
review apps, coderabbit) can be tens of KB each, and fetching the full payload
every poll is the single biggest context cost of this loop. Bot comments put
their tag, severity, and finding summary in the first few hundred chars, so the
1500-char head is enough to classify; refetch the full body only for the one
thread you're about to action (see *Refetch full body before acting* below).

```bash
gh api graphql -f query='
  query($owner:String!, $repo:String!, $num:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$num) {
        reviewThreads(first:100) {
          nodes {
            id
            isResolved
            isOutdated
            comments(first:20) {
              nodes {
                databaseId
                author { login __typename }
                body
                path
                line
              }
            }
          }
        }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F num=<pr_number> \
  | jq '[
      .data.repository.pullRequest.reviewThreads.nodes[]
      | select(.isResolved == false and .isOutdated == false)
      | {
          id,
          path: .comments.nodes[0].path,
          line: .comments.nodes[0].line,
          author_login: .comments.nodes[0].author.login,
          author_type: .comments.nodes[0].author.__typename,
          first_comment_id: .comments.nodes[0].databaseId,
          body_head: (.comments.nodes[0].body[:1500]),
          body_truncated: ((.comments.nodes[0].body | length) > 1500),
          reply_count: ((.comments.nodes | length) - 1),
          participants: ([.comments.nodes[]
            | {login: .author.login, type: .author.__typename,
               automated: (.body[:200] | contains("🤖 Automated comment by"))}]
            | unique)
        }
    ]'
```

#### Human participation makes the whole thread human

Classify every comment in a thread, not just its first. A comment is
**automated** if either:

- its author is a bot account — `type == "Bot"`, login ends with `[bot]`, or
  login matches the known review-bot list in Step 4 (greptile, veria,
  coderabbit, cursor, sonarcloud, codescene, sourcery, ellipsis,
  stamphog/posthog-code, Claude review apps, Dependabot), **or**
- its body carries the `🤖 Automated comment by` header (the `automated` flag
  in the jq above). This is the load-bearing check for our own comments:
  qa-swarm and past review-triage runs post through the PR author's own
  account (typed `User`), so the header — not the account — is what marks
  them as bot-authored.

If **any** comment is neither — a real person authored the thread or replied
in it — the thread is **human**: defer it (no fix, no resolve, no reply),
whatever the first comment's author was. A human replying in a bot thread has
joined the conversation, and responses to humans always come from the PR
author. If you can't confidently classify a comment, treat it as human.

For each returned thread where `body_head` contains
`🤖 Automated comment by **QA Swarm**` and thread id is not in
`deferred_threads`:

First apply the human-participation gate above — a qa-swarm thread a human has
replied in is deferred, untouched. Otherwise classify the thread body:

- **Actionable & clear** — concrete single-file fix, severity HIGH or
  CRITICAL (convergent findings count as higher confidence), scope tight and
  unambiguous.
- **NIT / non-actionable** — style-only, speculative, duplicate, or already
  addressed.
- **Ambiguous** — architectural judgement, broad scope, or requires design
  decisions.

Handle each class:

- **Actionable:** apply the edit with `Edit`/`Write`, stage via Graphite MCP,
  commit with a message like `fix: address qa-swarm <short description>`, push
  via Graphite MCP, then resolve the thread — no reply; the commit SHA and a
  one-line description go in the narration and report. If `body_truncated ==
  true` for this thread, refetch the full body first (see *Refetch full body
  before acting* below) so the fix isn't based on a clipped suggestion.
- **NIT:** resolve the thread — no reply; record the one-line reason
  ("intentional — <reason>" / "out of scope — follow-up" / "disagree —
  <reason>") in the report's per-thread lines.
- **Ambiguous:** before deferring, run it through the `paul-pair` gate (see
  *Judgement rules for auto-actioning a comment*). If the gate promotes it to
  just-do-it or recommend-and-ask, act on it and resolve the thread (count it
  as `promoted`, not `deferred`). Only a genuine stop-and-ask adds the thread
  id to `deferred_threads`, unresolved, included in the end-of-run report.

To resolve a thread (never reply — resolving is the only mutation this skill
performs on a thread):

```bash
# resolve
gh api graphql -f query='
  mutation($thread_id:ID!) {
    resolveReviewThread(input:{threadId:$thread_id}) {
      thread { id }
    }
  }' -F thread_id=<id>
```

#### Refetch full body before acting

If you've classified a truncated thread as **Actionable**, refetch its full body
before generating the fix. This is the only path that should pull a full body
into context — and only for one thread at a time:

```bash
gh api graphql -f query='
  query($id:ID!) {
    node(id:$id) {
      ... on PullRequestReviewThread {
        comments(first:1) { nodes { body } }
      }
    }
  }' -F id=<thread_id>
```

**Ambiguous threads never cause termination.** They are added to
`deferred_threads` and surfaced in the report. The split keeps branch-currency,
CI, and stamphog management running (in `ci-shepherd` / `pr-shepherd`) while the
user decides on the architectural questions in their own time.

### Step 4: Triage every other unresolved thread (bots and humans)

Step 3 handled the qa-swarm threads; this step accounts for **every remaining**
unresolved, non-outdated thread from the same fetch (those whose body does not
start with the qa-swarm header). **Nothing is silently skipped** — each thread
ends in exactly one bucket: resolved, actioned, promoted, or deferred.

Classify each thread by its participants (see *Human participation makes the
whole thread human* in Step 3):

- **Review bot** — every comment in the thread is automated per Step 3's
  participation rule (bot account or `🤖 Automated comment by` header). The
  typename check alone is **not** enough: many review bots post through plain
  **user** accounts typed `User`, not `Bot` (this is exactly why Greptile and
  Veria inline comments get missed) — match logins containing `greptile`,
  `veria`, `coderabbit`, `cursor`, `sonarcloud`, `codescene`, `sourcery`,
  `ellipsis`, plus stamphog/posthog-code, Claude review apps, and Dependabot.
  Apply the Step 3 judgement rules: actionable -> fix and resolve; nit ->
  resolve, reason in the report; ambiguous -> run the `paul-pair` gate before
  deferring, exactly as in Step 3 — promoted cases get fixed and resolved,
  only genuine stop-and-ask cases go to `deferred_threads`. Never reply —
  other bots' threads get the same silent resolve as qa-swarm's.
- **Human** — any participant is a real person, whether they opened the thread
  or replied in it. **Never auto-fix, auto-resolve, or reply** — they want a
  response or a decision from the author, not a silent edit and not a bot
  reply. Add it to `deferred_threads` and surface it in the report as
  human-participated. (Standalone, you may offer a trivial, obviously-correct
  fix via `AskUserQuestion` — but even an approved fix gets no reply and no
  resolve: push the fix, leave the thread open, and report "fixed in <sha>,
  thread left open for your reply". As a `pr-shepherd` sub-step, just defer.)

If you can't confidently place a participant, treat them as human and **defer
rather than ignore** — a surfaced thread is recoverable, a dropped one is not.

> A stamphog "approval dismissed" comment is a protocol signal, not a review
> thread — ignore it (don't reply, resolve, or treat it as actionable). Triage
> the bot's review *content* here; the `stamphog` label itself is `pr-shepherd`'s
> concern, not this skill's.

#### Skip stale bot reviews

Before classifying a bot review as actionable, check whether it is against the
current HEAD:

- inline review thread comments -- already filtered by `isOutdated=false` in the
  GraphQL query.
- top-level PR comments (e.g. Greptile review summaries) -- scan the body for a
  commit SHA reference. Common patterns: "reviewing commit `<sha>`", "in
  `<sha>`", or a GitHub commit link of the form `/commit/<sha>`. If a referenced
  SHA is present and != HEAD_SHA, skip the comment as stale. The bot will
  re-evaluate the new HEAD shortly.

When in doubt (no SHA reference but the review predates the latest commit by
more than one push), prefer skipping to acting -- a stale fix is worse than a
small wait.

### Step 5: Report

**Standalone:** print a one-line summary —

```
[triage] done — sha=<short_sha> qa-swarm=<ran|skip> resolved=<n> actioned=<n> promoted=<n> deferred=<n>
```

`promoted` is the count of ambiguous threads the `paul-pair` gate resolved
(just-do-it or recommend-and-ask) instead of deferring — see *Judgement rules
for auto-actioning a comment*. Break `deferred` down by author, e.g.
`deferred=5 (3 ambiguous bot, 2 human)`. The counts must **reconcile**: every
unresolved non-outdated thread you fetched ends as resolved, actioned,
promoted, or deferred — never seen-but-unhandled. List each deferred thread's
author, `file:line`, and a one-line reason under the summary, and each
resolved thread's `file:line` with the reason or commit SHA — since resolves
carry no reply, the report is the only audit trail. Then hand back (the skill
does not sleep or self-loop; wrap in `/loop` for cadence).

**As a `pr-shepherd` sub-step:** end with exactly this structured result and
nothing after it —

```json
{
  "head_sha_in": "<HEAD when this skill started>",
  "new_head_sha": "<HEAD after any fixes; == head_sha_in if none>",
  "qa_swarm_ran": false,
  "qa_swarm_marker_sha": "<unchanged from input — the orchestrator owns the qa-swarm run>",
  "resolved": 0,
  "actioned": 0,
  "promoted": 0,
  "deferred_threads": ["<id>"],
  "unresolved_actionable_remaining": false,
  "narration": ["<one [triage] line per step taken>"]
}
```

Set `unresolved_actionable_remaining` to `true` if any unresolved thread you saw
would be actionable but you could not safely auto-fix it (so the orchestrator
knows the actionable state is not clean).

## Judgement rules for auto-actioning a comment

A thread is **actionable** only if **all** of these hold:

- Severity is HIGH or CRITICAL (or it's a convergent finding across reviewers —
  those carry higher confidence).
- The fix is described concretely enough that a reader knows exactly what to
  change (a specific rename, a missing null check, a typo, a forgotten await, an
  obvious off-by-one).
- The change is localised — a single file, or at most a small set of tightly
  related edits.
- Applying it does not require new design decisions, new dependencies, or
  altering the PR's scope.

Otherwise the thread is either a NIT (auto-resolve, reason in the report) or
**ambiguous**.

### The paul-pair gate — before deferring an ambiguous AI/bot thread

An ambiguous thread is not automatically a deferral. Resolve `paul-pair`
local-first, then the store (same pattern as `qa-swarm` — see *Dependencies*),
and apply its autonomy ladder to the thread's suggested change:

- **Just do it** — the outcome is unambiguously better and there's essentially
  one sensible way to get there (a trivial, reversible improvement). Apply the
  fix, commit, push, resolve the thread (no reply — commit SHA and description
  in the report). Count it as `promoted`, not `deferred`.
- **Do it, but recommend and ask** — more than one reasonable solution exists.
  Make the call, apply it, commit, push, resolve the thread — and the report
  entry must state the one-line reasoning and the alternative considered (e.g.
  "did X because Y — alternative was Z, shout if you'd rather Z"). Count it as
  `promoted`. Surface these prominently in the report/narration (not folded
  silently into a bare count) so the human can redirect cheaply if they'd
  rather the alternative.
- **Stop and ask** — it would violate one of the four rules of simple design,
  or it's genuinely unclear which outcome is better. This is the only outcome
  that still adds the thread to `deferred_threads`, unresolved.

This gate applies to ambiguous **qa-swarm and bot** threads only (Steps 3-4).
It never applies to the human-participated bucket — those are always deferred,
never auto-fixed, regardless of how trivial the change looks; that rule
protects the human review conversation, which is a different concern from
judging a fix's difficulty.

**Invariant: an all-bot thread that has been addressed always ends resolved —
silently; this skill never posts a thread reply.** The only threads left open
are genuine stop-and-ask (paul-pair-confirmed) and anything with human
participation. When in doubt about whether a fix is safe to apply at all,
that doubt itself is the stop-and-ask signal — a nagging status line is
cheaper than a wrong push.

## Terminal conditions (standalone only)

Stop cleanly and print the report when **any** of:

- PR is `MERGED` or `CLOSED`.
- Every unresolved thread has been classified and handled (fixed, resolved, or
  deferred) — nothing autonomous left to do.
- The user interrupts.

Ambiguous review findings are **not** a terminal condition; they go to
`deferred_threads` and are surfaced in the report.

## Dependencies

- **`qa-swarm`** — orchestrates the four review agents (qa-team, paul-reviewer,
  xp-reviewer, security-audit), resolved local-first then from the PostHog skill
  store: run `Skill("qa-swarm")` if installed, else `llma-skill-get` its body and
  follow it inline. qa-swarm itself owns loading each reviewer's body. (Standalone
  only; as a `pr-shepherd` sub-step the orchestrator runs qa-swarm.)
- **`paul-pair`** — autonomy-ladder gate applied to ambiguous qa-swarm/bot
  threads before deferring (see *The paul-pair gate*), resolved local-first
  then from the PostHog skill store, same pattern as `qa-swarm`.
- `gh` CLI (repo, pr, api commands).
- Graphite MCP for git operations (commit/push for fixes). Fall back to
  `gh`/`git` only when Graphite doesn't cover a case.

## Graceful degradation

- **qa-swarm skill missing:** warn and continue — still triage the bot threads
  (Step 4). The skill still provides value without a fresh qa-swarm run.
- **paul-pair skill missing:** warn and skip the gate — treat every ambiguous
  thread as stop-and-ask (defer), the safer fallback when the ladder isn't
  available to consult.
- **No PR detected (standalone):** print a short note asking the user to pass a
  PR number or URL, then stop.
- **User interrupts mid-run:** stop at the next natural checkpoint and print the
  report.
