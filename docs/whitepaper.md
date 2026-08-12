# Vapor Chamber — Whitepaper

**Version 1.0.0 — March 2026**

*Luciano Federico Pereira — ORCID 0009-0002-4591-6568 — luciano-pereira.pages.dev*

---

## Abstract

Vapor Chamber is a ~4KB-brotli command bus built for Vue Vapor. It provides a semantic,
middleware-aware dispatch layer that connects any frontend pattern to any backend, without
imposing a framework, a build system, or an opinion about your stack. v1.0 adds
e-commerce-grade features: transactional batch dispatch with undo rollback, automatic
optimistic undo via registered handlers, schema auto-validation, and full bus introspection.

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
  1. check sealed / disposed / recursion depth (max 16)
  2. validate naming convention (regex test)
  3. build Command { action, target, payload, meta: { ts, id, correlationId?, causationId? } }
  4. run beforeHooks — throw to cancel, returns { ok: false }
  5. run plugins in priority order (cached runner — rebuilt only on use()/unuse())
  6. execute handler (Map.get — O(1) lookup)
  7. run afterHooks
  8. notify pattern listeners
  9. return CommandResult { ok, value?, error? }
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
registeredActions()                   // → string[] of all registered actions
query(action, target, payload?)       // CQRS read-only dispatch — skips onBefore hooks
emit(event, data?)                    // domain events — no handler, no result
seal()                                // freeze configuration — rejects register/use/clear
dispose()                             // clean teardown — clears state, cancels timers
clear()                               // reset — useful for testing and HMR

