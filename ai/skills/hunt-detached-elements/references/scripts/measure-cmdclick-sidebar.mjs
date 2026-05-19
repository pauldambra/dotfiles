#!/usr/bin/env node
// Headed Chromium harness using chromium.launch() + newContext({storageState}).
//
// Visibility: Playwright has a known long-standing limitation that
// document.visibilityState always reports 'visible' regardless of tab focus
// (see microsoft/playwright#2286, #22634). There is no CDP method that
// honestly flips a tab to hidden in headed mode (Page.setWebLifecycleState
// requires the tab to already be hidden). So we use the standard
// JS-injection workaround: on tabs 1..N we override document.hidden +
// document.visibilityState and dispatch visibilitychange. This exercises
// the exact code path production listeners (e.g. kea-disposables) use.
//
// Flow:
//   1) launch headed chromium with persisted storage state (run auth-setup.mjs first)
//   2) open BASE_URL in tab 0 (foreground)
//   3) for each --items entry, open a new tab via context.newPage() and goto path.
//      Each newPage() becomes the active tab; we bringToFront() tab 0 at the
//      very end so the prior items end up real-backgrounded.
//   4) wait for each tab to fully render (networkidle + .SpinnerOverlay gone)
//   5) idle for --idle seconds, sampling every --sample seconds:
//        - renderer RSS per tab (via `ps -axww` filtered to a unique marker
//          arg we pass to chromium, pids sorted ascending == tab creation order)
//        - JS heap + visibility + DOM count + listeners via CDP per tab
//   6) write one NDJSON line per sample to ./leak-hunter-out/<label>-<ts>.ndjson
//
// Usage:
//   BASE_URL=https://us.posthog.com node tools/leak-hunter/measure-cmdclick-sidebar.mjs \
//     --state=~/.leak-hunter-prod-state.json \
//     --idle=600 --sample=60 --label=prod \
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
const idleSeconds = Number(args.idle ?? 600)
const sampleEvery = Number(args.sample ?? 60)
const label = String(args.label ?? 'run')
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

log(`base=${baseUrl} state=${statePath} idle=${idleSeconds}s sample=${sampleEvery}s items=${items.length}`)
log(`writing -> ${outFile}`)

// Build ancestor->descendant set by walking ppid pointers. Used to filter
// renderer pids to only our chromium subtree, since playwright's tmp profile
// dir path is the only stable identifier and is awkward to grep for.
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
        layout_count: get('LayoutCount'),
    }
}

const browser = await chromium.launch({
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
})
// Playwright doesn't expose the chromium browser pid (browser.process is a
// Puppeteer API). Use our node pid as the root — chromium is a descendant.
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
    console.error('[harness] still on /login — re-run auth-setup.mjs to refresh storage state.')
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

// Apply the visibility override on tabs 1..N. Bringing tab 0 to front does
// NOT honestly flip visibilityState in headed playwright (see file header).
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

// verify visibility before committing to the long run
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
    items: [{ name: 'first', path: '/' }, ...items],
    pid_by_tab: pidByTab,
})

const start = Date.now()
const endAt = start + idleSeconds * 1000

let n = 0
while (Date.now() < endAt) {
    const rss = rssMbForPids(Object.values(pidByTab))
    const perTab = await Promise.all(sessions.map((s) => sampleTab(s).catch((e) => ({ error: String(e) }))))
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
            ...perTab[i],
        })),
    }
    write(row)
    const summary = row.tabs.map((t) => `tab${t.i}=${t.rss_mb ?? '?'}MB(${t.visibility_state ?? '?'})`).join(' ')
    log(`sample ${n} t+${row.elapsed_s}s ${summary}`)
    n++
    await new Promise((r) => setTimeout(r, sampleEvery * 1000))
}

log('final GC + sample')
for (const s of sessions) {
    try {
        await s.send('HeapProfiler.collectGarbage')
    } catch {}
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
        ...finalPerTab[i],
    })),
})

out.end()
await browser.close()
log(`done -> ${outFile}`)
