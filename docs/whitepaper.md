# Vapor Chamber — Whitepaper

**Version 0.6.0-pre — March 2026**

*Luciano Federico Pereira — ORCID 0009-0002-4591-6568 — luciano-pereira.pages.dev*

---

## Abstract

Vapor Chamber is a ~2–4KB command bus built for Vue Vapor. It provides a semantic,
middleware-aware dispatch layer that connects any frontend pattern to any backend, without
imposing a framework, a build system, or an opinion about your stack.

---

## 1. What It Is

vapor-chamber is a **command bus** — a thin coordination layer that sits between your Vue
components and your application logic, without owning state. It dispatches commands, runs
them through a plugin pipeline, and returns structured results. That is all it does.

It does not replace:
- **Pinia** — which owns application state
- **TanStack Query** — which owns data fetching and caching
- **XState** — which owns workflow state machines
- **Inertia.js** — which owns page navigation and server-driven UI

It coordinates between all of them through a single, consistent surface.

```
Components  →  dispatch command  →  plugin pipeline  →  handler
                                                              ↓
                                                    result { ok, value, error }
                                                              ↓
                                          Pinia / TanStack Q / Inertia react
```

---

## 2. The Problem

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
actions across any stack, at any scale, without lock-in. Without a coordination layer, logic
ends up scattered — in component `setup()` functions, in Pinia store actions, in ad-hoc fetch
wrappers, in event bus hacks. One bus. One dispatch surface. Every concern is a plugin.

---

## 3. Target Stack

**Primary:** Vue 3.6 Vapor + Vite frontend / Laravel backend
**Secondary:** Node.js (server-side command buses, API services)
**Core:** Framework-agnostic — documented as a reusable foundation for similar tools

**Out of scope:** React, Svelte, Angular, other frontend frameworks.
The core can be used in any TypeScript project. vapor-chamber is not built for them.

---

## 4. Core Philosophy

### 4.1 Semantic over imperative

Instead of scattered `emit`, `v-on`, and component-local handlers, Vapor Chamber gives every
user action a name and one handler. The question shifts from "where did this get handled?" to
"what does this do?" — and the answer is always one function.

```js
bus.dispatch('cartAdd', product, { quantity: 2 })
```

### 4.2 Transport agnostic

The bus doesn't know or care how a command reaches the backend. HTTP fetch, WebSocket, SSE —
all of these are plugins. The core stays minimal regardless of what transport you choose.

### 4.3 Build optional

Vapor Chamber ships as an ES module and as an IIFE. You can import it through a CDN inside a
Blade template and have a reactive command bus running in under 30 seconds, zero npm involved.

### 4.4 Framework agnostic at the top

The core `command-bus.ts` has zero Vue imports. It runs anywhere: Vue 3.5 (VDOM), Vue 3.6
Vapor, Node.js tests, Web Workers, any JavaScript runtime. The Vue-specific layer is a thin
wrapper that adds signals, lifecycle cleanup, and shared bus management.

### 4.5 camelCase action names — an empirical decision

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

### 4.6 The bus must not own state

Nine rounds of comparative analysis (§7) produced one consistent finding. Every round that
attempted to borrow state-centric patterns hit the same wall. Every round that worked with the
stateless design added genuine value.

This is not a limitation. It is the architecture. Pinia, TanStack Query, and Inertia already
solve state, cache, and navigation within the Vue + Laravel stack. Adding a state layer to
vapor-chamber would create a fourth source of truth and a competition problem.

---

## 5. Architecture

### 5.1 Layer model

```
┌─────────────────────────────────────────────────────────────────┐
│  CORE  ·  zero deps  ·  framework-agnostic  ·  fully tested     │
│  command-bus.ts  ·  testing.ts                                  │
└───────────────────────────┬─────────────────────────────────────┘
                            │  optional layers  (tree-shaken)
         ┌──────────────────┼──────────────────┬──────────────────┐
         ▼                  ▼                  ▼                  ▼
   Vue composables      Plugins          Transport           Utilities
   chamber.ts           plugins-core     transports.ts       createChamber
   chamber-vapor.ts     plugins-io       http.ts             createWorkflow
   directives.ts        form.ts          inertia bridge      createReaction
                        schema.ts        devtools.ts
                        vite-hmr.ts
```