// Standalone (tree-shakeable)
inspectBus(bus)                       // → BusInspection topology snapshot
unsealBus(bus)                        // unseal a sealed bus
```

### 5.4 CQRS distinction

`dispatch` is mutation territory. `query` is read territory — it skips `onBefore` hooks
(no auth gates, no loading spinners for reads) but runs plugins, handlers, and afterHooks.
`emit` fires domain events without requiring a handler. `request/respond` is the legacy
query pattern with timeout support.

**Note:** `request/respond` on the sync bus is a known inconsistency — it returns `Promise` on
an otherwise synchronous primitive. Prefer `query()` for the CQRS read path.

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
// HTTP fetch — CSRF, retry, timeout, action filter, scope-aware abort
const ctrl = new AbortController()
onScopeDispose(() => ctrl.abort())  // Vapor lifecycle: cancel in-flight on dispose

bus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  timeout: 15_000,
  retry: 2,
  noRetry: ['paymentCharge', 'orderPlace'],  // never retry non-idempotent commands
  actions: ['cart*', 'order*'],
  scopeController: ctrl,                     // v0.6.0: all requests cancelled on dispose
}))

// WebSocket — reconnect, bounded queue, reactive connection signal
const ws = createWsBridge({
  url: 'wss://api.example.com/vc',
  timeout: 10_000,
  maxQueueSize: 100,
})
bus.use(ws)
ws.connect()
ws.connected.value  // → reactive Signal<boolean>, bindable in templates

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
| `throttle` | Rate limiting | Execute immediately, block for N ms. On block throws `BusError('VC_CORE_THROTTLED', …)` with `retryIn` in `error.context`. |
| `authGuard` | Guards | Block protected actions when unauthenticated |
| `optimistic` | UX | Apply state immediately, rollback on failure |
| `optimisticUndo` | UX | Auto-rollback via registered undo handlers on dispatch failure |
| `cache` | Performance | LRU query result caching with TTL and glob filter |
| `circuitBreaker` | Resilience | Per-action closed/open/half-open circuit states |
| `rateLimit` | Rate limiting | Per-action sliding window rate limiter |
| `metrics` | Observability | Lightweight telemetry: count, duration, errorRate per action |
| `serialize` | Concurrency | Per-key sequential processing of async commands — prevents same-key read-modify-write races |
| `idempotent` | Exactly-once | Collapses duplicate commands (double-submit/retry/reconnect); stamps an `Idempotency-Key` the HTTP bridge forwards to the backend |
| `schemaValidator` | Guards | Auto-validates field types against schema (auto-installed in schema bus) |
| `retry` | Resilience | Exponential/linear/fixed backoff on failure |
| `persist` | Storage | Auto-save state to localStorage/sessionStorage/custom; validate on load |
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

// persist — with shape validation to reject stale state after deploys
const cartPersist = persist({
  key: 'vc:cart',
  getState: () => cartState.value,
  validate: (state) => Array.isArray(state.items) && typeof state.total === 'number',
})
bus.use(cartPersist)
const saved = cartPersist.load()   // → T | null (null if validate returns false)
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
The public API is unchanged — `ref()`, `computed()`, `watch()` work identically — and a `ref()`
holding a **primitive** IS a signal now, not a Proxy wrapper around one. A `ref()` holding an
**object or array** is still a signal *wrapping a deep reactive Proxy* (`toReactive()`); the rewrite
changed dependency tracking, not object wrapping. See the `shallowRef` note below for why the
library wires shallow signals.

| Aspect | Proxy-based (Vue 3.0–3.5) | Alien-signals (Vue 3.6+) |
|--------|--------------------------|--------------------------|
| Tracking mechanism | Proxy `get`/`set` traps | Signal dependency graph |
| Granularity | Property-level on objects | Value-level on primitives |
| Memory overhead | Proxy + handler per reactive object | Lightweight signal node |
| Update propagation | Full component re-evaluation | Only affected signal consumers |

**Vapor has been feature-complete since beta.8** (March 2026): `<script setup vapor>`,
`createVaporApp()`, `vaporInteropPlugin`, `<Teleport>` / `<Suspense>` / `<KeepAlive>`, and
`defineAsyncComponent` all work, with the `vapor` attribute as the per-SFC opt-in. The
alien-signals reactivity that shipped with it brought Vue's headline gains: ~14% less memory for
reactive state, ~40% less CPU on complex visualizations, ~100k components mounted in ~100 ms
(SolidJS parity), sub-10 KB Vapor-only bundles, ~66% smaller JS payload.

Every beta since has been **bug fixes and runtime optimizations** that Vapor Chamber inherits
through its pass-through wrappers — no consumer code changes. The table below is the running
**Vue 3.6 alignment log**: this is the single source of per-beta detail, so prose elsewhere stays
version-agnostic, and each new beta is one added row.

| Vue 3.6 beta | What changed in Vue's runtime | vapor-chamber response |
|---|---|---|
| **beta.8** (Mar) | Vapor reaches feature-complete (the alien-signals reactivity rewrite had already landed earlier, in **3.6.0-alpha.1**, #12349 — see headline gains above). | Baseline Vapor surface wrapped. Pass-through. |
| **beta.9** (Mar) | TransitionGroup→VDOM parity: key inheritance, dynamic `tag` updates, v-if dynamic slots, **no invalid hooks on unkeyed interop children**, leaving-cache isolated by resolved child type, null keys treated as absent; `<Transition>` template children + interop vnode-identity alignment; **v-for+v-if hook application fixed** (the counterpart to beta.8's v-if+v-for); teleport hydration null-/disabled-target anchor fixes; interop vnode lifecycle hooks (`onVnodeBeforeMount`) now invoked; static-key preservation; KeepAlive scope-leak fixes. | Pass-through. The transition bridge forwards whatever hooks Vue fires, so these corrections just mean the bus now receives the **corrected** hook set — moves it previously missed, and no longer the bogus hooks on unkeyed interop children. No code change. |
| **beta.10** (Apr) | Async setup components hydrate under VDOM Suspense; SSR runtime tree-shaken out of `defineVaporCustomElement`; interop **mount/unmount/update/hydration hook-order aligned with VDOM**; `<Transition>` dynamic-slot update + `appear` with slotted v-show; duplicate dynamic-slot-name last-wins; interop slot remount / stale-effect cleanups; `parentComponent` null-guard. | Pass-through. `createVaporChamberApp` / `defineVapor*` forward Vue's app + components untouched, so the hook-order alignment and async-Suspense hydration are inherited; our SSR is command-replay above DOM hydration, so the custom-element SSR tree-shake doesn't touch it. No code change. |
| **beta.11** (May) | Tree-shake axes (slot-fallback / teleport / transition / keep-alive / suspense); static-template hydration fast path; dynamic-props stability. | Mirrored as three sized IIFE variants (`core` / `elements` / `full`, §11.6). Pass-through. |
| **beta.12** | Vapor `setup()` error recovery (component context, fallthrough props, render effects restored after a throw); VDOM-slot interop normalization; SSR unresolved-tag fallback. | Pass-through. Lib-side this cycle: AbortController extensions, `useSharedCommandState`, TestBus snapshot / time-travel. |
| **beta.13** (May) | `onMove` fires for Vapor **and** VDOM component moves in a Vapor `<TransitionGroup>` (was silently skipped); moves defer until child updates flush; slot-fallback transition hooks; v-for key preservation; 5 SSR hydration fixes; interop CSS scope IDs on Vapor roots; **lazy lifecycle update jobs**; compiler opts (inline `v-bind` spreads, single-use component-resolve lowering, static-prop inlining). | Pass-through. Lazy lifecycle jobs make `tryAutoCleanup` / `onScopeDispose` allocation-free when no reactive state is tracked in the scope. |
| **beta.14** (Jun) | HMR: child/parent reload alignment, parent-reload dedup, setup-effect preservation, context-restore-on-error, app-instance refresh on root reload. Transitions: `onMove` suppressed for v-show-hidden children. Custom elements: no hook retention on shared definitions; children update from reactive props. Async: `loadingComponent` receives props/slots; `defineVaporAsyncComponent` now a main `vue` export. Interop: bridge no longer mutated on setup; slot wrappers memoised. Vapor root: scope ID preserved on dynamic updates. Scheduler: job-queue length reset after flush. v-for: skip updated hooks on mount, no fast-remove for component v-for, lazy destructure defaults. | HMR shim gains a per-cycle dedup guard + try/catch — the **only** new beta.14 code; the rest is pass-through. **Measured gains:** `useCommandState` ~+24%, `effectScope` lifecycle ~+9%, transition bridge ~+8% (all from the scheduler flush fix). |
| **beta.15** (Jun) | Teleport (7 fixes): invalid-target handling, disabled-target order preserved, mount location tracked explicitly, CSS vars by mount location, no target-child moves on reorder, raw props proxy reused. Transitions: hooks restored after a skipped move, key inheritance + stability aligned with VDOM, unique keys for multi-root v-for items, v-if comment handling. v-show: appear timing aligned with VDOM, fragment method arguments preserved. Events: click-modifier normalization, **opt-out for event delegation** (#14924), delegated handlers skipped on disabled elements (#14948). Interop: vnode access guarded. Keyed direct template refs cleared on replace. Perf: fragment classes dropped from app-only bundles. | **One new line of behaviour:** `v-vc:command` now bails out on disabled / `aria-disabled` / in-flight elements — it attaches a *direct* (non-delegated) listener, so Vue's #14948 runtime fix doesn't reach it automatically; this mirrors it. Everything else is pass-through. No perf-affecting change on the hot path (re-measure pending on the reference host). |
| **beta.16** (Jun) | Transitions (6): transition-group leave bucketed by type, raw-key compare before early removal, out-in branch key kept in sync when leave defers render, hooks re-resolved on prop change, leaving cache shared for unkeyed children, `persisted` no longer leaks onto non-v-show roots. Hydration (7): dynamic props applied on mismatch-recreated nodes, static-template clone-cache reused (not re-cloned per adoption), exact tag-mismatch detection, fragment-start warning text, full-mount fallback for empty SSR containers, static-text mismatches patched (prod included), v-if empty branches hydrated with static templates. App lifecycle: no-op mount for a missing selector, unmount safe without dev instance state (prod). Props/emit/attrs/events: nullish dynamic props → empty, nullish emit sources skipped, symbol attr values stringified, dynamic v-bind event options (`Once`/`Passive`/`Capture`) parsed like VDOM. Compiler (8): setup-let inline assignment, v-html-before-text, unsafe attr names kept out of templates, dynamic/static/native v-model modifier key quoting, slot v-else-without-v-if reporting, empty blocks return `[]`. Perf: **SlotFragment skipped for stable slot fallback** (#14969). | **Fully pass-through — no lib code change** (every commit read at source). Two consumer-visible inheritances: `createTransitionBridge`/`useTransitionCommand` `onLeave` now fires for a non-v-show root removed after a v-show branch (was dropped — `a816c9e`); `createVaporChamberApp(...).mount('#missing')` no-ops instead of throwing and `.unmount()` is prod-safe (`05bf22a` / `52fda7c`). Our `rehydrate()` sits above DOM hydration, so the 7 hydration fixes are below us. **Perf technique to evaluate (measured, post-stable):** #14969 proves slot-fallback reachability at compile time, encodes it as a one-bit flag on the emitted fn, and the runtime selects a lighter `DynamicFragment` over `SlotFragment` when the flag is absent — the "prove-it-at-compile-time, pay-for-the-wrapper-only-when-unprovable" pattern, a candidate for our own hot paths once the Vapor-first/bus-first identity (v2.0.0) is settled. |
| **beta.17** (Jun) | Compiler-vapor (7): stable slot roots kept on the fast path, non-stable slots avoided for stable root siblings, slot-root tracking skipped for slot outlets, forwarded slot-fallback validity tracked, unsafe repeated expression replacements avoided; perf — redundant text-run slicing avoided, child-context analysis cached. Runtime-vapor (7): slot validity aligned for component roots, dynamic native-element slots hydrated correctly (#14972), **VDOM-interop update hooks paired** (`beforeUpdate`/`updated`, `bcaa753`), **tracking paused when invoking function refs** (#14986), **render-effect creation order preserved on update** (scheduler tiebreaker behind component id, #14984), interop slot owner root re-synced after child updates (`975dd4d`); perf — redundant slot-content validity checks avoided. | **Fully pass-through — no lib code change** (every commit read at source). The two interop fixes land below `getVaporInteropPlugin()`'s pass-through, so mixed Vapor/VDOM trees inherit paired slot hooks (`bcaa753`) and the slot-owner-root re-sync (`975dd4d`) for free; #14972 sits below `rehydrate()`'s command replay; the seven compiler-vapor fixes are compile-time, inherited by recompiling the Vapor SFC examples. **Pattern noted, nothing to act on:** #14984 had to add render-effect *creation order* as a scheduler tiebreaker behind component id — the same insertion-order invariant the bus already gets for free from JS's stable `Array.prototype.sort` on equal-priority plugins (`byPriority`), already pinned by the `equal priority preserves registration order` test. #14986 (pause tracking on function refs) is **N/A** — the lib uses no template/function refs and only *writes* signals from dispatch callbacks, never reads inside a tracked effect. Verified against beta.17: `tsc` clean, **884/884 tests** pass, bench green on the recorded baselines, IIFE sizes unchanged (10.2 / 7.0 / 7.4 KB brotli). |
| **rc.1** (`6fa3447`, Jul) | **Vue 3.6 enters RC — Vapor feature-complete.** All 13 fixes are runtime-vapor / hydration internals (slot-anchor + hydration-anchor management, v-show transition on a VDOM child #15074, v-if/v-show on transition roots #15069, remove unsafe slot dry runs from VDOM interop #15089/#15031, forwarded-slot/async-setup hydration). | **Fully pass-through — no lib code change** (diffs read at source). The anchor/hydration/dry-run fixes are all renderer-internal — the lib collects no slot vnodes and holds no hydration anchors, so #15089/#06778e7 have no analog here; the two transition fixes reach `createTransitionBridge`/`useTransitionCommand` as a corrected hook set. Verified against rc.1: `tsc` clean, **1102/1102** pass, IIFE 10.8/7.6/8.0 KB brotli. |
| **rc.2** (Jul) | **compiler-vapor: event delegation flips opt-OUT → opt-IN (#15127, BREAKING).** Compiled `@click` in Vapor SFCs now attaches a direct per-element listener unless the template writes `.delegate` explicitly; `compilerOptions.eventDelegation` is removed entirely (the beta.15 opt-out, #14924, is gone — there's nothing left to opt out of). One internal compiler-vapor codegen fix (#15124 — v-for loop variables no longer collide with runtime-helper names, e.g. `v-for="child in items"` clashing with the `child()` DOM helper). The other 12 fixes are runtime-vapor internals surfaced by testing Vapor against Nuxt: effect-scope not restored to "no scope" after `setCurrentInstance`, freezing a vapor page's watchers on its first vdom→vapor `<Suspense>` navigation (#15141); a vapor block's transition hooks dropped across interop mount/unmount/move, deadlocking a vdom `<Transition mode="out-in">` wrapped around a vapor page (#15133, #15140); prod-only crash when a vapor `setup()` throws under `onErrorCaptured` (#15130); slot anchor missing for interop slot content without SSR fragment markers, e.g. `RouterLink` (#15131); vapor mount/activated hooks and post-render effects not deferred to an owning `<Suspense>` boundary (#15139, #15144); vapor components never hydrating when deferred past the root hydration pass via interop, e.g. `hydrateOnVisible()` (#15132); pending-async-component placeholder position lost across Suspense/KeepAlive (#15147); async setup's re-entry losing instance context, warning `renderEffect called without active EffectScope` (#15129); the "logical child" hydration cache left stale after mismatch-recovery node replacement (#15145); vdom-interop bypassing prop validation entirely (#15111). | **Pass-through for all 13 runtime-vapor/compiler-vapor fixes — no lib code change** (every diff read at source, not just titles). `createVaporChamberApp` / `getVaporInteropPlugin` / `defineVapor*` forward Vue's own functions untouched; `rehydrate()` replays commands *above* Vue's DOM hydration; `createTransitionBridge`/`useTransitionCommand` only supply hook bodies Vue calls into; `tryAutoCleanup()` calls the public `getCurrentScope()`/`onScopeDispose()` pair, never the internal restore path #15141 fixed. Confirmed no example's `v-for` variable collides with a compiler-vapor helper name (#15124 N/A here). Two real, non-theoretical unblocks worth knowing even though no code changed: a vdom `<Transition mode="out-in">` around a vapor page no longer deadlocks (#15133/#15140 — relevant to anyone pairing `useTransitionCommand` with page-level transitions, Nuxt-style), and a first vdom→vapor `<Suspense>` navigation no longer kills that page's watchers (#15141 — any composable here called from such a page's `setup()` was swept into that teardown with no userland workaround possible). **LIB-SIDE, inspired by studying #15127 rather than required by it:** `v-vc:command` gains its own opt-in `.delegate` modifier (`src/directives.ts`) — one shared document-level listener instead of one per element, mirroring Vue's exact opt-in trade-off (an ancestor's `.stop` can pre-empt a delegated descendant) and its incompatibility with `.capture`/`.once`/`.passive` (dev-warns, falls back to direct). **Measured, not assumed** (`tests/perf.bench.ts`, 5k elements): delegate mode is **~1.3x slower to mount+unmount**, not faster — correcting an initial assumption. Its real payoff is standing listener count (1 vs N) for large, mostly-static lists, so it's documented as a memory trade, not a speed one; `examples/vapor-island-cart`'s 3-item product list is left as plain `@click` (nothing to win at that size) with a comment explaining when to reach for `.delegate` instead. Verified against rc.2: `tsc` clean, **1259/1259** tests pass (71/71 files, coverage 95.86/88.92/96.88/97.36 stmt/branch/fn/line, all above the floors — which are lines 95 / functions 94 / branches 86 / statements 93, i.e. `vitest.config.ts` declaration order, NOT the stmt/branch/fn/line order these four numbers are printed in), lint clean, IIFE 10.8/7.5/8.0 KB brotli (unchanged from rc.1 within rounding). |

| **rc.3** (Aug) | 36 commits, all read at source. **KeepAlive is the theme** (6): cached component props and dynamic slots isolated behind a commit boundary so a cached child stops observing transient parent values (#15251, closing #15228); branch removal deferred until cache pruning (#15189); leaving cache entries unmounted from their real parent (#15190); updates deferred while async setup is pending (#15172); interop entries fully pruned at `max` (#15181); and KeepAlive scopes now **paused** while deactivated (closing #15237). **Custom directives** hardened in three places: compiler wraps the value in parens (#15258), async component roots treated as pending rather than warned about (#15167), fragment roots re-applied via a detached scope (#15158). **v-show stops over-tracking** twice — transition hooks (#15203) and the source inside fragment effects (#15204) — both by running callbacks with tracking disabled. **App unmount lifecycle aligned with vDOM** (#15262): `onBeforeUnmount` → `onScopeDispose` → `onUnmounted`, children before parents. Plus vDOM slot content in `<Transition>` (#15159), teleport target cleanup on scope disposal (#15236), interop prop normalization (#15254), class-prop normalization (#15227), functional-component root bindings, 4 async-hydration fixes, 6 slot-fallback/hydration fixes, and 2 type-only fixes. | **Pass-through for the runtime fixes** — no wrapper change. But the read surfaced two things the lib had wrong, both now corrected with fixtures rather than argument. (1) **Custom directives are NOT VDOM-only.** `withVaporDirectives` is a public export shipping since **3.6.0-alpha.3** (verified by unpacking published dists alpha.3 → rc.3); rc.3 only hardened it. Four places in this repo asserted the opposite, including a runtime `console.warn`. What genuinely blocks `v-vc:command` is the *shape* — Vapor directives are `(el, value, arg, mods) => cleanup` with **no `updated` hook** — not upstream policy. Fixture: `tests/vapor-directives-fixture.test.ts`. (2) **The `tryKeepAliveHooks` removal note was wrong.** `docs/router.md` said #15237 landing would make it double-suppression; measured, Vue pauses *effects*, while that guard protects a `bus.onAfter` callback the bus invokes directly, which still fires under a paused scope. Guard kept, note corrected. Fixture: `tests/keepalive-pause-fixture.test.ts`. **Technique logged, then applied:** #15203/#15204 run callbacks with tracking disabled (`setActiveSub`) — the bus has the same exposure (a `dispatch()` from inside an effect leaks the *handler's* reads into the caller's dependency set, reproduced). `setActiveSub` is not on the `vue` entry, but `pauseTracking`/`resetTracking` are exported by `@vue/reactivity`, which resolves to the same module instance; `untracked()` is built on those and every composable routes its dispatch through it. Getting them at BUILD time rather than through a runtime probe is what `vapor-chamber/vue` exists for — see §11.6. **Lib-side this cycle:** Vapor detection gains an owned global slot + `configureVue()` — see §11.6. Verified against rc.3: `tsc` clean, **1491/1491** tests (92 files). |

Vapor Chamber auto-detects Vue at module load and wires `signal()` to **`shallowRef()`**, not
`ref()`. The distinction matters and is easy to get wrong: the alien-signals rewrite changed the
**dependency-tracking layer**, but `ref(anObjectOrArray)` in 3.6 still calls `toReactive()` and
wraps the value in a **deep reactive Proxy** — exactly as in 3.5. So `ref(0)` is a pure signal,
but `ref([])` is a signal *plus* a deep Proxy, and every read/spread of that value pays Proxy-trap
cost. The "value-level granularity" in the table above holds **for primitives only**.

The library never mutates a signal's value in place — it replaces it wholesale
(`state.value = handler(...)`, `errors.value = [...]`, `past.value = [...]`). Whole-value
replacement is precisely the pattern where shallow tracking is semantically identical to deep
tracking, so `shallowRef` is correct here and skips the deep-Proxy tax. Measured on the real
`useCommandState` dispatch path (interleaved same-process A/B): array-state dispatch is ~3.4×
faster with `shallowRef`, scalar signals ~1.2× faster, with lower per-write allocation. Direct
nested mutation of a returned state (`state.value.x = y`) would bypass the command bus regardless,
which this library treats as an anti-pattern — so nothing of value is lost by tracking shallowly.

For the cases where deep reactivity *is* wanted deliberately — a state object two-way bound with
`v-model` whose nested fields you mutate in place — the `vapor-chamber/reactive` companion module
exports `useDeepCommandState()` and `deepSignal()`. They share the exact dispatch/coalesce/cleanup
core with `useCommandState`, differing only in the signal factory (deep `ref()` vs shallow
`shallowRef()`), and ship in a separate tree-shakable chunk so the default install stays lean. The
result is best-of-both-worlds: shallow-fast by default, deep-reactive per state when you opt in. The
ref-vs-shallowRef ratios quoted here are proven by a committed CI benchmark
(`tests/signal-shallow-ab.test.ts`), not assumed.

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

Composables prefer `onScopeDispose` (Vue 3.5+) over `onUnmounted`. This is critical because
in Vapor mode, **`getCurrentInstance()` returns `null`** — Vapor components do not have the
same internal instance structure as VDOM components. Any composable that calls
`getCurrentInstance()` or `onUnmounted()` will silently fail in a `<script setup vapor>` block.

`onScopeDispose` is the universal hook that works in component `setup()`, `effectScope()`,
Vapor components, and SSR — it's what Vue's own composables use internally.

Vapor Chamber v0.6.0 handles this gracefully:
- `tryAutoCleanup()` tries `onScopeDispose` first, then `onUnmounted` as fallback
- In development mode, a console warning is emitted when neither scope nor instance is found
- `useCommand()` is fully Vapor-safe — uses no `getCurrentInstance()` at all
- `defineVaporCommand()` was already Vapor-safe since v0.4.0

### 9.4 Memory: useCommand vs defineVaporCommand

Each `useCommand()` call creates 2 signals (`loading`, `lastError`):

| Vue version | Per signal | 50 components using useCommand |
|-------------|-----------|-------------------------------|
| Vue 3.5 (Proxy) | ~200 bytes | ~20 KB |
| Vue 3.6 (alien-signals) | ~64 bytes | ~6.4 KB |

_Byte figures are order-of-magnitude **estimates** (an alien-signals reactive node vs a Vue 3.5
reactive `Proxy` + dep wrapper), **not measured heap allocations** — our bench suite measures
throughput, not memory. The robust claim is the **direction**: 3.6's alien-signals backing is
materially lighter than 3.5's Proxy._

`useCommand()` is the single command composable: it bundles reactive `loading`/`lastError`
state with `register()`, `on()`, `emit()`, and `dispose()`, and never calls
`getCurrentInstance()`, making it safe in both Vapor and VDOM components. Cleanup runs
automatically on scope disposal.

`defineVaporCommand()` creates 0 signals — suitable for fire-and-forget dispatches where
loading/error state is not needed in the template.

| Composable | Signals | Vapor-safe | Use case |
|------------|---------|------------|----------|
| `useCommand()` | 2 | ✅ | UI-bound dispatch + register/on/emit (Vapor & VDOM) |
| `defineVaporCommand()` | 0 | ✅ | Fire-and-forget (analytics, scroll, search) |

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
// Single command composable — reactive state + register + on + emit + auto-cleanup, Vapor-safe
const { dispatch, register, on, emit, loading, lastError, dispose } = useCommand()
register('cartAdd', (cmd) => addToCart(cmd.target))
on('cart*', (cmd, result) => console.log('Cart event:', cmd.action))

// Zero-overhead hot path — no signals, no alien-signals graph nodes
const { dispatch: track } = defineVaporCommand('scrollSample', (cmd) => {
  // forward to whatever metrics / telemetry sink you use
  sendMetric('scroll', { depth: cmd.target.depth })
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
| `useCommand()` | `loading`, `lastError` | UI-bound dispatch + register/on/emit — Vapor-safe |
| `defineVaporCommand()` | None | Fire-and-forget (analytics, scroll, search) |
| `useCommandBus()` | None | Direct bus access, no state tracking |
| `useCommandGroup()` | None | Feature namespace isolation |
| `useCommandError()` | `errors`, `latestError` | Component-scoped error display |
| `useCommandState()` | `state` | Reducer-based reactive state |
| `useCommandHistory()` | `past`, `future`, `canUndo`, `canRedo` | Undo/redo UI |
| `useCommandQuery()` | `data`, `loading`, `lastError` | CQRS read-side (skips onBefore) |
| `useTransitionCommand()` | `phase` | `<Transition>` hook → bus dispatch |

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

Modifiers: `.stop` `.prevent` `.self` `.left` `.middle` `.right` `.capture` `.once` `.passive`
`.<number>` (dispatch timeout in ms), and `.delegate` (§rc.2 alignment log row) — opts a
`v-for`'d list into one shared document listener instead of one per element. Incompatible with
`.capture`/`.once`/`.passive`; falls back to a direct listener with a dev warning if combined.

**Vapor compatibility note:** `v-vc:command` is VDOM-only — **Vapor custom
directives are not**. This section previously said the feature itself was
VDOM-only; that was wrong, and wrong from the beginning.
`withVaporDirectives` is a public export of the with-vapor build and ships in
every Vue version this project has tracked (verified by unpacking the published
`@vue/runtime-vapor` dist from 3.6.0-alpha.3 through rc.3 — present in all of
them; rc.3 only hardened it: #15258 codegen, #15167 async component roots,
#15158 fragment roots). Measured in `tests/vapor-directives-fixture.test.ts`,
which mounts a real Vapor app and drives a custom directive through it.

What actually blocks this directive is the **shape** it registers, and the two
shapes are not interchangeable:

```
VDOM    { mounted(el, binding), updated(el, binding), beforeUnmount(el) }
Vapor   (el, value, argument, modifiers) => cleanup | void
```

The Vapor form runs once per root element inside a detached `EffectScope`, and
a returned function is registered via `onScopeDispose`. There is **no `updated`
hook at all** — `value` arrives as a getter, so a directive that must react to
a changing binding opens its own effect inside that scope (pinned by the same
fixture: changing the bound value does not re-invoke the directive function,
and only an effect the directive opened sees the new value). So
`app.directive('vc', …)` cannot serve both renderers from one registration, and
a port is real work rather than a rename.

When Vapor mode is detected, `createDirectivePlugin.install()` emits a console
warning pointing to `useCommand()` or `defineVaporCommand()`. That advice is
unchanged; only its stated reason is now accurate. Directives still work in
VDOM components within a mixed VDOM/Vapor tree.

### 10.4 Vite HMR plugin

```ts
import { vaporChamberHMR } from 'vapor-chamber/vite'
export default defineConfig({ plugins: [vue(), vaporChamberHMR()] })
```

Bus handlers and registered state survive Vite hot module replacement transparently.
Supports `.vapor.vue` files (Vue 3.6+ Vapor SFCs) in addition to `.ts`, `.js`, `.vue`, `.tsx`, `.jsx`.

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

**Where the router's loader cache sits in this boundary.** `fetchLoaders({ cache })`
(v1.12.0) does not move the line: TanStack Query still owns *app* reads. The
router owns **URL-addressed** reads — the ones its own `load` column declares,
which commit atomically with the navigation snapshot — and those now reach the
HTTP client's existing fresh/stale windows instead of missing a cache engine
sitting directly underneath them. Nothing else in the app should read through
that path.

This is also the reason a `useSWRV`-shaped read composable was evaluated and
declined rather than adopted: [Kong/swrv](https://github.com/kong/swrv) is a
smaller TanStack Query, so adopting it would re-litigate a settled boundary,
and its cache is *weaker* than `http-cache.ts` (no stale window, no
serve-stale-on-error, no pattern invalidation). Its `REF_CACHE` would also be a
second source of truth alongside the frozen snapshot, which is already the
shared read state. What survived that evaluation was this repo's own
unconnected wiring — the loader cache above, and the `isRevalidating` lane that
makes a stale-while-revalidate commit expressible.

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

### 11.5 With WebSocket-based realtime (Laravel Reverb / Echo, Centrifugo, custom servers)

The generic `createWsBridge` works with any WebSocket server — it forwards
commands as JSON envelopes and pairs request/response by id. For
framework-specific protocols (Laravel Echo channels / private / presence,
Centrifugo subscriptions, etc.) the user-side handler can wrap the generic
bridge or implement protocol-specific message parsing inside an `onReceive`
callback.

A protocol-aware `createEchoBridge` adapter for Laravel Reverb / Echo (native
channels, private channels, presence) is on the roadmap — not yet shipped.
Track [ROADMAP.md](../ROADMAP.md) for the version it lands in.

### 11.6 Blade + CDN (zero build)

Three IIFE variants ship under `dist/`, split by **audience / deployment shape**:

| Variant   | Audience                                                  | Brotli |
|-----------|-----------------------------------------------------------|--------|
| core      | Sprinkled JS on server-rendered pages — Blade / Rails / Django | 7.3 KB |
| elements  | Embeddable widgets via custom elements                    | 7.7 KB |
| full      | SPAs that grew big (realtime + undo/redo + persistence)   | 10.6 KB |

_(Generated, always-current per-export sizes: [BUNDLE-SIZES.md](./BUNDLE-SIZES.md).)_

The Blade example below uses **core** with the `connect()` one-liner — the
audience-specific helper that wires HTTP + CSRF in a single call:

```html
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@1.9/dist/vapor-chamber-core.iife.min.js"></script>
<script>
const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });

