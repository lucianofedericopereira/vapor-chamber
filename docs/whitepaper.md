# Vapor Chamber — Whitepaper
**Version 0.5.0-pre — March 2026**

*Luciano Federico Pereira — ORCID 0009-0002-4591-6568 — luciano-pereira.pages.dev*

---

## Abstract

Vapor Chamber is a ~2–4KB command bus built for Vue Vapor. It provides a semantic,
middleware-aware dispatch layer that connects any frontend pattern to any backend, without
imposing a framework, a build system, or an opinion about your stack.

---

## 1. The Problem

Modern frontend tooling has split into two directions:

**The full SPA route** — React, Vue with Pinia, full routing on the client, duplicated
validation logic, REST APIs that exist only to feed the frontend, and a build pipeline that
must run before you can ship anything.

**The server-driven route** — Livewire, Phoenix LiveView, HTMX — which trade client complexity
for backend coupling. You gain simplicity, but you lose the flexibility to use the best tool
for each layer.

Alpine.js proved a third path exists: a runtime small enough to drop into a Blade template via
CDN, expressive enough to handle real interactivity, and agnostic enough to work alongside any
backend. It doesn't try to replace Laravel. It doesn't try to replace Vue.

Vapor Chamber occupies the same position for Vue Vapor: the command bus that orchestrates
actions across any stack, at any scale, without lock-in.

---

## 2. Core Philosophy

### 2.1 Semantic over imperative

Instead of scattered `emit`, `v-on`, and component-local handlers, Vapor Chamber gives every
user action a name and one handler. The question shifts from "where did this get handled?" to
"what does this do?" — and the answer is always one function.

```js
bus.dispatch('cartAdd', product, { quantity: 2 })
```

### 2.2 Transport agnostic

The bus doesn't know or care how a command reaches the backend. HTTP fetch, WebSocket, SSE —
all of these are plugins. The core stays minimal regardless of what transport you choose.

### 2.3 Build optional

Vapor Chamber ships as an ES module and as an IIFE. You can import it through a CDN inside a
Blade template and have a reactive command bus running in under 30 seconds, zero npm involved.

### 2.4 Framework agnostic at the top

The core `command-bus.ts` has zero Vue imports. It runs anywhere: Vue 3.5 (VDOM), Vue 3.6
Vapor, Node.js tests, Web Workers, any JavaScript runtime. The Vue-specific layer is a thin
wrapper that adds signals, lifecycle cleanup, and shared bus management.

### 2.5 camelCase action names — an empirical decision

Action names use **camelCase** (`cartAdd`, `orderCreate`, `authLogin`). This is not a stylistic
preference — it is grounded in empirical measurement.

Pereira (2026) measured BPE tokenization differentials across four naming conventions on a
corpus of 200 enterprise event identifiers, modeled across 500 LLM responses:

> "Dot notation produces 1.12–1.20× more tokens than camelCase (p < 0.001), generating a
> projected cost differential of **$54,499/year** at enterprise API volumes."
> — *Empirical Validation of Cognitive-Derived Coding Constraints and Tokenization Asymmetries
> in LLM-Assisted Software Engineering*, §4.1

> "The relative efficiency ordering of the four naming conventions is identical across every
> vocabulary tested (Spearman ρ = 1.000), confirming that the camelCase advantage is
> **structural**, not an artefact of any particular tokenizer's training data."
> — ibid., §4.2

Cross-model consistency was verified across GPT-4o, GPT-4, and Claude. All three achieve
Spearman ρ = 1.000. camelCase wins universally.

**Why camelCase over snake_case:** Both outperform dot notation. camelCase edges out snake_case
because underscores, like dots, introduce punctuation characters that force the tokenizer to
split adjacent morphemes. `cartAdd` is typically two tokens; `cart_add` risks three.

**The CDCC constraint:** The same paper establishes that functions at cyclomatic complexity ≤ 10
receive **3.3× more LLM output per input token** than violating functions (0.141 vs 0.043
output/input ratio, p < 0.001). This is why Vapor Chamber enforces CDCC-compliant function
sizes throughout the codebase — handler design encourages small, single-responsibility
functions: one action, one function, one outcome.

**Naming convention enforcement:**

