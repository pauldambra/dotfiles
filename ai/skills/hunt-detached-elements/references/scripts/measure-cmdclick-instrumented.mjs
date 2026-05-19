#!/usr/bin/env node
// Adaptive variant of measure-cmdclick-sidebar.mjs: same setup, same sampling,
// but additionally auto-attaches network capture + a heap snapshot when a tab
// crosses the growth threshold. Baseline = MIN RSS observed during the first
// --baseline-window-samples samples (default 3), so it isn't polluted by the
// load high-water-mark.
//
// Output: NDJSON with `type:sample`, `type:network` for captured requests,
// `type:heap-snapshot` markers. Heap snapshots stream to
// ./leak-hunter-out/<label>-tab<i>-<ts>.heapsnapshot
//
// Usage:
//   BASE_URL=https://us.posthog.com node tools/leak-hunter/measure-cmdclick-instrumented.mjs \
//     --state=~/.leak-hunter-prod-state.json \
//     --idle=1800 --sample=30 --label=prod-post-disposables-fix \
//     --growth-threshold=200 --baseline-window-samples=3 \
//     --items="Dashboards|/dashboard,Product analytics|/insights,Web analytics|/web,Feature flags|/feature_flags,Error tracking|/error_tracking"

import { chromium } from 'playwright'
import { execSync } from 'node:child_process'
import { mkdirSync, createWriteStream } from 'node:fs'
import { homedir, platform } from 'node:os'
import { resolve, join } from 'node:path'

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, ...rest] = a.replace(/^--/, '').split('=')
        return [k, rest.join('=') || true]
    })
)

const baseUrl = process.env.BASE_URL || 'https://us.posthog.com'
const statePath = resolve((args.state || '~/.leak-hunter-prod-state.json').replace(/^~/, homedir()))
const idleSeconds = Number(args.idle ?? 1800)
const sampleEvery = Number(args.sample ?? 30)
const label = String(args.label ?? 'instrumented')
const growthThresholdMb = Number(args['growth-threshold'] ?? 200)
const baselineWindowSamples = Number(args['baseline-window-samples'] ?? 3)
const itemsArg = String(
    args.items ??
        'Dashboards|/dashboard,Product analytics|/insights,Web analytics|/web,Feature flags|/feature_flags,Error tracking|/error_tracking'
)
const items = itemsArg.split(',').map((s) => {
    const [name, path] = s.split('|')
    return { name: name.trim(), path: path.trim() }
})

const outDir = resolve(args.out || './leak-hunter-out')
mkdirSync(outDir, { recursive: true })
const ts = new Date().toISOString().replace(/[:.]/g, '-')
const outFile = join(outDir, `${label}-${ts}.ndjson`)
const out = createWriteStream(outFile)

const log = (...m) => console.log(`[${new Date().toISOString()}]`, ...m)
const write = (rec) => out.write(JSON.stringify(rec) + '\n')

log(
    `base=${baseUrl} state=${statePath} idle=${idleSeconds}s sample=${sampleEvery}s growth_threshold=${growthThresholdMb}MB baseline_window=${baselineWindowSamples} items=${items.length}`
)
log(`writing -> ${outFile}`)

function descendantPids(rootPid) {
    if (platform() !== 'darwin' && platform() !== 'linux') return new Set()
    const out = execSync('ps -axww -o pid=,ppid=').toString()
    const parentByPid = new Map()
    for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)/)
        if (m) parentByPid.set(Number(m[1]), Number(m[2]))
    }
    const descendants = new Set([rootPid])
    let grew = true
    while (grew) {
        grew = false
        for (const [pid, ppid] of parentByPid) {
            if (descendants.has(ppid) && !descendants.has(pid)) {
                descendants.add(pid)
                grew = true
            }
        }
    }
    return descendants
}

function rendererPidsForBrowser(browserPid) {
    if (platform() !== 'darwin' && platform() !== 'linux') return []
    const descendants = descendantPids(browserPid)
    const out = execSync('ps -axww -o pid=,command=').toString()
    const pids = []
    for (const line of out.split('\n')) {
        if (!line.includes('--type=renderer')) continue
        const m = line.match(/^\s*(\d+)\s/)
        if (!m) continue
        const pid = Number(m[1])
        if (descendants.has(pid)) pids.push(pid)
    }
    return pids.sort((a, b) => a - b)
}

function rssMbForPids(pids) {
    if (!pids.length) return {}
    const out = execSync(`ps -o pid=,rss= -p ${pids.join(',')}`).toString()
    const map = {}
    for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)/)
        if (m) map[Number(m[1])] = Math.round(Number(m[2]) / 1024)
    }
    return map
}

