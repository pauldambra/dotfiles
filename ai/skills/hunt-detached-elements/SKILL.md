---
name: hunt-detached-elements
description: >
  Set up a deterministic sandbox for investigating React detached-element
  leaks in a codebase that uses @memlab/lens. Exposes on-demand scanner
  helpers (`window.__leakHunter.scan/attribute/tags/inspect`), drops in a
  CDP forced-GC helper so each measurement is stable, and drives workloads
  through the Playwright MCP to produce clean before/after numbers. Picks
  targets from production telemetry rather than guesswork. Stops at
  measurements and narrow one-line fixes — large refactors are separate
  tasks. Use when the user says "hunt detached elements", "investigate
  react memory leaks", "find detached nodes", "profile detached DOM", or
  asks to stand up a detached-elements sandbox.
---

# Hunt detached elements

The goal is to turn a slow, noisy leak investigation into a deterministic
before/after loop. Four reusable pieces make that possible:

1. **On-demand scanner** — a dev-only `window.__leakHunter` that wraps
   MemLens's synchronous `scan()` and adds attribution helpers
   (`attribute`, `tags`, `inspect`) so you can name orphans even when
   MemLens can't.
2. **Forced GC via CDP** — a tiny Node script that connects to the
   Playwright MCP's Chrome (which always exposes `--remote-debugging-port`)
   and calls `HeapProfiler.collectGarbage`. No `--expose-gc` flag needed.
3. **Telemetry-driven targeting** — the `detached_elements` event already
   captures top offenders across all users. Query it via the PostHog
   HogQL API using env vars that PostHog Code sets automatically
   (`POSTHOG_API_KEY`, `POSTHOG_API_URL`, `POSTHOG_PROJECT_ID`). No MCP
   required.
4. **Lifecycle counters** — when suspicion narrows to a specific module,
   instrument `ensured`/`cleaned`/`cleanedButMissing` counts on a
   `window.__<feature>Counters` object. The counter deltas expose
   mismatched lifecycles that MemLens alone can't see.

Without (1) and (2), counts are dominated by unswept `WeakRef`s and the
default 30s scan tick. With them, a re-render loop and a single fix can
be measured in seconds, not minutes.

## Quick reference

- **Setup checklist** → Step 1, Step 1.5
- **Add `__leakHunter` helpers** → Step 2 (scan/attribute/tags/inspect),
  Step 2.4 (forensics/rawElements), Step 2.5 (scanStrict)
