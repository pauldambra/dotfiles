---
name: hunt-memory-leaks
description: >
  Hunt browser memory leaks using all available signals — off-heap renderer
  process growth (phys_footprint/RSS), detached DOM element counts, heap
  snapshot diffs, network activity, CDP performance metrics, and
  memory-infra allocator traces. Covers the multi-tab Playwright harness,
  production cmd-click testing, memlab MCP heap analysis, in-browser
  __leakHunter helpers, CDP forced-GC, Apple footprint tool, and
  memory-infra traces. Use when the user says "browser tabs use gigabytes",
  "renderer RSS growing", "phys_footprint climbing", "memory leak",
  "tabs slow/crash", "hunt detached elements", "investigate react memory
  leaks", "find detached nodes", or asks to investigate PostHog's memory
  problem.
---

# Hunt browser memory leaks

## Production reality — read this first

This is a real, ongoing production issue at PostHog. The user reports:

- **Many users see multi-gigabyte memory** when hovering over a Chrome
  tab in the OS task bar / Chrome's task manager. Reports up to
  **11 GB in a single tab**.
- **The browser crashes.** Multiple user reports of OOM kills.
- The leak is observed **on page load, in active tabs, AND in
  background/idle tabs**. Don't assume it requires interaction. Don't
  assume the active tab is the only one growing.
- **`performance.memory.usedJSHeapSize` lies — or rather, it only tells
  part of the story.** A tab can report 200 MB JS heap while the
  renderer process is at 2 GB. The bulk of the leak is non-V8:
    - Blink-side DOM, layout, and style objects
    - `system / ExternalStringData` (V8 strings whose backing bytes
      live in C++) — grows with every script load, sourcemap, and
      large API response
    - Image bitmaps, canvas backing buffers, WebGL textures
    - Decoded media (video frames in session replay)
    - Network response cache
    - Service Worker / Worker memory
    - V8 bytecode caches and per-module debug info (dev-mode only,
      but still ~100 MB on top of everything else)

**Source of truth = Chrome's Task Manager** (Window -> Task Manager, or
`chrome://memory-internals`). The `performance.memory` JS heap is a
*subset* of the renderer process memory and routinely understates the
problem by 10x.

**Dev-mode artifacts cannot explain the production leak.** Vite source
maps and HMR caches add overhead, but the leak is observed in production
where none of that is present. Any finding that is only reproducible in
dev mode is not the root cause.

**Detached count != memory.** A tab with 0 detached elements can still
leak gigabytes (long Max conversation with rendered markdown, session
replay buffering frames, a chart redrawing into a fresh canvas each
tick, a Monaco editor that never disposes its model registry). Always
measure both detached count AND renderer memory trend. If one is flat
and the other grows, the growth is non-DOM and you need different
tools (heap snapshot type/name aggregates, `Memory.getDOMCounters`,
`Performance.getMetrics`, image cache inspection).

**Multi-tab is not optional in the methodology.** Production users
routinely have 3-7 PostHog tabs open. The leak hits idle background
tabs too. Use `measure-cmdclick-sidebar.mjs` (headed, against production)
to open tabs via cmd-click and sample phys_footprint per renderer process.
Look for monotonic growth in any tab regardless of which is foreground.

**Three rules to apply before drawing any conclusion:**

1. **Don't over-correct on a single data point.** One trial, one growing
   tab, one snapshot's retainer chain — these are leads, not conclusions.
   Plan >=3 trials. Ask: was the data representative? (demo vs real data,
   headless vs headed, visibility state correct?)

2. **Production data is the best signal for identification; local tests
   are for iterating on fixes.** Production accounts have real data
   volumes, active polling, and real user patterns — use them to confirm
   the leak is present and to identify which scene/behaviour causes it.
   Once you have a hypothesis, use local tests to iterate quickly on
   candidate fixes. Demo (Hedgebox) is too sparse to reproduce the leak
   reliably — "no growth on demo" does not mean the fix worked.

3. **Detached-element counts are not the right signal for multi-GB tab
   growth.** If `heap_used_mb` is flat but renderer RSS grows, you need
   the off-heap path (Step 7.5), not this one.

## Signals and tools

Use all available signals together — not in isolation. Ranked by signal
strength for renderer process memory growth (the dominant production
complaint):

### Diagnostic signals

1. **phys_footprint / renderer RSS** — renderer process private memory.
   Apple `footprint -p <pid>` on macOS; Chrome Task Manager on all
   platforms. This is the primary signal. A tab reporting 200 MB JS heap
   while the renderer process is at 2 GB is a phys_footprint problem.

2. **Detached DOM element counts** — via `window.__leakHunter` (MemLab/
   lens). One proxy signal; misses everything off-heap. Non-zero counts
   after forced GC indicate React components not unmounting. Zero counts
   do NOT mean the tab is healthy.

3. **Heap snapshot diffs** — JS object retention, retainer chains, type
   histograms. Useful for `system / ExternalStringData` growth and
   confirming the shape of on-heap leaks. Load `.heapsnapshot` files via
   memlab MCP. Forced GC at snapshot time can suppress the leak signal —
   use carefully.

