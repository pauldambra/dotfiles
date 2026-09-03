# Narration

Skills run silently unless the assistant prints text between tool calls. Before
**every** step, emit one short line so the user can see what is happening without
watching raw tool output. One sentence, present tense.

Format: `[shepherd] <step> — <what and why>`

A silent 30+ second gap is the failure mode — err on the side of more lines.

Relay each dispatched sub-skill's returned `narration` lines verbatim. They
already carry their own `[triage]` / `[ci]` prefix; add the round number when
inside the quality loop.

## Examples

```
[shepherd] step 1 — resolving PR from gh pr view
[shepherd] step 1 — no change since a1b2c3d, stamphog present, no failing CI — skipping iteration
[shepherd] step 1 — PR is draft, marking ready before continuing
[shepherd] step 2 round 1 — diff since a1b2c3d touches src/foo.ts, running qa-swarm
[shepherd] step 2 round 1 — dispatching review-triage (sonnet runner)
[shepherd] step 2 round 2 — fixes landed in round 1, re-running qa-swarm + simplify
[shepherd] step 2 — round 2 dry, quality loop converged after 2 rounds
[shepherd] step 3 — dispatching ci-shepherd against H1=def4567
[shepherd] step 4 — applying stamphog at def4567; verdict so far: changes requested
[shepherd] iter done — handing back; re-invoke or let /loop drive the next pass
```
