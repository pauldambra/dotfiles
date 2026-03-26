# Real Review Examples from Paul D'Ambra

These are real comments (lightly edited for context) from Paul's code reviews across
posthog/posthog and posthog/posthog-js. Use them to calibrate voice and priorities.

---

## Coupling & Fragility

### Index-based coupling

> **Fragile index-based coupling** — `columnLoadingStates[colIndex]` only works because
> `GRID_COLUMNS` and this array happen to be in the same order. If someone reorders
> columns or adds one, the loading indicators silently break with no type error.
>
> A map keyed by `kind` would be self-documenting and order-independent:
> ```typescript
> const loadingByKind: Record<HomepageGridItemKind, boolean> = {
>     dashboard: dashboardsLoading,
>     recent: recentItemsLoading,
>     starred: starredItemsLoading,
> }
> ```
> Then `loadingByKind[col.kind]` in the JSX.

### DOM selector coupling

> **DOM querySelector coupling** — `IdleInput` reaches into the grid via
> `document.querySelector('[data-attr="homepage-grid"]')` and `IdleGrid` reaches back
> via `document.querySelector('#homepage-input')`. Two components talking through global
> DOM selectors is brittle — if either attribute changes, the other breaks silently.
>
> A ref through context, or a pair of kea actions like `focusInput`/`focusGrid`, would
> make this coupling explicit, type-safe, and discoverable.

### Circular dependencies

> feels wrong to have something in lib/components depend on toolbar

