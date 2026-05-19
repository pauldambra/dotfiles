---
name: Prefer plain `assert x == y` over `self.assertEqual` in Python tests
description: Use bare `assert` statements (assert x == y, assert x in y, etc.) rather than unittest's self.assertEqual / self.assertIn family in Python tests
type: feedback
originSessionId: 019dd5ce-2cd9-722f-8cd7-d91db603412a
---
In Python tests, prefer plain `assert` statements over `self.assertEqual(x, y)`, `self.assertIn(x, y)`, `self.assertNotIn(x, y)`, `self.assertIsNone(x)`, etc. Use `assert x == y`, `assert x in y`, `assert x not in y`, `assert x is None`.

**Why:** pytest's failure output for bare `assert` is much more informative — it shows the diff and intermediate values. unittest's assertEqual and friends just print the values without the rich introspection.

**How to apply:**
- When writing new tests, default to `assert` style.
- When modifying tests in a file that already uses `self.assertX`, prefer converting the lines you touch rather than matching the existing style.
- Don't reflexively convert untouched code in the same file just for consistency — only the lines/blocks you're changing.
