# Vapor Chamber: Technical Whitepaper

*Luciano Federico Pereira - ORCID 0009-0002-4591-6568 - luciano-pereira.pages.dev*

This document formalizes the architecture and implementation of the Vapor Chamber library, synchronized with Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->. Historical evolution, initial specifications, version alignment logs, and internal self-corrections are archived in the appendix. The core specification supersedes historical notes.

---

## Abstract

Vapor Chamber is an unopinionated command bus engineered specifically for Vue Vapor, featuring a <!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB Brotli-compressed dispatch core. Every user interaction maps to a discrete action identifier and a single deterministic handler, passing through configurable middleware rules and lifecycle steps before yielding a structured result object. The bus maintains zero internal state and enforces no coupling to specific frameworks, build systems, or backend architectures. The identical core executes seamlessly within client-side Vue applications (vDOM or Vapor), Node.js runtimes, and zero-build static pages. All peripheral capabilities—including Vue composables, network transports, HTTP clients, routing modules, state stores, Server-Side Rendering (SSR), and testing utilities—are modular and opt-in. Unimported entry points incur zero bundle cost.

---

## 1. Architectural Scope: What It Is and What It Is Not

`vapor-chamber` functions strictly as a **command bus**: a lightweight coordination layer bridging Vue components and application business logic without maintaining domain state. It dispatches commands, evaluates middleware rules and execution steps, and returns structured execution outcomes. 

It does not supersede specialized state and navigation libraries:
- **Pinia** - Manages reactive application state.
- **TanStack Query** - Manages asynchronous data fetching, caching, and server-state synchronization.
- **XState** - Manages finite state machines and complex workflow orchestration.
- **Inertia.js** - Manages page navigation and server-driven client rendering.

Vapor Chamber coordinates these concerns through a unified dispatch interface while shipping optional, tree-shakeable subpaths for routing and state management.


```

Components  ->  dispatch command  ->  rules, steps  ->  handler
v
result { ok, value, error }
v
Pinia / TanStack Q / Inertia react

```

- **Not a Livewire replacement:** Livewire tightly couples the component lifecycle end-to-end. Vapor Chamber provides a modular data-flow orchestration layer.
- **Not a standalone router (Core):** URL-driven navigation is handled by `vapor-chamber/router` (Vue 3.6 over Laravel Blade), where read-state and query parameters reside in the router while write operations utilize the bus. Inertia, Vue Router, and Next.js Router remain fully supported alternatives.
- **Not a traditional state store (Core):** The core bus is entirely stateless. `vapor-chamber/store` provides a reactive state management layer where every state mutation is explicitly driven by a command dispatch, preserving bus statelessness.
- **Backend agnostic:** The `/api/vc` endpoint represents a standard convention rather than a hard protocol constraint.

---

## 2. Problem Statement and Ecosystem Positioning

Modern frontend engineering is bifurcated into two primary paradigms:

1. **The Full SPA Paradigm:** Relies on client-side frameworks (React, Vue with Pinia) and comprehensive client routing, frequently introducing duplicated validation logic and REST endpoints dedicated solely to frontend data consumption.
2. **The Server-Driven Paradigm:** Utilizes frameworks like Livewire, Phoenix LiveView, or HTMX, trading client-side flexibility for tight backend coupling.

Alpine.js demonstrated that a third paradigm is viable: an ultra-lightweight runtime operable via CDN within server-rendered templates, offering high interactivity without dictating backend architecture or replacing full component frameworks. 

Vapor Chamber adopts this philosophy for Vue Vapor: a framework-agnostic command bus that interoperates with any backend topology. Without an explicit coordination layer, application logic fragments across component `setup()` hooks, store actions, ad-hoc fetch wrappers, and event buses. Vapor Chamber centralizes every action through a single dispatch surface, modularizing cross-cutting concerns into plugins.

### 2.1 Target Stack

- **Primary Stack:** Vue 3.6 Vapor + Vite Frontend / Laravel Backend
- **Secondary Stack:** Node.js (Server-side command dispatching, API orchestration)
- **Core Runtime:** Framework-agnostic JavaScript/TypeScript foundation

