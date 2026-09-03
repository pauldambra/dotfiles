# Step 5 output formats

Fetch this when you reach Step 5.

## Iteration summary

```
[shepherd] iter done - sha=<short_sha> models=<qa:model,triage:model,simplify:model,ci:model,validators:[model,...]> qa-swarm=<ran|skip> rounds=<n> resolved=<n> actioned=<n> promoted=<n> simplify=<changed n files|clean> deferred=<n> ci=<pass=N pending=N fail=N> ci-repair=<committed|none|blocked> rerun=<n> stamphog=<applied|already|skipped> verdict=<approved|changes|dismissed|pending> stopped=<converged|round-cap>
```

`models` records the model used for each sub-skill and each validation. `rounds`
is how many quality-loop rounds ran this iteration (1-4). `resolved` /
`actioned` / `promoted` / `deferred` are summed across all rounds. CI counts are
the snapshot observed before any repair push. `stopped` says why the quality loop
ended.

If there are deferred threads, print their `file:line` and one-line reason under
the status line. Summarize fixed root causes and validation, queued reruns, and
unresolved CI failures with their classifications. If stamphog requested changes
or dismissed, print its one-line reason.

## State line

Print this so the next caller (the user, or `/loop`) can re-supply it:

```
[shepherd] state — qa_swarm_marker_sha=<sha|null> simplify_marker_sha=<sha|null> stamphog_applied_for_sha=<sha|null> deferred_threads=[<id>,...] last_updated_at=<iso8601|null>
```

Set `last_updated_at` from the `updatedAt` returned by Step 4's combined verdict
read — it runs after your actions, so the next fast-path check compares against a
post-action baseline. No separate re-read is needed.

## Final summary (terminal conditions only)

When the loop stops for good, list:

- commits pushed (with short SHAs and messages),
- threads resolved (count, grouped by "fixed" / "nit", each with the reason or
  commit SHA — resolves carry no reply, so this is the only audit trail),
- threads deferred (with file:line and one-line reason each),
- final CI state, stamphog verdict, label state, and PR merge state.
