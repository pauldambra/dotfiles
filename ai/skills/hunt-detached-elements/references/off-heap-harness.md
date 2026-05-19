# Off-heap idle-tab reproducer (Step 7.5)

Full documentation for the `idle-leak-test.mjs` harness, production testing
setup, `measure-cmdclick-sidebar.mjs`, visibility emulation, and footprint
analysis tools. Load this reference when investigating renderer RSS growth
(the off-heap leak class) rather than in-browser detached element counts.

---

## Step 7.5: Off-heap idle-tab reproducer

For the leak class where renderer RSS climbs to GBs while V8 heap stays
flat (~150 MB) — observed on /experiments, /sql, /feature_flags in
production — `__leakHunter` won't help. The memory lives in Chrome's
renderer C++ allocators (Blink, paint records, compositor caches) that
JS can't see. Use the standalone Playwright harness:

```
# WRONG — solo idle tab will likely show no leak. The page reclaims
# memory in isolation. Don't waste 30 minutes on this.
node tools/leak-hunter/idle-leak-test.mjs --paths=/feature_flags

# RIGHT — multi-tab with one tab active. Tab 0 is your target
# (sampled idle), tabs 1+ are backgrounded co-residents. The
# --active-tab=0 flag drives periodic scroll/key interaction in
# tab 0 (foreground); leave it OFF when tab 0 is the idle target.
# If you want tab 0 idle AND tab N active, pass --active-tab=N.
BASE_URL=http://127.0.0.1:8000 HEADLESS=1 IDLE_SECONDS=3600 \
    node tools/leak-hunter/idle-leak-test.mjs \
    --paths=/home,/dashboard,/insights,/replay/home,/feature_flags,/error_tracking \
    --active-tab=0 --debug-port=9333 --sample=10
```

The harness:

1. Launches Chromium via Playwright with a unique `--user-data-dir`
   (so RSS sums only count its own renderer, not the host's day-to-day
   Chrome).
2. Logs in to the dev stack.
3. Opens one page per `--paths` entry — tab 0 is the first.
4. Waits for `networkidle` AND for `.SpinnerOverlay` to be gone on every
   tab (max 60s each). Then sleeps a grace period.
5. Captures pid->tab mapping by sorting renderer pids ascending (chromium
   spawns renderers in tab-creation order; stable for tab lifetime).
6. Force-GCs and snapshots all tabs.
7. Idles for `--idle` seconds, sampling renderer RSS via `ps -axww`
   filtered to the playwright user-data-dir, plus per-tab DOM count,
   listeners, and JS heap via CDP, every `--sample-every` seconds.
   Logs per-tab RSS using the pid->tab mapping (`tab0=315MB tab1=289MB ...`).
8. Force-GCs again, snapshots, prints per-tab + total summary.

---

## Critical gotchas (learned the hard way 2026-05-15)

- **BASE_URL must be `http://127.0.0.1:8000` (Django direct), not the
  Caddy proxy on :8010.** Two reasons: (1) `localhost` resolves to IPv6
  ::1 which the proxy doesn't bind to (curl times out); (2) the Caddy
  proxy has been observed returning `Content-Length: 0` for HTML routes
  while serving static assets fine — silently breaking SPA boot in a
  way that's invisible until you screenshot. The user's browser works
  because of cached service-worker assets; a fresh headless chromium
  has none of that and gets an empty body. Always confirm with
  `curl -sS $BASE_URL/login | wc -c` returning a real number before
  running.

- **`waitForLoadState('networkidle')` is necessary but NOT sufficient.**
  posthog-js polling, feature-flag refresh, and session-recording
  capture keep the network busy in PostHog so networkidle frequently
  times out at 30s with the spinner still up. The harness now also
  waits for `.SpinnerOverlay` to be absent or zero-sized. If you bypass
  this and start sampling, per-tab RSS numbers are not representative
  of fully-loaded scenes — they're loading-state numbers. **Always
  screenshot at least one tab early in the run to verify the scene
  actually rendered** (see `--debug-port` below).