### 5.2 Dispatch flow

```
dispatch(action, target, payload)
  1. validate naming convention (regex test)
  2. build Command { action, target, payload }
  3. run beforeHooks — throw to cancel, returns { ok: false }
  4. run plugins in priority order (cached runner — rebuilt only on use()/unuse())
  5. execute handler (Map.get — O(1) lookup)
  6. run afterHooks
  7. notify pattern listeners
  8. return CommandResult { ok, value?, error? }
```

The plugin chain is built once when plugins are added or removed. On each dispatch only the
innermost `execute` closure is created — no per-dispatch allocations for the chain traversal.

### 5.3 Core surface (stable API)

```ts
// Two factories — same concept, different execution model
createCommandBus(options)       // sync: zero-overhead, pure pipeline
createAsyncCommandBus(options)  // async: await-able, plugins can be async

// Bus interface (BaseBus — both extend it)
dispatch(action, target, payload?)    // mutation territory — fire and get result
dispatchBatch(commands, options?)     // sequential dispatch; successCount + failCount
register(action, handler, options?)   // bind a handler; { undo?, throttle? }
use(plugin, options?)                 // add middleware to the pipeline
onBefore(hook)                        // pre-dispatch; throw to cancel
onAfter(hook)                         // post-dispatch side effects
on(pattern, listener)                 // subscribe to matching commands
once(pattern, listener)               // one-shot subscription — auto-unsubs after first match
offAll(pattern?)                      // remove all listeners for pattern, or all listeners
request(action, target, payload?)     // query territory — expects a responder
respond(action, handler)              // register a query responder
hasHandler(action)                    // introspect
clear()                               // reset — useful for testing and HMR
```

### 5.4 CQRS distinction

`dispatch` is mutation territory. `request/respond` is query territory. These are not enforced
by the type system but are a strong naming convention. A command that changes state goes through
`dispatch`. A command that reads state goes through `request`.

**Note:** `request/respond` on the sync bus is a known inconsistency — it returns `Promise` on
an otherwise synchronous primitive. This will be restricted to `AsyncCommandBus` only in a
future release.

### 5.5 Plugin pipeline

Plugins are middleware. They wrap every dispatch in priority order. This is where cross-cutting
concerns live:

```ts
bus.use(logger())            // log every command
bus.use(authGuard(check))    // block unauthorized commands
bus.use(optimistic(opts))    // apply optimistic updates
bus.use(retry(opts))         // retry on failure
```

The pipeline is composable, ordered by priority, and the same model for sync and async buses.

### 5.6 Transport plugins

```ts
// HTTP fetch — CSRF, retry, timeout, action filter
bus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  timeout: 15_000,
  retry: 2,
  noRetry: ['paymentCharge', 'orderPlace'],  // never retry non-idempotent commands
  actions: ['cart*', 'order*'],
}))

// WebSocket — reconnect, bounded queue
bus.use(createWsBridge({
  url: 'wss://api.example.com/vc',
  timeout: 10_000,
  maxQueueSize: 100,
}))

// SSE — server push; accepts BaseBus (sync or async)
bus.use(createSseBridge({ url: '/api/vc/stream' }))
```

### 5.7 HTTP client

`postCommand` is the underlying HTTP function used by `createHttpBridge`. Also exposed directly:

```ts
import { postCommand, readCsrfToken, invalidateCsrfCache } from 'vapor-chamber'

const res = await postCommand('/api/commands', { command: 'cartAdd', target: product }, {
  csrf: true,
  csrfCookieUrl: '/sanctum/csrf-cookie',  // fetched on 419; set '' to disable
  timeout: 8_000,
  retry: 2,
  signal: controller.signal,
  onSessionExpired: (status) => router.push('/login'),
})
```

