# RTG state-machine replacement pattern and pitfalls

Appendix B (react-transition-group migration recipe) and Appendix E
(general pitfalls). Load this reference when:
- A leak narrows to a component using `react-transition-group`
- You hit an unexpected behaviour when replacing RTG
- You need the full in-component state-machine implementation

---

## Appendix B: RTG state-machine replacement pattern

`react-transition-group` is **abandoned** (no code commits since Sept
2022; open issues against React 19's `findDOMNode` removal go
unanswered). Its class-component state machine races with React 18's
concurrent rendering and can leave a subtree in `--exit-done` /
`--enter-done` state with the underlying DOM still attached after
React unmount. This is one of the contributing causes for "one extra
detached subtree per re-render" leak signatures we've seen on
auto-refreshing dashboards.

If a leak narrows down to a component that wraps its content in a RTG
`CSSTransition` or `Transition`, the fix is to **replace RTG with an
in-component state machine**. PRs that did this in this codebase:

- `frontend/src/lib/lemon-ui/Popover/Popover.tsx`
- `frontend/src/lib/lemon-ui/LemonBadge/LemonBadge.tsx`
- `frontend/src/lib/components/Cards/CardMeta.tsx`
- `frontend/src/lib/lemon-ui/LemonTable/LemonTableLoader.tsx`

### The recipe

Two pieces of state plus two refs. `useLayoutEffect` so the class
toggles before paint. `requestAnimationFrame` to delay applying the
"open" class so the transition plays. `setTimeout(delayMs)` to delay
unmount so the exit transition plays.

```tsx
const [shouldRender, setShouldRender] = useState(false)
const [isOpen, setIsOpen] = useState(false)
const exitTimeoutRef = useRef<number | null>(null)
const enterFrameRef = useRef<number | null>(null)

useLayoutEffect(() => {
    if (visible) {
        // Cancel any in-flight exit before starting an entry
        if (exitTimeoutRef.current !== null) {
            clearTimeout(exitTimeoutRef.current)
            exitTimeoutRef.current = null
        }
        setShouldRender(true)
        // RAF defers `isOpen=true` to a frame after the portal
        // mounts, so the CSS transition has a "from" state.
        enterFrameRef.current = requestAnimationFrame(() => {
            enterFrameRef.current = null
            setIsOpen(true)
        })
    } else {
        // Cancel any pending entry
        if (enterFrameRef.current !== null) {
            cancelAnimationFrame(enterFrameRef.current)
            enterFrameRef.current = null
        }
        // Cancel any prior exit timer (see "orphaned timers" pitfall)
        if (exitTimeoutRef.current !== null) {
            clearTimeout(exitTimeoutRef.current)
            exitTimeoutRef.current = null
        }
        setIsOpen(false)
        exitTimeoutRef.current = window.setTimeout(() => {
            exitTimeoutRef.current = null
            setShouldRender(false)
        }, delayMs)
    }
    return () => {
        if (exitTimeoutRef.current !== null) {
            clearTimeout(exitTimeoutRef.current)
            exitTimeoutRef.current = null
        }
        if (enterFrameRef.current !== null) {
            cancelAnimationFrame(enterFrameRef.current)
            enterFrameRef.current = null
        }
    }
}, [visible, delayMs])
```

JSX gates rendering on `shouldRender` and applies the active class
based on `isOpen`:

```tsx
{shouldRender && (
    <Portal>
        <div className={clsx('Popover', isOpen && 'Popover--enter-active')}>
            ...
        </div>
    </Portal>
)}
```

---

## Pitfall: SCSS class-name aliasing (silent visual regression)

RTG used to emit a family of classes: `--enter`, `--enter-active`,
`--enter-done`, `--exit`, `--exit-active`, `--exit-done`. Any
external file that **statically applies the old class** (in JSX,
not via RTG) will silently lose its styles when you switch to
emitting only one.

Concrete regression: the `Popover` rewrite emitted only
`Popover--enter-active`, but
`frontend/src/scenes/session-recordings/components/InternalSurvey/InternalMultipleChoiceSurvey.tsx`
applies `Popover--enter-done` directly in JSX as a permanent
"already-settled" class. The popup rendered at opacity 0.

Fix: keep the old class as a CSS alias until you've audited every
consumer:

```scss
.Popover.Popover--enter-active &,
.Popover.Popover--enter-done & {
    opacity: 1;
    transform: none;
}
```

Audit step before deleting the alias:

```sh
rg "Popover--enter-done|Popover--exit-done|<YourComponent>--(enter|exit)-(active|done)"
```

---

## Pitfall: orphaned timers when prop deps change mid-close

If the timeout duration is a prop (`delayMs`) and changes while
`visible` is already `false`, the effect re-runs, schedules a new
timer, and orphans the old one. The old timer fires at the original
delay and unmounts state the new timer expected to manage.

Fix: clear the existing timer at the top of the closing branch
before scheduling a new one (already shown in the recipe above).
The cleanup function alone is not sufficient because the re-run
path schedules a fresh timer before the cleanup runs.

