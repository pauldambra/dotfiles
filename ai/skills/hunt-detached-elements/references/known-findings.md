# Known findings to build on (Appendix F)

Established facts from prior investigation sessions. Load this reference
at the start of a new hunt to avoid re-deriving already-known results.

Each finding is tagged `[fixed]`, `[partial]`, or `[open]`.

---

- **`[fixed]` `InsightTooltipWrapper-*` portal containers** on
  dashboards. Original cause: `useInsightTooltip` creating a
  `document.createElement('div')` + `createRoot(el)` per chart, with
  `useMemo(() => Math.random(), [])` for ids that drifted under
  StrictMode. Shipped fix (PR #55923): collapsed to dual-singleton
  pattern (one hover element, one pinned element, neither destroyed).
  20 detached -> 0 detached over 30 cycles. See Pattern 3 and Example 4
  in `known-patterns.md`.

- **`[fixed]` `BillingTooltipWrapper`** in `BillingLineGraph.tsx`. Same
  pattern as InsightTooltipWrapper. PR #55973 applies the same
  shared-singleton fix.

- **`[fixed]` Insight loading tooltip** at `InsightMeta.tsx:663`. PR
  #56235 removes the redundant `<Tooltip>` wrapper around the loading
  Spinner. Eliminates 9 listeners + 237 DOM nodes per dashboard
  refresh cycle. See Example 1 in `known-patterns.md`.

- **`[fixed]` LemonTableLoader** retention via CSSTransition. PR #56237
  drops the wrapper for conditional render. See Example 2 in
  `known-patterns.md`.

- **`[fixed]` Popover, LemonBadge, CardMeta** retention via
  CSSTransition. PR #56254 (Popover) plus #56253 (LemonBadge,
  CardMeta) replace RTG with the in-component state-machine recipe.
  See `pitfalls-and-rtg.md` and Example 3 in `known-patterns.md`.

- **`[fixed]` `kea-disposables` polling bypass** (PR #58691) —
  `add()` called while `document.hidden` ran setup immediately instead
  of deferring. Caused any poller rescheduling in a `finally`/listener
  (e.g. `conversations/tickets/unread_count` every 5s) to keep firing
  in backgrounded tabs indefinitely. Measured: 340 fetch requests in
  30 min from a single backgrounded `/error_tracking` tab on production.

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
  causes selector rebuilds. See Pattern 4 in `known-patterns.md`.

- **`[open]` PerformanceObserver buffering web-vitals.** +180
  `LayoutShift` + 180 `LayoutShiftAttribution` + 146 each
  `PerformanceLongTaskTiming` and `TaskAttributionTiming` per 25
  SPA navs. We set `web_vitals_attribution: false` already; another
  observer must still be active. See Pattern 5 in `known-patterns.md`.

- **`[open]` Background-tab DOM growth during foreground tab work.**
  Reproducible at a real-Chrome level (3 tabs, work in tab 0, B and C
  show DOM growth). Eliminated several hypotheses (cross-tab
  `storage` events, kea-localstorage write-only, listener filtering).
  Open hypothesis: BroadcastChannel or SharedWorker. See Pattern 6
  in `known-patterns.md`.

- **`[open]` `/replay/home` consistently grows 900-1400 MB when
  backgrounded** in 3/3 headed-production runs — separate from the
  polling fix above. Likely snapshot data held in kea state + rrweb
  player not releasing on hide. Not yet fixed.

- **`[open]` per-scene baseline costs are very high** (1.3-1.7 GB
  for /dashboard on prod). Dominant allocators identified via
  memory-infra trace: `partition_alloc/buffer` (~445 MB) and
  `parkable_strings` (~128 MB). Not yet attributed to specific code
  paths. Next step: `chrome://tracing` with `memory-infra` or CDP
  `Memory.getAllTimeSamplingProfile`. See `off-heap-harness.md` for
  context.

- **Scene-swap retention** (full `scene-content` subtree from prior
  scene detached after SPA nav) is Oilpan lag, not a JS leak. Heap
  snapshot shows only `(Traced handles)` retainer and the count clears
  on forced GC. Ignore this signal unless it's growing unboundedly
  over many navigations (not just one).