Key behaviours:
- Multi-source CSRF: meta tag → `XSRF-TOKEN` cookie → hidden `_token` input; 5-minute TTL cache
- **419 = CSRF expiry** — fetches `csrfCookieUrl` to refresh, retries once; concurrent 419s coalesce
- **401 = session expiry** — fires `onSessionExpired` + dispatches `session-expired` CustomEvent; 419 does NOT
- `HttpError.code` — machine-readable code from response body `{ code: '...' }` for pattern-matching
- `Retry-After` / `X-RateLimit-Reset` header honoured on 429/503
- Jittered exponential backoff (avoids thundering herd)
- `AbortSignal.any` with manual fallback for older environments
- `TimeoutError` is distinct from `AbortError`

### 5.8 DDD positioning

In Domain-Driven Design terms:
- The bus is the **application service layer**
- Handlers are **application services**
- Plugins are **cross-cutting concerns**
- Transports (HTTP, WS, SSE) are **adapters** in the hexagonal sense
- Commands in → domain events out

---

## 6. Design Decisions

### Why two factories instead of one?

`createCommandBus` (sync) and `createAsyncCommandBus` (async) are different execution models,
not different feature sets. The sync bus is a pure function pipeline — zero Promise overhead,
predictable, suitable for in-process coordination. The async bus enables `await` in handlers
and plugins, necessary for HTTP and I/O. Collapsing them into one factory with an option would
reduce clarity without reducing complexity.

### Why no state in the bus?

Every tool that owns state also owns the responsibility for invalidation, hydration, persistence,
and synchronization. Pinia, TanStack Query, and Inertia already solve these problems well within
the Vue + Laravel stack. Adding a state layer to vapor-chamber would create a fourth source of
truth and a competition problem. The bus coordinates state transitions. It does not store state.

### Why `BaseBus`?

Utilities (`createChamber`, `createWorkflow`, `createReaction`) operate on the bus generically.
The typed `CommandBus<M>` and `AsyncCommandBus<M>` interfaces use generic handler types that
diverge between sync and async, forcing `as any` casts in any utility that accepts both.
`BaseBus` is a structural escape hatch for framework-level utilities. Application code keeps
the fully typed interfaces.

### Why `commandKey`?

A stable `action:target` string key enables cache invalidation integration with TanStack Query.
It was already internal (used by the throttle plugin). Making it public is a one-line export
that unlocks a documented integration pattern.

### Why `onBefore`?

Guards belong before execution, not inside plugins. A `beforeHook` that throws cancels the
dispatch cleanly without needing to wrap the entire plugin chain. Auth gates, rate-limit checks,
and loading-state management are cleaner here than as plugins.

---

## 7. Comparative Analysis — What Survived

Nine rounds of analysis against established tools. Each round confirmed the stateless design
and contributed specific improvements.

| Round | Tool | What survived |
|---|---|---|
| 1 | Redux Toolkit | `createChamber` — handler grouping by namespace |
| 2 | VueUse | `useCommand` shape alignment — `{ execute, isPending, error, data }` |
| 3 | XState | `createWorkflow` — sequential saga with compensation |
| 4 | TanStack Query | CQRS naming, `commandKey` export, `optimistic` vocabulary alignment |
| 5 | DDD | Bus = app service layer, bridges = adapters (vocabulary, no code) |
| 6 | Svelte Stores | `observe(bus, pattern)` — zero-dep subscribable for non-Vue use |
| 7 | RxJS | `toObservable(bus, pattern)` — optional `vapor-chamber/rx` adapter |
| 8 | GraphQL clients | `useCommand` shape confirmed, `useMutation` vocabulary |
| 9 | ArangoDB | `createReaction` — declarative cross-chamber dispatch rules |