Vue is an optional peer dependency: `>=3.5.0` is required for core composables, and <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> (or later on the 3.6 line) is required for full Vapor integration (`peerDependencies` in `package.json`). The core bus operates independently of Vue.

### 2.2 Comparison with Official Vue Ecosystem (Vue Router & Pinia)

While Vue Router and Pinia represent the standard defaults for generic SPAs, Vapor Chamber ships dedicated routing and state subpaths optimized for server-owned multi-page architectures.

| Domain | Official Library | Vapor Chamber Subpath | Architectural Differentiation |
| :--- | :--- | :--- | :--- |
| **Router** | `vue-router` | `vapor-chamber/router` | Designed for server-owned catch-all architectures: generated route tables, Blade integration, typed query-as-state, and a vDOM-free core with renderers loaded via subpaths. `vue-router` relies on a vDOM `RouterView` and enforces its own convention stack. |
| **Store** | Pinia | `vapor-chamber/store` | Mutations-as-commands: native support for undo/redo, optimistic updates, idempotent execution, and per-key sequencing enabled by the underlying bus. Cross-tab synchronization propagates writes as commands (`share: shareTabs()`) processed by local reducers without re-dispatching. Fast-lane channels (`createChannel`) transport raw facts without touching the dispatch pipeline. |

Adherence to architectural discipline is enforced via two primary rules:
- **Upstream Integration:** Innovations from Vue Router v5 (e.g., query hardening) are adopted in `src/dict.ts`. Pinia architectural patterns (root state refs, scope hierarchies, state factories) inform the store design without direct code replication.
- **Audience Scope:** Applications not utilizing server-owned catch-all routing or vDOM-based rendering should continue using Vue Router and Pinia.

### 2.3 Comparison with Zero-Build Ecosystem

| Metric | Livewire | Alpine.js | HTMX | Vapor Chamber |
| :--- | :--- | :--- | :--- | :--- |
| **Backend Coupling** | Laravel Only | None | None | None |
| **Build Requirement** | None | None | None | None (IIFE Bundles Available) |
| **Reactivity Model** | Server-Driven | `x-data` | Hypermedia | Vue Vapor Signals |
| **Transport Layer** | Built-in (AJAX/WS) | None | Built-in (AJAX) | Modular Plugin |
| **TypeScript Support** | Partial | None | None | Full |
| **Vue DevTools** | None | None | None | Native Support |
| **Undo/Redo** | None | None | None | Built-in |
| **Cross-Tab Sync** | None | None | None | Built-in (`share`, `createChannel`) |
| **Persistence** | None | None | None | Built-in |
| **Retry/Backoff** | None | None | None | Built-in |
| **LLM-Token Efficient Naming** | None | None | None | Opt-in (`naming`) |

Exact bundle sizes depend on version and compilation targets; dispatch core size is benchmarked at <!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB Brotli ([BUNDLE-SIZES.md](./BUNDLE-SIZES.md)).

---

## 3. Core Design Principles

### 3.1 Semantic over Imperative Execution

Replacing disparate `emit`, `v-on`, and component-local handlers, Vapor Chamber associates every user action with a unique identifier and a single execution handler, shifting architectural inquiry from *"Where is this handled?"* to *"What operation does this represent?"*

```js
bus.dispatch('cartAdd', product, { quantity: 2 })

```

### 3.2 Transport Agnostic

The bus remains decoupled from underlying communication protocols. HTTP fetch, WebSocket, and Server-Sent Events (SSE) operate as interchangeable transport plugins, ensuring minimal core footprint.

### 3.3 Build Optionality

Vapor Chamber is distributed as an ES module and as three IIFE `<script>` bundles, allowing direct consumption via CDN within server templates without requiring a Node.js build chain.

### 3.4 Framework Agnostic at the Core

The core module (`command-bus.ts`) contains zero Vue dependencies, executing in Vue 3.5 (vDOM), Vue 3.6 Vapor, Node.js test suites, Web Workers, or any standard JavaScript runtime. The Vue-specific integration layer is a lightweight wrapper introducing reactive signals, lifecycle cleanup, and shared bus management.

### 3.5 Empirical Naming Conventions: camelCase