4. **Network activity** — background polling, excessive fetches, unbounded
   response caches. CDP `Network.requestWillBeSent` events reveal requests
   firing from idle tabs. Look for polling intervals that continue after
   tab is backgrounded.

5. **CDP performance metrics** — DOM node count, JS event listener count,
   layout/recalc counts via `Performance.getMetrics`. Useful for ruling
   in or out DOM accumulation independent of React fiber state. Note:
   `JSEventListeners` count varies across samples as a timing artifact —
   don't chase variations; look for monotonic trends only.

6. **memory-infra traces** — allocator-level breakdown: partition_alloc,
   parkable_strings, blink_gc, cc/tile. `chrome://tracing` or CDP
   `Tracing.start` with `memory-infra` category. The only way to
   attribute off-heap bytes to a specific C++ allocator bucket. Use when
   phys_footprint is growing but heap snapshots show flat JS heap.

### Essential tools

- **memlab MCP** — `mcp__memlab__*` — load heap snapshots, find largest
  objects, trace retainers, find detached DOM, inspect object shapes.
  Use this when you have a `.heapsnapshot` file on disk. Key tools:
  `memlab_load_snapshot`, `memlab_largest_objects`, `memlab_retainer_trace`,
  `memlab_detached_dom`, `memlab_class_histogram`, `memlab_snapshot_summary`.

- **Playwright MCP** — `mcp__playwright__*` — drive browser, navigate tabs,
  evaluate JS in tabs, take screenshots, measure heap via
  `browser_evaluate`. Essential for any reproducible test sequence. Use
  `browser_evaluate` to call `window.__leakHunter.scan()`, trigger GC,
  and collect metrics.

- `tools/leak-hunter/idle-leak-test.mjs` — headless multi-tab idle harness,
  per-tab phys_footprint. Primary harness for off-heap investigation.

- `tools/leak-hunter/measure-cmdclick-sidebar.mjs` — headed production-
  realistic cmd-click multi-tab test against a real account.

- `tools/leak-hunter/measure-multitab-footprint.mjs` — per-tab
  phys_footprint with visibility emulation.

- `tools/leak-hunter/measure-tab-footprint.mjs` — single tab N-reload
  phys_footprint measurement.

- `tools/leak-hunter/stream-heap-analyzer.py` — streaming heap snapshot
  analysis for files >512 MB (avoids OOM when loading enormous snapshots).

- `tools/leak-hunter/measure-cmdclick-instrumented.mjs` — headed
  production cmd-click test with **adaptive deep instrumentation**: samples
  phys_footprint each cycle; when any tab crosses the growth threshold
  (configurable, default delta >200 MB AND absolute >600 MB), automatically
  attaches CDP network event subscription to that tab and takes periodic
  heap snapshots. This is the primary tool for attributing growth to a
  specific cause once you've confirmed which tab is leaking.

- `tools/leak-hunter/memory-infra-trace.mjs` — capture allocator breakdown
  via CDP Tracing with `memory-infra` category.

## Known facts — anchor before re-investigating

These are verified, repeatedly confirmed observations. Treat them as
load-bearing constraints. Do NOT re-litigate them on a new investigation
session without strong new evidence.

**The leak is multi-scene, multi-user, severe:**
- Observed on /home, /dashboard, /insights, /replay, /feature_flags,
  /error_tracking, and others in production. Not one specific scene.
- Reports of >6 GB in multiple tabs simultaneously. Browser crashes (OOM).
- Problem predates the product-tours feature. Not posthog-js related
  (disabling posthog-js was tested — same steady-state renderer RSS).

**The leak is OFF-HEAP (phys_footprint, not JS heap):**
- JS heap stays ~120-140 MB per tab. The renderer process grows to 1-4 GB+.
- Source of truth: Apple `footprint -p <pid>` (macOS) or Chrome Task Manager.
- `performance.memory.usedJSHeapSize` understates the problem by 10x.

**Demo data does NOT reproduce the leak reliably:**
- Hedgebox demo (local dev stack) has sparse data — dashboards with 3 tiles,
  tiny event volumes, no ongoing polling at scale.
- Tests on demo may show normal or small growth even when production leaks.
  "Didn't reproduce on demo" is NOT evidence the leak is fixed.
- Always confirm suspected fixes against a real production account
  (see Step 7.5 -> "Testing against production").

**Headless Chromium does NOT reproduce background-tab behaviour:**
- Headless chromium reports all tabs as `document.visibilityState=visible`
  regardless of focus. Visibility-change handlers never fire.
- Background-tab growth in headless measures "all tabs foreground + idle"
  — a pathological scenario that over-counts.
- Use headed Chromium with cmd-click tab opening for production-realistic
  visibility behaviour (see `measure-cmdclick-sidebar.mjs`).

**Confirmed root causes (fixed) and open work:** See
`references/known-findings.md` — load it at the start of every
investigation to avoid re-deriving what's already been tried.

## The leak is OFF-HEAP. Repeat: OFF-HEAP.

