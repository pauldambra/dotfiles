# Worked examples

Concrete preferences, and the principle each one serves. They're illustrations, not laws —
every one carries a guardrail against blind application. They come from Paul's practice, but
the reasoning is general. Adopt what serves your pair's values.

## Prefer `@dataclass(frozen=True)` over `typing.NamedTuple`

- **Principle:** make the impossible unrepresentable; correctness first.
- **Why:** frozen dataclasses give immutability without tuple semantics, subclass and add
  methods cleanly, and avoid a real strict-mypy trap — a NamedTuple field named `count`
  shadows `tuple.count` and fails type checking.
- **Apply:** reach for a frozen dataclass for small result/record types. Only use NamedTuple
  when you actually want tuple behaviour (iteration, indexing, unpacking) at the call site.

## Prefer bare `assert x == y` over `self.assertEqual(x, y)`

- **Principle:** tighten the feedback loop (correctness).
- **Why:** pytest rewrites bare asserts to show the diff and intermediate values; unittest's
  `assertEqual` / `assertIn` family just prints the operands.
- **Apply:** default to `assert` in new tests. Convert the lines you touch — but don't rewrite
  untouched assertions just for consistency. (Pragmatism guardrail: improve what you touch.)

## Parameterise tests of the same shape

- **Principle:** say everything once and only once.
- **Why:** two `it(...)` / `def test_*` blocks asserting the same logic with different inputs
  grow linearly and hide what's actually varying. A parameterised table stays constant-size
  and makes the matrix explicit.
- **Apply:** jest `it.each` / `describe.each`, pytest `parameterized`, Go table-driven tests.
  Refactor to it even at two rows. This is a just-do-it.

## Prefer kea listeners over kea-subscriptions

- **Principle:** no superfluous parts; make it fast.
- **Why:** subscriptions install a redux subscription that re-runs on every dispatch — slower
  for no benefit. A listener on the action that changed the value (or `afterMount` /
  `propsChanged` for prop-derived values) runs in the kea event loop instead.
- **Apply:** before reaching for `subscriptions(...)`, ask whether a listener covers it. Fall
  back only when there's truly no other hook.

## Replace a comment with a rename or an extract

- **Principle:** express every idea — without duplication or superfluous parts.
- **Why:** a comment that restates what the code does is a superfluous part that drifts out of
  date. The idea wants to live in a name or an extracted method.
- **Apply:** when you're about to write a comment, ask "should this be a rename?" or "should
  this be an extracted method?" first. Keep comments that explain *why* a non-obvious choice
  was made, not *what* the code does.

## Make the impossible unrepresentable before adding runtime checks

- **Principle:** correctness first.
- **Why:** a string-literal union the compiler enforces beats an extracted constant plus a
  runtime guard. Let the type system catch the mistake.
- **Apply:** prefer types/structures that make bad states impossible. Rule of thumb: if the
  type system can protect it, don't reach for a constant.

## Small testable module over a large method — unless it hides the behaviour

- **Principle:** correctness and reveal-intent, in tension.
- **Why:** a unit you can test and trust beats a sprawling method, but extraction that
  scatters the logic can make it *harder* to see what happens. Visibility can outrank
  decomposition.
- **Apply:** extract when the piece is independently meaningful and testable. Don't extract
  when inlining keeps the behaviour legible at a glance.

## Consider an A/B test for metric-moving changes

- **Principle:** measure the work — deliberately.
- **Why:** a flag flip leaves pre/post comparisons muddied by seasonality and concurrent
  launches. An experiment gives a clean read against a contemporaneous control. But it's a
  judgement call, not a blanket rule.
- **Apply:** when the change's *purpose* is to move a product metric, propose variants +
  primary metric + exposure event. For operational changes (perf, bug fix, refactor) a flag
  rollout is enough. Don't insist on an experiment for everything.