Action identifiers enforce **camelCase** (`cartAdd`, `orderCreate`, `authLogin`), determined through empirical tokenization analysis. Pereira (2026) evaluated Byte-Pair Encoding (BPE) tokenization differentials across four naming conventions across 200 enterprise event identifiers and 500 LLM responses:

> *"Dot notation produces 1.12–1.20x more tokens than camelCase ($p < 0.001$), generating a projected cost differential of **$54,499/year** at enterprise API volumes."*
> — *Empirical Validation of Cognitive-Derived Coding Constraints and Tokenization Asymmetries in LLM-Assisted Software Engineering*, Section 4.1

> *"The relative efficiency ordering of the four naming conventions is identical across every vocabulary tested (Spearman $\rho = 1.000$), confirming that the camelCase advantage is **structural**, not an artifact of tokenizer training distributions."*
> — Ibid., Section 4.2

Cross-model verification confirmed identical metrics across GPT-4o, GPT-4, and Claude ($\rho = 1.000$).

* **camelCase vs. snake_case:** Both outperform dot notation. camelCase is favored because underscores function as punctuation in tokenizers, forcing morpheme splitting (`cartAdd` tokenizes efficiently compared to multi-token `cart_add`).
* **Cognitive-Derived Coding Constraints (CDCC):** Functions adhering to cyclomatic complexity $\le 10$ yield **3.3x higher LLM output-to-input token ratios** ($0.141$ vs. $0.043$, $p < 0.001$). Vapor Chamber adopts this as a design guideline for single-responsibility handlers.
* **Enforcement:** Naming compliance is opt-in per bus instance via the `naming` configuration option, validated at registration and dispatch (`validateNaming` in `src/command-bus.ts`). Identifiers containing `$` (such as store reset actions) bypass validation.

```ts
const bus = createCommandBus({
  naming: {
    pattern: /^[a-z][a-zA-Z0-9]+$/, // camelCase
    onViolation: 'throw',
  }
})

bus.register('cartAdd', handler)   // Passes
bus.register('cart_add', handler)  // Throws
bus.register('cart.add', handler)  // Throws

```

**Reference:** Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo. https://zenodo.org/records/18853783.

### 3.6 Stateless Core

State-owning architectures introduce complex invalidation, hydration, persistence, and synchronization overhead. Pinia, TanStack Query, and Inertia handle state management; Vapor Chamber coordinates state transitions without retaining state.

`vapor-chamber/store` maintains consistency with this architecture: stores own a `shallowRef` while the bus remains stateless, routing every state mutation through the dispatch pipeline. This enables plugins (undo/redo, optimistic updates, out-of-order sequencing) to operate transparently on state stores. The store implementation occupies 5.8 KB.

---

## 4. The Bus Architecture

### 4.1 Layer Model

```
+-----------------------------------------------------------------+
|  CORE  -  zero deps  -  framework-agnostic  -  fully tested     |
|  command-bus.ts  -  testing.ts                                  |
+---------------------------+-------------------------------------+
                            |  optional layers  (tree-shaken)
         +------------------+------------------+------------------+
         v                  v                  v                  v
   Vue composables      Plugins          Transport           Utilities
   chamber.ts           plugins-core     transports.ts       createChamber
   chamber-vapor.ts     plugins-extra    http.ts             createWorkflow
   directives.ts        plugins-io       outbox.ts           createReaction
   vue.ts / vapor.ts    schema.ts        router/             form.ts

```

### 4.2 Dispatch Pipeline Execution Flow

```
dispatch(action, target, payload)
  1. Evaluate depth guard (maximum 16 nested levels, inclusive of queries)
  2. Validate action naming convention (if `naming` option is configured)
  3. Construct Command object { action, target, payload, meta: { ts, id, correlationId, causationId, origin, idempotencyKey, response, request } } (+ signal on async bus)
  4. Bare bus execution (zero plugins/hooks/listeners): execute handler directly and return result
  5. `started` phase: plugin start hooks execute prior to authorization rules
  6. Authorization and Validation rules: execute all plugin `authorize` then `validate` hooks; initial refusal halts execution
  7. Work execution steps: execute plugin `reuse` (cache hit), `admit` (rate limit check), and `begin` (dispatch initiation), followed by transport or local handler lookup ($O(1)$ Map lookup)
  8. Execute post-dispatch `afterHooks`
  9. `settled` phase: execute plugin settled hooks, followed by exact-match and wildcard event listeners
 10. Return CommandResult { ok, value, error }

```