```ts
const bus = createCommandBus({
  naming: {
    pattern: /^[a-z][a-zA-Z0-9]+$/,   // camelCase
    onViolation: 'throw',
  }
})

bus.register('cartAdd', handler)   // ✓ passes
bus.register('cart_add', handler)  // ✗ throws
bus.register('cart.add', handler)  // ✗ throws
```

**Reference:** Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding
Constraints and Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
https://zenodo.org/records/18853783.

---

## 3. Architecture

### 3.1 Layered design

```
┌─────────────────────────────────────────┐
│             any backend                 │
│   Laravel · Node · Django · Go · none   │
└────────────┬────────────────────────────┘
             │ JSON / state diff
┌────────────▼────────────────────────────┐
│           transport plugin              │
│   HTTP fetch · WebSocket · SSE · none   │
└────────────┬────────────────────────────┘
             │ normalized command
┌────────────▼────────────────────────────┐
│              CORE (~2–4KB)              │
│  command bus · middleware · state atoms │
│  command history · effectScope cleanup  │
│  typed commands (TypeScript generics)   │
└────────────┬────────────────────────────┘
             │ reactive state
┌────────────▼────────────────────────────┐
│         any frontend pattern            │
│  Blade+CDN · Inertia · Vite SFC        │
│  Next.js · Filament islands             │
└─────────────────────────────────────────┘
```

### 3.2 Dispatch flow

```
dispatch(action, target, payload)
  1. validate naming convention (regex test)
  2. build Command { action, target, payload }
  3. run plugins in priority order (cached runner — rebuilt only on use()/unuse())
  4. execute handler (Map.get — O(1) lookup)
  5. run afterHooks
  6. notify pattern listeners
  7. return CommandResult { ok, value?, error? }
```

The plugin chain is built once when plugins are added or removed. On each dispatch only the
innermost `execute` closure is created — no per-dispatch allocations for the chain traversal.

### 3.3 Core surface (stable API)

```ts
// Create and configure
const bus = createCommandBus({ onMissing: 'error' | 'throw' | 'ignore' })

// Register a handler with optional undo + throttle
bus.register('cartAdd', (cmd) => {
  state.cart.count += cmd.payload.quantity
}, {
  undo: (cmd) => { state.cart.count -= cmd.payload.quantity },
  throttle: 300,
})

// Dispatch from anywhere
bus.dispatch('cartAdd', product, { quantity: 2 })

// Async bus for async handlers and transport plugins
const asyncBus = createAsyncCommandBus()
await asyncBus.dispatch('orderCreate', { items })

// Batch dispatch — stops on first failure
const batchResult = bus.dispatchBatch([
  { action: 'cartAdd',        target: cart, payload: item },
  { action: 'totalsUpdate',   target: cart },
  { action: 'analyticsTrack', target: session },
])

// Wildcard listeners (not handlers — observe only)
bus.on('*', (cmd, result) => analytics.track(cmd.action))
bus.on('cart*', (cmd, result) => updateBadge())

// Request / response with timeout
bus.respond('getAuthToken', async (cmd) => fetchToken(cmd.target))
const result = await bus.request('getAuthToken', { userId: 42 }, { timeout: 3000 })
```

### 3.4 Transport plugins

```ts
// HTTP fetch — CSRF, retry, timeout, action filter
bus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  timeout: 15_000,
  retry: 2,
  actions: ['cart*', 'order*'],  // only forward these; others stay local
}))

// WebSocket — reconnect
bus.use(createWsBridge({ url: 'wss://api.example.com/vc' }))

// SSE — server push
bus.use(createSseBridge({ url: '/api/vc/stream' }))
```

### 3.5 HTTP client

`postCommand` is the underlying HTTP function used by `createHttpBridge`. Also exposed directly:

```ts
import { postCommand, readCsrfToken, invalidateCsrfCache } from 'vapor-chamber'

const res = await postCommand('/api/commands', { command: 'cartAdd', target: product }, {
  csrf: true,           // reads XSRF-TOKEN cookie / meta tag / hidden input; 5-min TTL cache
  timeout: 8_000,
  retry: 2,
  signal: controller.signal,
  onSessionExpired: (status) => router.push('/login'),
})
```