- **One trial is not enough.** Trial 1 showed a sudden 3x spike at
  +2190s with a 6-min CDP stall (all tabs jumped simultaneously);
  trial 2 with the same config showed no spike, RSS monotonically
  decreased. The leak event is intermittent. Plan for >=3 trials before
  concluding either way. If you see a spike once, the question is
  reproducibility — schedule wake-ups to check at +30/+45/+60 min.

---

## Useful flags

- `--active-tab=<index>` — drive periodic interaction (wheel scroll +
  End/Home keys) on the tab at this index every sample cycle. Use to
  simulate a user working in one tab while others sit idle.
- `--debug-port=<port>` — exposes chromium DevTools on `localhost:<port>`.
  Lets you connect with a separate playwright script
  (`chromium.connectOverCDP('http://127.0.0.1:<port>')`) to screenshot
  each running tab mid-run, verify the scene is rendered, or attach
  DevTools manually. Without this, headless tabs are invisible — and
  you can't tell a fully-loaded tab from a stuck-on-spinner tab from
  the log alone. **Pick a port not used by the PostHog dev stack** —
  9333 is SeaweedFS, 8000 Django, 8010 Caddy, 8234 Vite, 9000 ClickHouse.
  9222 (chromium default) is usually free. Verify with
  `lsof -iTCP:<port> -sTCP:LISTEN` before launching; if a process is
  already there, chromium silently fails to bind and the harness runs
  without the debug port (you'll only notice when `connectOverCDP`
  fails).
- `--browser=firefox|webkit|chromium` (default chromium) — cross-engine
  testing. Firefox + WebKit lose per-tab heap (no CDP) but renderer
  RSS via `ps` still works. Use this to confirm any Chromium-specific
  hypothesis isn't a red herring (it often is — see "Hypotheses we
  already chased" in the main SKILL.md).
- `--disable-app-dedupe=true` — sets the storage-dedupe kill switch
  via sessionStorage before page load. Lets you A/B the wrapper if
  someone re-introduces it.
- `--disable-posthog-js=true` — nullifies `window.JS_POSTHOG_API_KEY`
  via init script so posthog-js never inits. Use to attribute heap
  growth to the SDK vs the app.

Env: `BASE_URL` (default `http://localhost:8010` — **override to
`http://127.0.0.1:8000`**), `LOGIN_USERNAME`, `LOGIN_PASSWORD`,
`IDLE_SECONDS`, `SAMPLE_EVERY_S`, `HEADLESS=1`.

---

## Verifying tabs are alive mid-run

Use `screenshot-paths.mjs` to do a sanity check by connecting to the
debug port:

```js
import { chromium } from 'playwright'
const b = await chromium.connectOverCDP('http://127.0.0.1:9333')
const ctx = b.contexts()[0]
for (const [i, p] of ctx.pages().entries()) {
    await p.screenshot({ path: `/tmp/trial-tab${i}.png` })
}
await b.close()
```

If a tab still shows just a spinner, your numbers are unreliable —
restart the run after fixing the wait logic.