document.querySelector('#add-to-cart').addEventListener('click',
  () => dispatch('cartAdd', { id: 42 }));
</script>
```

`connect()` is equivalent to
`createApp({ transport: createHttpBridge({ csrf: true, ...opts }) })` but
shorter for the common case.

Sites that ship `<vc-widget>` custom elements should use
`vapor-chamber-elements.iife.min.js` and the `defineWidget(tag, options)`
helper. Sites needing realtime (WebSocket / SSE), persistence, or the full
Vapor composables surface use the `full` bundle.

Variant contents are not stable across major versions before v2.0 — see
ROADMAP.md. ESM consumers (the `vapor-chamber` main entry) always get the
full surface.

**Vapor mode detection without a bundler.** `isVaporAvailable()` /
`createVaporChamberApp()` will report Vapor as unavailable here even with
Vue 3.6 installed, and that is correct, not a bug: Vue ships Vapor as a
**physically separate build** (`vue.runtime-with-vapor.esm-browser.js`) —
the plain `vue.esm-browser.js` a `<script type="module">` or bare
`import('vue')` resolves to never contains it. A bundler can alias the whole
app's `vue` import to the with-vapor build (the Vite examples do this
explicitly in `vite.config.ts`), which is why they reach Vapor at all and this
zero-build path does not.

That alias, though, only makes Vapor *present* — it does not make it
*detectable*. `configureVue()` is what makes it detectable, and it is needed
under a bundler too: see the correction at the end of this section, where the
built `vapor-sfc` example threw on a page that had Vapor bundled into it. Treat
the recipes below as the general wiring, not a no-build workaround.

To get real Vapor detection here, load the with-vapor build yourself and hand
it to the library. **Prefer `configureVue()`** — it is explicit, involves no
globals, and cannot be raced:

```html
<script type="module">
  import * as Vue from 'https://cdn.jsdelivr.net/npm/vue@3.6/dist/vue.runtime-with-vapor.esm-browser.prod.js';
  import { configureVue } from 'https://cdn.jsdelivr.net/npm/vapor-chamber@1.12/dist/index.js';
  configureVue(Vue);