async function waitFullyLoaded(page, timeoutMs = 60_000) {
    try {
        await page.waitForLoadState('networkidle', { timeout: timeoutMs })
    } catch {}
    try {
        await page.waitForFunction(
            () => {
                const el = document.querySelector('.SpinnerOverlay, [data-attr="loading-spinner"]')
                if (!el) return true
                const r = el.getBoundingClientRect()
                return r.width === 0 && r.height === 0
            },
            { timeout: timeoutMs }
        )
    } catch {}
}

async function cdp(page) {
    const session = await page.context().newCDPSession(page)
    await session.send('Performance.enable')
    return session
}

async function sampleTab(session) {
    const heap = await session.send('Runtime.evaluate', {
        expression:
            'JSON.stringify({heap:performance.memory?performance.memory.usedJSHeapSize:0,vis:document.visibilityState,hidden:document.hidden})',
        returnByValue: true,
    })
    const parsed = heap.result?.value ? JSON.parse(heap.result.value) : {}
    const perf = await session.send('Performance.getMetrics')
    const get = (name) => perf.metrics.find((m) => m.name === name)?.value ?? 0
    return {
        js_heap_mb: parsed.heap ? Math.round(parsed.heap / 1024 / 1024) : null,
        visibility_state: parsed.vis ?? null,
        hidden: parsed.hidden ?? null,
        nodes: get('Nodes'),
        js_event_listeners: get('JSEventListeners'),
        documents: get('Documents'),
    }
}

async function enableNetworkCapture(session, tabIdx) {
    await session.send('Network.enable')
    session.on('Network.requestWillBeSent', (e) => {
        write({
            type: 'network',
            ts: Date.now(),
            tab: tabIdx,
            url: e.request.url,
            method: e.request.method,
            request_id: e.requestId,
            resource_type: e.type,
        })
    })
}

async function takeHeapSnapshot(session, tabIdx, suffix) {
    const path = join(outDir, `${label}-tab${tabIdx}-${suffix}.heapsnapshot`)
    const stream = createWriteStream(path)
    const handler = (chunk) => stream.write(chunk.chunk)
    session.on('HeapProfiler.addHeapSnapshotChunk', handler)
    try {
        await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
    } finally {
        session.off?.('HeapProfiler.addHeapSnapshotChunk', handler)
        stream.end()
    }
    write({ type: 'heap-snapshot', ts: Date.now(), tab: tabIdx, path })
    log(`heap snapshot tab${tabIdx} -> ${path}`)
}

const browser = await chromium.launch({
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
})
const harnessRootPid = process.pid
log(`harness root pid=${harnessRootPid}`)
const ctx = await browser.newContext({
    storageState: statePath,
    viewport: { width: 1280, height: 900 },
})

const firstTab = await ctx.newPage()
await firstTab.goto(baseUrl)
await waitFullyLoaded(firstTab)

if (firstTab.url().includes('/login')) {
    console.error('[harness] still on /login — re-run auth-setup.mjs.')
    await browser.close()
    process.exit(2)
}
log('first tab loaded, opening sidebar items as additional tabs')

const tabs = [firstTab]
for (const item of items) {
    const p = await ctx.newPage()
    await p.goto(new URL(item.path, baseUrl).toString())
    log(`opened ${item.name} -> ${p.url()}`)
    tabs.push(p)
}

log('waiting for all tabs to settle')
await Promise.all(tabs.map((p) => waitFullyLoaded(p)))

// Apply the visibility override on tabs 1..N (see header comment in
// measure-cmdclick-sidebar.mjs — Playwright cannot honest-flip visibilityState).
await firstTab.bringToFront()
const emulateHidden = args['emulate-hidden-on-bg-tabs'] !== 'false'
if (emulateHidden) {
    log(`overriding document.hidden=true on tabs 1..${tabs.length - 1}`)
    for (let i = 1; i < tabs.length; i++) {
        await tabs[i]
            .evaluate(() => {
                Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
                Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
                document.dispatchEvent(new Event('visibilitychange'))
            })
            .catch((e) => log(`visibility override failed tab${i}: ${e}`))
    }
}
await new Promise((r) => setTimeout(r, 1500))

const sessions = await Promise.all(tabs.map((t) => cdp(t)))
for (const s of sessions) {
    try {
        await s.send('HeapProfiler.collectGarbage')
    } catch {}
}

const pids = rendererPidsForBrowser(harnessRootPid)
log(`found ${pids.length} renderer pids: ${pids.join(',')}`)
const pidByTab = {}
for (let i = 0; i < tabs.length && i < pids.length; i++) {
    pidByTab[i] = pids[i]
}