Key behaviours:
- Multi-source CSRF: meta tag → `XSRF-TOKEN` cookie → hidden `_token` input; 5-minute TTL cache
- 419 CSRF refresh coalesces concurrent requests (no duplicate refreshes)
- `Retry-After` / `X-RateLimit-Reset` header honoured on 429/503
- Jittered exponential backoff (avoids thundering herd)
- `AbortSignal.any` with manual fallback for older environments
- `TimeoutError` is distinct from `AbortError` (timeout vs user abort)
- `session-expired` CustomEvent dispatched on 401/419

---

## 4. Full Plugin Catalogue

| Plugin | Category | Purpose |
|--------|----------|---------|
| `logger` | DX | Grouped console logs for every dispatch |
| `validator` | Guards | Pre-dispatch validation with short-circuit |
| `history` | State | Undo/redo with inverse handler execution |
| `debounce` | Rate limiting | Wait for activity to stop before executing |
| `throttle` | Rate limiting | Execute immediately, block for N ms. Throws `{ message: 'throttled', retryIn }` on block. |
| `authGuard` | Guards | Block protected actions when unauthenticated |
| `optimistic` | UX | Apply state immediately, rollback on failure |
| `retry` | Resilience | Exponential/linear/fixed backoff on failure |
| `persist` | Storage | Auto-save state to localStorage/sessionStorage/custom |
| `sync` | Multi-tab | Broadcast commands to all open tabs via BroadcastChannel |
| `createHttpBridge` | Transport | Fetch-based HTTP transport |
| `createWsBridge` | Transport | WebSocket transport with reconnect |
| `createSseBridge` | Transport | Server-sent events (server push) |

```ts
// retry
bus.use(retry({
  maxAttempts: 3, strategy: 'exponential', baseDelay: 200,
  actions: ['api*'],
  isRetryable: (err) => err.message !== 'Unauthorized',
}))

// persist
const cartPersist = persist({ key: 'vc:cart', getState: () => cartState.value })
bus.use(cartPersist)
const saved = cartPersist.load()   // → T | null
cartPersist.save()                 // force save (e.g. beforeunload)
cartPersist.clear()                // remove (e.g. logout)

// sync — cross-tab BroadcastChannel
const tabSync = sync(
  { channel: 'vc:app', filter: cmd => cmd.action.startsWith('cart') },
  { dispatch: bus.dispatch.bind(bus) }
)
bus.use(tabSync)
tabSync.close()
```

---

## 5. Vue 3.6 and alien-signals

### 5.1 The reactivity rewrite