**If you are measuring `heap_used_mb` per tab and concluding anything, stop.**
The production report is **11 GB renderer process** in a single tab. That
number cannot be in V8's JS heap — V8 caps the per-isolate heap well below
that. The bulk lives in **Blink/native renderer allocators**:

- Image bitmaps, canvas backings, WebGL textures
- Decoded media (session replay frames in particular)
- `system / ExternalStringData` (V8 strings whose backing bytes are C++)
- Network response cache
- Paint records, compositor layer caches, layout objects
- Service Worker / Worker memory
- V8 bytecode caches and per-module debug info

**The only authoritative signal is renderer process RSS** (`ps -o rss=`).
Sample it via the `idle-leak-test.mjs` harness — it already does the right
thing (sums per-renderer-PID RSS filtered to the playwright user-data-dir).

**Common dead-end agents hit (verified again 2026-05-15):**

- Measuring per-tab `JSHeapUsedSize` and seeing +16 MB over 20 min on
  `/feature_flags` while neighbours are idle — IGNORE this. It's V8 heap
  churn, not the leak. The same run will show renderer RSS *reclaiming*.
- Counting `addEventListener` net adds via instrumentation — clean to net
  zero. The renderer is still leaking off-heap. Native listeners (e.g. from
  IntersectionObserver, MutationObserver, paint, compositor) don't go
  through `EventTarget.addEventListener` so a clean count tells you nothing.
- CDP `Performance.getMetrics` `JSEventListeners` count varying across
  samples — it's a timing artifact, not real accumulation. Don't chase.
- Heap snapshot diff by constructor — useful for *on-heap* problems and
  for finding `system / ExternalStringData` growth specifically, but the
  diff overhead (forced GC at start) often suppresses the leak signal
  entirely. Use heap snapshots to look for `system / ExternalStringData`
  total size, image-backed strings, and `(string)` totals. Ignore counts
  of small JS objects.

The leak is **bimodal** — sometimes a run leaks +2 GB renderer RSS in 30
minutes, sometimes it reclaims cleanly. Verified in the 6-trial control
arm (one trial +2237 MB, two trials -10 to -947 MB). Single-trial-per-arm
tests can mislead. Use >=3 trials per arm when comparing configurations.

20-minute runs are usually too short to catch the runaway. **Run for at
least 30 minutes**, preferably 60+, when looking for the off-heap class.
Short runs only catch on-heap churn, which is not the leak.

## The canonical test pattern

The canonical unit is a set of real user tabs opened via cmd-click in
headed Chromium against production. Measure phys_footprint per renderer
process. Use all available signals together — not in isolation.

**Solo-tab measurements are misleading and will send you down the wrong
rabbit hole.** Confirmed empirically (2026-05-14):

- `/feature_flags?tab=overview` measured in isolation for 30 min idle:
  page CLEANED UP. Nodes 6505 -> 5340, listeners 4207 -> 2375, heap
  119 -> 116 MB, renderer RSS 2402 -> 528 MB. *Looks healthy.*
- The same page as one of 6 idle tabs while a 7th tab was active:
  **+45 MB heap, +160 MB renderer RSS over 30 min**. Real leak signal.

The leak only manifests **when other tabs are doing something** — even
fully-idle tabs collecting nav events, broadcast storage events,
service-worker messages, kea cross-tab propagation, or just sharing
process resources with active tabs. A solo tab in a fresh
playwright user-data-dir has none of that pressure.

**Every test must be: target tab idle, at least one other tab active,
in the same playwright context.** Anything else risks missing the leak
or falsely concluding "the page is fine".

The active tab should mimic realistic user behaviour: cycle through 3-5
scenes, dwell ~30s on each, occasional scroll/click. Don't make it
hammer — production users don't either. The whole point is to simulate
"I have this tab open while I work elsewhere in the app".

Operationalise it with the `idle-leak-test.mjs` `--active-tab=<index>`
flag (see Step 7.5). Tab 0 is your target (idle, sampled). Tab 1+ are
backgrounded scenes. The active tab cycles in the background.

When you see a leak signal, **always cross-check by running the same
target solo**. If it disappears solo, you've confirmed it's a cross-tab
interaction effect — the next investigation step is to identify what
the other tabs are doing that triggers retention in the target tab
(storage events? broadcast channel? cross-tab kea sync? shared workers?
posthog-js cross-tab config replication?).

## Hypotheses we already chased (don't repeat without strong evidence)

Load `references/known-findings.md` for the full list with evidence
summaries. Short version of the ruled-out hypotheses:

- **localStorage IPC fan-out** — Firefox shows same growth without the
  Chrome IPC bug. Not dominant.
- **posthog-js** — disabled -> same steady-state RSS. Not dominant.
- **DOMPurify duplicate instances** — exists, costs something, but not
  the dominant axis. Don't re-chase without A/B evidence.
- **Dev-mode source maps** — real contributor (~280 MB) but production
  users hit 11 GB. Don't use this to dismiss findings.

Fixed real bugs: PR #58359 (cross-tab nav), PR #58247 (modal per row),
PR #58691 (disposables polling bypass). Confirm all three are present
before running any cross-tab test.

## Goal