const initialVisibility = await Promise.all(
    tabs.map((t) => t.evaluate(() => ({ vis: document.visibilityState, hidden: document.hidden })))
)
log(`visibility check: ${initialVisibility.map((v, i) => `tab${i}=${v.vis}`).join(' ')}`)
write({ type: 'visibility-check', ts: Date.now(), per_tab: initialVisibility })

write({
    type: 'meta',
    ts: Date.now(),
    base_url: baseUrl,
    label,
    idle_seconds: idleSeconds,
    sample_every_s: sampleEvery,
    growth_threshold_mb: growthThresholdMb,
    baseline_window_samples: baselineWindowSamples,
    items: [{ name: 'first', path: '/' }, ...items],
    pid_by_tab: pidByTab,
})

const rssWindow = {} // tabIdx -> [observed mb values, length <= baselineWindowSamples]
const baselineRss = {} // tabIdx -> min over window
const captureOn = new Set()

const start = Date.now()
const endAt = start + idleSeconds * 1000
let n = 0

while (Date.now() < endAt) {
    const rss = rssMbForPids(Object.values(pidByTab))
    const perTab = await Promise.all(sessions.map((s) => sampleTab(s).catch((e) => ({ error: String(e) }))))

    for (let i = 0; i < tabs.length; i++) {
        const r = rss[pidByTab[i]] ?? null
        if (r == null) continue
        if (!rssWindow[i]) rssWindow[i] = []
        if (rssWindow[i].length < baselineWindowSamples) {
            rssWindow[i].push(r)
            if (rssWindow[i].length === baselineWindowSamples) {
                baselineRss[i] = Math.min(...rssWindow[i])
                log(`tab${i} baseline locked at ${baselineRss[i]}MB (window=${rssWindow[i].join(',')})`)
            }
        } else if (baselineRss[i] != null && !captureOn.has(i)) {
            if (r - baselineRss[i] >= growthThresholdMb) {
                captureOn.add(i)
                log(`tab${i} grew ${r - baselineRss[i]}MB (>= ${growthThresholdMb}) — attaching network + heap`)
                await enableNetworkCapture(sessions[i], i).catch((e) => log(`net enable failed tab${i}: ${e}`))
                await takeHeapSnapshot(sessions[i], i, `growth-n${n}`).catch((e) =>
                    log(`heap snapshot failed tab${i}: ${e}`)
                )
                write({
                    type: 'growth-trigger',
                    ts: Date.now(),
                    tab: i,
                    baseline_mb: baselineRss[i],
                    current_mb: r,
                    growth_mb: r - baselineRss[i],
                })
            }
        }
    }

    const row = {
        type: 'sample',
        ts: Date.now(),
        n,
        elapsed_s: Math.round((Date.now() - start) / 1000),
        tabs: tabs.map((t, i) => ({
            i,
            url: t.url(),
            pid: pidByTab[i] ?? null,
            rss_mb: rss[pidByTab[i]] ?? null,
            baseline_rss_mb: baselineRss[i] ?? null,
            capture_on: captureOn.has(i),
            ...perTab[i],
        })),
    }
    write(row)
    const summary = row.tabs
        .map((t) => `tab${t.i}=${t.rss_mb ?? '?'}MB(${t.visibility_state ?? '?'})${t.capture_on ? '*' : ''}`)
        .join(' ')
    log(`sample ${n} t+${row.elapsed_s}s ${summary}`)
    n++
    await new Promise((r) => setTimeout(r, sampleEvery * 1000))
}

log('final GC + sample + snapshot of any captured tabs')
for (const s of sessions) {
    try {
        await s.send('HeapProfiler.collectGarbage')
    } catch {}
}
for (const i of captureOn) {
    await takeHeapSnapshot(sessions[i], i, 'final').catch((e) => log(`final snapshot failed tab${i}: ${e}`))
}
const finalRss = rssMbForPids(Object.values(pidByTab))
const finalPerTab = await Promise.all(sessions.map((s) => sampleTab(s).catch((e) => ({ error: String(e) }))))
write({
    type: 'final',
    ts: Date.now(),
    tabs: tabs.map((t, i) => ({
        i,
        url: t.url(),
        pid: pidByTab[i] ?? null,
        rss_mb: finalRss[pidByTab[i]] ?? null,
        baseline_rss_mb: baselineRss[i] ?? null,
        ...finalPerTab[i],
    })),
})

out.end()
await browser.close()
log(`done -> ${outFile}`)