Vue 3.6 replaces Proxy-based reactivity with [alien-signals](https://github.com/stackblitz/alien-signals).
The public API is unchanged — `ref()`, `computed()`, `watch()` work identically — but `ref()`
IS a signal now, not a Proxy wrapper around one.

| Aspect | Proxy-based (Vue 3.0–3.5) | Alien-signals (Vue 3.6+) |
|--------|--------------------------|--------------------------|
| Tracking mechanism | Proxy `get`/`set` traps | Signal dependency graph |
| Granularity | Property-level on objects | Value-level on primitives |
| Memory overhead | Proxy + handler per reactive object | Lightweight signal node |
| Update propagation | Full component re-evaluation | Only affected signal consumers |

**Performance benchmarks from the Vue 3.6 beta:**
- 14% less memory for reactive state
- 40% less CPU on complex data visualizations
- Mounting 100,000 components in ~100ms (parity with SolidJS)
- Base bundle under 10KB for Vapor-only apps (vs ~50KB+ with VDOM)

Vapor Chamber auto-detects `ref()` at module load. No configuration needed — `signal()` IS a
Vue alien-signal in 3.6+.

### 5.2 Vapor mode — the VDOM-less path

Under Vapor mode, the compiler generates imperative DOM code instead of a render function:

```js
// VDOM: creates virtual nodes, diffs on every update
// Vapor: direct DOM binding, no diffing

const text = document.createTextNode('')
effect(() => { text.textContent = count.value }) // alien-signal subscription
```

For Vapor Chamber, this means `dispatch → state → signal → DOM node` with no intermediate
VDOM layer. The command bus handles `dispatch → state`; alien-signals handles `state → DOM`.

```ts
// Pure Vapor app (~40KB smaller — no VDOM runtime)
import { createVaporChamberApp } from 'vapor-chamber'
createVaporChamberApp(App).mount('#app')

// Mixed VDOM/Vapor tree (gradual migration)
import { getVaporInteropPlugin } from 'vapor-chamber'
const plugin = getVaporInteropPlugin()
if (plugin) app.use(plugin)
```

### 5.3 Lifecycle cleanup

Composables prefer `onScopeDispose` (Vue 3.5+) over `onUnmounted`. This is important because
in Vapor mode, component instances have a different internal structure than VDOM components.
`onScopeDispose` is the universal hook that works in component `setup()`, `effectScope()`,
Vapor components, and SSR — it's what Vue's own composables use internally.

### 5.4 Memory: useCommand vs defineVaporCommand

Each `useCommand()` call creates 2 signals (`loading`, `lastError`):

| Vue version | Per signal | 50 components using useCommand |
|-------------|-----------|-------------------------------|
| Vue 3.5 (Proxy) | ~200 bytes | ~20KB |
| Vue 3.6 (alien-signals) | ~64 bytes | ~6.4KB |

`defineVaporCommand()` creates 0 signals — suitable for fire-and-forget dispatches where
loading/error state is not needed in the template.

### 5.5 Rolldown / Vite 8 compatibility

Dynamic imports of optional peer dependencies use `/* @vite-ignore */` to prevent Rolldown
(Rust-based bundler in Vite 8) from treating them as required:

```ts
const vuePkg = 'vue'
import(/* @vite-ignore */ vuePkg)  // optional peer dep — must not fail build
```

---

## 6. Vue Composables

### 6.1 Full reference

```ts
// Reactive dispatch — loading + lastError signals
const { dispatch, loading, lastError } = useCommand()

// Zero-overhead hot path — no signals, no alien-signals graph nodes
const { dispatch: track } = defineVaporCommand('analyticsScroll', (cmd) => {
  gtag('event', 'scroll', { depth: cmd.target.depth })
})

// Reducer-based reactive state
const { state, dispose } = useCommandState(initialState, {
  'cartAdd':    (s, cmd) => ({ ...s, count: s.count + 1 }),
  'cartRemove': (s, cmd) => ({ ...s, count: s.count - 1 }),
})

// Undo / redo
const { canUndo, canRedo, undo, redo, past, future } = useCommandHistory({ maxSize: 50 })

// Namespace isolation — all calls prefixed in camelCase
const cart = useCommandGroup('cart')
cart.dispatch('add', product)      // → 'cartAdd'
cart.register('remove', handler)   // registers 'cartRemove'
cart.on('*', listener)             // listens to 'cart*'

// Error boundary
const { latestError, errors, clearErrors } = useCommandError({
  filter: (cmd) => cmd.action.startsWith('payment'),
})

// Direct bus access
const bus = useCommandBus()
```

### 6.2 When to use which

| Composable | Signals created | Use case |
|------------|-----------------|----------|
| `useCommand()` | `loading`, `lastError` | UI-bound dispatch (buttons, forms) |
| `defineVaporCommand()` | None | Fire-and-forget (analytics, scroll, search) |
| `useCommandBus()` | None | Direct bus access, no state tracking |
| `useCommandGroup()` | None | Feature namespace isolation |
| `useCommandError()` | `errors`, `latestError` | Component-scoped error display |
| `useCommandState()` | `state` | Reducer-based reactive state |
| `useCommandHistory()` | `past`, `future`, `canUndo`, `canRedo` | Undo/redo UI |

### 6.3 Directive plugin (opt-in, 0KB when not imported)

```ts
import { createDirectivePlugin } from 'vapor-chamber/directives'
app.use(createDirectivePlugin())
```

```html
<button v-vc:command="'cartAdd'"
        v-vc-payload="{ id: product.id, qty: 1 }">
  Add to cart
</button>
```

CSS classes applied automatically: `.vc-loading` (disables button) and `.vc-error` on failure.

### 6.4 Vite HMR plugin

```ts
import { vaporChamberHMR } from 'vapor-chamber/vite'
export default defineConfig({ plugins: [vue(), vaporChamberHMR()] })
```

Bus handlers and registered state survive Vite hot module replacement transparently.

---

## 7. Integration Patterns

The same bus API and mental model work identically across all stacks.

### 7.1 Blade + CDN (zero build)

```html
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber/dist/vapor-chamber.iife.min.js"></script>
<script>
const { bus, dispatch } = VaporChamber.createApp({
  transport: VaporChamber.http({ endpoint: '/api/vc', csrf: true }),
  plugins: [VaporChamber.logger()],
})
bus.use(VaporChamber.persist({ key: 'vc:cart', getState: () => state }))
</script>
```

**Backend (Laravel — no Livewire dependency):**
```php
Route::post('/vc', function (Request $request) {
    $state = match ($request->input('command')) {
        'cartAdd' => app(CartService::class)->add($request->input('target')),
        default    => abort(404),
    };
    return response()->json(['state' => $state]);
});
```

### 7.2 Laravel + Vite + SFC

```ts
const bus = createCommandBus()
bus.use(logger())
bus.use(retry({ maxAttempts: 3 }))
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))
createApp(App).use(createDirectivePlugin()).mount('#app')
```

### 7.3 Laravel + Inertia.js (complementary)

Inertia handles routing and page props. Vapor Chamber handles in-page actions.

```ts
const { dispatch } = useCommand()
const result = await bus.request('orderCancel', { id })
if (result.ok) router.visit('/orders')  // Inertia router
```

### 7.4 Next.js App Router

```tsx
// providers.tsx
const bus = createAsyncCommandBus()
bus.use(retry({ maxAttempts: 3 }))
bus.use(createHttpBridge({ endpoint: '/api/vc' }))

// app/api/vc/route.ts
export async function POST(req: Request) {
  const { command, target, payload } = await req.json()
  const state = await commandRouter.handle(command, target, payload)
  return Response.json({ state })
}
```

### 7.5 Filament panel islands

```html
<div id="analytics-island"></div>
<script>
VaporChamber.mount('#analytics-island', {
  transport: VaporChamber.http({ endpoint: '{{ $endpoint }}' }),
  state: { period: 'week', metrics: [] }
})
</script>
```

Livewire and Vapor Chamber never touch each other's DOM scope.

---

## 8. Migration Strategy: Vue VDOM → Vapor

### Phase 1 — Install vaporInteropPlugin (no code changes required)

```ts
import { createApp, vaporInteropPlugin } from 'vue'
createApp(App).use(vaporInteropPlugin).mount('#app')
```

Existing VDOM components continue working. Vapor components can now be nested inside them.

### Phase 2 — Convert hot-path components to Vapor

Identify components with frequent reactive updates (cart sidebar, filter bar, live search,
notification toasts). Change only the `<script>` tag:

```vue
<!-- Before -->
<script setup>
import { useCommand } from 'vapor-chamber'
const { dispatch, loading } = useCommand()
</script>

<!-- After — only the script attribute changes -->
<script setup vapor>
import { useCommand } from 'vapor-chamber'
const { dispatch, loading } = useCommand()
</script>
```

For fire-and-forget patterns, switch to `defineVaporCommand` to avoid unnecessary signal nodes:

```vue
<script setup vapor>
import { defineVaporCommand } from 'vapor-chamber'
const { dispatch: trackScroll } = defineVaporCommand('analyticsScroll', (cmd) => {
  gtag('event', 'scroll', { depth: cmd.target.depth })
})
</script>
```

### Phase 3 — Full Vapor app (optional)

```ts
import { createVaporChamberApp } from 'vapor-chamber'
createVaporChamberApp(App).mount('#app')
// No VDOM runtime loaded — ~40KB baseline savings
```

---

## 9. SSR

### 9.1 The challenge

Vue Vapor's signal-based reactivity is designed for direct DOM updates. On the server there is
no DOM, so signals work as plain values. The challenge is **hydration**: commands that ran on
the server to populate initial state need to replay on the client so reactive signals reflect
the same values from the start.

### 9.2 Per-request bus isolation

For production SSR with concurrent requests, always create a fresh bus per request:

```ts
import { createCommandBus, setCommandBus, resetCommandBus } from 'vapor-chamber'

export async function handleRequest(req, res) {
  const bus = createCommandBus()
  setCommandBus(bus)
  try {
    // ... render app, dispatch commands ...
  } finally {
    resetCommandBus()  // prevent cross-request contamination
  }
}
```

### 9.3 Dehydrate on server, rehydrate on client

```ts
// server-entry.ts
resetCommandBus()
const bus = getCommandBus()
const serverCommands: Array<{ action: string; target: any; payload?: any }> = []

bus.onAfter((cmd, result) => {
  if (result.ok) serverCommands.push({ action: cmd.action, target: cmd.target, payload: cmd.payload })
})

await setupApp()
// Embed in HTML: <script>window.__VAPOR_COMMANDS__ = JSON.stringify(serverCommands)</script>
resetCommandBus()
```

```ts
// client-entry.ts
const bus = getCommandBus()
for (const { action, target, payload } of (window.__VAPOR_COMMANDS__ ?? [])) {
  bus.dispatch(action, target, payload)
}
createVaporChamberApp(App).mount('#app')
```

### 9.4 Suppress side effects during hydration

```ts
let hydrating = true

bus.use((cmd, next) => {
  if (hydrating && isSideEffect(cmd.action)) return { ok: true, value: undefined }
  return next()
})

for (const cmd of commands) bus.dispatch(cmd.action, cmd.target, cmd.payload)
hydrating = false
```

### 9.5 Simpler alternative: seed signals from JSON

If your server renders state separately (e.g. via `useAsyncData`), skip the replay mechanism:

```ts
const { state } = useCommandState(
  window.__INITIAL_CART__ ?? { items: [], total: 0 },
  { 'cartAdd': (s, cmd) => ({ ...s }) }
)
```

### 9.6 SSR recommendations

| Scenario | Approach |
|----------|---------|
| Simple initial state (list of items, user profile) | Seed signals from JSON |
| State resulting from a command sequence | Dehydrate on server, replay on client |
| Side-effectful commands (analytics, API calls) | Use `hydrating` plugin to suppress during replay |
| Multiple concurrent SSR requests | `createCommandBus()` per request + `resetCommandBus()` in teardown |

---

## 10. Testing

```ts
import { createTestBus, setCommandBus, resetCommandBus } from 'vapor-chamber'

const bus = createTestBus()
setCommandBus(bus)

bus.dispatch('cartAdd', { id: 1 }, { qty: 2 })
bus.dispatch('cartAdd', { id: 2 })
bus.dispatch('checkout', {})

// Assertions
expect(bus.wasDispatched('cartAdd')).toBe(true)
expect(bus.getDispatched('cartAdd')).toHaveLength(2)

// Immutable snapshot — mutations don't affect bus.recorded
const snap = bus.snapshot()
expect(snap[0].cmd.payload).toEqual({ qty: 2 })

// Time-travel
const before = bus.travelToAction('checkout')   // [cartAdd, cartAdd, checkout]
const first2  = bus.travelTo(1)                  // [cartAdd, cartAdd]
bus.travelTo(999)                                // clamped to full history

// Clean up between tests
resetCommandBus()
```

---

## 11. What Vapor Chamber Is Not

**Not a Livewire replacement.** Livewire owns its component model end-to-end. Vapor Chamber
provides the data flow layer.

**Not a router.** Use Inertia, Vue Router, or Next.js Router for page transitions.

**Not a state management library.** `useCommandState` provides reactive state atoms for
command-driven values. Pinia remains the right tool for complex shared state — and works
alongside Vapor Chamber without conflict.

**Not opinionated about your backend.** The `/api/vc` endpoint is a convention, not a
requirement.

---

## 12. Comparison

| | Livewire | Alpine.js | HTMX | Vapor Chamber |
|---|---|---|---|---|
| Backend coupling | Laravel only | none | none | none |
| Build required | no | no | no | no (IIFE available) |
| Reactivity model | server-driven | x-data | hypermedia | Vue Vapor signals |
| Transport | AJAX/WS (built-in) | none | AJAX (built-in) | plugin |
| Bundle size | ~50KB | ~15KB | ~14KB | ~2–4KB core |
| TypeScript | partial | no | no | full |
| Vue DevTools | no | no | no | yes |
| Undo/redo | no | no | no | built-in |
| Cross-tab sync | no | no | no | built-in |
| State persistence | no | no | no | built-in |
| Retry/backoff | no | no | no | built-in |
| LLM-token efficient naming | no | no | no | enforced |

---

## 13. Implementation Status

### Implemented (v0.4.x / Unreleased)

- [x] Core command bus — sync and async, plugin pipeline, dead-letter, naming conventions
- [x] `effectScope` / `onScopeDispose` cleanup
- [x] Typed commands with TypeScript generics
- [x] Middleware chain — `bus.use()` with priority, async, cached runner (no per-dispatch alloc)
- [x] Command history — `useCommandHistory`, `history` plugin, inverse handlers
- [x] `useCommandGroup` — namespace isolation, camelCase prefixing
- [x] `useCommandError` — reactive error boundary, optional filter
- [x] `createHttpBridge` — fetch, CSRF, headers, timeout, retry, action filter
- [x] `createWsBridge` — WebSocket, reconnect
- [x] `createSseBridge` — server-sent events, server push
- [x] `retry` plugin — exponential/linear/fixed, `isRetryable` predicate
- [x] `persist` plugin — localStorage/sessionStorage/custom storage
- [x] `sync` plugin — BroadcastChannel cross-tab coordination
- [x] Vue DevTools — timeline layer, inspector panel, dynamic import (0KB prod)
- [x] `createTestBus` — snapshot, time-travel, dispatch recording
- [x] Directive plugin — `v-vc:command`, `v-vc-payload`, `v-vc-optimistic`
- [x] Vite HMR plugin — state-preserving hot reload
- [x] IIFE/CDN build — `vapor-chamber.iife.min.js`, global `VaporChamber`
- [x] `http.ts` — TypeScript HTTP client (`postCommand`, `readCsrfToken`, `invalidateCsrfCache`)
- [x] CDCC-compliant file splits — `plugins-core.ts`, `plugins-io.ts`, `chamber-vapor.ts`
- [x] camelCase action names throughout (empirically justified — Pereira 2026)
- [x] Async-on-sync guard — warns when async plugin installed on sync bus
- [x] SSR concurrency verified (4 dedicated tests)

### Remaining (0.5.0 milestones)

- [ ] `@vapor-chamber/laravel` — Artisan commands, command routing, state serialization
- [ ] `@vapor-chamber/devtools` — standalone DevTools panel (decoupled from `@vue/devtools-api`)
- [ ] Full documentation site with live examples for all five integration patterns
- [ ] Performance benchmark vs Alpine.js, Livewire, HTMX — published and reproducible
- [ ] API freeze declaration — semver guarantees from 0.5.0 onward

---

## 14. File Map

```
src/
  command-bus.ts    — core bus, SyncState/AsyncState, plugin pipeline, types
  chamber.ts        — signals, Vue probe, shared bus, tryAutoCleanup,
                      useCommand, useCommandState, useCommandHistory,
                      useCommandGroup, useCommandError, useCommandBus
  chamber-vapor.ts  — createVaporChamberApp, getVaporInteropPlugin, defineVaporCommand
  plugins-core.ts   — logger, validator, history, debounce, throttle, authGuard, optimistic
  plugins-io.ts     — retry, persist, sync
  plugins.ts        — barrel re-export of plugins-core + plugins-io
  http.ts           — postCommand, readCsrfToken, invalidateCsrfCache
  transports.ts     — createHttpBridge, createWsBridge, createSseBridge
  directives.ts     — createDirectivePlugin
  vite-hmr.ts       — vaporChamberHMR() Vite plugin
  iife.ts           — CDN entry point → window.VaporChamber
  devtools.ts       — Vue DevTools integration (dynamic import)
  testing.ts        — createTestBus, snapshot, time-travel
  index.ts          — public ESM barrel

tests/
  command-bus.test.ts        (18 tests)
  chamber.test.ts            (19 tests)
  plugins.test.ts            (31 tests)
  new-features.test.ts       (44 tests — incl. SSR concurrency)
  whitepaper-future.test.ts  (28 tests)
  plugins-v042.test.ts       (18 tests)
                             ─────────
                             158 total
```

---

## 15. References

1. Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and
   Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
   https://zenodo.org/records/18853783
2. Vue 3.6.0-beta.1 Release: https://github.com/vuejs/core/releases/tag/v3.6.0-beta.1
3. Alien Signals: https://github.com/stackblitz/alien-signals
4. Vue Vapor Repository: https://github.com/vuejs/vue-vapor
5. Vite 7.0: https://vite.dev/blog/announcing-vite7

---

## 16. License

GNU Lesser General Public License v2.1 (LGPL-2.1)