Turn a slow, noisy leak investigation into a deterministic before/after
loop using all available signals together.

**For the dominant off-heap complaint (Path A):**
1. Confirm which tab(s) grow using headed cmd-click production tests.
2. Attribute growth using adaptive instrumentation (network + heap snapshots).
3. Analyse snapshots with memlab MCP; find code via grep.
4. Fix, then verify with ≥3 production runs comparing phys_footprint distributions.

**For detached DOM elements (Path B):**
1. Confirm counts grow after forced GC across multi-tab sessions.
2. Attribute via `window.__leakHunter` scan + retainer chain.
3. Fix, then verify clean scan under forced GC.

In both paths: single-trial results are leads not conclusions; production
data identifies the cause; local tests iterate on fixes.

## Quick reference

### Reference files — load the one you need

| File | When to load |
| --- | --- |
| `references/known-findings.md` | **Load first on every investigation** — fixed bugs, ruled-out hypotheses, open work. Avoids re-deriving what's known. |
| `references/off-heap-harness.md` | Renderer RSS / phys_footprint is the signal (multi-GB tabs, production complaint) |
| `references/in-browser-scanner.md` | Setting up `window.__leakHunter` detached-element detection (Path B, Steps 2-3.10) |
| `references/known-patterns.md` | You've reproduced a leak and want to match it to a known fix pattern |
| `references/pitfalls-and-rtg.md` | Leak narrows to `react-transition-group`, or you hit an unexpected visual regression during a fix |

### In-session quick lookup