- **CDP forced-GC** → Step 3
- **Heap-snapshot diff (memory growth)** → Step 3.5
- **Process metrics (DOM nodes, listeners)** → Step 3.6
- **Background-tab measurement** → Step 3.7-3.8
- **Force-refresh via kea action** → Step 3.9
- **Heap retainer chain analysis** → Step 3.10
- **Telemetry-driven targeting** → Step 5
- **Drive a workload, measure cycles** → Step 6
- **Lifecycle counters (ensure/cleanup parity)** → Step 7
- **Pattern recognition** → Appendix C (7 patterns)
- **Worked examples with metrics** → Appendix D (5 examples + bot review wins)
- **Pitfalls** → Appendix B (RTG migration), Appendix E (general)
- **Known findings (don't re-derive)** → Appendix F

## Narration — one line per step

```
[leak-hunter] step 1 — verifying @memlab/lens is wired up
[leak-hunter] step 2 — exposing window.__leakHunter helpers in dev
[leak-hunter] step 3 — dropping in CDP forced-GC helper
[leak-hunter] step 4 — baseline on /home — 0 detached / 1347 total / 233MB
[leak-hunter] step 5 — top paths: dashboards; top components: DraggableCore, LemonButton; top "undefined" = 155M (orphan containers)
[leak-hunter] step 6 — driving SPA nav cycles on /dashboard/1 — +2 InsightTooltipWrapper per cycle
[leak-hunter] step 7 — fix: useMemo → useRef for tooltipId (ensured 23/cleaned 20 → 20/20)
[leak-hunter] step 8 — writing summary
```

## Workflow

### Step 1: Verify prerequisites

Before touching any code, confirm the environment can support the loop:

- **MemLens is wired up**: `grep -l '@memlab/lens' <frontend-src>` must
  find an integration point. Typically a file named something like
  `detachedElementTracker.ts` that calls `createReactMemoryScan(...)`.
  If absent, STOP and tell the user the skill doesn't apply.
- **Playwright MCP is connected**: the agent's tool list should include
  `mcp__playwright__*`. If not, ask the user to enable it.
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
  That's all you need — no MCP.

**Worktree trap**: Vite owns the frontend dev port (typically 8234)
process-wide, not repo-wide. If two PostHog Code worktrees both ran
`./bin/start`, the first one to claim the port serves its code; the
second's `./bin/start` silently skips Vite. Confirm by checking the
Vite process's cwd:
```
lsof -p $(lsof -iTCP:8234 -sTCP:LISTEN -P | awk 'NR==2 {print $2}') | awk '/cwd/{print $NF}'
```
If it mismatches the current working directory, kill that Vite and
restart from the right worktree, **or switch the investigation to match
the serving worktree** — otherwise edits won't be seen.

**Build sentinel**: add a one-line `console.info` at the top of the dev
entry (typically `frontend/src/loadPostHogJS.tsx`) so you can confirm
in the browser console that you're looking at YOUR build, not someone
else's. Bump the slug per experiment:

```ts
console.info('[leak-hunter] build sentinel: baseline-0')
```

If the sentinel doesn't print, you're not editing the served code.

### Step 1.5: Force the tracker on without a feature flag

In production the detached-element tracker is gated on `is_debug` or a
feature flag (`TRACK_DETACHED_ELEMENTS`). Locally those may not be set,
so the tracker stays in `idle` state and `__leakHunter` is never
exposed.

Quickest unblock: short-circuit the gate in dev. Open the integration
point and force-enable for `process.env.NODE_ENV === 'development'`:

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

If `__leakHunter` is undefined despite the gate change, the integration
point isn't reaching `exposeLeakHunter(...)`. Check the scanner state
machine:

```js
window.__memLensState
// expected: 'ready'  (not 'idle' / 'starting' / 'error')
```

(Add this exposure in the integration point if it isn't there — it
saves a lot of debugging.)

### Step 2: Expose the on-demand scanner + attribution helpers

Open the integration point from Step 1. The scanner returned by
`createReactMemoryScan(...)` has public `scan(): ScanResult` and
`getDetachedDOMInfo(): DOMElementInfo[]` methods but is kept in a
closure. Add a dev-gated helper that installs a set of helpers on
`window.__leakHunter`:

```ts
interface DetachedElementSnapshot {
    totalElements: number
    totalDetachedElements: number
    detachedComponentToFiberNodeCount: Record<string, number>
    componentToFiberNodeCount: Record<string, number>
    path: string
    takenAt: number
}

interface MemLensScanner {
    // ...existing fields...
    scan: () => Omit<MemLensScanResult, 'start' | 'end'>
    getDetachedDOMInfo: () => Array<{ element: WeakRef<Element> }>
}

function mapToObject(map: Map<string, number>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, v] of map) {
        out[k] = v
    }
    return out
}

const REACT_FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$']

type FiberLike = { type?: unknown; elementType?: unknown; return?: unknown } | null

function fiberOf(element: Element): FiberLike {
    for (const prefix of REACT_FIBER_PREFIXES) {
        const key = Object.getOwnPropertyNames(element).find((k) => k.startsWith(prefix))
        if (key) {
            return (element as unknown as Record<string, FiberLike>)[key]
        }
    }
    return null
}

function nameOfFiber(fiber: FiberLike): string | null {
    if (!fiber) return null
    const t = (fiber.type ?? fiber.elementType) as any
    if (!t || typeof t === 'string') return null
    return t.displayName ?? t.name ?? t.render?.displayName ?? t.render?.name ?? null
}

function nearestNamedAncestor(element: Element): string {
    let fiber = fiberOf(element)
    let depth = 0
    while (fiber && depth < 40) {
        const name = nameOfFiber(fiber)
        if (name) return name
        fiber = (fiber.return as FiberLike) ?? null
        depth += 1
    }
    // fallback: walk up DOM, try fiber at each parent
    let node: Node | null = element.parentNode
    let hops = 0
    while (node && hops < 20) {
        if (node instanceof Element) {
            const parentFiber = fiberOf(node)
            let walk = parentFiber
            let d = 0
            while (walk && d < 40) {
                const n = nameOfFiber(walk)
                if (n) return `via:${n}`
                walk = (walk.return as FiberLike) ?? null
                d += 1
            }
        }
        node = node.parentNode
        hops += 1
    }
    return '<unnamed>'
}

function exposeLeakHunter(scanner: MemLensScanner): void {
    if (process.env.NODE_ENV !== 'development') return
    const w = window as unknown as { __leakHunter?: unknown }
    w.__leakHunter = {
        scan: (): DetachedElementSnapshot => {
            const r = scanner.scan()
            return {
                totalElements: r.totalElements,
                totalDetachedElements: r.totalDetachedElements,
                detachedComponentToFiberNodeCount: mapToObject(r.detachedComponentToFiberNodeCount),
                componentToFiberNodeCount: mapToObject(r.componentToFiberNodeCount),
                path: window.location.pathname,
                takenAt: Date.now(),
            }
        },
        attribute: (): Record<string, number> => {
            scanner.scan()
            const counts: Record<string, number> = {}
            for (const info of scanner.getDetachedDOMInfo()) {
                const el = info.element.deref()
                if (!el) continue
                const name = nearestNamedAncestor(el)
                counts[name] = (counts[name] ?? 0) + 1
            }
            return counts
        },
        tags: (): Record<string, number> => {
            scanner.scan()
            const counts: Record<string, number> = {}
            for (const info of scanner.getDetachedDOMInfo()) {
                const el = info.element.deref()
                if (!el) continue
                const tag = el.tagName?.toLowerCase() ?? 'unknown'
                counts[tag] = (counts[tag] ?? 0) + 1
            }
            return counts
        },
        inspect: (limit = 20): Array<{ tag: string; component: string; id?: string; classes?: string }> => {
            scanner.scan()
            const out: Array<{ tag: string; component: string; id?: string; classes?: string }> = []
            for (const info of scanner.getDetachedDOMInfo()) {
                const el = info.element.deref()
                if (!el) continue
                const entry: { tag: string; component: string; id?: string; classes?: string } = {
                    tag: el.tagName?.toLowerCase() ?? 'unknown',
                    component: nearestNamedAncestor(el),
                }
                const htmlEl = el as HTMLElement
                if (htmlEl.id) entry.id = htmlEl.id
                if (typeof htmlEl.className === 'string' && htmlEl.className) {
                    entry.classes = htmlEl.className.slice(0, 120)
                }
                out.push(entry)
                if (out.length >= limit) break
            }
            return out
        },
    }
}
```

Call `exposeLeakHunter(scan)` in the integration point (right after the
scanner is created, before `scan.subscribe(...)`).

**Why four helpers, not one**: `scan()` gives MemLens's own best
attribution, which only names fibers it can walk. When an element has
no fiber at all (e.g., a manually-created portal container), it shows
up in `totalDetachedElements` but is absent from
`detachedComponentToFiberNodeCount`. `attribute()` adds a
parent-fiber-walk fallback. `tags()` groups by HTML tag — useful when
every detached thing is a `<div>` (common for manual portals). And
`inspect()` returns per-element `{id, classes, tag}` so you can pattern
match on CSS signatures like `InsightTooltipWrapper-*` or
`Tooltip__popup` — often more actionable than a component name.

### Step 2.4: Add `forensics()` and `rawElements()`

Two more helpers prove their worth once you're past the cycle-counting
phase and into the "what subtree is actually retained" phase.

**`forensics(limit)`** — returns root detached trees only (i.e., a
detached element whose `parentNode` is also detached doesn't show up).
This collapses a 360-element subtree into one entry. Without this,
`inspect()` returns the leaves of the tree (spans, paths) which look
like noise; `forensics` shows you the trunk.

```ts
forensics: (limit = 10): Array<{
    tag: string
    id?: string
    classes?: string
    childCount: number
    component: string
    hasFiber: boolean
}> => {
    scanner.scan()
    const detachedSet = new Set<Element>()
    const allRefs = scanner.getDetachedDOMInfo()
    for (const info of allRefs) {
        const el = info.element.deref()
        if (el) detachedSet.add(el)
    }
    const isRoot = (el: Element): boolean => {
        let p: Node | null = el.parentNode
        while (p) {
            if (p instanceof Element && detachedSet.has(p)) return false
            p = p.parentNode
        }
        return true
    }
    const roots: Array<{
        tag: string
        id?: string
        classes?: string
        childCount: number
        component: string
        hasFiber: boolean
    }> = []
    for (const el of detachedSet) {
        if (!isRoot(el)) continue
        const html = el as HTMLElement
        roots.push({
            tag: html.tagName?.toLowerCase() ?? 'unknown',
            id: html.id || undefined,
            classes: typeof html.className === 'string' ? html.className.slice(0, 200) : undefined,
            childCount: html.querySelectorAll('*').length,
            component: nearestNamedAncestor(html),
            hasFiber: !!fiberOf(html),
        })
        if (roots.length >= limit) break
    }
    roots.sort((a, b) => b.childCount - a.childCount)
    return roots
},
```

**`rawElements(limit)`** — returns *the actual elements* (not refs).
Lets you `Runtime.evaluate` them or expose them via `__leakHunter.last`
for follow-up inspection. Useful when you need to walk a specific
detached subtree by hand:

```ts
rawElements: (limit = 50): Element[] => {
    scanner.scan()
    const out: Element[] = []
    for (const info of scanner.getDetachedDOMInfo()) {
        const el = info.element.deref()
        if (el) out.push(el)
        if (out.length >= limit) break
    }
    ;(window as any).__leakHunter.last = out
    return out
},
```

Now in DevTools you can `$_[0].outerHTML` or `$_[0].__reactFiber$xyz`
on the captured set.

### Step 2.5: Add a strict-scan helper (Oilpan-aware)

Raw `scanner.scan()` returns everything the MutationObserver has ever
seen detached that `WeakRef.deref()` still resolves — including things
Blink's Oilpan GC will reclaim in the next cycle. To distinguish real
leaks from Oilpan lag, snapshot the WeakRefs, wait for an idle delay,
and only count survivors:

```ts
scanStrict: async (delayMs = 10_000) => {
    const first = scanner.scan()
    const raw = first.totalDetachedElements
    const refs = Array.from(scanner.getDetachedDOMInfo()).map((i) => i.element)
    await new Promise<void>((r) => setTimeout(r, delayMs))
    const persistent = refs.filter((r) => r.deref()).length
    return { raw, persistent, delayMs }
},
```

Also wire the periodic tracker subscribe to only capture *persistent*
counts — raw counts flood telemetry with Oilpan noise that isn't
actionable. Keep raw as a secondary property for debugging.

### Step 3: Drop in the CDP forced-GC helper

Create `tools/leak-hunter/gc.mjs` (or wherever the repo keeps dev tools).
No npm dependencies — relies on Node 22+ native `WebSocket`.

```js
#!/usr/bin/env node
const CDP_PORT = Number(process.env.CDP_PORT || 52350)
const URL_SUBSTRING = process.env.CDP_URL_MATCH || 'localhost:8010'

const tabs = await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json())
const target = tabs.find((t) => t.type === 'page' && t.url.includes(URL_SUBSTRING))
if (!target) {
    console.error(`No page tab matched "${URL_SUBSTRING}" on port ${CDP_PORT}`)
    process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
    })

ws.addEventListener('message', (event) => {
    const msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString())
    if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
})

await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (e) => reject(e), { once: true })
})

await send('HeapProfiler.enable')
// Twice: a single pass often leaves cross-heap refs (V8↔Oilpan) that only
// a second pass resolves. Empirically, one pass may leave 200+ elements
// detached that a second pass clears entirely.
await send('HeapProfiler.collectGarbage')
await send('HeapProfiler.collectGarbage')

const { result } = await send('Runtime.evaluate', {
    expression: `(() => {
        const snap = window.__leakHunter ? window.__leakHunter.scan() : null
        return JSON.stringify({
            scannerExposed: !!snap,
            totalElements: snap?.totalElements ?? null,
            totalDetachedElements: snap?.totalDetachedElements ?? null,
            detachedComponentToFiberNodeCount: snap?.detachedComponentToFiberNodeCount ?? null,
            usedJSHeap: performance.memory ? performance.memory.usedJSHeapSize : null,
            totalJSHeap: performance.memory ? performance.memory.totalJSHeapSize : null,
            url: location.href,
        })
    })()`,
    returnByValue: true,
})

console.log(result.value)
ws.close()
```

Set `CDP_PORT` from Step 1. Run once to smoke-test:

```
CDP_PORT=52350 node tools/leak-hunter/gc.mjs
```

Expect a single JSON line. On a freshly-loaded quiet scene expect
`totalDetachedElements` ≤ 5 and `usedJSHeap` in the 200-300 MB range.

### Step 3.5: Heap snapshot diff workflow

Detached counts only catch one class of leak. For "tab grows in memory
over time" complaints, the canonical signal is heap snapshot diff. Drop
in a second tool — `tools/leak-hunter/heap-diff.mjs`:

```js
#!/usr/bin/env node
import { writeFileSync } from 'node:fs'

const CDP_PORT = Number(process.env.CDP_PORT || 52350)
const URL_SUBSTRING = process.env.CDP_URL_MATCH || 'localhost:8010'
const OUT = process.argv[2] || `/tmp/heap-${Date.now()}.heapsnapshot`

const tabs = await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json())
const target = tabs.find((t) => t.type === 'page' && t.url.includes(URL_SUBSTRING))
if (!target) throw new Error(`No tab matched ${URL_SUBSTRING}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        ws.send(JSON.stringify({ id, method, params }))
    })

