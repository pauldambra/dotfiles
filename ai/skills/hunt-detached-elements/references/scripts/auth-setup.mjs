#!/usr/bin/env node
// One-time login flow that saves cookies + localStorage to a storageState
// JSON. Headed so the human handles password + TOTP. Auto-detects login
// completion by polling the page URL (no terminal interaction required).
//
// Completion criteria: page URL doesn't contain /login or /signup, AND the
// app shell sidebar is present (.PostHog app rendered). Times out after
// --timeout seconds (default 300).
//
// Usage:
//   BASE_URL=https://us.posthog.com \
//     node tools/leak-hunter/auth-setup.mjs \
//     --state=~/.leak-hunter-prod-state.json --timeout=300

import { chromium } from 'playwright'
import { homedir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, ...rest] = a.replace(/^--/, '').split('=')
        return [k, rest.join('=') || true]
    })
)

const baseUrl = process.env.BASE_URL || 'https://us.posthog.com'
const statePath = resolve((args.state || '~/.leak-hunter-prod-state.json').replace(/^~/, homedir()))
const timeoutS = Number(args.timeout ?? 300)

console.log(`[auth-setup] base=${baseUrl} state=${statePath} timeout=${timeoutS}s`)

mkdirSync(dirname(statePath), { recursive: true })

const browser = await chromium.launch({
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })

const page = await ctx.newPage()
await page.goto(baseUrl)

console.log(`[auth-setup] Chromium open. Complete login (incl. 2FA) in the window.`)
console.log(`[auth-setup] polling for completion... will detect automatically.`)

const start = Date.now()
const deadline = start + timeoutS * 1000
let loggedIn = false

while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500))
    let url = ''
    try {
        url = page.url()
    } catch {
        continue
    }
    if (/\/(login|signup|reset)/.test(url)) continue
    if (url === 'about:blank' || url === '') continue
    // app shell heuristic: navigate completes AND the page contains something
    // recognizably PostHog (a project-scoped URL is the strongest signal).
    if (/\/project\/\d+/.test(url) || /\/home/.test(url)) {
        loggedIn = true
        break
    }
}

if (!loggedIn) {
    console.error(`[auth-setup] timed out after ${timeoutS}s — login not detected. state not saved.`)
    await browser.close()
    process.exit(1)
}

console.log(`[auth-setup] login detected at ${page.url()} — saving state.`)
await ctx.storageState({ path: statePath })
await browser.close()
console.log(`[auth-setup] storage state saved -> ${statePath}`)