- **Setup checklist** -> Step 1, Step 1.5
- **Add `__leakHunter` helpers** -> `references/in-browser-scanner.md`
- **CDP forced-GC** -> `references/in-browser-scanner.md` (Step 3)
- **Heap-snapshot diff / retainer chain** -> `references/in-browser-scanner.md` (Steps 3.5, 3.10)
- **Process metrics (DOM nodes, listeners)** -> `references/in-browser-scanner.md` (Step 3.6)
- **Multi-tab polling / background driving** -> `references/in-browser-scanner.md` (Steps 3.7-3.8)
- **Force-refresh via kea action** -> `references/in-browser-scanner.md` (Step 3.9)
- **Telemetry-driven targeting** -> Step 5 (in this file)
- **Drive workload, measure cycles** -> Step 6 (in this file)
- **Lifecycle counters** -> Step 7 (in this file)
- **Off-heap renderer RSS harness** -> `references/off-heap-harness.md`
- **Adaptive attribution (growth confirmed, find cause)** -> `tools/leak-hunter/measure-cmdclick-instrumented.mjs`
- **Pattern recognition** -> `references/known-patterns.md` (7 patterns)
- **Worked examples with metrics** -> `references/known-patterns.md` (5 examples)
- **RTG migration + pitfalls** -> `references/pitfalls-and-rtg.md`
- **Known findings (don't re-derive)** -> `references/known-findings.md`
- **Idle-tab Playwright harness** -> `tools/leak-hunter/idle-leak-test.mjs`
- **Single-tab reload-loop** -> `tools/leak-hunter/reload-loop.mjs`
- **Streaming heap analyzer** -> `tools/leak-hunter/stream-heap-analyzer.py`
- **memlab MCP tools** -> `mcp__memlab__load_snapshot`, `mcp__memlab__largest_objects`, `mcp__memlab__retainer_trace`

## Narration — one line per step

```
[leak-hunter] step 1 — measuring phys_footprint baseline (multi-tab, headed)
[leak-hunter] step 2 — verifying @memlab/lens is wired up
[leak-hunter] step 3 — exposing window.__leakHunter helpers in dev
[leak-hunter] step 4 — dropping in CDP forced-GC helper
[leak-hunter] step 5 — baseline on /home — 0 detached / 1347 total / 233MB
[leak-hunter] step 6 — top paths: dashboards; top components: DraggableCore, LemonButton; top "undefined" = 155M (orphan containers)
[leak-hunter] step 7 — driving SPA nav cycles on /dashboard/1 — +2 InsightTooltipWrapper per cycle
[leak-hunter] step 8 — fix: useMemo -> useRef for tooltipId (ensured 23/cleaned 20 -> 20/20)
[leak-hunter] step 9 — writing summary
```

## Workflow

### Choose your path first

**Path A — Off-heap (renderer RSS growing, phys_footprint, multi-GB tabs):**
This is the dominant production complaint. Start here when the user
reports GBs of memory, browser crashes, or slow tabs.
-> Load `references/off-heap-harness.md`. Steps 1-7 are NOT required.

Investigation chain once you're on Path A:

1. **Baseline**: run `measure-cmdclick-sidebar.mjs` against production
   (headed, auth'd profile). Confirm phys_footprint grows on ≥1 tab
   across ≥3 runs. This identifies WHICH tab(s) grow.

2. **Attribute the growth**: switch to `measure-cmdclick-instrumented.mjs`.
   It watches phys_footprint and automatically attaches to any tab that
   crosses the growth threshold — capturing: CDP network requests (reveals
   background polling), periodic heap snapshots (reveals JS retainers).
   The network log and snapshot files are the primary attribution evidence.

3. **Analyse snapshots**: load `.heapsnapshot` files via the memlab MCP
   (`mcp__memlab__load_snapshot`, then `memlab_largest_objects`,
   `memlab_retainer_trace`, `memlab_detached_dom`). For files >512 MB use
   `stream-heap-analyzer.py`.

4. **Find the code**: the network log will name specific API endpoints;
   grep them. The heap retainer chain will name JS objects; grep them.
   One or two targeted greps is usually enough.

5. **Fix and verify**: apply the smallest possible fix, run
   `measure-cmdclick-sidebar.mjs` again (≥3 runs), compare phys_footprint
   distributions. Local demo data is fine for fix iteration once you know
   the root cause.

**Path B — Detached DOM elements (React components not unmounting, detached-
element counts climbing):**
One specific signal, one specific tool. Use when detached counts are
confirmed growing after forced GC, independent of renderer RSS signal.
-> Follow Steps 1 through 7 in sequence.

**Unknown:** Start with Step 7.5 to baseline phys_footprint. Use CDP
performance metrics and network activity as secondary signals. Fall back to
Steps 1-7 only if renderer RSS is flat and detached counts are the signal.

---

### Step 1: Verify prerequisites (detached-element path only)

Before touching any code, confirm the environment can support the loop:

- **MemLens is wired up**: `grep -l '@memlab/lens' <frontend-src>` must
  find an integration point. Typically a file named something like
  `detachedElementTracker.ts` that calls `createReactMemoryScan(...)`.
  If absent, STOP and tell the user the skill doesn't apply.
- **Playwright MCP is connected**: the agent's tool list should include
  `mcp__playwright__*`. If not, ask the user to enable it.
- **memlab MCP is connected**: the agent's tool list should include
  `mcp__memlab__*`. If not, note that heap snapshot analysis will be
  limited to the streaming Python script.
- **Dev server is reachable**: `curl -sI <app-url> | head -1` returns 200
  or a redirect. If it 502s, ask the user to start the stack.
- **CDP endpoint is exposed**: Playwright launches Chrome with
  `--remote-debugging-port=<N>`. Find N by grepping the running process:
  `ps -ef | grep 'remote-debugging-port' | grep -v grep`. Curl
  `http://localhost:<N>/json/version` — expect a JSON response with
  `Browser`, `Protocol-Version`, `webSocketDebuggerUrl`.
- **PostHog telemetry credentials**: check `env | grep -iE "POSTHOG_API"`.
  In PostHog Code sessions you'll already have `POSTHOG_API_KEY`,
  `POSTHOG_AUTH_HEADER`, `POSTHOG_API_URL`, `POSTHOG_PROJECT_ID` set.

**Worktree trap**: Vite owns the frontend dev port (typically 8234)
process-wide, not repo-wide. Confirm by checking the Vite process's cwd:
```
lsof -p $(lsof -iTCP:8234 -sTCP:LISTEN -P | awk 'NR==2 {print $2}') | awk '/cwd/{print $NF}'
```
If it mismatches the current working directory, kill that Vite and
restart from the right worktree.

**Build sentinel**: add a one-line `console.info` at the top of the dev
entry (typically `frontend/src/loadPostHogJS.tsx`) so you can confirm
in the browser console that you're looking at YOUR build:

```ts
console.info('[leak-hunter] build sentinel: baseline-0')
```

### Step 1.5: Force the tracker on without a feature flag

In production the detached-element tracker is gated on `is_debug` or a
feature flag (`TRACK_DETACHED_ELEMENTS`). Locally those may not be set.

Quickest unblock: short-circuit the gate in dev:

```ts
const shouldStart =
    process.env.NODE_ENV === 'development' ||
    posthog.isFeatureEnabled('track-detached-elements') ||
    posthog.config?.is_debug
```

Verify in the browser console:

```js
window.__leakHunter && window.__leakHunter.scan()
// expected: { totalElements: 1347, totalDetachedElements: 0, ... }
```

If `__leakHunter` is undefined despite the gate change, check the scanner
state machine:

```js
window.__memLensState
// expected: 'ready'  (not 'idle' / 'starting' / 'error')
```

### Steps 2-3.10: Detached-element detection (one signal among several)

See `references/in-browser-scanner.md` for full setup code. These steps
set up the `window.__leakHunter` helpers (scan/attribute/tags/inspect/
forensics/rawElements/scanStrict/health), CDP GC utilities (`gc.mjs`,
`heap-diff.mjs`, `diff-snapshots.mjs`), process metrics via CDP, multi-tab
background polling, background-tab driving without focus changes, kea
forced-refresh, and retainer chain analysis.

Skip if investigating off-heap RSS growth (Step 7.5) — you don't need
in-browser detection for that. Go straight to `references/off-heap-harness.md`.

When you do have a `.heapsnapshot` file (from CDP `HeapProfiler.takeHeapSnapshot`
or from Chrome DevTools), use the memlab MCP instead of (or in addition to)
the heap-diff scripts:

```
mcp__memlab__memlab_load_snapshot  -- load the file into memlab
mcp__memlab__memlab_snapshot_summary -- overview: total objects, size, top types
mcp__memlab__memlab_largest_objects  -- find the heaviest retained objects
mcp__memlab__memlab_retainer_trace   -- trace why a specific node is retained
mcp__memlab__memlab_detached_dom     -- find detached DOM nodes in the snapshot
mcp__memlab__memlab_class_histogram  -- count instances by class name
```

### Step 4: Establish baseline

Pick a quiet scene (home, empty list view) and take a **post-GC** reading.
Don't do pre-GC/mid-workload reads — they can show tens of thousands of
elements that are just mid-collection (we've seen 57K transient that
dropped to 160 once GC ran).

```
[leak-hunter] baseline on /home
  post-GC: 0 detached / 1347 total / 233 MB
```

If the post-GC number is non-zero on a quiet page, note it as **baseline
residue**. Any time you cycle back to this scene afterwards, subtract
the residue from the detached count.

### Step 5: Pick a target — telemetry first

The whole point of this loop is to spend time fixing the *biggest*
leaks, not the most visible ones. Query the telemetry before driving.

Hit the HogQL API directly using the env vars from Step 1. Two queries.

**Top paths**:
```sh
curl -sS -X POST "$POSTHOG_API_URL/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Authorization: $POSTHOG_AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"query":{"kind":"HogQLQuery","query":"SELECT properties.current_path AS path, sum(toIntOrZero(toString(properties.detached_elements))) AS total_detached, avg(toIntOrZero(toString(properties.detached_elements))) AS avg_detached, count() AS scans, uniq(distinct_id) AS users FROM events WHERE event = '"'"'detached_elements'"'"' AND timestamp > now() - interval 7 day AND properties.current_path IS NOT NULL GROUP BY path ORDER BY total_detached DESC LIMIT 20"}}'
```

**Top components (globally)**:
```sh
curl -sS -X POST "$POSTHOG_API_URL/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Authorization: $POSTHOG_AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"query":{"kind":"HogQLQuery","query":"SELECT kv.1 AS component, sum(toIntOrZero(toString(kv.2))) AS total_detached, count() AS scans_with, uniq(distinct_id) AS users FROM events ARRAY JOIN JSONExtractKeysAndValues(ifNull(toString(properties.detached_components), '"'"'{}'"'"'), '"'"'String'"'"') AS kv WHERE event = '"'"'detached_elements'"'"' AND timestamp > now() - interval 7 day GROUP BY component ORDER BY total_detached DESC LIMIT 25"}}'
```

**HogQL gotchas we hit**:
- Use `toIntOrZero`, not `toInt64OrZero` (doesn't exist in PostHog HogQL).
- `JSONExtractKeysAndValues` doesn't accept a `Nullable` — wrap with
  `ifNull(toString(properties.detached_components), '{}')`.
- `ARRAY JOIN ... AS kv` then `kv.1` / `kv.2` for key and value works.

**What to look for in the results**:
- A large `undefined` row means lots of detached DOM has **no React fiber
  at all** — almost always manually-created portal containers.
- Named components like `LemonButton`, `DraggableCore` are the next layer.
  Cross-reference with the path query — an offender that only shows up on
  one path is a sharper fix target.
- **`children`, `render`, `label` as component names** are real components
  that happen to be named with common words. They're not spurious.

Draft a short summary and present the top ~5 paths and top ~10
components to the user. Ask which to investigate locally.

### Step 6: Drive the workload, measure each cycle

**Before driving anything: confirm you're testing the right shape.**
A target tab actively driven through SPA navigation tests *active-tab*
leak behaviour. A target tab idle alongside another tab being driven
tests *idle-tab* leak behaviour. These are different leak classes.
The canonical production scenario is the idle-tab pattern — make sure
you've stood that one up first.

SPA navigation (not hard reload) is where real active-tab leaks live.
Drive with client-side clicks via `mcp__playwright__browser_evaluate`:

```js
async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 10; i++) {
    document.querySelector('a[href="/project/1/feature_flags"]').click()
    await sleep(600)
    document.querySelector('a[href="/project/1/dashboard"]').click()
    await sleep(600)
    document.querySelector('a[href="/project/1/dashboard/1"]').click()
    await sleep(1100)
  }
  return { done: true }
}
```

Then call the GC helper and evaluate `__leakHunter` helpers:

```js
() => {
  const scan = window.__leakHunter.scan()
  const attr = window.__leakHunter.attribute()
  const tags = window.__leakHunter.tags()
  return {
    totalDetached: scan.totalDetachedElements,
    namedByScan: scan.detachedComponentToFiberNodeCount,
    attribution: attr,
    tags,
    sample: window.__leakHunter.inspect(25)
  }
}
```

**Interpretation ladder** — use whichever level has signal:
1. `scan.detachedComponentToFiberNodeCount` names named fibers.
2. If empty or all `<unnamed>` in `attribute()`, look at `tags()`.
   `div`-heavy with no component names is the manual-portal-container smell.
3. `inspect(N)` exposes `id` + `classes`. Group by CSS signature:
   ```js
   const groups = {}
   for (const s of inspectOutput) {
     const key = s.id?.replace(/-[a-z0-9]+$/, '') || s.classes?.split(' ')[0] || s.tag
     groups[key] = (groups[key] ?? 0) + 1
   }
   ```

A real leak manifests as **linear growth across cycles**. A one-shot
spike that plateaus is usually framework scaffolding — ignore it unless
telemetry proves otherwise.

### Step 7: Small hypothesis, small fix

When you've isolated a component / module, instrument it with lifecycle
counters to confirm the ensure/cleanup parity:

```ts
const counters = { ensured: 0, cleaned: 0, cleanedButMissing: 0 }
if (process.env.NODE_ENV === 'development') {
    ;(window as unknown as { __featureCounters?: typeof counters }).__featureCounters = counters
}
// bump counters.ensured in the create path
// bump counters.cleaned in the destroy path when entity exists
// bump counters.cleanedButMissing in the destroy path when entity is absent
```

A run of `ensured: N, cleaned: N-k` with `k > 0` means **k entities are
created but never destroyed**. That's a real bug.

`cleanedButMissing > 0` alone is usually React StrictMode's phantom
double-cleanup — not a real bug.

**Quick fixes we've tried that may or may not work**:
- **`useMemo` -> `useRef` for stable ids**: FIXES id-drift races. We saw
  this cause `ensured: 23, cleaned: 20` in `useInsightTooltip`.
- **Drop `queueMicrotask` around unmount**: often makes no difference.
- **`flushSync(() => root.unmount())`**: does NOT free containers created
  via `createRoot(manualDiv)` — the DOM node is retained by something
  else (chart lib holding the external callback's DOM ref, or React
  internal bookkeeping).
- **Portal refactor**: the "real fix" for manual-DOM + `createRoot`
  patterns is to switch to `ReactDOM.createPortal(children, container)`
  where the container is owned by the caller component's tree. Big
  diff, but eliminates the whole class. Propose it, don't ship it silently.

Ship one small fix at a time. Verify with the loop: same workload, same
GC, counters back to parity, detached count drops (or doesn't — write
that down too, so the next agent doesn't re-try a dead end).

### Step 7.5: Off-heap idle-tab reproducer

For the leak class where renderer RSS climbs to GBs while V8 heap stays
flat (~150 MB) — observed on /experiments, /sql, /feature_flags in
production — `__leakHunter` won't help. The memory lives in Chrome's
renderer C++ allocators that JS can't see.

**Quick start** (see `references/off-heap-harness.md` for full details):

```
# RIGHT — multi-tab with one active, at least 30 min
BASE_URL=http://127.0.0.1:8000 HEADLESS=1 IDLE_SECONDS=3600 \
    node tools/leak-hunter/idle-leak-test.mjs \
    --paths=/home,/dashboard,/insights,/replay/home,/feature_flags,/error_tracking \
    --active-tab=0 --debug-port=9333 --sample=10
```

**Critical gotchas:**
- Use `http://127.0.0.1:8000` not `:8010` — Caddy silently serves empty HTML.
- Screenshot tabs early to verify they loaded (use `--debug-port`).
- Run >=3 trials — the leak is intermittent; single trials mislead.
- Headed mode required for real `visibilityState` behaviour.

**For production-scale testing** (demo data won't reproduce):
```bash
# One-time auth setup
BASE_URL=https://us.posthog.com node tools/leak-hunter/auth-setup.mjs \
    --user-data-dir=~/.leak-hunter-prod-profile
# Subsequent runs
BASE_URL=https://us.posthog.com node tools/leak-hunter/measure-cmdclick-sidebar.mjs \
    --user-data-dir=~/.leak-hunter-prod-profile --idle=600 --sample=60
```

See `references/off-heap-harness.md` for full flag reference, gotchas, the
workflow for comparing baseline vs candidate fix, and the per-scene baseline
cost reframe (2026-05-15).

### Step 8: Report findings

Produce a compact summary:

```markdown
# Memory leak investigation: <branch/commit>

## Baseline
- /home: 0 detached / 1347 total / 233 MB JS heap / renderer RSS 520 MB

## Signals used
- phys_footprint: [trend over run]
- Detached DOM: [post-GC count trend]
- Heap snapshot: [top types if snapshotted]
- Network: [any background polling found]

## Telemetry (7 days)
- Top paths: dashboards (5/top15), /sql (3/top15), data-management
- Top named components: LemonButton 63M (14K users), DraggableCore 39M (4K users)
- Top "undefined": 155M (15K users) — orphan portal containers

## Local cycles on /dashboard/1 (10 SPA cycles)
| Metric | Before | After |
| --- | --- | --- |
| Detached | 0 | 26 |
| Heap | 243 MB | 266 MB |
| Named by scan() | — | — (all undefined) |
| By signature | — | InsightTooltipWrapper x20, Tooltip* x6 |

## Fixes shipped
- [PR #NNNN] useMemo -> useRef for tooltipId. Counters before/after:
  23/20/10 -> 20/20/10. Eliminates the id-drift race; leaves the
  createRoot-container retention for a follow-up.

## Candidates to rule out
- <component>: flat line across 10 cycles.

## Next step
<either: propose a specific follow-up fix, or hand back with a short
 list of open hypotheses>
```

STOP here unless the user explicitly asks for a larger refactor.

## Terminal conditions

Always stop (with the best report you can) when:

- MemLens isn't wired up in the codebase (skill doesn't apply).
- CDP endpoint isn't reachable (ask for Playwright MCP or for the user
  to point Playwright at the running Chrome).
- Measurements are noisy beyond the workload's delta (re-pick the scene
  or admit the signal is too small).
- You've confirmed counter parity AND the leak persists — that means
  you've found a structural issue (React internals, third-party lib
  retention) that needs a refactor, not a patch. Write it up.
- The user interrupts to switch direction.

## Judgement rules

- **Don't over-correct on a single data point.** One trial showing growth,
  one tab leaking, one heap snapshot's retainer chain — these are leads, not
  conclusions. Before concluding anything from a measurement, ask:
  - Was the data shape representative? (demo vs real data, headless vs headed)
  - Was the visibility state correct? (headless shows all tabs as visible)
  - Were there >=3 trials? (single trials have huge variance)
  - Did the test actually exercise the code path that leaks in production?
  If any answer is "no" or "unsure", get more data.

- **Distinguish "reproduces under these conditions" from "the only cause".**
  If /replay/home always leaks in a 6-tab idle test, that is one confirmed
  leak — not evidence that other scenes are fine.

- **Blink Oilpan lag is NOT a leak.** Filter with `scanStrict(delayMs)`
  or CDP `HeapProfiler.collectGarbage` **called twice** (a single pass
  often leaves cross-heap refs behind).
- **Ignore single-pass detached counts.** Only the intersection after
  forced GC + delay is actionable.
- **Rapid cycling overestimates.** Open/close a menu 40 times in 5s and
  you'll read hundreds of detached nodes — Oilpan can't keep up. Real user
  pacing clears them.
- **Linear > spike after forced GC.** A growing line across cycles is a
  true cumulative leak. A flat non-zero line is one stuck instance.
- **Heap snapshot retainers named `(Traced handles)`** mean Blink's own
  C++ bookkeeping holds the node. Clears on any real GC pass. NOT a JS
  leak. If CDP GC doesn't clear it, look for real JS retainers elsewhere.
- **Detached-element counts are not the right signal for tab memory
  growth.** Users reporting "tabs get slow / memory-heavy" are usually
  hitting accumulating event listeners, setInterval/setTimeout churn,
  Chart/canvas instances, rrweb session recording buffers, or unbounded
  in-memory caches (kea reducers, SWR, react-query). Use
  `performance.memory.usedJSHeapSize` over a long session plus heap
  snapshot diffs.
- **`<unnamed>` / "undefined" components** (no fiber) usually mean
  orphan portal containers (`document.createElement + createRoot`).
- **Trust CSS signatures when names fail.** IDs like
  `InsightTooltipWrapper-<random>` grep directly to the culprit.
- **Don't optimise a flat line.** If a component doesn't grow across
  cycles *under forced GC*, there's nothing to fix.
- **Gate the window hook to dev.** Exposing MemLens internals on `window`
  in production is a support burden.
- **Counter parity != zero leaks.** `ensured === cleaned` only proves the
  lifecycle logic is paired — DOM can still be retained via external refs.

## Dependencies

- **@memlab/lens** already present in the target codebase.
- **Playwright MCP** connected in the agent session (`mcp__playwright__*`).
- **memlab MCP** connected in the agent session (`mcp__memlab__*`).
- **Node 22+** for native `WebSocket` in the CDP helper.
- **PostHog env vars** (`POSTHOG_API_KEY`, `POSTHOG_AUTH_HEADER`,
  `POSTHOG_API_URL`, `POSTHOG_PROJECT_ID`) — set automatically by
  PostHog Code. No MCP required.

## Graceful degradation

- **No PostHog env vars / telemetry**: ask the user for a personal API
  key or have them run the HogQL in the UI. Fall back to user's verbal
  guidance or a recent bug report to pick a scene.
- **No Playwright MCP**: describe the loop and ask the user to drive
  the browser manually. The GC helper still works; the user runs it
  between their interactions.
- **No memlab MCP**: fall back to `tools/leak-hunter/stream-heap-analyzer.py`
  for heap snapshot analysis. Heap snapshot retainer chain inspection will
  require manual steps in Chrome DevTools.
- **CDP port can't be discovered**: ask the user for it, or fall back to
  allocation-pressure GC (noisy; flag confidence as `low`).
- **Scanner reports 0 detached everywhere**: either the tracker isn't
  starting (check `state` enum reaches `'ready'`, check that the
  `TRACK_DETACHED_ELEMENTS` flag is on or `is_debug` is true) or the
  workload genuinely doesn't leak. Try a different scene before giving
  up.
- **Scanner exposes but `scan()` returns 0 detached and all components
  named**: MemLens is working but the scene is clean. Drive more
  aggressively — more SPA cycles, mount/unmount of complex subtrees,
  or pick a different scene from the telemetry top-5.
