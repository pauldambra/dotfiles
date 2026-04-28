---
name: Always parameterise tests when possible
description: Reach for parameterised tests by default when writing more than one variation of the same assertion, in any language; multiple sequential `it(...)` / `def test_*` blocks asserting the same logic with different inputs is a smell to refactor before pushing
type: feedback
originSessionId: 019dce82-347d-757d-9e20-a8e50974191d
---
When writing multiple test cases that exercise the same logic with different
inputs, default to a parameterised form (jest `describe.each` / `it.each`,
pytest's `parameterized` library, Go table-driven tests). Don't ship two or
more sequential `it(...)` / `def test_*` blocks that assert the same shape
with different fixtures.

**Why:** the user has stated this preference twice now — once in
`AGENTS.md` ("Tests: prefer parameterized tests... if you're writing
multiple assertions for variations of the same logic, it should be
parameterised") and once in conversation reinforcing it as `always`. Two
similar tests grow linearly with future cases and obscure what's actually
being varied; parameterised tests make the matrix explicit and stay
constant in size.

**How to apply:** before pushing tests, ask yourself "are two of these
testing the same thing with different inputs?" If yes, refactor to a
parameterised form, even if the matrix only has 2 rows today. Especially
true when reviewing your own qa-swarm output — convergent feedback from
multiple reviewers on test parameterisation should be auto-actioned, not
deferred.
