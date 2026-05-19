# Pattern signatures and worked examples

Appendix C (7 reusable patterns) and Appendix D (5 worked examples with metrics).
Load this reference when you've narrowed a leak to "this scene leaks N elements
per cycle" and want to short-cut to a fix, or when calibrating against known-good
before/after numbers.

---

## Appendix C: pattern signatures (reusable across hunts)

When you've narrowed to "this scene leaks N elements per cycle", match
the leaked elements' shape against these patterns to short-cut to a
fix. Each pattern below is a real leak we've shipped a fix for.

### Pattern 1: Tooltip-wraps-loading-spinner

**Signature:** auto-refresh dashboard cycles leak ~9 listeners and
~237 DOM nodes per refresh. Heap diff shows `KeyframeEffect`,
`CSSAnimation`, `SVGCircleElement` growing in lockstep.
`window.__leakHunter.forensics()` shows `<unnamed>` div trees
containing `Spinner`, `Tooltip`, `Tooltip__popup`.

**Cause:** `<Tooltip title="Loading...">` wrapping a `<Spinner>` while
data fetches. Each refresh cycles the Tooltip mount/unmount. Base UI's
Tooltip retains one popup subtree per instance via internal store
refs. Repeated mount/unmount = repeated retention.

**Fix:** if the tooltip is just restating visible text ("Loading"
spinner with title="Loading insight results"), remove the `<Tooltip>`
wrapper entirely. The visible label is enough.

```diff
- <Tooltip title={loading ? 'This insight is loading results.' : 'Waiting'}>
-     <span><Spinner />{loading ? 'Loading' : 'Waiting to load'}</span>
- </Tooltip>
+ <span><Spinner />{loading ? 'Loading' : 'Waiting to load'}</span>
```

If the tooltip carries information not in the visible text, defer the
fix and pursue the upstream Base UI retention bug.

### Pattern 2: react-transition-group on a frequently-cycled element

**Signature:** an element with classes ending in `--enter-done`,
`--exit-done`, or `--enter-active` shows up detached after each cycle.
Detached count grows linearly with the cycle count.

**Cause:** `react-transition-group`'s class-component state machine
races React 18 concurrent rendering. The exit transition completes
but the unmount setState is dropped or interleaved, leaving the DOM
detached with `nodeRef.current` still pointing at it.

**Fix:** see `references/pitfalls-and-rtg.md` for the in-component
state-machine recipe. Past PRs: `Popover.tsx`, `LemonBadge.tsx`,
`CardMeta.tsx`, `LemonTableLoader.tsx`. After all consumers are
migrated, remove `react-transition-group` from the dependency tree.

### Pattern 3: createRoot on a manually-created div + module Map

**Signature:** detached elements with no React fiber. `inspect()` shows
`id`s like `Wrapper-0.2384712` (random suffix) or stable IDs like
`BillingTooltipWrapper`. The "named by scan" map is empty;
`forensics()` shows divs whose `hasFiber: false`.

**Cause:**
```ts
const instances = new Map<id, { root, element }>()
function ensureTooltip(id) {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    instances.set(id, { root, element: el })
    return [root, el]
}
```
React owns the rendered children but not the container. On
cleanup, even with `root.unmount()` + `element.remove()`, the
container can be retained by:
- The chart library's external callback closure (Chart.js etc.)
- React 18's `_internalRoot.containerInfo` not releasing on `unmount`
- Stale captured ids (`useMemo` for ids drifts under StrictMode)

**Fix:** collapse to a **shared singleton** — one element + one root
created lazily, never destroyed. Track ownership by `currentOwner: string`
so stale callbacks no-op:

```ts
let element: HTMLElement | null = null
let root: Root | null = null
let currentOwner: string | null = null

function ensure(id: string): [WrappedRoot, HTMLElement] {
    if (!element) {
        element = document.createElement('div')
        document.body.appendChild(element)
        root = createRoot(element)
    }
    currentOwner = id
    return [wrappedRoot(id), element]
}

function cleanup(id: string): void {
    if (currentOwner !== id) return // no-op for stale callers
    currentOwner = null
    root!.render(null) // clear the React tree, keep the container
    element!.style.opacity = '0'
}

function wrappedRoot(id: string): WrappedRoot {
    return {
        render: (children) => {
            if (currentOwner !== id) return // stale
            root!.render(children)
        },
        unmount: () => {
            // never destroy the singleton
            console.error('[ownership] unmount called on shared root; ignored')
        },
    }
}
```

Past PRs: `useInsightTooltip.ts`, `BillingLineGraph.tsx`. The
"hover/pinned dual-singleton" variant supports concurrent display
states (one floating per cursor, one pinned per click). Each owns a
separate singleton; ownership transfer between them is explicit.

