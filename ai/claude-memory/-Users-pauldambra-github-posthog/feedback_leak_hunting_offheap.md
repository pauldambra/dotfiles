---
name: Leak hunting targets off-heap, not JS heap
description: When investigating memory leaks in PostHog frontend, measure process/off-heap memory (detached DOM, GPU, workers, native allocations) rather than the JS heap.
type: feedback
originSessionId: 019e1c50-08a5-701e-9ccf-9e5bfaf7b952
---
When hunting memory leaks in the PostHog frontend, the signal we care about is **off-heap growth**, not JS heap growth.

**Why:** The leaks we've seen in practice (detached DOM nodes from modals that don't unmount, canvas/chart buffers, retained subscriptions holding native handles) live outside V8's `usedJSHeapSize`. `performance.memory` is incomplete and misleading for this work — you can have an apparently flat JS heap while the process bloats. Detached DOM and native allocations are the actual cost driver.

**How to apply:**
- Do not propose `performance.memory.usedJSHeapSize` as the primary metric.
- Prefer `performance.measureUserAgentSpecificMemory()` (includes DOM/workers/cross-origin) when same-origin-isolated, or drive Chrome via CDP `Memory.getProcessMemoryUsage` / `Memory.getAllTimeSamplingProfile` for full process memory.
- Pair memory samples with `__leakHunter.scan` (detached node counts) — that signal is also off-heap and is what we actually shipped the tool to measure.
- Always force GC (CDP `HeapProfiler.collectGarbage` or the existing helper in `tools/leak-hunter/`) before each sample so we measure retained memory, not transient.