Calling `seal()` freezes configuration methods (`register`, `use`, `onAfter`, `respond`, `clear`) while permitting dispatches. The bus has no disposed state; calling `dispose()` invokes plugin teardown routines, clears state, and settles pending requests while keeping the bus functional.

### 4.3 Recursion Depth and Listener Isolation

* **Recursion Depth:** Nested dispatches inside handlers, hooks, plugins, or listeners increment depth tracking. Exceeding 16 levels triggers `core:exceeded:depth`. Synchronous and asynchronous buses track depth relative to current execution context.
* **Listener Snapshotting:** Dispatches invoke the set of listeners active at dispatch initiation. Listeners removed mid-dispatch do not execute within that cycle; newly added listeners execute starting from subsequent dispatches, matching DOM `EventTarget` specifications.

### 4.4 Core API Surface (Stable Interface)

```ts
createCommandBus(options)       // Synchronous factory: zero-overhead, pure pipeline
createAsyncCommandBus(options)  // Asynchronous factory: promise-returning, async plugin support

// BaseBus Interface (Implemented by both synchronous and asynchronous buses)
dispatch(action, target, payload?)    // Mutation path: execute command and return result
register(action, handler, options?)   // Register action handler { undo?, canUndo?, answer?, optimistic?, exclusive? }
use(plugin)                           // Install plugin parts; returns uninstaller
onAfter(hook)                         // Register post-dispatch side-effect hook
on(pattern, listener)                 // Subscribe to matching command events
once(pattern, listener)               // Register one-shot event subscription
offAll(pattern?)                      // Remove listeners matching pattern or all listeners
hasHandler(action)                    // Introspect handler existence
registeredActions()                   // Return string array of registered action identifiers
query(action, target, payload?)       // CQRS read-only dispatch path
emit(event, data?)                    // Domain event emission (no handler/result required)
seal()                                // Freeze configuration state
isSealed()                            // Return boolean indicating seal status
dispose()                             // Clean teardown of timers, state, and pending requests
clear()                               // Reset bus state (testing and HMR support)

// Exclusive to CommandBus and AsyncCommandBus
dispatchBatch(commands, options?)     // Sequential batch dispatch returning success/failure counts
request(action, target, payload?, options?) // Query-path request expecting a responder
respond(action, handler)              // Register a query request responder

// Tree-shakeable Standalone Utilities
inspectBus(bus)                       // Return topological BusInspection snapshot
unsealBus(bus)                        // Unseal a sealed bus instance

```

### 4.5 CQRS Separation

* `dispatch`: Mutation domain.
* `query`: Read-only domain, bypassing execution state tracking (omits loading indicators).
* `emit`: Domain event broadcasting.
* `request`/`respond`: Request-response pattern bounded by a timeout (default 5000 ms). *Note: `request/respond` on synchronous buses returns a Promise.*

### 4.6 Results and Error Taxonomy

Every dispatch yields a standardized `{ ok, value, error }` tuple (`V8-RULES` Rule 1). Failures are encapsulated as `BusError` instances formatted as `owner:condition:subject` (e.g., `core:missing:handler`, `rateLimit:limited:action`).

Fourteen canonical error conditions are supported: `missing`, `already`, `conflict`, `invalid`, `refused`, `unauthenticated`, `limited`, `timeout`, `lost`, `aborted`, `exceeded`, `failed`, `unexpected`, and `unknown`. HTTP status codes map directly to these conditions (e.g., 404/410 $\to$ `missing`, 429/503 $\to$ `limited`).

### 4.7 Asynchronous Retry Logic

The asynchronous bus provides built-in retry mechanics governed by failure condition classification and per-bus retry budgets:

* Transient failures (`limited`, HTTP 408) trigger automatic retries for any action.
* Uncertain outcomes (timeouts, HTTP 502/504/500) trigger retries strictly for explicitly identified idempotent or keyed commands.
* `Retry-After` headers dictate backoff delays. Unidentified commands yielding no reply fail with `context.outcome: 'unknown'`.
* Verdict-based failures (`invalid`, `refused`, `missing`, `already`, `conflict`, `unauthenticated`) are never automatically retried.