**What did not survive any round:** State in the bus, cache in the bus, full state machine on
the bus, normalized entity storage. The wall held every time.

---

## 8. Full Plugin Catalogue

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
| `createWsBridge` | Transport | WebSocket transport with reconnect + bounded queue |
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

## 9. Vue 3.6 and alien-signals

### 9.1 The reactivity rewrite

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

### 9.2 Vapor mode — the VDOM-less path

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

### 9.3 Lifecycle cleanup

Composables prefer `onScopeDispose` (Vue 3.5+) over `onUnmounted`. This is important because
in Vapor mode, component instances have a different internal structure than VDOM components.
`onScopeDispose` is the universal hook that works in component `setup()`, `effectScope()`,
Vapor components, and SSR — it's what Vue's own composables use internally.

### 9.4 Memory: useCommand vs defineVaporCommand

Each `useCommand()` call creates 2 signals (`loading`, `lastError`):

| Vue version | Per signal | 50 components using useCommand |
|-------------|-----------|-------------------------------|
| Vue 3.5 (Proxy) | ~200 bytes | ~20KB |
| Vue 3.6 (alien-signals) | ~64 bytes | ~6.4KB |

`defineVaporCommand()` creates 0 signals — suitable for fire-and-forget dispatches where
loading/error state is not needed in the template.

### 9.5 Rolldown / Vite 8 compatibility

Dynamic imports of optional peer dependencies use `/* @vite-ignore */` to prevent Rolldown
(Rust-based bundler in Vite 8) from treating them as required:

```ts
const vuePkg = 'vue'
import(/* @vite-ignore */ vuePkg)  // optional peer dep — must not fail build
```

---

## 10. Vue Composables

### 10.1 Full reference

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

### 10.2 When to use which

| Composable | Signals created | Use case |
|------------|-----------------|----------|
| `useCommand()` | `loading`, `lastError` | UI-bound dispatch (buttons, forms) |
| `defineVaporCommand()` | None | Fire-and-forget (analytics, scroll, search) |
| `useCommandBus()` | None | Direct bus access, no state tracking |
| `useCommandGroup()` | None | Feature namespace isolation |
| `useCommandError()` | `errors`, `latestError` | Component-scoped error display |
| `useCommandState()` | `state` | Reducer-based reactive state |
| `useCommandHistory()` | `past`, `future`, `canUndo`, `canRedo` | Undo/redo UI |

### 10.3 Directive plugin (opt-in, 0KB when not imported)

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

### 10.4 Vite HMR plugin

```ts
import { vaporChamberHMR } from 'vapor-chamber/vite'
export default defineConfig({ plugins: [vue(), vaporChamberHMR()] })
```

Bus handlers and registered state survive Vite hot module replacement transparently.

---

## 11. Integration Patterns

### 11.1 With Pinia

Pinia owns state. vapor-chamber dispatches commands that mutate Pinia stores. No direct
coupling — handlers import stores and call them.

```ts
const cartChamber = createChamber('cart', {
  add:    (cmd) => cartStore.add(cmd.payload),
  remove: (cmd) => cartStore.remove(cmd.target.id),
  clear:  ()    => cartStore.clear(),
});
cartChamber.install(bus);
```

### 11.2 With TanStack Query

TanStack Query owns reads. vapor-chamber owns writes. After a command succeeds, invalidate
the relevant query:

```ts
bus.onAfter((cmd, result) => {
  if (cmd.action === 'cartAdd' && result.ok)
    queryClient.invalidateQueries({ queryKey: ['cart'] });
});
```

Use `commandKey(action, target)` as a stable TQ query key for command-specific cache entries.

### 11.3 With Inertia 3

Inertia handles routing and page props. vapor-chamber handles in-page actions. They do not
overlap — commands go to a separate Laravel endpoint outside Inertia middleware.

