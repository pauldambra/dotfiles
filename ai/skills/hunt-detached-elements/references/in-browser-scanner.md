# In-browser scanner setup (Steps 2–3.10)

Full implementation steps for `window.__leakHunter` helpers, CDP GC utilities,
heap snapshot tooling, process metrics, multi-tab polling, and retainer chain
analysis. Load this reference when setting up in-browser JS detection.

---

## Step 2: Expose the on-demand scanner + attribution helpers

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

---

## Step 2.4: Add `forensics()` and `rawElements()`

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

---

## Step 2.5: Add a strict-scan helper (Oilpan-aware)

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

---

## Step 2.6: Add `health()` + `dev_health` context on captures

`__leakHunter.scan()` answers "what's detached right now?" but not "is
the heap / DOM / listener density growing over time?". The renderer
total memory often grows multi-GB with the V8 heap and DOM count
nearly flat — the only signal that climbs in lockstep with the actual
pain is **listener density** (DOM nodes / React-tracked components).
Add a `health()` helper for one-shot probing and tag every captured
`detached_elements` event with the same shape so you get a time
series across a session.

Add a `tab age` epoch and a single collector function near the top of
the tracker file:

```ts
interface DevHealth {
    js_heap_used_mb: number | null
    js_heap_total_mb: number | null
    js_heap_limit_mb: number | null
    dom_node_count: number
    document_count: number
    iframe_count: number
    canvas_count: number
    svg_count: number
    image_count: number
    tab_age_seconds: number
    listeners_per_node: number | null
}

const tabLoadedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()

export function collectDevHealth(detachedReactCount: number, totalReactCount: number): DevHealth {
    const m = (
        performance as unknown as {
            memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
        }
    ).memory
    const dom = document.getElementsByTagName('*').length
    const reactNodes = totalReactCount + detachedReactCount
    return {
        js_heap_used_mb: m ? +(m.usedJSHeapSize / 1024 / 1024).toFixed(1) : null,
        js_heap_total_mb: m ? +(m.totalJSHeapSize / 1024 / 1024).toFixed(1) : null,
        js_heap_limit_mb: m ? +(m.jsHeapSizeLimit / 1024 / 1024).toFixed(1) : null,
        dom_node_count: dom,
        document_count: document.querySelectorAll('html').length,
        iframe_count: document.querySelectorAll('iframe').length,
        canvas_count: document.querySelectorAll('canvas').length,
        svg_count: document.querySelectorAll('svg').length,
        image_count: document.querySelectorAll('img').length,
        tab_age_seconds: Math.round(
            ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - tabLoadedAt) / 1000
        ),
        listeners_per_node: reactNodes > 0 ? +(dom / reactNodes).toFixed(2) : null,
    }
}
```

Add it to `__leakHunter` alongside `scan`/`attribute`/etc:

```ts
health: () => {
    const r = scanner.scan()
    return collectDevHealth(r.totalDetachedElements, r.totalElements)
},
```

And tag the existing `posthog.capture('detached_elements', { ... })`
call with a `dev_health` field — guarded by the same `NODE_ENV` check
so production telemetry shape stays unchanged:

```ts
const properties: Record<string, unknown> = {
    total_elements: result.totalElements,
    detached_elements: result.totalDetachedElements,
    // ...existing fields...
}

if (process.env.NODE_ENV === 'development') {
    properties.dev_health = collectDevHealth(result.totalDetachedElements, result.totalElements)
}

posthog.capture('detached_elements', properties)
```

**What to interpret**:

- `listeners_per_node` climbing while `dom_node_count` is flat -> orphan
  listeners accumulating (closures pinning off-heap allocations like
  canvas backings or response Blobs).
- `js_heap_used_mb` flat while `tab_age_seconds` grows -> the leak is
  off-heap. Don't bother with V8 heap snapshots; investigate Blink-side
  state, network buffers, or compositor caches.
- `canvas_count: 0` but renderer total is huge -> canvas backings are
  detached but pinned via JS refs (the bookmarklet probe of a 3 GB
  tab showed this exact shape).

---

## Step 3: Drop in the CDP forced-GC helper

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
// Twice: a single pass often leaves cross-heap refs (V8<->Oilpan) that only
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
`totalDetachedElements` <= 5 and `usedJSHeap` in the 200-300 MB range.

---

## Step 3.5: Heap snapshot diff workflow

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

**Snapshots larger than ~500 MB won't fit in a JS string** (V8's
`max_string_length` is 0x1FFFFFE8 ~= 512 MB). When `readFileSync` blows
up with `ERR_STRING_TOO_LONG`, switch to the Python streaming analyzer
at `tools/leak-hunter/stream-heap-analyzer.py` (uses `ijson` —
`python3 -m pip install --user --break-system-packages ijson` if
missing). It reports:

- Top constructors by total `self_size` (count + size, plus
  detached-instance count and size).
- Top constructors with detached instances ranked by detached size.
- Top 20 individual detached nodes.
- Forward-BFS subtree size and node count for the top 5 detached roots.
- Retainer chain (one preferred parent per level, max depth 15) for
  every detached `HTMLDocument` — these are the single most valuable
  output: each detached HTMLDocument is a full retained old DOM tree.

```bash
/usr/bin/python3 tools/leak-hunter/stream-heap-analyzer.py /path/to/snap.heapsnapshot
```

Multiple detached `HTMLDocument` instances is a *signal*, not a
*diagnosis* — see hypothesis 6 in the main SKILL.md for the DOMPurify
cul-de-sac. Treat retainer chains as one parent per node, not as cause.

---

## Step 3.6: Process metrics via CDP (DOM nodes, listeners, layouts)

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

---

## Step 3.7: Multi-tab CDP polling (background-tab measurement)

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

---

## Step 3.8: Drive a tab without focusing it

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

---

## Step 3.9: Forcing kea actions via CDP (cheap workload simulation)

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

---

## Step 3.10: Heap retainer chain for a specific node

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
- **Path ends at a global object** (e.g., `Window`, `(GC roots)` ->
  named global) — find the variable name in the chain; that's the
  retainer.
- **Path ends at `(closure)`** — a captured closure variable. Walk
  back to its `(scope)` parent and find the function that defined it.
- **Path ends at a `Map` / `WeakMap` / `Array`** — something is
  pushing without clearing. Find the owner of the collection.