---

## 5. Plugin Architecture

### 5.1 Pipeline Model

Plugins are structured objects containing execution hooks mapped to pipeline steps. Middleware phases execute uniformly across synchronous and asynchronous runtimes.

```ts
bus.use(logger())
bus.use(authGuard(check))

```

### 5.2 Built-in Plugin Catalogue

| Plugin | Category | Description |
| --- | --- | --- |
| `logger` | DX | Formatted console logging for dispatches, queries, refusals, and cancellations. |
| `validator` | Guards | Pre-execution schema validation rules. |
| `history` | State | Undo/redo management via inverse handler execution. |
| `authGuard` | Guards | Authentication verification prior to authorization checks. |
| `cache` | Performance | LRU query result caching with TTL and glob filtering. |
| `circuitBreaker` | Resilience | Circuit breaker pattern protecting failing actions with automated recovery intervals. |
| `rateLimit` | Rate Limiting | Sliding window rate limiting emitting `rateLimit:limited:action` upon threshold breach. |
| `metrics` | Observability | Lightweight telemetry tracking execution counts, durations, and error rates. |
| `idempotent` | Exactly-once | Deduplication layer injecting `Idempotency-Key` headers for HTTP transports. |
| `schemaValidator` | Guards | Standard Schema validation integration. |
| `createChannel` | Multi-context | BroadcastChannel synchronization for multi-tab event mirroring. |
| `supersede` | Concurrency | Aborts pending dispatches matching active execution keys. |

---

## 6. Transports and HTTP Client

### 6.1 Transport Layer

Transports act as terminal work handlers for asynchronous buses. `httpTransport`, `wsTransport`, and SSE bridges integrate seamlessly with pipeline middleware.

```ts
const api = httpTransport({
  endpoint: '/api/vc',
  csrf: true,
  timeout: 15_000,
})

const bus = createAsyncCommandBus({ transport: { 'cart*': api } })

```

### 6.2 HTTP Client Architecture

`createHttpClient` provides robust request execution supporting multi-source CSRF token resolution, automatic 419 token refreshing, session expiration hooks, and RFC 9457 problem detail parsing (`problemOf`).

---

## 7. Vue Integration

### 7.1 Reactive Signals (`shallowRef` Optimization)