</script>
```

For the `<script>`-tag/IIFE shape, assign the namespace to
**`window.__VAPOR_CHAMBER_VUE__`** before vapor-chamber's tag:

```html
<script type="module">
  import * as Vue from 'https://cdn.jsdelivr.net/npm/vue@3.6/dist/vue.runtime-with-vapor.esm-browser.prod.js';
  window.__VAPOR_CHAMBER_VUE__ = Vue;
</script>
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@1.12/dist/vapor-chamber-core.iife.min.js"></script>
```

**Why not `window.__VUE__`, which earlier versions of this section recommended.**
That key belongs to Vue, and Vue writes a **boolean** to it: `target.__VUE__ = true`,
assigned from `prepareApp()` (Vapor) and `baseCreateRenderer()` (vDOM) — i.e.
the moment the first app is created, in both dev and production builds. So a
namespace parked there survives only until something mounts. The old recipe
still works when vapor-chamber's one-shot probe wins the race against your own
`mount()`, which is why it held up in practice — but it fails, silently, in any
arrangement where the library is evaluated after the first app: a code-split
chunk, a second island, an MPA page with different script order. Detection then
falls through to the async `import('vue')`, which on a no-bundler page is a
bare specifier the browser cannot resolve at all, and
`createVaporChamberApp()` throws "Vue 3.6+ with Vapor mode required" on a page
that demonstrably has Vapor.

Measured end to end in `tests/vue-detection-real-ordering.test.ts` (real build,
real `createVaporApp().mount()`, real freshly-evaluated `chamber.ts`, nothing
mocked) and `tests/vue-detection-global-clobber.test.ts`. `__VUE__` remains
supported as a legacy fallback — it is read after the owned slot — so existing
pages keep working.

**Correction — the scope is wider than this section first claimed.** It said
"under a bundler the async fallback resolves and the bug is invisible". That is
true in `vite dev` and **false in `vite build`**, and the flagship
`examples/vapor-sfc` was shipping broken because of it: the built page rendered
nothing and threw *"Vue 3.6+ with Vapor mode required. No Vue detected."* while
the with-vapor runtime sat bundled in the very same 94 KB file. Loaded the built
`dist/` over plain HTTP and captured it, rather than reasoning about it.

Both channels are absent in a production bundle:

- the **synchronous** channel reads the owned global slot, and the only thing
  that primes it under Vite is `vaporChamberHMR()`'s companion module — which is
  `apply: 'serve'`, deliberately, so it never runs in a build;
- the **async** channel is a bare `import('vue')`, which a browser cannot resolve
  from a built bundle with no import map. It rejects into an empty `catch`.

So any app that calls `createVaporChamberApp()` synchronously at module scope —
the shape every example and every doc snippet used — depends on a channel that
only exists in dev. What made this invisible is narrower than "a bundler": it is
*the dev server*. The suite missed it because the tests exercise `chamber.ts`
directly and the examples were only ever opened via `vite dev`.

The fix is `configureVue(Vue)`, and it is **required** rather than advisory for
bundled Vapor apps: it seeds the registry synchronously from the same aliased
`vue` instance the compiled SFCs use, so there is no channel to race.
`examples/vapor-sfc/src/main.ts` now does this and its built output renders;
pinned by `tests/vapor-sfc-prod-detection.test.ts`. The alternative — `await
waitForVueDetection()` before the first call — cannot help here, because the
async channel it waits on is the one that rejects.

The failure is also no longer silent: the thrown message now distinguishes
"no Vue here", "Vue here without the Vapor build", and "Vue here but its
namespace could not be reached", and names `configureVue()`.

**Do not** also load the plain `vue.esm-browser.js` elsewhere on the same
page. Each Vue dist file bundles its own independent copy of the reactivity
engine — two different files, even both genuinely "Vue," are two disconnected
module instances with no shared effect-tracking state. Verified directly: a
`ref()` created via one build is invisible to a `watchEffect` created via the
other (a plain assignment never re-triggers it). Silent, no warning, no
error — just reactivity that stops working across the boundary. One page,
one Vue build, always.

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

### `createTransitionBridge`

Wires Vue `<Transition>` hooks to bus commands. Framework-agnostic — accepts any `BaseBus`.

```ts
const modal = createTransitionBridge({ bus, namespace: 'modal' });
// modal.onEnter dispatches 'modalEnter', etc.
// modal.phase.value → 'idle' | 'entering' | 'leaving'
```

The composable counterpart `useTransitionCommand()` uses the shared bus and auto-cleanup:

```ts
const hooks = useTransitionCommand({ namespace: 'drawer' });
// <Transition v-bind="hooks"> — all 8 hooks wired automatically
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
const { dispatch: trackScroll } = defineVaporCommand('scrollSample', (cmd) => {
  // forward to whatever metrics / telemetry sink you use
  sendMetric('scroll', { depth: cmd.target.depth })
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

### 14.2 Per-request isolation: the bus **and** the HTTP client

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

**The same rule applies to `createHttpClient()`, and it is the sharper edge of
the two.** Its response cache and in-flight dedupe map live in the client's own
closure (v1.12.0 — before that they were module-level, so a fresh bus per
request did *not* give a fresh cache). The cache key is
`responseType:fullUrl`, with **no auth, header or cookie dimension**. So a
client hoisted to module scope and shared across concurrent renders means:

- a `cache: true` GET to an authenticated endpoint stores user A's payload
  under a key user B's identical URL hits, and
- two concurrent requests for different users collapse into one in-flight
  promise and receive the same response.

Create the client where you create the bus:

```ts
export async function handleRequest(req, res) {
  const bus = createCommandBus()
  const http = createHttpClient({ headers: { cookie: req.headers.cookie } })
  setCommandBus(bus)
  try {
    // pass `http` explicitly — e.g. fetchLoaders({ http })
  } finally {
    resetCommandBus()
  }
}
```

If you would rather not think about it on the server at all, leave `cache`
off there: it is opt-in per request, and a client with no `cache` option
never stores anything.

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

**Not a router (core).** Page transitions belong to a router — shipped
alongside the bus as the `vapor-chamber/router` subpath (Vue 3.6 over Laravel
Blade; reads/URL-state live there, writes stay on the bus). Inertia, Vue
Router, or Next.js Router remain fine hosts where they are already in place.

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
| Bundle size | ~50KB | ~15KB | ~14KB | ~4KB brotli core |
| TypeScript | partial | no | no | full |
| Vue DevTools | no | no | no | yes |
| Undo/redo | no | no | no | built-in |
| Cross-tab sync | no | no | no | built-in |
| State persistence | no | no | no | built-in |
| Retry/backoff | no | no | no | built-in |
| LLM-token efficient naming | no | no | no | enforced |

---

## 18. Roadmap

This section used to carry a per-version feature list. It was a frozen snapshot
from the v1.0 era and had stopped being true: it still presented **v0.8.0** and
**v0.9.0** as *upcoming* and **v1.0.0** as *current*, twelve minor releases
later, and listed `createEchoBridge` as unshipped when it landed in **v1.5.0**.

Removed rather than re-synced, on the same rule §21 applies: a third copy is a
third thing to keep true. Forward-looking plans and the version policy live in
[`ROADMAP.md`](../ROADMAP.md); what each release actually changed lives in
[`CHANGELOG.md`](../CHANGELOG.md); per-release Vue alignment detail is §9's
table above.

## 19. Core Guarantee

The core (`command-bus.ts` + `testing.ts`) will remain:
- **Zero runtime dependencies** — always
- **Framework-agnostic** — always
- **~4 KB gzipped dispatch core** — measured ([BUNDLE-SIZES.md](./BUNDLE-SIZES.md))
- **`command-bus.ts` at 100% line + branch + function coverage** — measured ([vitest.config](../vitest.config.ts) gate; 3 provably-unreachable defensive guards excluded with rationale). *(`testing.ts` is the test harness — excluded from coverage by design.)*

Optional layers may add dependencies. The core never will.

---

## 20. Implementation Status

Removed for the same reason as §18, and with the same evidence: it was headed
"Implemented (v0.6.0)" / "Implemented (v1.0)" and its "Remaining" list still
had `createEchoBridge` (shipped v1.5.0) and the `vapor-chamber/rx` bridge
(superseded by the shipped `vapor-chamber/observable` subpath, which is the
`Symbol.observable` interop RxJS reads natively via `from()`).

Per-module status with test coverage now lives in exactly one place —
[`ROADMAP.md`](../ROADMAP.md)'s feature-matrix appendix — beside the generated
[`docs/COVERAGE.md`](./COVERAGE.md).

## 21. File Map

```
src/
  command-bus.ts    — core sync/async bus, plugin pipeline, BusError, inspectBus, types
  chamber.ts        — signal probe, shared bus, tryAutoCleanup, useCommand,
                      useCommandState, useCommandHistory, useCommandGroup,
                      useCommandError, useCommandBus
  chamber-vapor.ts  — createVaporChamberApp, getVaporInteropPlugin,
                      defineVaporCommand, useVaporAsyncCommand
  fast-lane.ts      — createFastLane (minimal-allocation single-handler hot dispatcher)
  signal.ts         — signal() + configureSignal (Vue shallowRef auto-detect → plain-object fallback)
  alien-signals.ts  — alienSignalAdapter, configureAlienSignals (opt-in alien-signals backing)
  reactive.ts       — deepSignal, useDeepCommandState (deep-reactivity companion, vapor-chamber/reactive)
  observable.ts     — observe, dispatchFrom (RxJS-style observable adapter)
  plugins-core.ts   — logger, validator, history, debounce, throttle, authGuard, optimistic
  plugins-io.ts     — retry, persist, sync
  plugins-extra.ts  — cache, circuitBreaker, rateLimit, metrics
  plugins-schema.ts — validateSchemas / validateSchemasAsync
  plugins.ts        — barrel re-export of plugins-core + plugins-io
  schema.ts         — schema bus, toTools / toAnthropicTools / toOpenAITools, schemaValidator, LlmAdapter
  form.ts           — createFormBus (validation, async validators, Precognition)
  http.ts           — postCommand, readCsrfToken, invalidateCsrfCache
  http-cache.ts     — getCached / setCache / clearAllCache / invalidateCacheByPattern
  http-query.ts     — buildFullUrl (URL + query-string builder)
  transports.ts     — createHttpBridge, createWsBridge, createSseBridge, createEchoBridge
  transitions.ts    — createTransitionBridge, useTransitionCommand
  directives.ts     — createDirectivePlugin (v-vc:command + event modifiers)
  ssr.ts            — createSSRPlugin, rehydrate (dehydrate / replay)
  utilities.ts      — createChamber, createWorkflow, createReaction
  vite-hmr.ts       — vaporChamberHMR() Vite plugin
  devtools.ts       — Vue DevTools integration (dynamic import)
  testing.ts        — createTestBus, snapshot, time-travel
  iife.ts           — CDN entry → window.VaporChamber (full variant)
  iife-core.ts      — CDN entry, core variant
  iife-elements.ts  — CDN entry, elements variant
  index.ts          — public ESM barrel

tests/                           (92 files, 1,491 tests)
```

The per-file test inventory that used to sit here has been removed rather than
re-synced. It drifted four times (13 → 40 → 47 → 85 files) because it is a
third copy of something two other places already track, and the project has
made this call before: v1.10.0 deleted the README's size table instead of
re-syncing it, and v1.11.0 did the same to `ROADMAP.md`'s version table. A
third copy is a third thing to keep true.

Where the current numbers live, both generated and CI-verified fresh:

| | |
|---|---|
| per-file coverage, test totals | [`docs/COVERAGE.md`](./COVERAGE.md) (`npm run coverage:doc`) |
| per-export bundle sizes | [`docs/BUNDLE-SIZES.md`](./BUNDLE-SIZES.md) (`npm run size:doc`) |
| what each release changed | [`CHANGELOG.md`](../CHANGELOG.md) |

`npx vitest run` prints the authoritative file and test counts in under ten
seconds, which is faster than reading a list that might be wrong.

---

## 22. References

1. Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and
   Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
   https://zenodo.org/records/18853783
2. Vue 3.6.0-beta.8 Release (Vapor feature-complete): https://github.com/vuejs/core/releases/tag/v3.6.0-beta.8
3. Alien Signals: https://github.com/stackblitz/alien-signals
4. Vue Vapor Repository: https://github.com/vuejs/vue-vapor
5. Vite 7.0: https://vite.dev/blog/announcing-vite7

---

## 23. License

GNU Lesser General Public License v2.1 (LGPL-2.1)

---

*vapor-chamber is built for the Vue Vapor + Laravel stack.
The core is open for anyone building similar coordination layers.*