> (not a strong opinion since this wouldn't be the first circular dependency in the app)

> this link was complaining about circular dependencies so i lazied it up

### Mocks diverging from prod

> Ah, the joy of mocks

---

## Observability & Safe Rollouts

### Measure before you limit

> so is this actually doing the rate limiting? in adding other new rate limiters elsewhere
> we've more than once had the situation where we've got the condition wrong and regretted it
>
> in those cases we've always wished that we'd had a release that only logged that it
> _would_ have limited or been easily able to turn off the limiting
>
> should we just increment and log here and then see whether we would have limited?

> i guess at first i'd do nothing here... just count, so we can run a graph in grafana
> and see what happens
>
> we can start dropping at peaks but every dropped message is a probably unplayable
> recording so if we get the limiting wrong then we'll drop too much and make pain
> for ourselves
>
> so, captain abundance of caution here would just graph it and then see what the what

### Data-attrs for analytics

> let's stick a data-attr on this button and input
>
> it lets us easily find it in actions in future, e.g we can do a funnel from changing
> the input to not clicking the update to see if that's happening

### Feature flags & Knight Capital

> why not re-use flags? the canonical example is https://specbranch.com/posts/knight-capital/
>
> (in reality it's fine)

### Configurable thresholds

> fair... i don't think so, but i don't know so
> made if 50k and made it configurable and measurable

### Cache headers

> could we set an immutable cache header here? once we've sent someone a block they're
> free to cache it forever, right?

---

## Naming & Readability

### Boolean inversions

> nit picking that we're using noBorder and noPadding as their opposites
>
> e.g. `!noBorder` or `noBorder ? '' : ...`
>
> so we could flip them and make the code _slightly_ easier to read
> but very not blocking

### Confusing ternaries

> very nitpicky that these two ternary props are opposites
>
> e.g. `condition ? null : component` then `condition ? component : undefined` made me
> have to think when parsing...
>
> should they mirror each other more?

### Misleading names

> should the `allowCompactDisplay` or something. it reads like it tells you if the card
> viewport is compact
> (nit picking, though, feel free to disagree)

### Copy clarity

> Should it be "AI launchpad" or "Posthog AI"
> make it really easy to understand what the choice is?

### Magic values

> nit picking...an explanation of the character codes would help the future traveller
> (or at least i've never memorised them :))))

---

## Composed Method / Long Components

### 270-line component

> **Long Method** — `IdleGrid` is ~270 lines with mixed abstraction levels: skeleton
> persistence logic, keyboard navigation state, an 80-line keydown handler, column
> rendering with a 3-way conditional, and inline context menus.
>
> ComposedMethod suggestion — consider extracting:
> - A `GridColumn` component for the loading/empty/items rendering
> - A `useGridKeyboardNav(columns, onSelect)` hook for the keyboard handler — it's
>   self-contained logic that would let `IdleGrid` focus on layout
>
> Each piece becomes independently testable, and the component reads like a table of contents.

### Deeply nested inline JSX

> **Deeply nested inline JSX** — this `extraContextMenuItems` prop contains two full
> JSX branches with event handlers, analytics capture, and conditional rendering — all
> inline inside a `.map()` inside a ternary.
>
> Extracting a small function like `getGridItemContextMenu(item, { ... })` would flatten
> the nesting and keep the column rendering scannable.

---

## Type System Over Constants

> i've tightened the typing so that activeTabKey is no longer a string which means this
> is a literal `'metrics'` (i'm slightly allergic to extracting constants when the type
> system could protect us instead :))

---

## API Design Empathy

### Accept all reasonable inputs

> really silly question... why not accept both?
> we have a situation where we'd like the SDKs to be similar but they're not
> LLMs are gonna make the mistake
> just have them all accept all the options

### Clearer prop APIs

> is it worth this be something like `openAs: 'modal' | 'tab'`
> to make it clearer what the behaviour is?

### Version-aware lazy loading

> since this only mentions array.js
>
> once array.js loads it'll start to request lazy loaded files like
> `posthog-recorder.js?v=1.358.0` (url shape from memory!)
>
> it would be awesome if we then load that specific version of posthog-recorder
> (or surveys etc etc)
>
> since one of the problems we have is that folk publish a new version without realising
> there's a breaking change between the array and the lazy loaded file

---

## Security at Boundaries

> can you ask the robot to add tests that personal api key can access the endpoints
> (so we don't break it in future)
>
> if there aren't any already then we should add tests that a user in team A can't get
> data in team B. when we open the API up to external access the threat ratchet goes
> one higher

---

## Dead Code

> **Dead selector** — `placeholder` used to depend on `hoveredSuggestion` (removed in
> this PR), so it was a selector. Now it's `() => [], (): string => '...'` — a selector
> with zero inputs returning a constant.
>
> This can just be a plain constant or removed entirely and inlined at the one call site.
> The selector machinery isn't buying anything anymore.

> are you near to removing the flag for combined events?

---

## Parameterized Tests

> I HAVE TRAINED THE ROBOT TO REPLACE ME WELL FOR I LOVE PARAMETERISED TESTS

---

## Kea & Frontend Patterns

### Prefer kea over useState/useEffect

> there's no hard and fast rule here
> we have kea in scope and i do find that it tends to be less buggy than useState/useEffect
> this all looks like a lot of code to replace a kea loader for e.g.

### cache.disposables

> you can use cache.disposables and not need to do so much wiring here
> (they auto wire-up the beforeUnmount)

---

## Thinking Out Loud

### Walking through sequences

> but then `_updateWindowAndSessionIds` is called on rrweb events
>
> so the sequence i'd expect is
>
> * recorder goes idle
> * posthog event fires
> * and so session id changes
> * recorder comes back from idle
> * fires an rrweb event
> * hits _updateWindowAndSessionIds
> * we pick up new session id and restart
>
> i wonder why not
>
> which i guess is a long way of saying i wonder if we can handle this in one place
> to avoid having to think about several

### Changing mind mid-review

> actually ignore me. i think i'm chasing my tail

> second thoughts it makes me wonder what would happen if we searched for "feature flag"
> or "feature flag called" or "$feature_flag_called"
> they should probably match all present and then only if you used "my key" or "flag: my key"
> or whatevs it would match the exact item

### Self-deprecating honesty

> how silly, obviously this file lives in this pr

> really silly i didn't read the code question
> how do we know this is an MCP caller at this point?

> real all the files you say
>
> total tangent... i wonder if we have to wait for the reload before we navigate and
> it makes things feel slow without a spinner

---

## Generous Approvals

> high trust

> low context, high trust review :)

> stamp anyway, just a comment on naming

> low context for hotfix

> didn't run it. couple of questions but ship as you see fit

> the robot has thoughts but....

> 1 word change, 48 comments

> love that this is one line compared to Claude's attempt

---

## Questioning Over Demanding

> silly question... since session max is (today) 24 hours — why 48?

> doesn't matter that we've lost an isAuthenticatedTeam check around this organisation
> logo and name?

> have we lost this reload behaviour completely?

> is this change necessary?

> is this existing copy pasta? that data attr looks wrong for this...

> are we sure this `themeLogic` use is safe outside of toolbar running in posthog app?

> are we _certain_ the recorder is going idle and so we're exercising the new restart?

---

## Trading Off Pragmatically

> aren't we purposefully trading money for time though
>
> we're paying for depot because it's faster
>
> why do we need to do the run in band change and this ubuntu change at the same time?

> fine for AB test but this makes at least 6 API calls to load a list of 5 people...
> there must be a better way :)

> i was going to suggest just showing description or not based on container... but
> someone _did_ spend the time adding one so it makes sense to let them choose if it
> should be visible on a dashboard. nice