Vue 3.6 reactivity (ported from [alien-signals](https://github.com/stackblitz/alien-signals)) improves memory efficiency and CPU throughput. Vapor Chamber binds internal signals to **`shallowRef()`** rather than deep `ref()` proxies, eliminating traversal overhead on complex state objects during wholesale replacement (`state.value = handler(...)`).

### 7.2 Import Entry Points

* **`vapor-chamber` (Root):** Core bus and framework-agnostic utilities.
* **`vapor-chamber/vue`:** Static entry point for standard Vue vDOM applications, bundling Vue dependencies at build time.
* **`vapor-chamber/vapor`:** Specialized entry point for Vue 3.6 Vapor applications, statically wiring Vapor-native renderers.

### 7.3 DOM-less Vapor Mode

Vapor mode compiles templates into imperative DOM mutation code, bypassing the virtual DOM entirely. Vapor Chamber orchestrates `dispatch -> state -> signal -> DOM node` with zero vDOM interop overhead.

```ts
import { createVaporChamberApp } from 'vapor-chamber/vapor'
createVaporChamberApp(App).mount('#app')

```

### 7.4 Lifecycle Cleanup

Composables utilize `onScopeDispose` (Vue 3.5+) gated by `hasInjectionContext()`, ensuring safe teardown across vDOM, Vapor, and SSR execution contexts without relying on broken instance bindings.

---

## 8. Router, Store, and Composed Vapor Surface

### 8.1 The Router

`vapor-chamber/router` provides a URL-addressable routing engine for Vue 3.6 designed around the tenet: **Path = navigation, query = state**. Routing data loads in parallel and commits atomically as a frozen snapshot.

### 8.2 Composed Vapor Stack

Combining `vapor-chamber/vapor`, `vapor-chamber/router/vapor`, and `vapor-chamber/store` yields a zero-vDOM architecture:

```
command dispatch --> store (signals) -------> renderEffect --> DOM
navigation ---> frozen RouteSnapshot ---> Vapor outlet ------> DOM
         \--------- the bus coordinates both -------------/

```

---

## 9. Integration Patterns

* **Pinia:** Handlers invoke Pinia store methods directly.
* **TanStack Query:** Query invalidation triggered via `bus.onAfter` hooks using `commandKey(action, target)`.
* **Inertia.js:** Isolated command endpoints with CSRF token sharing via cookie inspection.
* **XState:** Workflow orchestration driving bus dispatch commands.
* **Zero-Build (Blade + CDN):** IIFE bundles (`core`, `elements`, `full`) supporting script-tag initialization via `VaporChamber.connect()`.

---

## 10. Utilities

* **`createChamber`:** Namespace grouping for related action handlers.
* **`createWorkflow`:** Sequential saga orchestration with automated compensation (rollback) upon failure.
* **`createTransitionBridge`:** Binds Vue `<Transition>` hooks to bus command dispatches.
* **`createReaction`:** Declarative cross-module event reaction rules.

---

## 11. Migration and SSR

* **vDOM to Vapor Migration:** Phased migration path utilizing `vaporInteropPlugin`, incremental component conversion via `<script setup vapor>`, and complete vDOM runtime removal.
* **Server-Side Rendering (SSR):** Per-request bus and HTTP client isolation (`createCommandBus()`, `createHttpClient()`) combined with state serialization via `storeStates()` and client hydration via `seedStores()`.

---

## 12. Testing Infrastructure

Vitest integration (`vapor-chamber/vitest`) provides dedicated test matchers (`expect(bus).toHaveBeenDispatchedWith(...)`) and mock time-travel capabilities via `createTestBus()`.

```ts
import { createTestBus, setCommandBus, resetCommandBus } from 'vapor-chamber'

const bus = createTestBus()
setCommandBus(bus)

bus.dispatch('cartAdd', { id: 1 })
expect(bus.wasDispatched('cartAdd')).toBe(true)

```

---

## 13. V8 Performance Optimization Rules

Performance benchmarks adhere to strict V8 optimization guidelines ([V8-RULES.md](https://www.google.com/search?q=./V8-RULES.md)):

1. **Monomorphic Shapes:** Ensure consistent object shapes for `Command`, `CommandResult`, and internal state structures.
2. **Execution Mode Isolation:** Resolve behavioral options at instantiation rather than within hot execution paths.
3. **Closure Minimization:** Avoid allocating closures inside high-frequency dispatch loops.
4. **Process-Level Benchmarking:** Automated A/B regression testing (`npm run ab`) verifies execution speed differentials across isolated process environments.

---

## 14. Core Guarantee

The core runtime (`command-bus.ts` and `testing.ts`) maintains:

* **Zero runtime dependencies**
* **Strict framework agnosticism**
* **6.1 KB Brotli dispatch core**
* **100% test coverage** across statements, branches, functions, and lines without pragma exclusions.

---

## 15. File Structure Map

```
src/
  command-bus.ts    - Core sync/async bus, plugin execution pipeline, inspection utilities
  failure.ts        - BusError definitions, error code taxonomy, status mapping
  chamber.ts        - Vue composables (useCommand, useCommandHistory, etc.)
  store.ts          - Reactive command-driven state stores (defineChamberStore)
  http.ts           - HTTP client, CSRF handling, request caching
  transports.ts     - Transport adapters (HTTP, WebSocket, SSE, Echo)
  router/           - Router subpath (Vue 3.6 over server catch-all)
  testing.ts        - Test bus implementation (createTestBus, time-travel)
  index.ts          - Public ESM barrel export

```

---

## 16. References & Licensing

1. Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo. https://zenodo.org/records/18853783
2. Vue 3.6 Release Documentation: https://github.com/vuejs/core
3. Alien Signals: https://github.com/stackblitz/alien-signals
4. Vite: https://vite.dev

**License:** GNU Lesser General Public License v2.1 (LGPL-2.1)