let chunks = []
ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data.toString())
    if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
        chunks.push(msg.params.chunk)
        return
    }
    if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
})

await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (e) => reject(e), { once: true })
})

await send('HeapProfiler.enable')
await send('HeapProfiler.collectGarbage')
await send('HeapProfiler.collectGarbage')
chunks = []
await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true })
writeFileSync(OUT, chunks.join(''))
console.log(`wrote ${OUT} (${chunks.length} chunks, ${(chunks.join('').length / 1024 / 1024).toFixed(1)} MB)`)
ws.close()
```

Workflow: snapshot A, drive workload, snapshot B, diff using a small
JS analysis script. The snapshots are JSON; you can either load them
into Chrome DevTools manually or analyse programmatically:

```js
// tools/leak-hunter/diff-snapshots.mjs
import { readFileSync } from 'node:fs'

const [, , aPath, bPath] = process.argv
const a = JSON.parse(readFileSync(aPath, 'utf8'))
const b = JSON.parse(readFileSync(bPath, 'utf8'))

function classify(snap) {
    const { snapshot, nodes, strings } = snap
    const fields = snapshot.meta.node_fields
    const types = snapshot.meta.node_types[0]
    const stride = fields.length
    const idxName = fields.indexOf('name')
    const idxType = fields.indexOf('type')
    const counts = new Map()
    for (let i = 0; i < nodes.length; i += stride) {
        const typeIdx = nodes[i + idxType]
        const nameIdx = nodes[i + idxName]
        const type = types[typeIdx]
        const name = strings[nameIdx]
        const key = `${type}::${name || '(unnamed)'}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
}

const ca = classify(a)
const cb = classify(b)
const all = new Set([...ca.keys(), ...cb.keys()])
const rows = []
for (const key of all) {
    const before = ca.get(key) ?? 0
    const after = cb.get(key) ?? 0
    rows.push({ key, before, after, delta: after - before })
}
rows.sort((x, y) => y.delta - x.delta)
console.table(rows.slice(0, 40))
```

Top deltas tell the story. Common findings:

- `closure::dependenciesChecker` / `recomputations` / `lastResult` /
  `resetRecomputations` / etc growing in groups of 7 — reselect
  memoised selectors. Each kea logic build pins its full selector
  machinery indefinitely. If logic mounts oscillate but selector
  closures grow, it's a *build* leak, not a *mount* leak.
- `LayoutShift` / `LayoutShiftAttribution` / `PerformanceLongTaskTiming`
  growing — a `PerformanceObserver` is buffering web-vitals entries
  without rotating. Even web-vitals attribution we thought we'd
  disabled may still be active via another observer.
- `KeyframeEffect` / `CSSAnimation` / `SVGCircleElement` growing in
  proportion — animated UI elements (commonly Spinners) leaking on
  every mount/unmount cycle.
- `InternalNode` / `Attr` / `DOMTokenList` growing — Blink C++ DOM
  internals retained for nodes that haven't been Oilpan-collected yet.
  Proportional to detached-element count.

Negative deltas (objects fewer in B than A) are usually irrelevant —
GC freed them. Focus on the top positive deltas.

### Step 3.6: Process metrics via CDP (DOM nodes, listeners, layouts)

`performance.memory` is JS heap only. The complaint is usually about
*tab process* memory which includes Blink-side DOM, listeners, image
decode buffers, layout trees. Use `Performance.getMetrics` instead:

```js
// inside the WebSocket loop in any of the tools
await send('Performance.enable')
const { metrics } = await send('Performance.getMetrics')
const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0
const dom = await send('DOM.getNodeCount').catch(() => ({ count: null }))
console.log({
    Nodes: get('Nodes'),                       // DOM node count (often more telling than heap)
    JSEventListeners: get('JSEventListeners'), // listener count - leaks here are very common
    LayoutCount: get('LayoutCount'),
    RecalcStyleCount: get('RecalcStyleCount'),
    Documents: get('Documents'),
    Frames: get('Frames'),
    JSHeapUsedSize: get('JSHeapUsedSize'),
    domNodeCount: dom.count,
})
```

Listener count growing without DOM count growing = closures captured
on `window` / `document` listeners not being removed. DOM count
growing without listener count = portal / detached-tree retention
(this skill's focus). Both growing = SPA scene leak.

### Step 3.7: Multi-tab CDP polling (background-tab measurement)

When the user reports "background tabs grow in memory", you need to
measure tabs that aren't focused. Playwright's `select_tab` gives
focus to the selected tab — that defeats the test. Use CDP to poll
tab metrics directly without ever focusing them:

```js
// tools/leak-hunter/poll-tab.mjs
const CDP_PORT = Number(process.env.CDP_PORT || 52350)
const TAB_INDEX = Number(process.argv[2] || 0)

const tabs = (await fetch(`http://localhost:${CDP_PORT}/json/list`).then((r) => r.json()))
    .filter((t) => t.type === 'page')
const target = tabs[TAB_INDEX]
if (!target) throw new Error(`No tab at index ${TAB_INDEX}`)

const ws = new WebSocket(target.webSocketDebuggerUrl)
// ...handshake same as gc.mjs...

await send('Performance.enable')
const { metrics } = await send('Performance.getMetrics')
const { count: nodeCount } = await send('DOM.getNodeCount')
const { result } = await send('Runtime.evaluate', {
    expression: `({
        url: location.href,
        title: document.title,
        visibilityState: document.visibilityState,
        detached: window.__leakHunter ? window.__leakHunter.scan().totalDetachedElements : null
    })`,
    returnByValue: true,
})
console.log(JSON.stringify({
    tabIndex: TAB_INDEX,
    title: target.title,
    url: target.url,
    visibility: result.value.visibilityState,
    metrics: Object.fromEntries(metrics.map((m) => [m.name, m.value])),
    nodeCount,
    detached: result.value.detached,
}))
ws.close()
```

This works on background tabs because CDP doesn't require focus — the
DevTools protocol talks to the renderer regardless.

**Crucial**: poll the tab's *own* metrics from its own CDP session.
Don't try to read background-tab DOM from the foreground tab — even if
they have the same origin, each has its own renderer process and
isolated state.

### Step 3.8: Drive a tab without focusing it

Same constraint applies to driving — `mcp__playwright__browser_evaluate`
foregrounds the tab. To drive a specific background tab via CDP:

```js
// tools/leak-hunter/drive-tab.mjs
// connect to a specific tab's webSocketDebuggerUrl, then:
await send('Runtime.evaluate', {
    expression: `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        for (let i = 0; i < 5; i++) {
            document.querySelector('a[href="/dashboard/1"]').click()
            await sleep(800)
            document.querySelector('a[href="/feature_flags"]').click()
            await sleep(800)
        }
        return 'done'
    })()`,
    awaitPromise: true,
    returnByValue: true,
})
```

Now you can drive tab A while polling tab B without ever switching
focus, which is the only valid background-tab leak test.

### Step 3.9: Forcing kea actions via CDP (cheap workload simulation)

If the leak is auto-refresh-driven (dashboards, error tracking, etc.),
you don't have to wait 5 minutes for the timer. Dispatch the action
directly:

```js
// expose kea context in dev (one-time setup in initKea.ts):
if (process.env.NODE_ENV === 'development') {
    ;(window as any).__keaContext = getContext()
}

// then via CDP Runtime.evaluate:
const ctx = window.__keaContext
const logic = ctx.mount.mounted['scenes.dashboards.dashboardLogic.234']
logic.actions.refreshDashboardItems({ action: 'refresh' })
```

10 forced refreshes back-to-back simulates an hour of user dwell time
in seconds. Combine with `gc.mjs` to measure each cycle:

```js
// tools/leak-hunter/force-refresh.mjs
for (let i = 0; i < 10; i++) {
    await send('Runtime.evaluate', {
        expression: `Object.values(window.__keaContext.mount.mounted)
            .find((l) => l.pathString.includes('dashboardLogic'))
            ?.actions.refreshDashboardItems({ action: 'refresh' })`,
    })
    await sleep(2000)  // let the refresh complete
    await send('HeapProfiler.collectGarbage')
    await send('HeapProfiler.collectGarbage')
    const m = await send('Performance.getMetrics')
    console.log(`cycle ${i}:`, m.metrics.find(x => x.name === 'Nodes').value, 'nodes')
}
```

This was the test that surfaced "every dashboard refresh leaks +237
DOM nodes per tile loading cycle" — would have taken hours to spot
otherwise.

### Step 3.10: Heap retainer chain for a specific node

When a heap snapshot diff identifies a leaking class but you can't
tell *what's holding it*, query the retainer chain by node ID. The
strongest signal is: walk back from the detached node to a global root
and see what type of edges connect.

```js
// tools/leak-hunter/heap-retainers.mjs
// load a snapshot, find nodes whose class matches a query string,
// walk retainers up to depth 8 or until reaching a root.

import { readFileSync } from 'node:fs'

const [, , snapPath, classQuery] = process.argv
const snap = JSON.parse(readFileSync(snapPath, 'utf8'))
const { snapshot, nodes, edges, strings } = snap
const nf = snapshot.meta.node_fields
const ef = snapshot.meta.edge_fields
const nodeStride = nf.length
const edgeStride = ef.length
const types = snapshot.meta.node_types[0]
const edgeTypes = snapshot.meta.edge_types[0]
const idxName = nf.indexOf('name')
const idxType = nf.indexOf('type')
const idxEdgeCount = nf.indexOf('edge_count')
const idxEdgeType = ef.indexOf('type')
const idxEdgeNameOrIndex = ef.indexOf('name_or_index')
const idxEdgeToNode = ef.indexOf('to_node')

const nodeCount = nodes.length / nodeStride
const nameOf = (i) => strings[nodes[i * nodeStride + idxName]]
const typeOf = (i) => types[nodes[i * nodeStride + idxType]]

// Build a reverse-edge index (retainers): nodeId -> [{from, type, name}]
const retainers = Array.from({ length: nodeCount }, () => [])
let edgeCursor = 0
for (let i = 0; i < nodeCount; i++) {
    const ec = nodes[i * nodeStride + idxEdgeCount]
    for (let e = 0; e < ec; e++) {
        const eOff = (edgeCursor + e) * edgeStride
        const toNode = edges[eOff + idxEdgeToNode] / nodeStride
        const eType = edgeTypes[edges[eOff + idxEdgeType]]
        const eName = strings[edges[eOff + idxEdgeNameOrIndex]] || ''
        retainers[toNode].push({ from: i, edgeType: eType, edgeName: eName })
    }
    edgeCursor += ec
}

const matches = []
for (let i = 0; i < nodeCount; i++) {
    if (nameOf(i).includes(classQuery)) matches.push(i)
}
console.log(`${matches.length} match(es) for "${classQuery}"`)

for (const start of matches.slice(0, 5)) {
    console.log(`\n=== ${typeOf(start)}::${nameOf(start)} ===`)
    let cur = start
    for (let depth = 0; depth < 8; depth++) {
        const r = retainers[cur][0]
        if (!r) {
            console.log(`  ${'  '.repeat(depth)}<- (root)`)
            break
        }
        console.log(`  ${'  '.repeat(depth)}<- ${r.edgeType}:${r.edgeName} from ${typeOf(r.from)}::${nameOf(r.from)}`)
        cur = r.from
    }
}
```

Critical interpretation:

- **Path ends at `(Traced handles)` only** — Blink C++ holds the
  reference, no JS retainer. Means it's Oilpan-pending. Wait or pressure
  Oilpan; not a JS leak.
- **Path ends at a global object** (e.g., `Window`, `(GC roots)` →
  named global) — find the variable name in the chain; that's the
  retainer.
- **Path ends at `(closure)`** — a captured closure variable. Walk
  back to its `(scope)` parent and find the function that defined it.
- **Path ends at a `Map` / `WeakMap` / `Array`** — something is
  pushing without clearing. Find the owner of the collection.

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

The `detached_elements` event has these properties worth aggregating:

- `current_path` — which routes users spend detached fibers on
- `detached_components` — a top-N map of component names → count

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

**Top components for a specific path pattern**:
```sh
# replace LIKE '%/dashboard/%' with the path prefix of interest
```

**HogQL gotchas we hit**:
- Use `toIntOrZero`, not `toInt64OrZero` (doesn't exist in PostHog HogQL).
- `JSONExtractKeysAndValues` doesn't accept a `Nullable` — wrap with
  `ifNull(toString(properties.detached_components), '{}')`.
- `ARRAY JOIN ... AS kv` then `kv.1` / `kv.2` for key and value works
  in PostHog HogQL. Other tuple-destructuring forms may not.

**What to look for in the results**:
- A large `undefined` row (we've seen 155M over 7 days, 2.5× the next)
  means lots of detached DOM has **no React fiber at all**. That's
  almost always manually-created portal containers
  (`document.createElement + document.body.appendChild + createRoot(el)`).
  These are invisible to component-name attribution but tractable via
  CSS signature in step 6.
- Named components like `LemonButton`, `DraggableCore`,
  `Primitive.span.SlotClone` are the next layer. Cross-reference with
  the path query — an offender that only shows up on one path is a
  sharper fix target than one that's everywhere.
- **`children`, `render`, `label` as component names** are real
  components that happen to be named with common words. They're not
  spurious.

Draft a short summary and present the top ~5 paths and top ~10
components to the user. Ask which to investigate locally.

### Step 6: Drive the workload, measure each cycle

SPA navigation (not hard reload) is where real leaks live — hard
navigates throw away the React tree and wipe everything. Drive with
client-side clicks via `mcp__playwright__browser_evaluate`:

```js
async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 10; i++) {
    // nav away
    document.querySelector('a[href="/project/1/feature_flags"]').click()
    await sleep(600)
    // nav to dashboard list
    document.querySelector('a[href="/project/1/dashboard"]').click()
    await sleep(600)
    // open the dashboard tile
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
1. `scan.detachedComponentToFiberNodeCount` names named fibers. If
   populated, you're done — pick the top offender and look up its
   source.
2. If `detachedComponentToFiberNodeCount` is empty or all `<unnamed>`
   in `attribute()`, look at `tags()`. `div`-heavy with no component
   names is the manual-portal-container smell.
3. `inspect(N)` exposes `id` + `classes`. Group by CSS signature:
   ```js
   const groups = {}
   for (const s of inspectOutput) {
     const key = s.id?.replace(/-[a-z0-9]+$/, '') || s.classes?.split(' ')[0] || s.tag
     groups[key] = (groups[key] ?? 0) + 1
   }
   ```
   IDs with `-<random>` suffixes almost always come from
   `\`Wrapper-${Math.random()...}\`` template strings — grep the
   codebase for the stable prefix. Classnames like `Tooltip__popup` are
   BEM-like and map directly to the component that rendered them.

A real leak manifests as **linear growth across cycles**: cycle 1 adds
X, cycle 10 adds ~10X. A one-shot spike that plateaus is usually
framework scaffolding (e.g., a global `TooltipProvider` mount) — ignore
it unless you have telemetry proving otherwise.

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
created but never destroyed**. That's a real bug, independent of DOM
retention.

`cleanedButMissing > 0` alone is usually React StrictMode's phantom
double-cleanup — not a real bug.

**Quick fixes we've tried that may or may not work**:
- **`useMemo` → `useRef` for stable ids**: FIXES id-drift races. `useMemo`
  is not guaranteed stable across renders; if your cleanup closure
  captures a regenerated id, the original entity is orphaned. We saw
  this cause `ensured: 23, cleaned: 20` in `useInsightTooltip`.
- **Drop `queueMicrotask` around unmount + element.remove**: may help
  if the microtask was being cancelled by a component re-render. Check
  with counters; often makes no difference.
- **`flushSync(() => root.unmount())`**: forces React to complete the
  teardown synchronously. Useful hypothesis for React 18
  scheduler-batching races. In practice we found **it does not** free
  containers created via `createRoot(manualDiv)` — the DOM node is
  retained by something else (likely Chart.js / chart lib holding the
  external callback's DOM ref, or React internal bookkeeping that
  `unmount` doesn't fully release).
- **Portal refactor**: the "real fix" for manual-DOM + `createRoot`
  patterns is to switch to `ReactDOM.createPortal(children, container)`
  where the container is owned by the caller component's tree. Big
  diff, but eliminates the whole class of retention. Propose it, don't
  ship it silently.

Ship one small fix at a time. Verify with the loop: same workload, same
GC, counters back to parity, detached count drops (or doesn't — write
that down too, so the next agent doesn't re-try a dead end).

### Step 8: Report findings

Produce a compact summary:

```markdown
# Detached-elements sandbox: <branch/commit>

## Baseline
- /home: 0 detached / 1347 total / 233 MB

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
| By signature | — | InsightTooltipWrapper ×20, Tooltip* ×6 |

## Fixes shipped
- [PR #NNNN] useMemo → useRef for tooltipId. Counters before/after:
  23/20/10 → 20/20/10. Eliminates the id-drift race; leaves the
  createRoot-container retention for a follow-up.

## Candidates to rule out
- <component>: flat line across 10 cycles.

## Next step
<either: propose a specific follow-up fix, or hand back with a short
 list of open hypotheses>
```

STOP here unless the user explicitly asks for a larger refactor. Even
then, prefer opening the refactor as its own session with a fresh
context — the measurement scaffolding stays in the working tree for it.

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

- **Blink Oilpan lag is NOT a leak.** Detached elements immediately after
  React unmount are held by V8 traced handles until Blink's Oilpan GC
  runs. That happens minutes later under no pressure. Counts caught in
  this window are noise, not leaks. Filter with `scanStrict(delayMs)`
  or CDP `HeapProfiler.collectGarbage` **called twice** (a single pass
  often leaves cross-heap refs behind).
- **Ignore single-pass detached counts.** They conflate three things:
  real JS leaks, Oilpan-pending DOM, and in-flight React reconciliation.
  Only the intersection after forced GC + delay is actionable.
- **Rapid cycling overestimates.** Open/close a menu 40 times in 5s and
  you'll read hundreds of detached nodes — Oilpan can't keep up with
  the rate. Real user pacing clears them. If the signal disappears at
  realistic pacing, it isn't a production issue.
- **Linear > spike after forced GC.** Under forced GC, a flat non-zero
  line is one stuck instance (still worth investigating). A growing
  line across cycles is a true cumulative leak.
- **Heap snapshot retainers named `(Traced handles)`** mean the only
  thing keeping the node alive is Blink's own C++ bookkeeping. That
  looks like a leak to detached-element trackers, but clears on any
  real GC pass. It is NOT a JS-code leak. If CDP GC doesn't clear it,
  look for real JS retainers elsewhere.
- **Detached-element counts are not the right signal for tab memory
  growth.** Users reporting "tabs get slow / memory-heavy" are usually
  hitting one of: accumulating event listeners on `window`/`document`,
  setInterval/setTimeout churn, Chart/canvas instances, rrweb session
  recording buffers, unbounded in-memory caches (kea reducers, SWR,
  react-query), or WebSocket subscriptions. Measure
  `performance.memory.usedJSHeapSize` over a long session and compare
  heap snapshots separated by the suspected workload — that's the
  signal. `detached_elements` catches a *symptom* of some leaks, not
  all leaks.
- **`<unnamed>` / "undefined" components** (no fiber) usually mean
  orphan portal containers (`document.createElement + createRoot`).
  These retain for real, even after GC, because `createRoot`'s
  `_internalRoot` holds the container div. Use `createPortal` into a
  React-owned container instead.
- **Trust CSS signatures when names fail.** IDs like
  `InsightTooltipWrapper-<random>` grep directly to the culprit source
  file. Classnames like `Tooltip__popup` map to BEM-named components.
- **Don't optimise a flat line.** If a component doesn't grow across
  cycles *under forced GC*, there's nothing to fix.
- **Gate the window hook to dev.** Exposing the MemLens internals on
  `window` in production is a support-burden waiting to happen.
- **Counter parity ≠ zero leaks.** `ensured === cleaned` only proves the
  lifecycle logic is paired — DOM can still be retained via external
  refs (Chart.js external callbacks, React 18 `_internalRoot`,
  third-party libraries).

## Dependencies

- **@memlab/lens** already present in the target codebase.
- **Playwright MCP** connected in the agent session.
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

## When detached counts aren't enough

If the user's complaint is **"tabs grow in memory over a session"** and
your detached-element signal is flat or uncorrelated, you're looking at
a different leak class. Detached-element tracking only catches DOM that
survives React unmount; it misses:

- **Event listener accumulation.** Each SPA navigation may register
  listeners on `window` or `document` that aren't removed. Each
  listener holds its closure, which may capture significant state.
  Measure: `getEventListeners(window)` in DevTools; grep the codebase
  for `addEventListener` without matching `removeEventListener` in a
  cleanup.
- **Timer churn.** `setInterval` calls that outlive their caller hold
  their closures forever. Patch `setInterval` at startup to record
  stack traces and audit periodically.
- **Canvas / chart instance retention.** Chart.js, Plotly, echarts, etc.
  hold DOM via `external` callbacks and plugin state. Killing the
  React component doesn't destroy the chart; you need to call the
  library's explicit `.destroy()` on unmount.
- **Session replay buffers.** rrweb-based recording accumulates DOM
  mutations and events. Worth verifying the buffer is flushed/rotated
  rather than held forever.
- **Unbounded in-memory caches.** Kea reducers, React Query cache, SWR,
  Apollo client — any cache without a size cap or TTL will grow.

For this class, the right signal is `performance.memory.usedJSHeapSize`
over a real session, plus heap snapshot diffs:

1. Snapshot A on fresh scene.
2. Drive realistic workload (not rapid cycling).
3. Force GC twice via CDP.
4. Snapshot B.
5. In DevTools or via custom script: compare the two snapshots using
   the "Comparison" view, filter to "Objects allocated between A and
   B", inspect the largest retention chains.

`detached_elements` telemetry catches one slice. `memory_usage`
telemetry catches the superset but without attribution — use it to
find affected users and reproduce locally.

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

### Pitfall: SCSS class-name aliasing (silent visual regression)

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

### Pitfall: orphaned timers when prop deps change mid-close

If the timeout duration is a prop (`delayMs`) and changes while
`visible` is already `false`, the effect re-runs, schedules a new
timer, and orphans the old one. The old timer fires at the original
delay and unmounts state the new timer expected to manage.

Fix: clear the existing timer at the top of the closing branch
before scheduling a new one (already shown in the recipe above).
The cleanup function alone is not sufficient because the re-run
path schedules a fresh timer before the cleanup runs.

### Pitfall: conditional-render vs always-render (1.6px residue)

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

### Pitfall: type widening from explicit annotations

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

### Diagnostic: auto-refresh dashboards leak one wrapped subtree per cycle

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

**Fix:** see Appendix B for the in-component state-machine recipe.
Past PRs: `Popover.tsx`, `LemonBadge.tsx`, `CardMeta.tsx`,
`LemonTableLoader.tsx`. After all consumers are migrated, remove
`react-transition-group` from the dependency tree.

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
- ✅ ruled out cross-tab `storage` events as the trigger (firing 200
  fake storage events on the posthog-js key produces zero DOM growth)
- ✅ confirmed all `storage` listeners we own (`useLocalStorage`,
  `welcomeDialogLogic`, `sceneLogic` pinned-tabs) filter strictly by
  key
- ✅ confirmed `kea-localstorage` is write-only (no `storage`
  listener)
- ✅ confirmed Playwright's `select_tab` does NOT fire
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
intervals, detached count and DOM node count have grown by N × M.

**Localisation:** identify which tile element is wrapped in something
that mounts/unmounts on each load cycle. Typical culprits: any RTG
`<CSSTransition>`, any `<Tooltip>` around a loading state, any chart
that creates external DOM (Chart.js tooltip plugins).

**Validation:** force-refresh via kea action (Step 3.9) and confirm
linear growth. A 10-cycle force-refresh should produce 10× the per-cycle
delta.

**Fix:** match the wrapper pattern against Patterns 1-3 above.

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

Validation (force-refresh × 10, post-GC):

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

Validation (force-refresh × 10, post-GC):

| metric | before | after |
| --- | --- | --- |
| DOM nodes / refresh | +244 | **0** (oscillates) |
| JS event listeners / refresh | 0 | 0 |
| Heap / refresh | +0.36 MB | flat (modulo API payload) |

PR: PostHog #56237.

### Example 3: Popover state-machine (Pattern 2, with animation)

Same problem as Example 2 but with a fade+rotate animation that needs
to play on exit. Solution: in-component state machine (Appendix B
recipe). Two state variables, two refs, `useLayoutEffect`.

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
- `useMemo` → `useRef` for stable id: counters parity restored
  (23/20 → 20/20) but detached count unchanged

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

## Appendix E: pitfalls observed in the wild

These are footguns we hit and want future agents to short-cut past.

### CDP forced-GC must be called twice

A single `HeapProfiler.collectGarbage` call leaves cross-heap V8↔Oilpan
references behind. Empirically a second call clears them. The cost is
~200ms of additional latency and zero risk; do it always.

### `select_tab` foregrounds the tab

Playwright's `mcp__playwright__browser_select_tab` brings the selected
tab to the front and fires `visibilitychange` on the deselected tab.
For background-tab tests, never use it. Drive each tab via its own
CDP session by webSocketDebuggerUrl (Step 3.7-3.8).

### `performance.memory` is bucketed by default

Without `--enable-precise-memory-info` browser flag, `usedJSHeapSize`
rounds to ~5 MB granularity for security. Cross-origin isolation
unlocks `performance.measureUserAgentSpecificMemory()` for byte-precision
measurements but requires HTTP headers we don't set in dev. **For
leak validation**, prefer CDP `Performance.getMetrics → JSHeapUsedSize`
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

## Appendix F: known findings to build on

If a future agent picks this up, here are facts established in prior
sessions so they don't have to re-derive them. Tag each finding as
`[fixed]`, `[partial]`, or `[open]` so the reader knows the state.

- **`[fixed]` `InsightTooltipWrapper-*` portal containers** on
  dashboards. Original cause: `useInsightTooltip` creating a
  `document.createElement('div')` + `createRoot(el)` per chart, with
  `useMemo(() => Math.random(), [])` for ids that drifted under
  StrictMode. Shipped fix (PR #55923): collapsed to dual-singleton
  pattern (one hover element, one pinned element, neither destroyed).
  20 detached → 0 detached over 30 cycles. See Appendix C Pattern 3
  and Appendix D Example 4.
- **`[fixed]` `BillingTooltipWrapper`** in `BillingLineGraph.tsx`. Same
  pattern as InsightTooltipWrapper. PR #55973 applies the same
  shared-singleton fix.
- **`[fixed]` Insight loading tooltip** at `InsightMeta.tsx:663`. PR
  #56235 removes the redundant `<Tooltip>` wrapper around the loading
  Spinner. Eliminates 9 listeners + 237 DOM nodes per dashboard
  refresh cycle. See Appendix D Example 1.
- **`[fixed]` LemonTableLoader** retention via CSSTransition. PR #56237
  drops the wrapper for conditional render. See Appendix D Example 2.
- **`[fixed]` Popover, LemonBadge, CardMeta** retention via
  CSSTransition. PR #56254 (Popover) plus #56253 (LemonBadge,
  CardMeta) replace RTG with the in-component state-machine recipe.
  See Appendix B and Appendix D Example 3.
- **`[partial]` `Tooltip` / `Tooltip__popup` / `Tooltip__arrow`** come
  from `lib/lemon-ui/Tooltip/Tooltip.tsx` which uses `BaseTooltip`
  from `@base-ui/react/tooltip`. Real React portals internally, so
  the leak is in base-ui or floating-ui. Removing redundant Tooltip
  wrappers (Pattern 1) eliminates many call sites' contribution; the
  residual is library-level.
- **`[open]` `DraggableCore` on dashboards** (telemetry top-3) is
  `react-grid-layout`'s drag handle. Volume is high (27M on dashboards
  out of 39M globally) but unconfirmed whether it's really a leak
  versus just a high-count component. Drive a dashboard-*edit*
  workload (drag, resize, delete tile) to verify — view-only mode
  doesn't exercise the cleanup paths.
- **`[open]` `LemonButton` (63M, 14K users)** is the most
  broadly-distributed named offender and appears on every page.
  Likely a victim of subtree retention rather than a primary leak.
  Investigation should check: which parent portal/menu held it, did
  the parent leak, did fixing the parent reduce LemonButton's
  detached count proportionally.
- **`[open]` Base UI Menu / Dialog / ContextMenu subtrees**
  (`primitive-menu-content`, `z-[var(--z-popover)]`,
  `ScrollableShadows`) retain one full subtree per instance even
  after forced GC + 30s delay. Heap snapshot retainer chain is
  `(Traced handles)` only — no JS retainer visible. Pattern is the
  same across Menu and Dialog (both use @base-ui/react). The Radix
  equivalent `DropdownMenu` doesn't leak because our wrapper uses
  `if (!open) return null` which tears down the Presence subtree
  synchronously. Initial attempts to apply that pattern to Base UI
  consumers produced only partial reduction. Likely needs a
  library-side fix or a heavier wrapper change.
- **`[open]` reselect/kea selector accumulation under stable mount
  counts.** Heap diff shows +318 closures per 25 SPA navs. Mount
  counts oscillate — they are NOT growing — but pathString variation
  causes selector rebuilds. See Appendix C Pattern 4.
- **`[open]` PerformanceObserver buffering web-vitals.** +180
  `LayoutShift` + 180 `LayoutShiftAttribution` + 146 each
  `PerformanceLongTaskTiming` and `TaskAttributionTiming` per 25
  SPA navs. We set `web_vitals_attribution: false` already; another
  observer must still be active. See Appendix C Pattern 5.
- **`[open]` Background-tab DOM growth during foreground tab work.**
  Reproducible at a real-Chrome level (3 tabs, work in tab 0, B and C
  show DOM growth). Eliminated several hypotheses (cross-tab
  `storage` events, kea-localstorage write-only, listener filtering).
  Open hypothesis: BroadcastChannel or SharedWorker. See Appendix C
  Pattern 6.
- **Scene-swap retention** (full `scene-content` subtree from prior
  scene detached after SPA nav) is Oilpan lag, not a JS leak. Heap
  snapshot shows only `(Traced handles)` retainer and the count clears
  on forced GC. Ignore this signal unless it's growing unboundedly
  across many scene transitions.
