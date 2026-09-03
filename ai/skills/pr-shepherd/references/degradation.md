# Graceful degradation

Fetch this when something you need is missing or failing.

**Say which degradation you took, in the narration and the summary.** A shepherd
that quietly runs with two of three runners missing looks identical to one that
ran clean, and the user has no way to tell the verdict is thin.

- **`review-triage` missing:** warn and continue with `ci-shepherd` + stamphog.
  You lose the triage signal (resolved/deferred counts), but stamphog is still
  applied and its verdict still read.
- **`ci-shepherd` missing:** warn and skip the branch update + CI repair; run the
  quality loop and apply stamphog against `H1` (no further HEAD movement). Report
  CI as unknown.
- **`qa-swarm` missing:** warn and skip the qa-swarm gate for every round;
  review-triage still triages whatever bot threads exist, and simplify still
  runs.
- **`simplify` unavailable** (not in the harness and the store fetch failed):
  warn and skip Step 2c for every round — the quality loop still runs qa-swarm +
  review-triage, it just never applies a simplification pass.
- **A sub-skill body only partially loaded:** treat it as missing. Running a
  fragment means running without its terminal conditions and its own degradation
  rules, which live at the end of every skill.
- **`Agent` can't be spawned:** for `review-triage` / `ci-shepherd`, fall back to
  running the sub-skill body inline in the main loop (read the SKILL.md and
  follow it directly). For `simplify`, fall back to running it inline (built-in
  `Skill("simplify")`, or following the store body directly) instead of a
  wrapping Agent. It then runs on the session model, which is the expensive one —
  so under a budget, prefer skipping a runner to running it inline. Keep the same
  evidence and validation rules.
- **No model below the session model can be dispatched:** every runner will cost
  session-model rates. Narrate that, and cut the round cap to 2.
- **No PR detected:** prompt the user (see Step 1) to paste a PR number/URL or
  let the shepherd open a PR via `gh pr create`. Only stop if the user cancels.
- **User interrupts mid-iteration:** stop at the next natural checkpoint and
  print the final summary.