This is the only diagnostic that catches off-heap renderer growth from
within a test. It lives in `tools/leak-hunter/` rather than the
playwright/ tree because it's a local-only investigation tool, not
shipped — same reason the dev `__leakHunter` helpers stay in this
skill rather than in-tree (see PR #57224 closure rationale).

---

## Testing against production instead of the local dev stack

The dev stack uses Hedgebox demo data, which is far too sparse to
reproduce production-scale growth. If a leak does not reproduce
locally, test against real production (https://us.posthog.com or your
real local project with realistic data) using the
`measure-cmdclick-sidebar.mjs` harness and a persisted auth profile.

One-time setup (headed, you log in manually including 2FA):
```bash
BASE_URL=https://us.posthog.com \
    node tools/leak-hunter/auth-setup.mjs \
    --user-data-dir=~/.leak-hunter-prod-profile
# A Chromium window opens. Log in. Press Enter in the terminal.
```

Subsequent runs reuse the persisted profile without prompting:
```bash
BASE_URL=https://us.posthog.com \
    node tools/leak-hunter/measure-cmdclick-sidebar.mjs \
    --user-data-dir=~/.leak-hunter-prod-profile \
    --idle=600 --sample=60 --label=prod \
    --items="Dashboards|/dashboard,Product analytics|/insights,Web analytics|/web,Feature flags|/feature_flags,Error tracking|/error_tracking"
```

**Why prod data matters:** demo /dashboard, /insights, etc. are tiny
(3 tiles, 50 events). A production account has hundreds of tiles,
millions of events, realtime polling that fires constantly, and
conversations-tickets unread-count polling every 5s. The leak only
manifests with real data shapes. If the harness shows nothing on demo,
**that does not mean there is no leak** — switch to production before
concluding the leak was fixed.

---

## Gotchas for prod testing

- **Profile lock:** only one Chromium can use a `--user-data-dir` at a
  time. If the previous run left a stale `SingletonLock`, the next run
  opens in an existing window instead of a fresh one. Fix:
  ```bash
  pkill -f "Chromium.*leak-hunter-prod-profile" 2>/dev/null
  rm -f ~/.leak-hunter-prod-profile/Singleton*
  ```
- **Cookie expiry:** prod sessions typically expire after 1-7 days.
  Re-run `auth-setup.mjs` when you get "still on /login" errors.
- **Sidebar items differ on prod:** the default `--items` list assumes
  the standard PostHog sidebar. Adjust for your actual navigation
  (e.g., add LLM analytics if your project has it). Cmd-click failures
  print the full anchor list; use those hrefs to tune `--items`.
- **Headed mode is required** for real `document.visibilityState`
  behavior. Headless chromium reports all tabs as `visible` regardless
  of focus, so the existing visibility-change handlers in the app
  (which gate polling to foreground tabs) never fire. Results from
  headless tests significantly over-count background-tab growth.

---

## Workflow with the harness

1. Run baseline (commit on master) -> record `rss_growth_mb`,
   `listeners_growth`, `js_heap_growth_mb`.
2. Apply candidate fix.
3. Re-run.
4. Compare deltas. If the fix moves the needle, ship it; if not, revert
   and try a different hypothesis.

Don't add strict thresholds inside the harness — keep it as a reporter.
Drift across machines is real (other Chrome instances, fan throttling,
Spotlight indexing) so the harness produces numbers, the *agent* makes
the call.

---

## Reframe (2026-05-15): per-scene baseline cost

A single-tab 100-reload test of /dashboard (via
`tools/leak-hunter/reload-loop.mjs`) showed renderer RSS distribution
min=1272, p50=1653, p90=1710, p99=2170 MB with JS heap dead-flat at
111-117 MB across all 100 iterations. No growth across reloads — the
leak narrative is misleading. It's a **per-scene baseline-cost
problem**: /dashboard literally cannot exist under ~1.3 GB of renderer
process; the floor is set on first paint and doesn't reclaim.

Multi-GB tabs in user reports are explained by loading one heavy scene
(1.5 GB) then visiting another (another 1+ GB) where prior scene native
memory doesn't fully release. Stop hunting for "tab grows over time"
and start measuring per-scene cold-load cost across scenes — that's
where the budget actually goes.

The remaining open question is *what* in the off-heap budget (Blink
C++ DOM wrappers, decoded images, code cache, paint records,
ExternalStringData) dominates — V8 heap snapshots see only ~110 MB of
the ~1500 MB total, so they cannot diagnose this. Next diagnostic step
is `chrome://tracing` with `memory-infra` category, or CDP
`Memory.getAllTimeSamplingProfile`.

**memory-infra trace interpretation**: the dominant allocators identified
so far are `partition_alloc/buffer` (~445 MB) and `parkable_strings`
(~128 MB). Neither has been attributed to specific code paths yet.
`parkable_strings` grows with every large API response body that V8
parks to disk — likely dashboard/insight JSON responses. Reducing
response sizes or enabling compression is the lever.