### Pattern 4: kea selector accumulation under stable mount counts

**Signature:** `mount.mounted` map size oscillates within a tight
range (logics ARE unmounting), but heap diff shows
`closure::dependenciesChecker`, `closure::recomputations`,
`closure::lastResult`, `closure::resetRecomputations`, etc growing
across navigation cycles in groups of 7.

**Cause:** kea's `selectors({...})` builder uses reselect's
`createSelector` which retains its last input/output values per
*build*, not per *mount*. If a logic is rebuilt under a different
`pathString` (e.g. parameterised key changes), the old build's
selector closures stay pinned to the kea context indefinitely.

**Investigation:** instrument `getContext().mount.mounted` size and
the count of unique `pathString`s seen. If mounted size is stable but
unique pathStrings grow, you've identified the rebuild leak.

**Fix:** depends on the access pattern. Options:
- Patch `createSelector` calls to use `lruMemoize` with size 1
- Reduce keying surface (don't parameterise logics on volatile inputs)
- Switch hot-path selectors to plain functions (no memoization)
- Eject and replace the offending selector machinery

This is library-level, not a quick fix. Document and triage.

### Pattern 5: PerformanceObserver buffering

**Signature:** heap diff shows `LayoutShift`,
`LayoutShiftAttribution`, `PerformanceLongTaskTiming`,
`TaskAttributionTiming` accumulating ~7-30 entries per minute of
session.

**Cause:** a `PerformanceObserver` configured with `buffered: true`
or no rotation is collecting web-vitals or long-task entries
indefinitely. The buffer is never flushed — entries hold their
`Element` attribution refs (= DOM retention) and their own metadata.

**Investigation:** patch `PerformanceObserver.prototype.observe` at
startup to log call sites:

```js
const orig = PerformanceObserver.prototype.observe
PerformanceObserver.prototype.observe = function (opts) {
    console.log('[po]', opts.entryTypes || [opts.type], new Error().stack)
    return orig.call(this, opts)
}
```

**Fix:** confirm web-vitals attribution is disabled in the SDK init
(e.g., `web_vitals_attribution: false`). If still buffering, find
the offending observer and either disable it or rotate via
`takeRecords()` on a timer.

### Pattern 6: Background-tab DOM growth during foreground tab work

**Signature:** Tab A is foregrounded and active. Tabs B and C are
background. After 5 minutes of work on A, B and C show DOM node
count growth.

**Investigation steps that have already been done (don't repeat):**
- ruled out cross-tab `storage` events as the trigger (firing 200
  fake storage events on the posthog-js key produces zero DOM growth)
- confirmed all `storage` listeners we own (`useLocalStorage`,
  `welcomeDialogLogic`, `sceneLogic` pinned-tabs) filter strictly by
  key
- confirmed `kea-localstorage` is write-only (no `storage`
  listener)
- confirmed Playwright's `select_tab` does NOT fire
  `visibilitychange` events on the de-selected tab — so what looked
  like background-tab measurement may have been all-tabs-foregrounded
  measurement

**Open hypothesis:** `BroadcastChannel` or a `SharedWorker` posting
events that other tabs render on. Worth grepping for both. Also worth
probing `ServiceWorker` message-event handlers.

**Cheap tooling to add:** patch `addEventListener` for `'storage'`,
`'message'`, `'visibilitychange'` and bump per-event counters per tab.
Read the counters via CDP after a workload to see who fires what.

### Pattern 7: Auto-refresh cumulative leak

**Signature:** open a dashboard, leave the tab. After N refresh
intervals, detached count and DOM node count have grown by N x M.

**Localisation:** identify which tile element is wrapped in something
that mounts/unmounts on each load cycle. Typical culprits: any RTG
`<CSSTransition>`, any `<Tooltip>` around a loading state, any chart
that creates external DOM (Chart.js tooltip plugins).

**Validation:** force-refresh via kea action (Step 3.9 in the main
SKILL.md, or see `in-browser-scanner.md`) and confirm linear growth.
A 10-cycle force-refresh should produce 10x the per-cycle delta.

**Fix:** match the wrapper pattern against Patterns 1-3 above.

---

## Appendix D: worked examples (calibration)

### Example 1: insight loading tooltip (Pattern 1)

Symptom: dashboard auto-refresh leaks +9 listeners and +237 DOM nodes
per cycle. After 10 cycles, +90 listeners, +2,370 nodes, +10.6 MB heap.

Investigation: forensics shows trees containing
`text-accent ml-1.5` spans wrapping `Spinner` SVGs and
`Tooltip / Tooltip__popup / Tooltip__arrow` divs. Source:
`InsightMeta.tsx:663` — `<Tooltip title="Loading...">` around the
spinner.

Fix (one-line removal of redundant tooltip):

```diff
-{(loading || loadingQueued) && (
-    <Tooltip title={loading ? 'This insight is loading results.' : 'Waiting'}>
-        <span><Spinner />{loading ? 'Loading' : 'Waiting'}</span>
-    </Tooltip>
-)}
+{(loading || loadingQueued) && (
+    <span><Spinner />{loading ? 'Loading' : 'Waiting'}</span>
+)}
```

Validation (force-refresh x 10, post-GC):

| metric | before | after |
| --- | --- | --- |
| JS event listeners / refresh | +9 | **0** |
| Heap / refresh | +1.06 MB | +0.36 MB |
| DOM nodes / refresh | +237 | +244 |

The +244 nodes/refresh that survived motivated Example 2.

PR: PostHog #56235.

### Example 2: LemonTableLoader (Pattern 2)

Symptom: 244 DOM nodes leaked per dashboard refresh after Example 1
fix. forensics shows divs with `LemonTableLoader--exit-done` class.

Investigation: `LemonTableLoader` uses `CSSTransition` from
react-transition-group with a `nodeRef`. On exit, the timeout fires
but the unmount setState gets dropped under React 18 concurrent
rendering.

Fix (drop CSSTransition entirely):

```diff
-<CSSTransition in={loading} nodeRef={ref} timeout={200} classNames="LemonTableLoader" unmountOnExit>
-    <div ref={ref} className="LemonTableLoader" />
-</CSSTransition>
+if (!loading) return null
+return <div className="LemonTableLoader" />
```

Validation (force-refresh x 10, post-GC):

| metric | before | after |
| --- | --- | --- |
| DOM nodes / refresh | +244 | **0** (oscillates) |
| JS event listeners / refresh | 0 | 0 |
| Heap / refresh | +0.36 MB | flat (modulo API payload) |

PR: PostHog #56237.

### Example 3: Popover state-machine (Pattern 2, with animation)

Same problem as Example 2 but with a fade+rotate animation that needs
to play on exit. Solution: in-component state machine (see
`pitfalls-and-rtg.md` for the full recipe). Two state variables, two
refs, `useLayoutEffect`.

Critical pitfall hit: an `InternalMultipleChoiceSurvey.tsx` file
statically applied `Popover--enter-done` in JSX. When the rewrite
emitted only `Popover--enter-active`, the survey rendered with
opacity 0. Fix: keep both selectors as a CSS alias and audit all
direct consumers via:

```sh
rg "Popover--enter-done|Popover--exit-done"
```

PR: PostHog #56254.

### Example 4: shared-singleton chart tooltip (Pattern 3)

Symptom: `useInsightTooltip` creates `document.createElement('div')`
+ `createRoot(el)` per chart instance. After 30 SPA cycles on
`/dashboard/1`, 26 detached: 20 `InsightTooltipWrapper-*` + 6
`Tooltip*`.

Failed quick fixes (still useful negative results):
- Drop `queueMicrotask` around unmount: no change
- `flushSync(() => root.unmount())`: no change
- `useMemo` -> `useRef` for stable id: counters parity restored
  (23/20 -> 20/20) but detached count unchanged

Real fix: collapse to dual-singleton (one hover element, one pinned
element, neither destroyed). Public API of the hook unchanged — none
of the 7 call sites needed edits.

Validation (10-cycle SPA nav, post-GC):

| metric | before | after |
| --- | --- | --- |
| `InsightTooltipWrapper-*` detached | 20 | **0** |
| Total detached | 26 | 6 (base-ui Tooltip — unrelated) |
| Live wrappers in body | 2N | 1 (lazy `-pinned` only when used) |

PR: PostHog #55923. Same pattern reused for `BillingLineGraph` in
PR #55973.

### Example 5: bot-review caught real bugs in Example 4

Three reviewers (greptile, codex, qa-team) flagged real issues that
manual review missed:
- `console.error` on stale render fired on every mousemove over a
  pinned chart (P1 noise spam)
- `unmount()` exposed on the wrapped root could destroy the singleton
  globally if any caller called it (P1 footgun)
- `pinTooltip` could pin with `lastRendered === null` resulting in a
  blank pinned tooltip (P1 logic bug)
- Render guard wasn't id-bound — a stale chart's late callback could
  overwrite a different chart's content (P2 race)

All four were fixable with small edits in the same PR. Lesson:
**ship the leak fix as a draft PR and let bot reviewers stress-test
it before marking ready**. The investigation didn't catch any of these.