---

## Pitfall: conditional-render vs always-render (1.6px residue)

For `LemonTableLoader`, the initial replacement kept the element
always-rendered with an `is-loading` class toggle, mimicking
RTG's behaviour. But the surrounding `padding` made it 1.6px tall
*always* — a cumulative visual regression across every loaded
table.

Fix: when there's no exit transition needed (or the transition is
on a child element), prefer a true conditional render:

```tsx
if (!loading) {
    return null
}
return <div className="LemonTableLoader" />
```

Use the state-machine recipe only when you actually need an exit
transition. A `display: none` toggle is **not** a substitute — it
keeps the DOM attached and defeats the leak fix.

---

## Pitfall: type widening from explicit annotations

Reviewers may suggest adding an explicit type to a variable that
TypeScript was inferring just fine. If the explicit annotation is
*wider* than the actual flow, downstream calls fail:

```tsx
// Was: TS infers `text: string`
// Now: explicit annotation widens it past `.includes()`
let text: string | JSX.Element = ...
if (forcePlus && !text.includes('+')) { /* TS2339: not on JSX.Element */ }
```

Fix: prefer inferred types unless the inference is genuinely wrong.
If the annotation is load-bearing for documentation, narrow at the
use site (`typeof text === 'string'`) instead of widening the
declaration.

---

## Diagnostic: auto-refresh dashboards leak one wrapped subtree per cycle

A useful localisation hint: if a dashboard is on a poll/auto-refresh
loop and detached count grows linearly across refresh cycles (one
extra subtree per tile per cycle), the prime suspect is a
RTG-wrapped element nested inside the tile — typically
`Tooltip`-wrapped `Spinner` (loading state cycles per refresh) or
`Popover` (any popup the tile owns).

The signal is asymmetric: opening/closing the popup manually doesn't
reproduce the leak (one subtree at most), but auto-refresh does
(one per cycle, monotonically). That asymmetry points at the React
18 concurrent-render race rather than a missing cleanup.

Validate: in `dashboardLogic.refreshDashboardItems`, identify the
tile loading path that mounts/unmounts the wrapped element, then
swap the wrapper for the state-machine recipe and re-run the
auto-refresh workload from Step 6 / 7.

---

## Appendix E: pitfalls observed in the wild

These are footguns we hit and want future agents to short-cut past.

### CDP forced-GC must be called twice

A single `HeapProfiler.collectGarbage` call leaves cross-heap V8<->Oilpan
references behind. Empirically a second call clears them. The cost is
~200ms of additional latency and zero risk; do it always.

### `select_tab` foregrounds the tab

Playwright's `mcp__playwright__browser_select_tab` brings the selected
tab to the front and fires `visibilitychange` on the deselected tab.
For background-tab tests, never use it. Drive each tab via its own
CDP session by webSocketDebuggerUrl (Steps 3.7-3.8 in
`in-browser-scanner.md`).

### `performance.memory` is bucketed by default

Without `--enable-precise-memory-info` browser flag, `usedJSHeapSize`
rounds to ~5 MB granularity for security. Cross-origin isolation
unlocks `performance.measureUserAgentSpecificMemory()` for byte-precision
measurements but requires HTTP headers we don't set in dev. **For
leak validation**, prefer CDP `Performance.getMetrics -> JSHeapUsedSize`
which is byte-precise regardless of flags.

### Vite owns the dev port across worktrees

If multiple PostHog Code worktrees are open simultaneously and any
have run `./bin/start`, Vite is owned by whichever started first and
serves *its* code. Edits in other worktrees are invisible until you
kill that Vite. Use the `lsof | awk /cwd/` check from Step 1 to
confirm which worktree is serving.

### Heap-snapshot diffs include GC noise

A diff between two snapshots will show many "deleted" objects
(objects in A not in B) — those are usually GC casualties, not signal.
Focus on the additions (B \ A) sorted by delta.

### MemLens scanner hides behind feature flag in dev

Without unblocking the feature flag (Step 1.5), `__leakHunter` is
undefined and you'll waste time wondering why nothing exposes. Always
verify `window.__leakHunter` exists before driving workload.

### Forensics returns "trees by root", not "all detached"

`forensics()` collapses subtrees — a 100-element tree shows as one
root with `childCount: 100`. When comparing across workloads, compare
*root counts* (not summed `childCount`s) for the most stable signal.

### `useMemo` is not stable across renders

React 18 docs say `useMemo` cache *may be discarded* under memory
pressure. If you're using `useMemo` for an identity (`Math.random()`)
that needs to remain stable for cleanup, use `useRef` or `useId`
instead. We've seen `useMemo` ids drift mid-mount under StrictMode.

### Patches have invisible effects across tabs

Editing dev source rebuilds, and Vite HMR may inject the new module
*without* reinitialising things like `__leakHunter` on already-open
tabs. Reload affected tabs after dev edits to the integration file.
