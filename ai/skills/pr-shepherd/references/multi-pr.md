# Many PRs at once

Fetch this when one session coordinates more than one PR toward a shared goal.
Examples: a split refactor, a set of cuts against one budget, a stack plus its
siblings.

## Roles

- **Coordinator:** the main session. It does not shepherd a PR itself. It keeps
  the ledger, dispatches agents, enqueues on the user's standing rule, and
  reports.
- **Author:** an agent that writes code and opens PRs. It sends each PR link to
  the coordinator the moment the PR opens, then goes on with its next change. It
  does not shepherd its own PR, because that is the tail of the session that
  wrote the code (see "Where to run this").
- **Shepherd:** one top-level agent per PR, dispatched by the coordinator as soon
  as the link arrives. It runs this skill on that PR only.

Put the "send the link at once" rule in every author prompt. A PR that waits for
its author to finish a batch waits for review and CI with nobody watching.

## The ledger

Keep one ledger file per goal, for example `/tmp/<goal>-ledger.md`. A file
survives context compaction, agent stalls and a lost host. Conversation memory
does not.

One row per PR:

| PR | Change | Metric | State | Next step | Owner |
|---|---|---|---|---|---|

- **Metric:** the number the goal cares about, such as bytes cut or tests made
  faster. Write how it was measured. A number from the PR's own CI report is
  better than a local estimate.
- **State:** one of `authoring`, `shepherding`, `needs-human`, `ready`, `queued`,
  `merged`, `conflicting`, `stalled`, `dropped`.
- **Owner:** the agent that holds the PR now.

Update the row when an agent reports, before you write to the user.

## Reporting

The user should not read the whole table after every event.

- **On an event:** report only what changed. One or two lines: the PR link, the
  new state and the metric. Then the next step, if there is one.
- **The full table:** print it when the user asks for status, when a PR merges,
  or after about five events since the last table. Sort by state (`queued` and
  `ready` first, `needs-human` and `stalled` next), then by metric.
- **Totals:** add the metric for merged PRs and for open PRs, in separate lines.
  When each PR was measured alone against the same base, say that the open total
  is an estimate, because the cuts can overlap.
- **Needs a human:** put these PRs in a table, never in a run of paragraphs.
  One row per PR, with these columns: PR, what is needed, who can do it, why,
  and your recommendation. Use the same table when you ask the user a question
  about several PRs. A table lets the user scan the asks and answer each row.
- **Dropped work:** say what was not done and why, in one line each, so the user
  can decide.

## When a sibling merges

PRs toward one goal often edit the same file (a budget table, a guard list, a
baseline). After each merge:

1. Check the mergeable state of each open sibling.
2. For each conflicting sibling that is **not** in the merge queue, tell its
   shepherd to rebase and to take shared values (budgets, baselines) from a new
   measurement, not from either side of the conflict.
3. A sibling in the merge queue is never rebased or force-pushed. If the queue
   drops it for a conflict, rebase it, then enqueue it again.

## Stalls and lost tools

When an agent stalls or the host stops answering tool calls:

- Mark the row `stalled` with the last known head SHA and what was not pushed.
- When tools work again, check the PR's real state on GitHub first, because the
  queue may have merged it in the meantime.
- Resume the same agent with a message that names its worktree, its next step
  and the new master state. Do not start a new agent on the same PR while the old
  one may still push.
- Run builds and long waits in the background with a timeout. Many agents that
  build at the same time can starve the machine.