Three integration points:
1. **CSRF** — set `csrf: 'inertia'` on the HTTP bridge to defer token management to Inertia's Axios instance
2. **Auth redirects** — set `onRedirect: (url) => router.visit(url)` to hand 302 responses to Inertia
3. **Page prop refresh** — after a command succeeds, call `router.reload({ only: ['flash'] })` to pull fresh props

```ts
const { dispatch } = useCommand()
const result = await bus.request('orderCancel', { id })
if (result.ok) router.visit('/orders')  // Inertia router
```

### 11.4 With XState

XState owns workflow orchestration. vapor-chamber executes what XState decides. The integration
point is the XState `invoke` service:

```ts
invoke: {
  src: () => bus.dispatch('checkoutProcess', cart),
  onDone: 'complete',
  onError: 'failed',
}
```

### 11.5 With Laravel Reverb / Echo

The generic WS bridge works with any WebSocket server. A `createEchoBridge` adapter (v0.8.0)
speaks the Laravel Echo protocol (channels, private channels, presence) natively. This is the
correct transport for Laravel 13+ real-time features.

### 11.6 Blade + CDN (zero build)

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

### 11.7 Laravel + Vite + SFC

```ts
const bus = createCommandBus()
bus.use(logger())
bus.use(retry({ maxAttempts: 3 }))
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))
createApp(App).use(createDirectivePlugin()).mount('#app')
```

### 11.8 Filament panel islands

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

## 12. The Utility Layer

These ship with the package, are first-class and tested, but do not live in `command-bus.ts`.
They use only the public `BaseBus` interface.

### `createChamber`

Groups related handlers under a namespace. The declarative counterpart to `useCommandGroup`.

```ts
const cartChamber = createChamber('cart', {
  add:    handleCartAdd,
  remove: handleCartRemove,
  clear:  handleCartClear,
});

cartChamber.install(bus);   // registers cartAdd, cartRemove, cartClear
                            // returns uninstall function
```

### `createWorkflow`

Sequential commands with automatic compensation on failure (saga pattern).

```ts
const checkout = createWorkflow([
  { action: 'cartValidate' },
  { action: 'paymentReserve', compensate: 'paymentRelease' },
  { action: 'orderCreate',    compensate: 'orderCancel' },
  { action: 'cartClear' },
]);

const result = await checkout.run(bus, { cartId, paymentInfo });
// If orderCreate fails → paymentRelease runs automatically
```

### `createReaction`

Declarative cross-chamber dispatch rules. Explicit edges between domain modules.

```ts
createReaction('cartAdd', 'inventoryCheck', {
  when: (cmd, result) => result.ok,
  map:  (cmd) => ({ target: { itemId: cmd.payload.itemId } }),
}).install(bus);
```

---

## 13. Migration Strategy: Vue VDOM → Vapor

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

## 14. SSR

### 14.1 The challenge

Vue Vapor's signal-based reactivity is designed for direct DOM updates. On the server there is
no DOM, so signals work as plain values. The challenge is **hydration**: commands that ran on
the server to populate initial state need to replay on the client so reactive signals reflect
the same values from the start.

### 14.2 Per-request bus isolation

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

### 14.3 Dehydrate on server, rehydrate on client

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

### 14.4 Suppress side effects during hydration

```ts
let hydrating = true

bus.use((cmd, next) => {
  if (hydrating && isSideEffect(cmd.action)) return { ok: true, value: undefined }
  return next()
})

for (const cmd of commands) bus.dispatch(cmd.action, cmd.target, cmd.payload)
hydrating = false
```

### 14.5 Simpler alternative: seed signals from JSON

If your server renders state separately (e.g. via `useAsyncData`), skip the replay mechanism:

```ts
const { state } = useCommandState(
  window.__INITIAL_CART__ ?? { items: [], total: 0 },
  { 'cartAdd': (s, cmd) => ({ ...s }) }
)
```

### 14.6 SSR recommendations

