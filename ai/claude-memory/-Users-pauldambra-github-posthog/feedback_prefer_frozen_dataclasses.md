---
name: Prefer frozen dataclasses over NamedTuples
description: Paul prefers frozen dataclasses over typing.NamedTuple for small result/record types in Python code
type: feedback
originSessionId: 019d9e17-2697-757b-aa06-8e6e24de8abd
---
Prefer `@dataclass(frozen=True)` over `typing.NamedTuple` for small result/record types.

**Why:** Paul said so explicitly when reviewing a small result-bag type introduced to clean up a multi-value return. He prefers dataclasses and specifically frozen ones. Dataclasses are more flexible (can be subclassed, add methods cleanly, customize `__eq__`/`__repr__`), and `frozen=True` gives immutability without the tuple-inherited semantics. There's also a real mypy trap with NamedTuple: a field named `count` shadows `tuple.count` and fails strict typing.

**How to apply:** In new Python code, when you need a small value object to bundle multiple returns or to tag structured data, reach for `@dataclass(frozen=True)` first. Only use `NamedTuple` if tuple-semantics (iteration, indexing, unpacking) are actually wanted at call sites.