| Scenario | Approach |
|----------|---------|
| Simple initial state (list of items, user profile) | Seed signals from JSON |
| State resulting from a command sequence | Dehydrate on server, replay on client |
| Side-effectful commands (analytics, API calls) | Use `hydrating` plugin to suppress during replay |
| Multiple concurrent SSR requests | `createCommandBus()` per request + `resetCommandBus()` in teardown |

---

## 15. Testing

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

// on() and once() fire listeners — same as the real bus
bus.on('cart*', (cmd, result) => console.log(cmd.action))
bus.once('checkout', (cmd) => { /* fires exactly once */ })

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

## 16. What Vapor Chamber Is Not

**Not a Livewire replacement.** Livewire owns its component model end-to-end. Vapor Chamber
provides the data flow layer.

**Not a router.** Use Inertia, Vue Router, or Next.js Router for page transitions.

**Not a state management library.** `useCommandState` provides reactive state atoms for
command-driven values. Pinia remains the right tool for complex shared state.

**Not opinionated about your backend.** The `/api/vc` endpoint is a convention, not a
requirement.

---

## 17. Comparison

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

## 18. Roadmap

### v0.6.0 — Core quality (current)
- `onBefore` / `once` / `offAll` on both buses + TestBus
- `BaseBus` structural interface
- `BatchResult.successCount` / `failCount`
- `commandKey` exported, `buildRunner` / `matchesPattern` exported
- Fixed `once` mutation-during-iteration bug (`.slice()`)
- Fixed `isAsyncFn` for minified builds (`Symbol.toStringTag`)
- Fixed 419 ≠ 401 (CSRF expiry vs session expiry)
- Fixed CSRF refresh (now fetches `csrfCookieUrl`, was no-op)
- `HttpError.code` — machine-readable error codes
- `noRetry: string[]` on HTTP bridge — prevents double-charge
- WS `maxQueueSize` + configurable `timeout`
- SSE bridge accepts `BaseBus` (sync or async)
- Form async validators (`set()` = sync, `submit()` = awaits all)
- `synthesize` custom `LlmAdapter` option

### v0.7.0 — Utility layer
- `createChamber`
- `createWorkflow` (saga with compensation)
- `createReaction` (cross-chamber rules)
- `http.ts` Inertia CSRF option + `onRedirect`

### v0.8.0 — Laravel stack
- `createEchoBridge` — Laravel Echo / Reverb protocol
- Sanctum SPA auth pattern documented
- Laravel API Resource response unwrapping
- `createFormBus` Precognition option
- `vapor-chamber/inertia` sub-path

### v0.9.0 — Vue Vapor alignment
- Test against Vue 3.6 Vapor RC
- `useCommand` shape alignment — `{ execute, isPending, error, data }`
- Vite HMR plugin validation
- `vapor-chamber/rx` optional RxJS bridge

### v1.0.0 — Stability contract
- Semantic versioning guarantee
- Full documentation with Laravel + Vue Vapor happy path
- No breaking changes without major version
- Prime time: ready for Laravel 13 + Vue 3.6 Vapor stable

---

## 19. Core Guarantee

The core (`command-bus.ts` + `testing.ts`) will remain:
- **Zero runtime dependencies** — always
- **Framework-agnostic** — always
- **Under 3KB gzipped** — always
- **100% branch and line coverage** — always

Optional layers may add dependencies. The core never will.

---

## 20. Implementation Status

### Implemented (v0.6.0-pre)

- [x] Core command bus — sync and async, plugin pipeline, dead-letter, naming conventions
- [x] `onBefore` hooks — cancelable pre-dispatch, sync and async
- [x] `once` / `offAll` — one-shot and mass-unsubscribe
- [x] `BaseBus` structural interface — utilities work with either bus variant
- [x] `commandKey` exported — stable TanStack Query integration key
- [x] `BatchResult.successCount` / `failCount` — always present
- [x] `effectScope` / `onScopeDispose` cleanup
- [x] Typed commands with TypeScript generics
- [x] Middleware chain — `bus.use()` with priority, async, cached runner
- [x] Command history — `useCommandHistory`, `history` plugin, inverse handlers
- [x] `useCommandGroup` — namespace isolation, camelCase prefixing
- [x] `useCommandError` — reactive error boundary, optional filter
- [x] `createHttpBridge` — CSRF, headers, timeout, retry, `noRetry`, action filter
- [x] 419 vs 401 distinction — CSRF expiry ≠ session expiry
- [x] CSRF refresh fetches `csrfCookieUrl` (was no-op DOM re-read)
- [x] `HttpError.code` — machine-readable error code from response body
- [x] `createWsBridge` — WebSocket, reconnect, configurable timeout, `maxQueueSize`
- [x] `createSseBridge` — server-sent events, accepts `BaseBus`
- [x] `retry` plugin — exponential/linear/fixed, `isRetryable` predicate
- [x] `persist` plugin — localStorage/sessionStorage/custom storage
- [x] `sync` plugin — BroadcastChannel cross-tab coordination
- [x] Vue DevTools — timeline layer, inspector panel, dynamic import (0KB prod)
- [x] `createTestBus` — snapshot, time-travel, `on`/`once`/`offAll` fire for real
- [x] Directive plugin — `v-vc:command`, `v-vc-payload`
- [x] Vite HMR plugin — state-preserving hot reload
- [x] IIFE/CDN build — `vapor-chamber.iife.min.js`, global `VaporChamber`
- [x] `createFormBus` — reactive form + sync/async validation
- [x] Schema layer — `createSchemaCommandBus`, `toTools`, `synthesize` + `LlmAdapter`
- [x] CDCC-compliant file splits — `plugins-core.ts`, `plugins-io.ts`, `chamber-vapor.ts`
- [x] camelCase action names throughout (empirically justified — Pereira 2026)
- [x] SSR concurrency verified (per-request bus isolation)

### Remaining (post v0.6.0)

- [ ] `createChamber` / `createWorkflow` / `createReaction` — utility layer (v0.7.0)
- [ ] `createEchoBridge` — Laravel Echo / Reverb protocol (v0.8.0)
- [ ] `createFormBus` Precognition option (v0.8.0)
- [ ] `vapor-chamber/inertia` sub-path (v0.8.0)
- [ ] `vapor-chamber/rx` RxJS bridge (v0.9.0)
- [ ] Full documentation site with live examples
- [ ] Performance benchmark vs Alpine.js, Livewire, HTMX

---

## 21. File Map

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
  command-bus.test.ts            (core dispatch/register/plugins)
  command-bus-features.test.ts   (once, offAll, onBefore, BaseBus)
  chamber.test.ts                (composables)
  plugins.test.ts                (logger, validator, history, debounce, throttle, authGuard, optimistic)
  plugins-io.test.ts             (retry, persist, sync)
  http.test.ts                   (CSRF, 419 vs 401, session expiry, retry)
  transports.test.ts             (HTTP bridge, WS bridge, SSE bridge)
  form.test.ts                   (createFormBus, async validators)
  schema.test.ts                 (schema bus, toTools, synthesize, LlmAdapter)
                                 ─────────────
                                 318 total
```

---

## 22. References

1. Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and
   Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
   https://zenodo.org/records/18853783
2. Vue 3.6.0-beta.1 Release: https://github.com/vuejs/core/releases/tag/v3.6.0-beta.1
3. Alien Signals: https://github.com/stackblitz/alien-signals
4. Vue Vapor Repository: https://github.com/vuejs/vue-vapor
5. Vite 7.0: https://vite.dev/blog/announcing-vite7

---

## 23. License

GNU Lesser General Public License v2.1 (LGPL-2.1)

---

*vapor-chamber is built for the Vue Vapor + Laravel stack.
The core is open for anyone building similar coordination layers.*
