# Vapor Chamber: Whitepaper

*Luciano Federico Pereira - ORCID 0009-0002-4591-6568 - luciano-pereira.pages.dev*

This document describes the library as it is now, aligned with Vue
<!-- vc:vueAligned -->3.6.0-rc.10<!-- /vc:vueAligned -->. How it got here is in the appendix, Notes and
history. It holds the original header and abstract, the per-release Vue
alignment log, and this document's corrections to itself. The body points to it
and does not repeat it.

---

## Abstract

Vapor Chamber is a command bus built for Vue Vapor, with a <!-- vc:sizeCore -->4.7<!-- /vc:sizeCore --> KB brotli dispatch core.
Every user action gets a name and one handler, runs through a plugin pipeline,
and returns a structured result. The bus owns no state and imposes no
framework, build system or backend. The same core runs in a Vue app (vDOM or
Vapor), in Node, and on a page with no build at all. Everything beyond the core
is opt-in: Vue composables, transports, an HTTP client, a router, a store, SSR,
testing. An entry that is never imported costs nothing.

---

## 1. What it is, and what it is not

vapor-chamber is a **command bus**: a thin coordination layer that sits between your Vue
components and your application logic, without owning state. It dispatches commands, runs
them through a plugin pipeline, and returns structured results. That is all the bus does.

It does not replace:
- **Pinia** - which owns application state
- **TanStack Query** - which owns data fetching and caching
- **XState** - which owns workflow state machines
- **Inertia.js** - which owns page navigation and server-driven UI

It coordinates all of them through one consistent surface. The package also
ships its own router and store as opt-in subpaths. Section 2 says when each is
the right choice over the official libraries, and when it is not.

```
Components  ->  dispatch command  ->  plugin pipeline  ->  handler
                                                              v
                                                    result { ok, value, error }
                                                              v
                                          Pinia / TanStack Q / Inertia react
```

**Not a Livewire replacement.** Livewire owns its component model end-to-end. Vapor Chamber
gives the data flow layer.

**Not a router (core).** Page transitions belong to a router. One ships
alongside the bus as the `vapor-chamber/router` subpath, for Vue 3.6 over
Laravel Blade. Reads and URL state live there, and writes stay on the bus.
Inertia, Vue Router, or Next.js Router remain fine hosts where they are already
in place.

**Not a state management library (core).** The bus stores nothing.
`vapor-chamber/store` is a state layer in the same package, whose every
mutation arrives as a dispatch. Section 3 says why that keeps the bus
stateless rather than contradicting it. Pinia remains the right answer for an
app already on it. Section 2's positioning table says when each one is.

**Not opinionated about your backend.** The `/api/vc` endpoint is a convention, not a
rule.

---

## 2. The problem, and where the library stands

Modern frontend tooling has split into two directions:

**The full SPA route** - React, Vue with Pinia, full routing on the client. It brings
duplicated validation logic and REST APIs that exist only to feed the frontend. A build
pipeline must run before you can ship anything.

**The server-driven route** - Livewire, Phoenix LiveView, HTMX - which trade client complexity
for backend coupling. You gain simplicity, but you lose the flexibility to use the best tool
for each layer.

Alpine.js proved a third path exists. Its runtime is small enough to drop into a Blade template
from a CDN and expressive enough to handle real interactivity. It is agnostic enough to work
alongside any backend. It doesn't try to replace Laravel. It doesn't try to replace Vue.

Vapor Chamber takes the same position for Vue Vapor: a command bus that works beside any backend
and imposes no framework.

Without a coordination layer, logic scatters across component `setup()` functions, Pinia store
actions, ad-hoc fetch wrappers and event-bus hacks. With one, every action goes through one
dispatch surface, and each concern is a plugin.

### 2.1 Target stack

**Primary:** Vue 3.6 Vapor + Vite frontend / Laravel backend
**Secondary:** Node.js (server-side command buses, API services)
**Core:** Framework-agnostic - documented as a reusable foundation for similar tools

Vue is an optional peer: `>=3.5.0` for the composables, and
<!-- vc:vueAligned -->3.6.0-rc.10<!-- /vc:vueAligned --> or later on the 3.6 line for the full Vapor surface
(`package.json` `peerDependencies`). The core bus runs without Vue entirely.

**Out of scope:** React, Svelte, Angular and other frontend frameworks. vapor-chamber is not
built for them, though any TypeScript project can use the core.

### 2.2 Against Vue's own router and store

Both official libraries are good and are the right default for a generic Vue SPA. This repo ships its own router and its own store anyway, so the
justification has to stay sharp or the honest answer is "use theirs".

| | official | here | the difference that justifies existing |
| --- | --- | --- | --- |
| router | vue-router | `vapor-chamber/router` | built for the server-owned catch-all: generated route tables, blade rows, typed query-as-state, a vDOM-free core with the renderer opt-in by subpath. vue-router renders through a vDOM `RouterView` and owns its own conventions |
| store | Pinia | `vapor-chamber/store` | mutations-as-commands: undo, persist, optimistic, idempotent and per-key ordering exist *because* a bus exists underneath. Pinia grew a mini-bus (`action()` / `$onAction`) because one does not. Across tabs a store shares the state it reached (`share`), never the command, so a non-deterministic handler cannot split the tabs. `createChannel` carries facts on a fast lane and never sees a dispatch (docs/store.md) |

Two honesty rules keep this from drifting into not-invented-here.

- **Lessons flow in.** vue-router v5's query hardening became the prototype-key
  rule in `src/dict.ts`. Pinia's root-state-ref, scope hierarchy and
  state-factory patterns are the store's skeleton, studied at source and never
  copied as code.
- **The recommendation stays audience-scoped.** Take an app that is not behind
  a server-owned catch-all, does not speak the bus, and renders vDOM. It should
  use vue-router and Pinia, and these docs must keep saying so.

### 2.3 Against the no-build tools

| | Livewire | Alpine.js | HTMX | Vapor Chamber |
|---|---|---|---|---|
| Backend coupling | Laravel only | none | none | none |
| Build needed | no | no | no | no (IIFE available) |
| Reactivity model | server-driven | x-data | hypermedia | Vue Vapor signals |
| Transport | AJAX/WS (built-in) | none | AJAX (built-in) | plugin |
| TypeScript | partial | no | no | full |
| Vue DevTools | no | no | no | yes |
| Undo/redo | no | no | no | built-in |
| Cross-tab sync | no | no | no | built-in (a store's `share`, `createChannel` for facts) |
| State persistence | no | no | no | built-in |
| Retry/backoff | no | no | no | built-in |
| LLM-token efficient naming | no | no | no | opt-in (`naming`) |

Bundle sizes are left out of this table. The three peers' sizes were never
measured here, and a size is a fact of a version and a build. This library's
own are generated in [BUNDLE-SIZES.md](./BUNDLE-SIZES.md): the dispatch core is
<!-- vc:sizeCore -->4.7<!-- /vc:sizeCore --> KB brotli.

---

## 3. Design principles

### 3.1 Semantic over imperative

Instead of scattered `emit`, `v-on`, and component-local handlers, Vapor Chamber gives every
user action a name and one handler. The question shifts from "where did this get handled?" to
"what does this do?" - and the answer is always one function.

```js
bus.dispatch('cartAdd', product, { quantity: 2 })
```

### 3.2 Transport agnostic

The bus does not know how a command reaches the backend. HTTP fetch, WebSocket and SSE are all
plugins, so the core stays minimal whatever the transport.

### 3.3 Build optional

Vapor Chamber ships as an ES module and as three IIFE `<script>` bundles. A Blade template can
load one from a CDN and dispatch to the backend with no npm and no build (section 9.6).

### 3.4 Framework agnostic at the top

The core `command-bus.ts` has zero Vue imports. It runs anywhere: Vue 3.5 (VDOM), Vue 3.6
Vapor, Node.js tests, Web Workers, any JavaScript runtime. The Vue-specific layer is a thin
wrapper that adds signals, lifecycle cleanup, and shared bus management.

### 3.5 camelCase action names: an empirical decision

Action names use **camelCase** (`cartAdd`, `orderCreate`, `authLogin`). The choice rests on
measurement, not stylistic preference.

Pereira (2026) measured BPE tokenization differentials across four naming conventions on a
corpus of 200 enterprise event identifiers, modeled across 500 LLM responses:

> "Dot notation produces 1.12-1.20x more tokens than camelCase (p < 0.001), generating a
> projected cost differential of **$54,499/year** at enterprise API volumes."
> - *Empirical Validation of Cognitive-Derived Coding Constraints and Tokenization Asymmetries
> in LLM-Assisted Software Engineering*, section 4.1

> "The relative efficiency ordering of the four naming conventions is identical across every
> vocabulary tested (Spearman [rho] = 1.000), confirming that the camelCase advantage is
> **structural**, not an artefact of any particular tokenizer's training data."
> - ibid., section 4.2

Cross-model consistency was verified across GPT-4o, GPT-4, and Claude. All three achieve
Spearman rho = 1.000. camelCase wins universally.

**Why camelCase over snake_case:** Both outperform dot notation. camelCase edges out snake_case
because underscores, like dots, are punctuation. They force the tokenizer to split adjacent
morphemes. `cartAdd` is typically two tokens, and `cart_add` risks three.

**The CDCC constraint:** the same paper looks at functions at cyclomatic complexity <= 10. They
receive **3.3x more LLM output per input token** than functions that violate that bound
(output/input ratio 0.141 vs 0.043, p < 0.001). Here that is a design guideline, favouring
small, single-responsibility handlers: one action, one function, one outcome. No lint rule
enforces a complexity bound (`biome.json`'s `complexity` group sets none).

**Naming convention enforcement** is opt-in, per bus. With a `naming` option the
pattern is checked at registration and at every dispatch and query
(`validateNaming` in `src/command-bus.ts`). `onViolation` defaults to `'warn'`.
A name containing `$` is the library's (a store's `<id>$reset`) and skips the
check, which runs only once the pattern has failed:

```ts
const bus = createCommandBus({
  naming: {
    pattern: /^[a-z][a-zA-Z0-9]+$/,   // camelCase
    onViolation: 'throw',
  }
})

bus.register('cartAdd', handler)   // passes
bus.register('cart_add', handler)  // throws
bus.register('cart.add', handler)  // throws
```

The library names a store's actions, store id then action name (`liveLanded`,
`src/store.ts`). So a verb-first pattern rejects every store action on the bus
that hosts the store.

**Reference:** Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding
Constraints and Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
https://zenodo.org/records/18853783.

### 3.6 The bus owns no state

Every tool that owns state also owns the responsibility for invalidation, hydration, persistence,
and synchronization. Pinia, TanStack Query, and Inertia already solve these problems well within
the Vue + Laravel stack. The bus coordinates state transitions. It does not store state.

The comparative analysis that shaped the design ran several rounds (appendix
A.4). Every round found the same thing: borrowing state-centric patterns hit a
wall, and working with the stateless design added value.

`vapor-chamber/store` is consistent with it rather than an exception. A store
owns its own `shallowRef`. The bus stores nothing, and its only role is that
every mutation of the store arrives as a dispatch. So the plugin catalogue
(undo, persist, optimistic updates, per-key ordering) applies to state with no
code of the store's own. Undo takes one option, `undo: true`: an inverse
belongs to the action, and only the store knows the state it replaced. That is
why the store is
<!-- vc:sizeStore -->2.2<!-- /vc:sizeStore --> KB. Appendix A.3 says which half of the original "no state"
argument that reversed, and why.

---

## 4. The bus

### 4.1 Layer model

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

Section 16 maps every module.

### 4.2 Dispatch flow

```
dispatch(action, target, payload)
  1. check depth (max 16) - nesting, counted with queries (4.3)
  2. validate the naming convention, when the bus has a `naming` option
  3. build Command { action, target, payload, meta: { ts, id, correlationId, causationId,
     origin, idempotencyKey, response, request } } (+ signal on the async bus)
  4. bare bus (no plugins, hooks or listeners): call the handler, return its result
  5. run beforeHooks - throw to cancel: { ok: false }, core:refused:hook, cause: the throw
  6. run plugins in priority order (cached runner - rebuilt only when a plugin is added or removed)
  7. execute handler (Map.get - O(1) lookup)
  8. run afterHooks
  9. notify listeners: the exact bucket, then the wildcards (4.3)
 10. return CommandResult { ok, value, error }
```

`seal()` gates configuration (register, use, the hooks, respond, clear), not
dispatch. There is no disposed state. `dispose()` runs each plugin's
`dispose()`, clears state, cancels throttle timers and settles waiting
`request()`s, and the bus stays usable. On an `onMissing: 'buffer'` bus a
command with no handler is queued before step 5. So its hooks and listeners
run when it is replayed, not now.

The plugin chain is built once when plugins are added or removed. Each dispatch
creates the innermost `execute` closure and one `next` closure per plugin level.
The runners are re-entrant, so the bus's retry and deferred continuations
re-enter the chain at the right level. `buildRunner`'s PERF NOTE in
`src/command-bus.ts` records what that costs.

### 4.3 Depth, and listeners that change during a dispatch

**Depth is nesting, on both buses.** A dispatch made from inside another's
handler, hook, plugin or listener is one level deeper. The 17th level answers
`core:exceeded:depth` instead of running. A query counts on the same depth, so
a handler that queries itself stops there too.

On the sync bus the depth is a counter around the call. On the async bus it is
the depth of the dispatch whose code is running now. Each stretch of a dispatch
that calls user code (before-hooks, the runner, after-hooks, listeners) runs at
that dispatch's depth and restores the one it found. So concurrent dispatches
are each at depth 1, and a listener or after-hook that re-dispatches its own
action is stopped at 16. A loop that passes through the user's own `await` is
not followed: there is no async context to follow it by.
(`tests/command-bus-features.test.ts`, "recursion depth guard", log s35.67.)

**A dispatch calls the listeners that existed when it started.** One removed
during it, by itself, by a peer, or by `offAll()`, does not run in it. One added
during it runs from the next dispatch. This is the rule of DOM's `EventTarget`.
It is the same for `dispatch`, `emit`, the fast lane's default `'live'` mode and
`createTestBus()`. Unsubscribing marks the entry and replaces the listener
array instead of splicing the one a dispatch may be walking. So nothing a
listener does moves the loop's cursor.
(`tests/command-bus.test.ts`, `tests/fast-lane.test.ts`, log s35.67.)

**Before- and after-hooks follow the same rule**, on both buses and in
`createTestBus()`, `clear()` from a hook included.
(`tests/hook-removal-parity.test.ts`, log s35.209.)

### 4.4 Core surface (stable API)

```ts
// Two factories - same concept, different execution model
createCommandBus(options)       // sync: zero-overhead, pure pipeline
createAsyncCommandBus(options)  // async: await-able, plugins can be async

// Bus interface (BaseBus - both extend it)
dispatch(action, target, payload?)    // mutation territory - fire and get result
dispatchBatch(commands, options?)     // sequential dispatch; successCount + failCount
register(action, handler, options?)   // bind a handler; { undo?, throttle?, canUndo?, answer? }
use(plugin, options?)                 // add middleware to the pipeline; returns its remover
onBefore(hook)                        // pre-dispatch; throw to cancel
onAfter(hook)                         // post-dispatch side effects
on(pattern, listener)                 // subscribe to matching commands
once(pattern, listener)               // one-shot subscription - auto-unsubs after first match
offAll(pattern?)                      // remove all listeners for pattern, or all listeners
request(action, target, payload?, options?) // query territory - expects a responder
respond(action, handler)              // register a query responder
hasHandler(action)                    // introspect
registeredActions()                   // -> string[] of all registered actions
query(action, target, payload?)       // CQRS read-only dispatch - skips onBefore hooks
emit(event, data?)                    // domain events - no handler, no result
seal()                                // freeze configuration - rejects register/use/clear
dispose()                             // clean teardown - clears state, cancels timers, settles waiting requests
clear()                               // reset - useful for testing and HMR

// Standalone (tree-shakeable)
inspectBus(bus)                       // -> BusInspection topology snapshot
unsealBus(bus)                        // unseal a sealed bus
```

### 4.5 CQRS distinction

`dispatch` is mutation territory. `query` is read territory. It skips `onBefore` hooks
(no auth gates, no loading spinners for reads) but runs plugins, handlers, and afterHooks.
`emit` fires domain events and needs no handler. `request/respond` is the legacy
query pattern with timeout support.

**Note:** `request/respond` on the sync bus is a known inconsistency. It returns a `Promise` on
an otherwise synchronous primitive (`CommandBus.request` in `src/command-bus.ts`).
Prefer `query()` for the CQRS read path.

### 4.6 Results and errors

Every dispatch returns `{ ok, value, error }`, both slots always present (the
unused one `undefined`). One of two factories builds it, so every reader sees
one shape ([V8-RULES](./V8-RULES.md) rule 1). A handler's return value becomes
`value`. Its throw becomes `error`, unwrapped.

Every failure the library, a plugin or a transport raises is a `BusError`. Its
code is `owner:condition:subject`: who raised it, what went wrong, and what it
is about (`core:missing:handler`, `throttle:limited:handler`). The bus sets the
owner, never the raiser. `ownerOf()` and `conditionOf()` read the parts. A
backend's problem is `remote:<condition of its status>:<its code>`, inside a
2xx `{ problem }` too.

Every failure the library builds is coded. A plain `Error` passes through only
when it is someone else's: a handler's throw or the network's `TypeError`
(`tests/errors-match-catalogue.test.ts` rejects any other). The owner is the
producer's one name:

- a plugin's `id`. Every built-in plugin declares one
  (`tests/plugin-ids.test.ts`), and the bridges are `transport`.
- `core` or `remote`.
- a feature's name for a function that is not a plugin (`ssr`, `schema`,
  `directive`).

`<id>:failed:plugin` means a plugin threw or rejected (`plugin:failed:plugin`
for one without an id). That is a bug in the pipeline, which the bus does not
re-run.

The condition comes from a closed vocabulary of fourteen: `missing`,
`already`, `conflict`, `invalid`, `refused`, `unauthenticated`, `limited`,
`timeout`, `lost`, `aborted`, `exceeded`, `failed`, `unexpected`, `unknown`.
A status maps to one: 404/410 `missing`, 409/412 `conflict`, 401/419
`unauthenticated`, 403 `refused`, 429/503 `limited`, 408/504 `timeout`,
501/502/505 `unexpected`, another 5xx `failed`, another 4xx `invalid`.

Each reads 1:1 against gRPC's canonical codes, with one addition gRPC lacks.
`lost` is an outcome that may or may not have happened, re-sent only when the
command is idempotent ([plan-failures-and-contract.md](./plan-failures-and-contract.md) 4.2).
`ERROR_CODE_REGISTRY` lists every code with a fix. `getErrorEntry()` reads it
(and answers any `<id>:failed:plugin`), and so does `describeErrorCodes()`.
`tests/error-registry-sweep.test.ts` holds the registry and the code union to
each other in both directions.

### 4.7 The async bus's retry

One rule, in one place (docs/plan-shape.md 4). The async bus re-sends the call
that produced the outcome, a handler or a bridge (`transport: true`), so the
plugins outside see one dispatch. It reads the failure's condition and keeps a
per-bus budget.

- A transient failure (`limited`, a 408) is re-sent for any action.
- An uncertain one (no reply, a 502, 504 or 500) is re-sent only for an action
  declared idempotent or a keyed command.
- The `Retry-After` a failure carries sets the wait, never whether (RFC 9110
  10.2.3).
- An unidentified command that got no reply fails with
  `context.outcome: 'unknown'`, since it may have landed. Development warns once
  per action.

The bus never re-sends a verdict (`invalid`, `refused`, `missing`, `already`,
`conflict`), unless the command is identified and the answer declares a wait.
Nor does it re-send an expired session (`unauthenticated`: the app signs in,
then dispatches again). The same holds for an abort, a depth bound or a
plugin's own throw (`tests/retry-policy.test.ts`, `tests/wire-contract.test.ts`,
`tests/retry-unidentified.test.ts`). `createAsyncCommandBus({ retry: false })`
turns it off.

### 4.8 Design decisions

**Why two factories instead of one?**
`createCommandBus` (sync) and `createAsyncCommandBus` (async) are different execution models,
not different feature sets. The sync bus runs as plain function calls with no Promise, for
in-process coordination. The async bus enables `await` in handlers
and plugins, necessary for HTTP and I/O. Collapsing them into one factory with an option would
reduce clarity without reducing complexity.

**Why `BaseBus`?**
Utilities (`createChamber`, `createWorkflow`, `createReaction`) operate on the bus generically.
The typed `CommandBus<M>` and `AsyncCommandBus<M>` interfaces use generic handler types that
diverge between sync and async. That forces `as any` casts in any utility that accepts both.
`BaseBus` is a structural escape hatch for framework-level utilities. Application code keeps
the fully typed interfaces.

**Why `commandKey`?**
A stable `action:target` string key enables cache invalidation integration with TanStack Query.
The throttle plugin keys by it, and so do `idempotent`, `cache`, `serialize` and
`supersede`. It is public so an app can key the same way.

**Why `onBefore`?**
Guards belong before execution, not inside plugins. A `beforeHook` that throws cancels the
dispatch cleanly without needing to wrap the entire plugin chain. Auth gates, rate-limit checks,
and loading-state management are cleaner here than as plugins.

### 4.9 DDD positioning

In Domain-Driven Design terms:
- The bus is the **application service layer**
- Handlers are **application services**
- Plugins are **cross-cutting concerns**
- Transports (HTTP, WS, SSE) are **adapters** in the hexagonal sense
- Commands in -> domain events out

---

## 5. Plugins

### 5.1 The pipeline

Plugins are middleware. They wrap every dispatch in priority order (highest first, then
registration order). This is where cross-cutting concerns live:

```ts
bus.use(logger())            // log every command
bus.use(authGuard(check))    // block unauthorized commands
bus.use(optimistic(opts))    // apply optimistic updates
createAsyncCommandBus({ retry: opts }) // the async bus's own retry (4.7), not a plugin
```

The pipeline is composable and is the same model on sync and async buses.

### 5.2 The contract, and what a plugin cannot see

A plugin is `(cmd, next, fail) => result`, with an optional `id`, `dispose`,
`actions`, `actionFilter`, `transport` and `forget` (`Plugin` and
`PluginParts` in `src/command-bus.ts`). It sees every dispatch and query its
`actions` and `actionFilter` select (both absent: all), with its result. It
may answer in place of the handler. The bus decides the selection once per
action.

Once an undo of a command lands, the bus calls `forget(cmd)` on every plugin,
whatever its selection. `cache` and `idempotent` drop the answer they kept for
it, so a redo runs.

On the async bus `next()` returns a promise. So a plugin that reads the result
does it through `onSettled`, which stays synchronous on the sync bus. `Plugin`
is generic in what `next()` returns, so reading `.ok` straight off `next()` does
not compile. `SyncPlugin` and `AsyncPlugin` are the one-bus shapes. A plugin's
failures carry its `id` as their owner, and its own throw becomes
`<id>:failed:plugin` (4.6).

A plugin cannot see registration, `seal()`, a missing handler or the other
plugins. That is why buffering for a missing handler, the naming check, and
isLoading's tracking are core or hooks. It is also why a plugin cannot validate
the pipeline it sits in.

### 5.3 Catalogue

| Plugin | Category | Purpose |
|--------|----------|---------|
| `logger` | DX | Grouped console logs for every dispatch |
| `validator` | Guards | Pre-dispatch validation with short-circuit |
| `history` | State | Undo/redo with inverse handler execution |
| `debounce` | Rate limiting | Wait for activity to stop before executing |
| `throttle` | Rate limiting | Execute immediately, block for N ms. On block refuses with `throttle:limited:handler` (`core:limited:handler` for `register(..., { throttle })`), `retryIn` in `error.context`. |
| `authGuard` | Guards | Block protected actions when unauthenticated |
| `optimistic` | UX | Apply state immediately, rollback on failure |
| `optimisticUndo` | UX | Auto-rollback through registered undo handlers on dispatch failure |
| `cache` | Performance | LRU query result caching with TTL and glob filter |
| `circuitBreaker` | Resilience | Per-action closed/open/half-open circuit states. While open, refuses with `circuitBreaker:limited:action` and `retryIn`, the time left until half-open. A backend's failure counts, a plugin's own throw does not. |
| `rateLimit` | Rate limiting | Per-action sliding window rate limiter. Refuses the excess with `rateLimit:limited:action` and `retryIn`, the time until a slot frees. |
| `metrics` | Observability | Lightweight telemetry: count, duration, errorRate per action |
| `serialize` | Concurrency | Per-key sequential processing of async commands - prevents same-key read-modify-write races |
| `idempotent` | Exactly-once | Collapses duplicate commands (double-submit/retry/reconnect). Stamps an `Idempotency-Key` the HTTP bridge forwards to the backend |
| `schemaValidator` | Guards | Auto-validates field types against schema (auto-installed in schema bus) |
| `persist` | Storage | Auto-save state to localStorage/sessionStorage, IndexedDB (`indexedDbStorage()`, read with `hydrate()`) or custom, validate on load. `actions` scopes it like other plugins. It needs `getState`: without it `persist()` throws a `TypeError` at setup |
| `createChannel` | Multi-context | Mirror emitted facts to every other same-origin context through BroadcastChannel. Not a bus plugin: it takes a fast lane, not the bus |
| `supersede` | Concurrency | Aborts the in-flight dispatch of the same key when a newer one arrives. Async bus only: it mutates `cmd.signal` |
| `schemaLogger` | DX | `logger` plus the schema's descriptions and a per-field validation mark |
| `validateSchemas` / `validateSchemasAsync` | Guards | Standard Schema validation, from `vapor-chamber/standard-schema` |
| `createSSRPlugin` | SSR | Records dispatched commands on the server, then `.dehydrate()` for the HTML payload |
| `revalidateRoutes` | Router | Refetches the route's loaders after matching dispatches, with an `isRevalidating` flag. From `vapor-chamber/router` |
| `createHttpBridge` | Transport | Fetch-based HTTP transport |
| `createBatchingHttpBridge` | Transport | Same options, but every command in the window goes as one POST, matched back by id. The bus re-sends per command: a transient one joins the next batch, a verdict settles |
| `createWsBridge` | Transport | WebSocket transport with reconnect + bounded queue |
| `createSseBridge` | Transport | Server-sent events (server push) |
| `createEchoBridge` | Transport | Laravel Echo / Reverb: public, private and presence channels routed to the bus, plus presence membership |

Retry is not in the catalogue: it is the async bus's own (4.7), configured on
the bus.

```ts
// retry - the async bus's own. Declare where running twice is safe; a
// transient failure is re-sent for any action, an uncertain one only here.
const apiBus = createAsyncCommandBus({
  retry: { maxAttempts: 3, actionPolicies: { 'api*': 'idempotent', apiCharge: false } },
})

// persist - with shape validation to reject stale state after deploys
const cartPersist = persist({
  key: 'vc:cart',
  getState: () => cartState.value,
  validate: (state) => Array.isArray(state.items) && typeof state.total === 'number',
})
bus.use(cartPersist)
const saved = cartPersist.load()   // -> T | null (null if validate returns false)
cartPersist.save()                 // force save (e.g. beforeunload)
cartPersist.clear()                // remove (e.g. logout)

// createChannel - a BroadcastChannel. A FACT crosses, not a command: the
// receiving tab applies what this one computed instead of re-running the
// handler, so a non-deterministic handler still mirrors. Not a bus plugin.
const lane = createFastLane()
lane.on('cartChanged', fact => applyToCart(fact))   // local AND remote land here
bus.register('cartAdd', cmd => { lane.emit('cartChanged', computeCart(cmd.target)) })
const tabSync = createChannel({ channel: 'vc:app', lane, events: ['cartChanged'] })
tabSync.dispose()
```

---

## 6. Transports and the HTTP client

### 6.1 Transport bridges

```ts
// HTTP fetch - CSRF, timeout, action filter, scope-aware abort; the bus re-sends (4.7)
const ctrl = new AbortController()
onScopeDispose(() => ctrl.abort())  // Vapor lifecycle: cancel in-flight on dispose

bus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  timeout: 15_000,
  actions: ['cart*', 'order*'],
  scopeController: ctrl,                     // all requests cancelled on dispose
}))

// WebSocket - reconnect, bounded queue, reactive connection signal
const ws = createWsBridge({
  url: 'wss://api.example.com/vc',
  timeout: 10_000,
  maxQueueSize: 100,
})
bus.use(ws)
ws.connect()
ws.connected.value  // -> reactive Signal<boolean>, bindable in templates

// SSE - server push; accepts BaseBus (sync or async)
bus.use(createSseBridge({ url: '/api/vc/stream' }))
```

`createHttpBridge` is an async plugin, so it belongs on a
`createAsyncCommandBus()`. On a sync bus every dispatch returns a promise where
a result is expected. A command the bridge does not match (`actions`) stays
local. In an Inertia app `csrf: true` reads the `XSRF-TOKEN` cookie (9.3).

**Batched commands read like single ones.** With `createBatchingHttpBridge`
every command in the window shares one POST. A command the backend fails INSIDE
the batch arrives in a 200 as `{ id, problem }`. Its problem carries the status
the backend computed for that command. The client reads the failure's condition
from it through the same status table as a single response (the wire contract,
docs/plan-failures-and-contract.md 4.4). So a batched 503 is `limited` and a
batched 422 is `invalid`, exactly as they would be alone. The bus re-sends just
the transient ones, each joining the next batch:

```ts
bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', csrf: true }))
```

### 6.2 The HTTP client

`createHttpBridge` sends through `postCommand`, which is also exported for direct use:

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
- Multi-source CSRF: meta tag -> `XSRF-TOKEN` cookie -> hidden `_token` input, with a 5-minute TTL cache
- **419 = CSRF expiry**: fetches `csrfCookieUrl` to refresh and retries once. Concurrent 419s coalesce
- **401 = session expiry**: fires `onSessionExpired` and dispatches a `session-expired` CustomEvent. 419 does NOT
- A failure is the core's `BusError`, the same one a bridge returns. An answer is `remote:<condition>:<code>` (the body's `code`, `problemOf` for its problem). The rest are `transport:timeout:reply`, `transport:lost:reply`, `transport:aborted:request`
- A declared wait sets when to re-send, never whether. It is `Retry-After` (RFC 9110, read by its grammar, digits or an HTTP-date). Else the `RateLimit` field's `t` seconds for a policy with `r=0` (draft-ietf-httpapi-ratelimit-headers-11). Else `X-RateLimit-Reset`
- Jittered exponential backoff (avoids thundering herd)
- `AbortSignal.any` with manual fallback for older environments
- Retried by the bus's one rule. A transient failure (408, 429, 503) is re-sent for any request. An uncertain one, or an answer with a declared wait, only for an idempotent method or an `Idempotency-Key`. An abort never. An unidentified request with no reply, a 502 or a 504 fails with `context.outcome: 'unknown'`

`createHttpClient` is the full client on the same machinery: GET, POST, PUT,
PATCH, DELETE, interceptors, caching, dedupe, `safe` mode, download. Three
exported rules decide what happens to a failure:

- `isRetryableStatus`: may the client send it again? 408, 429 and every 5xx.
- `failureCondition`: what went wrong, by contract? The async bus's retry and
  the outbox judge by it.
- `classifyError`: may a cached response stand in for it?

A failure is the core's `BusError`, the one a bridge returns. `problemOf` reads
an answered one's RFC 9457 problem (`status`, `code`, `detail`, `errors`).

**Caching and dedupe, GET only.** A successful write (`post`, `put`, `patch`,
`delete`) drops the cached entry for its URL, as RFC 9111 asks. It also drops
the `Location` and `Content-Location` its answer names on the same origin
(`tests/http-location-invalidation.test.ts`).

`invalidateCache(pattern)` and `clearCache()` also cover a read already on the
wire. It answers its callers but is not stored. A read made after the
invalidation fetches again instead of joining it
(`tests/http-cache-writes.test.ts`).

A GET that joins one already in flight for the same URL shares its outcome,
never its abort. Each caller's own `signal` rejects only its own promise. The
shared fetch is cancelled only when every holder has aborted
(`tests/http-dedupe-signal.test.ts`). The cache and the dedupe map belong to
one client, which is why server rendering needs a client per request (12.2).

---

## 7. Vue integration

### 7.1 Signals: Vue 3.6's reactivity, wired shallow

Vue 3.6 replaces Proxy-based reactivity with [alien-signals](https://github.com/stackblitz/alien-signals).
The public API is unchanged: `ref()`, `computed()`, `watch()` work identically. A `ref()`
holding a **primitive** IS a signal now, not a Proxy wrapper around one. A `ref()` holding an
**object or array** is still a signal *wrapping a deep reactive Proxy* (`toReactive()`). The
rewrite changed dependency tracking, not object wrapping.

| Aspect | Proxy-based (Vue 3.0-3.5) | Alien-signals (Vue 3.6+) |
|--------|--------------------------|--------------------------|
| Tracking mechanism | Proxy `get`/`set` traps | Signal dependency graph |
| Granularity | Property-level on objects | Value-level on primitives |
| Memory overhead | Proxy + handler per reactive object | Lightweight signal node |
| Update propagation | Full component re-evaluation | Only affected signal consumers |

Vue reports the gains that came with it (reference 2):

- about 14% less memory for reactive state
- about 40% less CPU on complex visualizations
- about 100k components mounted in about 100 ms
- Vapor-only bundles under 10 KB

Those are Vue's figures, not measured here.

The library wires `signal()` to **`shallowRef()`**, not `ref()`. `ref(0)` is a pure signal.
But `ref([])` is a signal *plus* a deep Proxy, and every read or spread of that value pays
Proxy-trap cost. The "value-level granularity" in the table holds **for primitives only**.

The library never mutates a signal's value in place. It replaces it wholesale
(`state.value = handler(...)`, `errors.value = [...]`, `past.value = [...]`). That is
precisely the pattern where shallow tracking is semantically identical to deep tracking. So
`shallowRef` is correct here and skips the deep-Proxy tax.

It was measured on the real `useCommandState` dispatch path, interleaved,
`shallowRef` against `ref()`. Array-state dispatch ran about 3.4x faster, scalar
about 1.2x (`tests/signal-shallow-ab.test.ts`, its table printed by
`npm run test:timing`, and [performance.md, finding 5](./performance.md#reactive-runtime-notes-vue-36)).
The regression guard is the assertion that `signal()` stays a `shallowRef`
(`chamber.test.ts`). Direct nested mutation of a returned state
(`state.value.x = y`) would bypass the command bus regardless. This library
treats that as an anti-pattern, so nothing of value is lost by tracking
shallowly.

Sometimes deep reactivity *is* wanted deliberately: a state object two-way bound with
`v-model` whose nested fields you mutate in place. For that, the `vapor-chamber/reactive`
companion module exports `useDeepCommandState()` and `deepSignal()`. They share the exact
dispatch/coalesce/cleanup core with `useCommandState`. They differ only in the signal factory
(deep `ref()` vs shallow `shallowRef()`), and ship in a separate tree-shakable chunk so the
default install stays lean.

### 7.2 Which entry to import from

The bus (`createCommandBus`, `getCommandBus`, plugins, transports) comes from
the package root: it works with no Vue in the tree. The composables come from a
static entry that hands Vue to the library at build time:

- **`vapor-chamber/vue`** in a Vue app. The root can only look for Vue at
  runtime, through a bare `import('vue')`. That resolves under a dev server and
  fails in a production bundle. Composables imported from the root then get
  plain `{ value }` state (no reactivity), arm no automatic cleanup and skip
  the KeepAlive guard (`tests/root-only-prod-fixture.test.ts`). The library
  warns once, in production too, when it sees Vue running with nothing wired.
- **`vapor-chamber/vapor`** on Vue 3.6, when the app calls the library's Vapor
  API (`createVaporChamberApp` or a `defineVapor*` component wrapper). A Vapor
  app that uses only Vue's own Vapor APIs takes `/vue`. It is a superset of `/vue`
  that also wires `createVaporApp`, `defineVaporComponent` and
  `defineVaporAsyncComponent` statically. That costs +<!-- vc:sizeVaporEntryRaw -->4.5<!-- /vc:sizeVaporEntryRaw --> KB raw over hand-wiring
  `createVaporApp` (BUNDLE-SIZES' Vapor wiring table). It leaves out
  `defineVaporCustomElement` (+<!-- vc:sizeVaporCustomElementRaw -->6.8<!-- /vc:sizeVaporCustomElementRaw --> KB raw) and `vaporInteropPlugin`
  (+<!-- vc:sizeVaporInteropRaw -->89.4<!-- /vc:sizeVaporInteropRaw --> KB raw), since a static import is retained whether the app
  calls it or not. `configureVue({ ... })` adds either, and merges with what the
  entry wired.
- **`vaporChamberWire()`**, a Vite plugin, makes the root import correct
  instead. In a build it resolves the bare `vapor-chamber` specifier to the
  root plus a side-effect import of `/vue` (or `/vapor`). It also defines
  `__VC_WIRED_BUILD__`, which removes the root's runtime lookup from the
  bundle. In dev it only defines `__VC_WIRED__` (`tests/vite-wire-plugin.test.ts`).
  On esbuild or webpack an app imports from the subpath and adds
  `define: { __VC_WIRED_BUILD__: 'true' }` (`tests/root-probe-builds.test.ts`).

Every composable runs its dispatch through `untracked()`, so a handler's reads
never become dependencies of the effect that dispatched. A raw
`bus.dispatch()` inside an effect does not, and is the documented boundary:
wrap it in `untracked()` from `vapor-chamber/vue`.

### 7.3 The build profile

A trade of speed against memory sits behind one build-time switch, never a
flag per feature. `vaporChamberWire({ profile: 'lean' })` trades speed for
memory. The default, `'performance'`, trades memory for speed.

The plugin defines `__VC_LEAN__` for every profile (`'false'` for performance)
unless the app defines it. So the choice folds out of the build and costs
nothing per call. The IIFE builds are performance, and an esbuild or webpack app
defines it in one line.

The first trade concerns a key `isLoading()` has never read. In performance it
keeps its slot when it settles, while its action holds 256 or fewer, so its next
dispatch allocates nothing. Lean drops it at once
(`tests/isloading-profile.test.ts`, and section 14.4 has the numbers).

### 7.4 Vapor mode: the VDOM-less path

Under Vapor mode, the compiler generates imperative DOM code instead of a render function:

```js
// VDOM: creates virtual nodes, diffs on every update
// Vapor: direct DOM binding, no diffing

const text = document.createTextNode('')
effect(() => { text.textContent = count.value }) // alien-signal subscription
```

For Vapor Chamber, this means `dispatch -> state -> signal -> DOM node` with no intermediate
VDOM layer. The command bus handles `dispatch -> state`, and alien-signals handles `state -> DOM`.

```ts
// Pure Vapor app: no vDOM runtime. The static entry wires Vue at build time;
// the root's runtime lookup cannot resolve in a production bundle.
import { createVaporChamberApp } from 'vapor-chamber/vapor'
createVaporChamberApp(App).mount('#app')

// Mixed VDOM/Vapor tree (gradual migration). Take the plugin from `vue`:
// getVaporInteropPlugin() returns it only once configureVue() was handed it.
import { vaporInteropPlugin } from 'vue'
app.use(vaporInteropPlugin)
```

A pure Vapor app does not carry the vDOM interop renderer a mixed tree
installs. That renderer is +<!-- vc:sizeVaporInteropRaw -->89.4<!-- /vc:sizeVaporInteropRaw --> KB raw on a Vue-bundled build
(BUNDLE-SIZES' Vapor wiring table).

### 7.5 Lifecycle cleanup

Composables use `onScopeDispose` (Vue 3.5+), never `onUnmounted`, and gate on
`hasInjectionContext()`, never `getCurrentInstance()`.

**`getCurrentInstance()` returns `null` inside a Vapor `setup()`.** It reads
VDOM's `currentInstance`, and a Vapor component is not stored there, by design
(a Vue core maintainer's statement, appendix B, rc.5). Any composable that gates
on it silently does nothing in a `<script setup vapor>` block.
`hasInjectionContext()` answers correctly in **both** modes, with
`getCurrentScope()` for cleanup.

`onUnmounted()` itself does fire in Vapor. In a real `defineVaporComponent`,
`onMounted`, `onBeforeUnmount`, `onScopeDispose` and `onUnmounted` all fire, in
that order. `onScopeDispose` is the choice because it is the one hook that
works in component `setup()`, a bare `effectScope()`, Vapor and SSR alike. That
is why Vue's own composables use it.

How the library handles it:
- `tryAutoCleanup()` registers with `onScopeDispose` only.
- In development a console warning fires when no scope is found at all. The composable ran
  outside `setup()`/`effectScope()`, so its cleanup will not run automatically.
- `useCommand()` and `defineVaporCommand()` use no `getCurrentInstance()`.
  `tests/vapor-composables-fixture.test.ts` pins every public composable running
  inside a real mounted Vapor app, including that unmount really disposes.

### 7.6 Composables

```ts
// Single command composable - reactive state + register + on + emit + auto-cleanup, Vapor-safe
const { dispatch, register, on, emit, loading, lastError, dispose } = useCommand()
register('cartAdd', (cmd) => addToCart(cmd.target))
on('cart*', (cmd, result) => console.log('Cart event:', cmd.action))

// Zero-overhead hot path - no signals, no alien-signals graph nodes
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

// Namespace isolation - all calls prefixed in camelCase
const cart = useCommandGroup('cart')
cart.dispatch('add', product)      // -> 'cartAdd'
cart.register('remove', handler)   // registers 'cartRemove'
cart.on('*', listener)             // listens to 'cart*'

// Error boundary
const { latestError, errors, clearErrors } = useCommandError({
  filter: (cmd) => cmd.action.startsWith('payment'),
})

// Shared across every caller on the bus; isLoading is per (action, target)
const { isAnyLoading, isLoading } = useSharedCommandState()
const restarting = isLoading('svcRestart', 'httpd')   // true only while that key is in flight

// Direct bus access
const bus = getCommandBus()
```

Shapes, not signatures. Several of these return more than the destructure
shows. `useCommandHistory` also gives `clear` and `dispose`, `useCommandError`
a `dispose`, and `useSharedCommandState` the shared `inFlight`, `lastError` and
`errors` beside the two above. [`docs/api/`](./api/) is generated from source
and is the complete list.

| Composable | Signals created | Use case |
|------------|-----------------|----------|
| `useCommand()` | `loading`, `lastError` | UI-bound dispatch + register/on/emit - Vapor-safe |
| `defineVaporCommand()` | None | Fire-and-forget (analytics, scroll, search) |
| `getCommandBus()` | None | Direct bus access, no state tracking |
| `useCommandGroup()` | None | Feature namespace isolation |
| `useCommandError()` | `errors`, `latestError` | Component-scoped error display |
| `useSharedCommandState()` | One shared set per bus, plus one per `isLoading()` key | Global spinners and error lists, and per-(action, target) loading |
| `useCommandState()` | `state` | Reducer-based reactive state |
| `useCommandHistory()` | `past`, `future`, `canUndo`, `canRedo` | Undo/redo UI |
| `useCommandQuery()` | `data`, `loading`, `lastError` | CQRS read-side (skips onBefore) |
| `useTransitionCommand()` | `phase` | `<Transition>` hook -> bus dispatch |

`useCommand()` never calls `getCurrentInstance()`, so it is safe in both Vapor
and vDOM components, and cleanup runs automatically on scope disposal. Fewer
signals is less memory: 3.6's alien-signals node is lighter than 3.5's Proxy
plus its dep, and `defineVaporCommand()` creates none. That direction is the
claim. No heap is measured here.

`isLoading(action, target)` is keyed like `commandKey`, bus-wide (any dispatch
counts). Each key is its own signal, written only when its count crosses 0 and
1. So a reader re-runs on its key's transitions and no other's. It works on a
sealed bus, and a key in flight when the last holder leaves reads lit for the
next one (`tests/shared-state-handover.test.ts`).

### 7.7 Directives

```ts
import { createDirectivePlugin } from 'vapor-chamber/directives'
app.use(createDirectivePlugin())
```

```html
<button v-vc-command="'cartAdd'"
        v-vc-payload="{ id: product.id, qty: 1 }">
  Add to cart
</button>
```

While the dispatch is in flight the directive adds `vc-loading`. On a button it
also adds `aria-disabled`, never `disabled`, which sends keyboard focus to
`<body>`. A press while it is in flight, or on a disabled or `aria-disabled`
element, dispatches nothing. On failure it adds `vc-error` and announces the
failure's message through the document's shared live region, leaving focus
where it is (`src/directives.ts`).

Modifiers: `.stop` `.prevent` `.self` `.left` `.middle` `.right` `.capture` `.once` `.passive`
and `.<number>` (dispatch timeout in ms). `.delegate` opts a `v-for`'d list into
one shared document listener instead of one per element. That is a memory
trade, about 1.3x slower to mount and unmount (`tests/perf.bench.ts`). It is
incompatible with `.capture`/`.once`/`.passive`. Combined with one, it falls
back to a direct listener with a dev warning.

**In Vapor components** the same three directives are `vcCommandVapor`,
`vcPayloadVapor` and `vcOptimisticVapor`, in the function shape Vapor
directives take. Vue resolves an SFC directive by camelCasing the full name. So
the imports alias as `vVcCommand`, `vVcPayload` and `vVcOptimistic`. A shorter
alias compiles and mounts nothing:

```vue
<script setup vapor>
import { vcCommandVapor as vVcCommand, vcPayloadVapor as vVcPayload } from 'vapor-chamber/directives'
</script>
<template>
  <button v-vc-command.stop="'cartAdd'" v-vc-payload="{ id: 1 }">Add</button>
</template>
```

or app-wide, `createVaporApp(App).directive('vc-command', vcCommandVapor)`.
The two renderers want different shapes under one name:

```
VDOM    { mounted(el, binding), updated(el, binding), beforeUnmount(el) }
Vapor   (el, value, argument, modifiers) => cleanup | void
```

Vapor calls the function once per element inside a detached `EffectScope`. It
registers a returned function through `onScopeDispose`, and has **no `updated`
hook**: the value arrives as a getter (`tests/vapor-directives-fixture.test.ts`).
So the Vapor directives read their bindings at dispatch time. A changed binding
re-targets the next click without the directive re-running. On both renderers
a binding beats `data-vc-payload`, and `v-vc-payload` / `v-vc-optimistic` may
be written before or after `v-vc-command` (`tests/directives-vapor-fixture.test.ts`).

`createDirectivePlugin()` registers vDOM object directives, which a Vapor
template skips. So installed on a Vapor app it does nothing, and in DEV it says
so: "On a Vapor app use vcCommandVapor."

**Known limit:** do not put `:class` or `:aria-disabled` on the same element as
`v-vc-command` unless that element is a component root. The directive writes
both directly, and Vue diffs a binding against its own previous value. So the
binding's next update overwrites them, and the control stops showing that it is
working. That was measured on both renderers (appendix B, rc.9 and rc.10,
"Still watching"). A static `class="..."` is fine.

### 7.8 Vite plugins, and Rolldown

```ts
import { vaporChamberHMR } from 'vapor-chamber/vite'
export default defineConfig({ plugins: [vue(), vaporChamberHMR()] })
```

Bus handlers and registered state survive Vite hot module replacement. The
transform takes scripts only (`.ts`, `.js`, `.tsx`, `.jsx`). The shim reaches
the module graph through the entry script, and its virtual module is a
singleton, so one import anywhere is the whole mechanism. An `index.html` that
Vite itself serves gets the shim regardless, injected ahead of the app's own
module script. What stays uncovered is an app served from a backend template
whose entry script never names the package. `vaporChamberWire()` (7.2) and the
build profile (7.3) are the same subpath's build-time plugin.

Dynamic imports of optional peer dependencies use `/* @vite-ignore */`, so that
Rolldown (Vite 8's bundler) does not treat them as needed:

```ts
const vuePkg = 'vue'
import(/* @vite-ignore */ vuePkg)  // optional peer dep - must not fail build
```

---

## 8. Router, store, and the composed Vapor surface

### 8.1 The router

`vapor-chamber/router` is a router for Vue 3.6 over one thin server catch-all
(`/admin/{any?}` -> shell -> one island). **Path = navigation, query = state.**
Route tables and loaders arrive as data rather than a hand-written config
module. The split with the bus is deliberate: **the bus owns writes
(commands), the router owns reads (URL-addressed data)**.

A path change resolves, runs guards, loads components and loaders in parallel
and commits one frozen snapshot. So a page never renders with the previous
page's data. A query or hash change takes a fast path with no matching, no
guards and no remount, refetching only the loaders whose keys changed.

The core subpath binds no vDOM API, and each outlet is a subpath of its own. A
pure-Vapor app renders routes through `vapor-chamber/router/vapor`, built from
Vapor's own helpers, and needs no `vaporInteropPlugin`. Its startup chunk is
<!-- vc:outletSaving -->22.06<!-- /vc:outletSaving --> KB brotli smaller than the same app through the vDOM outlet
plus interop (`tests/vapor/vapor-outlet-size.test.ts`). A non-Vapor route
component throws a coded `router:invalid:component` there rather than silently
re-installing interop, and blade rows still need the vDOM outlet. The full
guide is [docs/router.md](./router.md).

### 8.2 The composed surface: store x router x outlet

The three experimental subpaths compose into a path with no vDOM anywhere on it.
Each closes one hole in the `dispatch -> state -> signal -> DOM` story of
section 7.4. Rendering a route used to restore the vDOM renderer, and app state
had no first-party home here.

```
command dispatch --> store (signals) -------> renderEffect --> DOM
navigation ---> frozen RouteSnapshot ---> Vapor outlet ------> DOM
         \--------- the bus coordinates both -------------/
```

What a full-Vapor consumer wires:

```ts
import { createCommandBus } from 'vapor-chamber';
import { createVaporChamberApp } from 'vapor-chamber/vapor';   // static wiring, no probe
import { createRouter, revalidateRoutes } from 'vapor-chamber/router';
import { RouterOutlet } from 'vapor-chamber/router/vapor';     // no interop
import { defineChamberStore } from 'vapor-chamber/store';      // actions are commands

const router = createRouter({ routes, components });
const bus = createCommandBus();
bus.use(revalidateRoutes(router, loaders, MAP));
const useCart = defineChamberStore('cart', { state, reducers });
const cart = useCart(bus);

createVaporChamberApp(App).use(router).mount('#app');
```

Every import reaches Vue statically. So there is no `vaporInteropPlugin`, no
`configureVue()` call and no wiring list to forget. The production-only failure
of a runtime Vue lookup (7.2) cannot occur on this path.

**One reactivity discipline underneath.** Shallow signals, wholesale
replacement, frozen snapshots, on every path:

- The router commits one frozen `RouteSnapshot` per navigation, and an outlet
  reads `render[depth]`: one shallowRef read, one array index.
- The store keeps state as one shallow ref swapped wholesale, measured at about
  3.4x faster than deep refs on array-state dispatch (7.1).
- The Vapor outlet turns a navigation into a keyless `DynamicFragment` update.
  Reuse follows resolved-component identity. The same record resolves to the
  same component and the update no-ops: reuse rather than remount on
  param-only navigations.

That deletes work structurally rather than optimizing it. Pinia's `$subscribe`
is a `deep: true` watcher with pause/resume choreography so `$patch` can emit
once, which is the price of making deep mutation observable. Wholesale
replacement gets atomic single-trigger updates with no deep watcher at all, and
the render side has no diff to skip. The composed stack has zero deep
watchers and zero reconciliation by construction.

**Which state lives where is a partition, not a convention.** Each kind has one
home. The wiring exists to keep it that way rather than to synchronize copies:

| state kind | single home | reached through |
| --- | --- | --- |
| URL-worthy (filters, page, sort) | the router query | a store `url` field, which delegates |
| route-scoped (loader results) | `snapshot.data`, committed with the navigation | a `computed` over `currentRoute` |
| app or session (cart, auth, prefs) | a store, mutated only by commands | store actions |
| ephemeral component state | component signals | `signal()` / refs |

Independence holds throughout. Every subpath ships without the others, and the
partition holds at every intermediate state, including an app that adopts none
of them.

---

## 9. Integration patterns

### 9.1 With Pinia

Pinia owns state. vapor-chamber dispatches commands that mutate Pinia stores. No direct
coupling: handlers import stores and call them.

This pattern remains correct for an app already on Pinia.
`vapor-chamber/store` is the alternative, not the replacement. Section 8 and the
positioning table in 2.2 say when each is the right answer.

```ts
const cartChamber = createChamber('cart', {
  add:    (cmd) => cartStore.add(cmd.payload),
  remove: (cmd) => cartStore.remove(cmd.target.id),
  clear:  ()    => cartStore.clear(),
});
cartChamber.install(bus);
```

### 9.2 With TanStack Query

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
does not move the line: TanStack Query still owns *app* reads. The router owns
**URL-addressed** reads: the ones its own `load` column declares, which commit
atomically with the navigation snapshot. Those reads go through the HTTP
client's fresh/stale windows rather than bypassing the cache engine directly
beneath them. Nothing else in the app should read through that path.

This is also why a `useSWRV`-shaped read composable was evaluated and declined
rather than adopted. [Kong/swrv](https://github.com/kong/swrv) is a smaller
TanStack Query, so adopting it would re-litigate a settled boundary. Its cache
is also *weaker* than `http-cache.ts`: no stale window, no serve-stale-on-error,
no pattern invalidation. Its `REF_CACHE` would be a second source of truth
alongside the frozen snapshot, which is already the shared read state.

### 9.3 With Inertia 3

Inertia handles routing and page props. vapor-chamber handles in-page actions. They do not
overlap: commands go to a separate Laravel endpoint outside Inertia middleware.

Three integration points:
1. **CSRF** - set `csrf: true` on the HTTP bridge. With no meta tag it reads the `XSRF-TOKEN` cookie Laravel sets. The bridge makes its own requests, which no Axios interceptor touches
2. **Auth redirects** - set `onRedirect: (url) => router.visit(url)` to hand a backend `{ redirect: '/path' }` body field to Inertia. Not a 302: `fetch` follows redirects itself, so the bridge only ever sees the final response. The backend has to say so in the body
3. **Page prop refresh** - after a command succeeds, call `router.reload({ only: ['flash'] })` to pull fresh props

```ts
const { dispatch } = useCommand()
const result = await dispatch('orderCancel', { id })
if (result.ok) router.visit('/orders')  // Inertia router
```

### 9.4 With XState

XState owns workflow orchestration. vapor-chamber executes what XState decides. The integration
point is the XState `invoke` service:

```ts
invoke: {
  src: () => bus.dispatch('checkoutProcess', cart),
  onDone: 'complete',
  onError: 'failed',
}
```

### 9.5 With WebSocket-based realtime (Laravel Reverb / Echo, Centrifugo, custom servers)

The generic `createWsBridge` works with any WebSocket server that answers its
envelope. It sends commands as JSON and pairs each answer with its request by
id. A frame with no pending id is ignored, so the bridge has no hook for a
framework's own protocol.

For Laravel Reverb / Echo, `createEchoBridge` in `vapor-chamber/transports`
routes public, private and presence channels to the bus. It also tracks
presence membership. It takes your own Echo instance, so the library never
imports `laravel-echo`. For another protocol (Centrifugo subscriptions and the
like), write a plugin of your own around that protocol's client.

### 9.6 Blade + CDN (zero build)

Three IIFE variants ship under `dist/`, split by **audience / deployment shape**:

| Variant   | Audience                                                  | Brotli |
|-----------|-----------------------------------------------------------|--------|
| core      | Sprinkled JS on server-rendered pages - Blade / Rails / Django | <!-- vc:sizeIifeCore -->10.2<!-- /vc:sizeIifeCore --> KB |
| elements  | Embeddable widgets through custom elements                | <!-- vc:sizeIifeElements -->10.7<!-- /vc:sizeIifeElements --> KB |
| full      | SPAs that grew big (realtime + undo/redo + persistence)   | <!-- vc:sizeIifeFull -->14.7<!-- /vc:sizeIifeFull --> KB |

_(Generated, always-current per-export sizes: [BUNDLE-SIZES.md](./BUNDLE-SIZES.md).)_

The Blade example below uses **core** with the `connect()` one-liner, the
audience-specific helper that wires HTTP + CSRF in a single call:

```html
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/vapor-chamber-core.iife.min.js"></script>
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

Variant contents are not stable across minor versions before v2.0 (see
ROADMAP.md). ESM consumers (the `vapor-chamber` main entry) always get the
full surface.

**Vapor on a page with no bundler.** Vue ships Vapor as a **physically
separate build** (`vue.runtime-with-vapor.esm-browser.js`). The plain
`vue.esm-browser.js` that a `<script type="module">` or a bare `import('vue')`
resolves to never contains it. So `isVaporAvailable()` and
`createVaporChamberApp()` report Vapor unavailable until the with-vapor build
is handed over. A bundler reaches Vapor through `vue.runtime.esm-bundler.js`,
which re-exports `@vue/runtime-vapor`. There, import from `vapor-chamber/vapor`
(7.2). **Prefer `configureVue()`**: it is explicit, involves no globals, and
cannot be raced:

```html
<script type="module">
  import * as Vue from 'https://cdn.jsdelivr.net/npm/vue@3.6/dist/vue.runtime-with-vapor.esm-browser.prod.js';
  import { configureVue } from 'https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/index.js';
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
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/vapor-chamber.iife.min.js"></script>
```

The full or the elements variant: the core one has no Vue surface and never
reads that key (log s35.231).

**`untracked()` does not work on a page with no build step.** Vue's browser
builds do not export the tracking primitives. `@vue/reactivity`'s browser
file is a second copy of the engine, the case the paragraph below describes.
So the IIFEs leave `untracked()` out, and a composable's dispatch there does
not suspend tracking. Measured on the full IIFE and on import-map pages, with
`configureVue()` and without (log s35.231).

`window.__VUE__` is not read: it is Vue's key, and Vue writes `true` to it when
the first app is created (`tests/vue-global-detection.test.ts`). A failed
detection throws a message that names `configureVue()`. It tells three cases
apart: "no Vue here", "Vue here without the Vapor build" and "Vue here but its
namespace could not be reached".

**Do not** also load the plain `vue.esm-browser.js` elsewhere on the same
page. Each Vue dist file bundles its own independent copy of the reactivity
engine. Two different files, even both genuinely "Vue," are two disconnected
module instances with no shared effect-tracking state. Verified directly: a
`ref()` created through one build is invisible to a `watchEffect` created
through the other (a plain assignment never re-triggers it). Reactivity stops
across that boundary with no warning and no error. Load one Vue build per page.

**Backend (Laravel - no Livewire dependency):**
```php
Route::post('/vc', function (Request $request) {
    $state = match ($request->input('command')) {
        'cartAdd' => app(CartService::class)->add($request->input('target')),
        default    => abort(404),
    };
    return response()->json(['state' => $state]);
});
```

### 9.7 Laravel + Vite + SFC

```ts
// ASYNC bus: createHttpBridge is an async plugin. On a sync createCommandBus()
// every dispatch returns a Promise where a result is expected (`result.ok` is undefined).
const bus = createAsyncCommandBus()
bus.use(logger())
// The bus re-sends through the bridge what the answer declares temporary,
// invisibly to the plugins outside; no reply only for an idempotent action.
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))
setCommandBus(bus)
createApp(App).use(createDirectivePlugin()).mount('#app')
```

The retry rule is 4.7. Batching with `createBatchingHttpBridge`, and how a
batched failure reads, is 6.1. [docs/integrations/laravel.md](./integrations/laravel.md)
covers the backend side.

### 9.8 Filament panel islands

`mount()` is in the **full** variant only, not core or elements. Section 9.6
splits them, and README's variant table is the per-symbol list.

```html
<script src=".../vapor-chamber.iife.min.js"></script>
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

## 10. Utilities

These ship with the package, are first-class and tested, but do not live in `command-bus.ts`.
They use only the public `BaseBus` interface.

### 10.1 `createChamber`

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

### 10.2 `createWorkflow`

Sequential commands with automatic compensation on failure (saga pattern).

```ts
const checkout = createWorkflow([
  { action: 'cartValidate' },
  { action: 'paymentReserve', compensate: 'paymentRelease' },
  { action: 'orderCreate',    compensate: 'orderCancel' },
  { action: 'cartClear' },
]);

const result = await checkout.run(bus, { cartId, paymentInfo });
// If orderCreate fails -> paymentRelease runs automatically
```

### 10.3 `createTransitionBridge`

Wires Vue `<Transition>` hooks to bus commands. Framework-agnostic: it accepts any `BaseBus`.

```ts
const modal = createTransitionBridge({ bus, namespace: 'modal' });
// modal.onEnter dispatches 'modalEnter', etc.
// modal.phase.value -> 'idle' | 'entering' | 'leaving'
```

The composable counterpart `useTransitionCommand()` uses the shared bus and auto-cleanup:

```ts
const hooks = useTransitionCommand({ namespace: 'drawer' });
// <Transition v-bind="hooks"> - all nine hooks wired automatically.
// Add your own @enter beside it and both run (Vapor: Vue 3.6.0-rc.8+;
// vDOM's mergeProps always merged them).
```

`phase` and `dispose` are non-enumerable, so `v-bind` spreads only the nine
hooks (`tests/transition-bind-fixture.test.ts`).

### 10.4 `createReaction`

Declarative cross-chamber dispatch rules. Explicit edges between domain modules.

```ts
createReaction('cartAdd', 'inventoryCheck', {
  when: (cmd, result) => result.ok,
  map:  (cmd) => ({ itemId: cmd.payload.itemId }),   // returns the TARGET itself
}).install(bus);
```

---

## 11. Migrating from vDOM to Vapor

### Phase 1: Install vaporInteropPlugin (no code changes needed)

```ts
import { createApp, vaporInteropPlugin } from 'vue'
createApp(App).use(vaporInteropPlugin).mount('#app')
```

Existing VDOM components continue working. Vapor components can now be nested inside them.

### Phase 2: Convert hot-path components to Vapor

Identify components with frequent reactive updates (cart sidebar, filter bar, live search,
notification toasts). Change only the `<script>` tag:

```vue
<!-- Before -->
<script setup>
import { useCommand } from 'vapor-chamber/vue'
const { dispatch, loading } = useCommand()
</script>

<!-- After - only the script attribute changes -->
<script setup vapor>
import { useCommand } from 'vapor-chamber/vue'
const { dispatch, loading } = useCommand()
</script>
```

The composables come from `vapor-chamber/vue`, which wires Vue at build time. Imported from
the package root they would lose reactivity, cleanup and the KeepAlive guard in a production
bundle (`tests/root-only-prod-fixture.test.ts`).

For fire-and-forget patterns, switch to `defineVaporCommand` to avoid unnecessary signal nodes:

```vue
<script setup vapor>
import { defineVaporCommand } from 'vapor-chamber/vapor'
const { dispatch: trackScroll } = defineVaporCommand('scrollSample', (cmd) => {
  // forward to whatever metrics / telemetry sink you use
  sendMetric('scroll', { depth: cmd.target.depth })
})
</script>
```

### Phase 3: Full Vapor app (optional)

```ts
import { createVaporChamberApp } from 'vapor-chamber/vapor'
createVaporChamberApp(App).mount('#app')
// No vDOM runtime and no interop renderer (7.4)
```

Dropping `vaporInteropPlugin` drops the vDOM interop renderer, +<!-- vc:sizeVaporInteropRaw -->89.4<!-- /vc:sizeVaporInteropRaw --> KB
raw on a Vue-bundled build. Routes then render through the Vapor outlet (8.1).

---

## 12. SSR

### 12.1 The challenge

Vue Vapor's signal-based reactivity is designed for direct DOM updates. On the server there is
no DOM, so signals work as plain values. The challenge is **hydration**. Commands that ran on
the server to populate initial state need to replay on the client. Then reactive signals
reflect the same values from the start.

### 12.2 Per-request isolation: the bus **and** the HTTP client

For production SSR with concurrent requests, create a bus per request. Provide
it to that request's app. A component reads it and passes it to each
composable, and every composable takes `bus`:

```ts
import { createSSRApp, inject } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createCommandBus, useCommand } from 'vapor-chamber'

export async function handleRequest(req, res) {
  const bus = createCommandBus()
  const app = createSSRApp(App)
  app.provide('bus', bus)
  res.end(await renderToString(app))
}

// in a component's setup
const { dispatch } = useCommand({ bus: inject('bus') })
```

Pass the same bus to your handlers and to the SSR helpers (`src/ssr.ts`).
Setting the shared bus per request, `setCommandBus(bus)` then
`resetCommandBus()`, is safe only when the server renders one request at a
time. Interleaved renders lose or swap each other's dispatches. In
`tests/ssr-per-request-bus.test.ts` the slower of two renders loses its
dispatch.

**The same rule applies to `createHttpClient()`, and it is the sharper edge of
the two.** Its response cache and in-flight dedupe map live in the client's own
closure, not module scope. A fresh bus per request needs a fresh cache too.
The cache key is `responseType:fullUrl`, with **no auth, header or cookie
dimension**. So a client hoisted to module scope and shared across concurrent
renders means:

- a `cache: true` GET to an authenticated endpoint stores user A's payload
  under a key user B's identical URL hits, and
- two concurrent requests for different users collapse into one in-flight
  promise and receive the same response.

Create the client where you create the bus:

```ts
export async function handleRequest(req, res) {
  const bus = createCommandBus()
  const http = createHttpClient({ headers: { cookie: req.headers.cookie } })
  const app = createSSRApp(App)
  app.provide('bus', bus)
  // pass `http` explicitly - e.g. fetchLoaders({ http })
  res.end(await renderToString(app))
}
```

Or leave `cache` off on the server: it is opt-in per request, and a client
with no `cache` option never stores anything.

### 12.3 Dehydrate on the server, rehydrate on the client

`vapor-chamber/ssr` records the commands that ran on the server and replays
them on the client. `rehydrate()` runs above Vue's DOM hydration, after it
completes, and holds no DOM references, so Vue's hydration fixes land below it.

```ts
// server-entry.ts
import { createSSRPlugin } from 'vapor-chamber/ssr'

const ssr = createSSRPlugin()        // records successful commands; `filter` to skip some
bus.use(ssr.plugin)
// ... render app, dispatch commands ...
const html = renderToString(app)
const serialized = ssr.dehydrate()   // embed: window.__VAPOR_COMMANDS__ = JSON.stringify(serialized)
ssr.dropped()                        // commands dropped at the `maxSize` cap: check it, non-zero is a truncated record
```

```ts
// client-entry.ts
import { rehydrate } from 'vapor-chamber/ssr'

rehydrate(getCommandBus(), window.__VAPOR_COMMANDS__)
createVaporChamberApp(App).mount('#app')
```

### 12.4 Suppress side effects during hydration

```ts
let hydrating = true

bus.use((cmd, next) => {
  // ok() from 'vapor-chamber': the bus's own result shape
  if (hydrating && isSideEffect(cmd.action)) return ok(undefined)
  return next()
})

for (const cmd of commands) bus.dispatch(cmd.action, cmd.target, cmd.payload)
hydrating = false
```

### 12.5 Simpler alternative: seed signals from JSON

If your server renders state separately (e.g. through `useAsyncData`), skip the replay mechanism:

```ts
const { state } = useCommandState(
  window.__INITIAL_CART__ ?? { items: [], total: 0 },
  { 'cartAdd': (s, cmd) => ({ ...s }) }
)
```

### 12.6 SSR recommendations

| Scenario | Approach |
|----------|---------|
| Simple initial state (list of items, user profile) | Seed signals from JSON |
| State resulting from a command sequence | `createSSRPlugin()` on the server, `rehydrate()` on the client |
| Side-effectful commands (analytics, API calls) | Use `hydrating` plugin to suppress during replay |
| Multiple concurrent SSR requests | `createCommandBus()` and `createHttpClient()` per request |

---

## 13. Testing

On Vitest 5, `setupFiles: ['vapor-chamber/vitest']` tests the real bus. It gives
matchers in Vitest's spy vocabulary
(`expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 })`), a recorded
shared bus and `bus` / `asyncBus` fixtures. `vapor-chamber/vitest/pure` gives
the same helpers registering nothing. `npx vc-vitest-mcp` lets an agent run the
suite and read its coverage gaps
([docs/integrations/vitest.md](./integrations/vitest.md)).

`createTestBus()` records every dispatch instead of needing a backend, with
snapshots and time travel. Its listeners follow the real buses' rule exactly
(4.3), so a test cannot pass against behaviour production does not have.

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

// on() and once() fire listeners - same as the real bus
bus.on('cart*', (cmd, result) => console.log(cmd.action))
bus.once('checkout', (cmd) => { /* fires exactly once */ })

// Immutable snapshot - mutations don't affect bus.recorded
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

## 14. Performance and V8

What the library has settled about speed, and how it decides that a change is
faster. The rules, one line each with their evidence, are
[V8-RULES.md](./V8-RULES.md). The record with every number is
[performance.md](./performance.md) and the alignment log
(`docs/rc-alignment-log.md`, cited below by section).

### 14.1 The hot-path rules

- **One shape per read-many object.** `Command`, `CommandResult`, `CommandMeta`
  and the bus state are each built by one literal or one factory. So every
  reader's inline cache stays monomorphic. A field written later is a map
  transition (rules 1-2, pinned by `tests/v8-shapes.test.ts` with V8's own
  `%HaveSameMap`).
- **Decide a mode once.** Behaviour is chosen at factory or build time and kept
  off the hot path. Examples: the fast lane's removal mode, the build profile
  (7.3), the pairing structure isLoading picks per bus (rule 3).
- **No closure per call on a hot path**, unless a measured reason is recorded
  beside it (rule 4). **No `typeof` of an undefined global per call** (rule 6).
- **Shape rules are for read-many paths.** A write-once, serialize-once object
  stays idiomatic (rule 7), and loop-syntax micro-optimizations are left to
  TurboFan (rule 8).

### 14.2 How a speed claim is measured

A ratio printed by one process is one draw. Both arms share its heap, its GC
schedule and its tier-up timeline, however many rounds run. So a claim here
comes from `npm run ab` (`scripts/ab/`, its gates pinned by
`tests/ab-tool.test.ts`). It bundles each built `dist/` the way a consumer
ships it and runs K processes per comparison (rule 16):

- **The process is the unit.** Each process has a random load order, a timing
  loop per arm, a fixed young generation and a minor GC before every timed
  call. A full `gc()` evicted the timing loop's optimized code, so every call
  recompiled it (rule 18, log s35.48).
- **An A/A control decides validity.** The same build is compared with a copy
  of itself first. A row counts only when all of these hold:
  - its control is within 3% and centred within 1.5% of 1
  - the interval excludes 1, and the effect beats the minimum detectable effect
  - both load orders agree
  - wall time minus main-thread CPU stays under 1%

  A row that fails says "no result", and that is a result.
- **The statistic.** Each arm's 20th percentile over 40 rounds, the median
  log-ratio across processes, a bootstrap 95% interval, and an exact sign-flip
  test. That test's smallest possible p-value is 2 / 2^K, so K below 6 can
  never pass at p < 0.05 (log s35.66).
- **Two call lengths** (n and 4n), and the saving reported in ns beside the
  ratio. A ratio depends on what surrounds the change (rules 14, 16).
- **Wall time decides, process CPU is not a ratio.** Process CPU counts every
  thread. V8's GC and compiler threads add a near-constant CPU per call, equal
  in both arms, which dilutes the CPU ratio toward 1. Main-thread CPU equals
  wall within 0.5%. So it serves as the descheduling gate, not as a second
  verdict (log s35.45, s35.48).
- **A change moves only the paths that run it.** Diff the two arms, and
  attribute a movement only to a timed path that executes changed code
  (rule 12). **An isolated win is a lead.** A mixed workload and
  `npm run bench` against the previous version decide (rule 13). **A ratio
  between two libraries is a fact of one host and one Node version** (rule 15).
- **Measure light, at normal priority.** The smallest run that answers the
  question: the rows the change touches plus one control. Six full jobs with
  the user's applications demoted left a shared machine unresponsive for 20
  minutes. They also widened their own controls (log s35.63). A run under
  background QoS lands on the efficiency cores, where every control failed
  (log s35.66).

CI runs the same tool on every push to main and every pull request against it,
base against head (`perf-ab`, `npm run ab:ci`). A counted "slower" fails the
build. So does a run in which no control passed, or a workload that measured
nothing. With no base to build, the job skips and says why
(`scripts/ab/base-ok.sh`). That is the push that creates the branch, a base
a force-push dropped, or a base on another release. Across a release the pair
measures the work the fixes do, and the new release is the baseline (log
s35.203). A missing base is not a regression.

### 14.3 Findings, in ns and ratios

Each figure is a process-replicated A/B against the commit before it, on the
row that runs the changed code.

| change | result | record |
|---|---|---|
| composable dispatch without a per-call thunk | 0.915-0.934x, -2.7 to -3.9 ns | log s35.53 |
| a scoped plugin's action filter as a loop, no closure per dispatch | 0.979-0.986x, -4.6 to -6.6 ns on a four-plugin chain with a listener | log s35.53 |
| composable creation: the build-flag check moved off the per-call path | back to v1.25.0's speed (it had cost 7-9%) | log s35.44 |
| isLoading: a key's signal created only once read | 0.969-0.982x, -3.6 to -6.1 ns | log s35.53 |
| isLoading: start/settle pairing in a Map, not a WeakMap | 0.858-0.871x, -24 to -26 ns | log s35.53 |
| isLoading: slots by action, then target (no key string per dispatch) | 0.892-0.905x, -15 to -18 ns | log s35.60 |
| isLoading: unread slots kept for reuse (performance profile) | 0.849 / 0.861x, -22.0 / -21.5 ns | log s35.61, s35.63 |
| isLoading: identity-checked stack on the sync bus | 0.645x, 124.1 -> 79.9 ns | log s35.66 |
| listener fan-out: the listeners a dispatch started with | 0.964-0.974x, -0.6 to -1.4 ns | log s35.67 |
| sync `query()` depth guard (a correctness fix) | 1.054-1.056x, +1.5 to +2.4 ns, accepted | log s35.67 |

The clock behind `meta.ts` is read once per microtask turn. That moved
`bus.dispatch` from 197.7x to 140.0x a direct call on the bench (appendix B,
rc.5, and [performance.md](./performance.md#metats-is-cached-per-microtask-turn-default-behaviour-no-option)).

### 14.4 The build profile, measured

The profile's first trade (7.3) was measured on its built variant against the
commit before it. On the default profile the tracked rows read 0.849 / 0.861x
and 0.848 / 0.862x. With the lean global set, every row read "no result"
against the base, as it must (log s35.63). A positive control first confirmed
the lean copies switch the built variant: 300 unread targets keep 256 slots by
default and none with the global.

### 14.5 Still open

From [V8-RULES.md](./V8-RULES.md#open-not-yet-settled), not yet rules:

- whether the tool should report CPU at all, and in which form
- whether a young or old pairing table changes isLoading's cost
- why an idle wait before a call slowed one session and not another
- classifying a gain as the optimizer's or as less work (`--no-opt --no-maglev`)
- the bytecode budget for inlining
- where a `try` belongs
- committing "build it the way a consumer does" as a test

And one gap the tool has by construction. It times synchronous functions only,
so it does not measure the async bus's dispatch path (log s35.67).

---

## 15. Core guarantee

The core (`command-bus.ts` + `testing.ts`) will remain:
- **Zero runtime dependencies** - always
- **Framework-agnostic** - always
- **<!-- vc:sizeCore -->4.7<!-- /vc:sizeCore --> KB brotli dispatch core** - measured ([BUNDLE-SIZES.md](./BUNDLE-SIZES.md))
- **`command-bus.ts` at 100% statement, branch, function and line coverage** - measured, the [vitest.config](../vitest.config.ts) gate. No line of `src/` is excluded by a pragma. *(`testing.ts` is the test harness, excluded from coverage by design.)*

Optional layers may add dependencies. The core never will.

---

## 16. File map

```
src/
  command-bus.ts    - core sync/async bus, plugin pipeline, inspectBus, types
  failure.ts        - BusError, its code vocabulary, the status table, the retry class
  action-filter.ts  - createActionFilter: CloudEvents filter expressions over the action name
  library-names.ts  - the library's own `$` command names, kept local
  applied-remotely.ts - the commands a transport carried out, and the store states they declared
  chamber.ts        - signal probe, tryAutoCleanup, useCommand, useCommandState,
                      useCommandHistory, useCommandGroup, useCommandError,
                      useSharedCommandState
  chamber-vapor.ts  - createVaporChamberApp, getVaporInteropPlugin,
                      defineVaporCommand, useVaporAsyncCommand
  shared-bus.ts     - getCommandBus / setCommandBus / resetCommandBus, free of the Vue probe
  fast-lane.ts      - createFastLane (minimal-allocation single-handler hot dispatcher)
  signal.ts         - signal() + configureSignal (Vue shallowRef auto-detect -> plain-object fallback)
  alien-signals.ts  - alienSignalAdapter, configureAlienSignals (opt-in alien-signals backing)
  reactive.ts       - deepSignal, useDeepCommandState (deep-reactivity companion, vapor-chamber/reactive)
  observable.ts     - observe, dispatchFrom (RxJS-style observable adapter)
  plugins-core.ts   - logger, validator, history, debounce, throttle, authGuard, optimistic
  plugins-io.ts     - persist, createChannel
  plugins-extra.ts  - cache, circuitBreaker, rateLimit, metrics, serialize, idempotent, supersede
  plugins-schema.ts - validateSchemas / validateSchemasAsync
  plugins.ts        - barrel re-export of plugins-core + plugins-io
  poll-with.ts      - pollWith: a 202 Accepted followed to its end
  schema.ts         - schema bus, toTools / toAnthropicTools / toOpenAITools, schemaValidator, LlmAdapter
  form.ts           - createFormBus (validation, async validators, the server's `errors` pointers)
  http.ts           - createHttpClient, postCommand, readCsrfToken, invalidateCsrfCache
  http-cache.ts     - createResponseCache (per client: one cache and dedupe map per createHttpClient)
  http-errors.ts    - the HTTP contract: problemOf, isRetryableStatus, classifyError, ProblemDetails
  http-query.ts     - buildFullUrl (URL + query-string builder)
  transports.ts     - createHttpBridge, createBatchingHttpBridge, createWsBridge, createSseBridge, createEchoBridge
  transitions.ts    - createTransitionBridge, useTransitionCommand
  transitions/
    vapor.ts        - VcTransition, a bus-driven transition for Vapor (experimental)
  directives.ts     - createDirectivePlugin and the Vapor directives (v-vc-command, -payload, -optimistic)
  ssr.ts            - createSSRPlugin, rehydrate (dehydrate / replay)
  utilities.ts      - createChamber, createWorkflow, createReaction
  store.ts          - defineChamberStore (state whose every mutation is a command)
  store-base.ts     - the store, once, for both entries (Vue and no Vue)
  store/
    core.ts         - vapor-chamber/store/core, the same store with no Vue
  outbox.ts         - durable offline queue, replayed in order on reconnect
  idb.ts            - one IndexedDB key-value store: indexedDbStorage (persist) and the outbox's adapter
  mcp.ts            - MCP server layer: a schema action becomes an MCP tool
  stream-parser.ts  - dependency-free incremental JSON parser
  vue.ts            - the entry for apps that have Vue (wires Vue at build time)
  vapor.ts          - the entry for Vue 3.6 Vapor apps (same, plus Vapor)
  vitest.ts         - the Vitest entry, with its side effects (setup file)
  vitest-pure.ts    - the same helpers, registering nothing
  vitest-mcp.ts     - a Vitest MCP server: runTests / getTestResults / getCoverageGaps
  vite-hmr.ts       - vaporChamberHMR() and vaporChamberWire() Vite plugins
  devtools.ts       - Vue DevTools integration (dynamic import)
  dev.ts            - DEV: is this a development build, derived per module so a production build folds it
  bounds.ts         - the one rule for a numeric option (every cap a caller supplies)
  dict.ts           - prototype-free dictionaries (one rule, one place)
  freeze.ts         - dev-only deep freeze for the entries the caches share
  glyphs.ts         - every non-ASCII character the project prints (dev-facing output only)
  settled.ts        - onSettled: read a result that may be a promise, on either bus
  scheduler.ts      - lanes (serialize) and cancellable waits (the bus's retry, the outbox)
  ledger.ts         - the one undo/redo ledger behind history() and useCommandHistory()
  a11y.ts           - announce() / setAnnouncer(): status messages for assistive technology
  router/           - the router subpath (Vue 3.6 over a server-owned catch-all)
    index.ts        - createRouter and the public surface
    engine.ts       - navigation: guards, two-phase commit, query fast path
    table.ts        - rows -> compiled table (chains, query defs, matching)
    history.ts      - base-aware web + memory history
    url.ts          - the URL and query layer (query params are state)
    loaders.ts      - loader SPI; presets resolve a row's `load` string
    revalidate.ts   - revalidateRoutes: refetch loaders after matching commands
    facts.ts        - routerFacts: committed and failed navigations as facts on a bus
    composables.ts  - useRoute / useQueryParam / usePagination / useMenu / ...
    menu.ts         - menu and breadcrumb projections of the route table
    dom.ts          - link interception, data-active stamping, idle preheat
    announce.ts     - tells assistive technology the page changed
    outlet.ts       - the outlet's one render path
    vdom.ts         - RouterOutlet (vDOM), makeBladeComponent
    vapor.ts        - RouterOutlet (Vapor-native, experimental)
    blade.ts        - blade rows as ordinary components
    remote.ts       - routerHttp, bladeFetcher (opts into the http client)
    errors.ts       - the router's one error taxonomy (a snake_case `code`)
    types.ts, router-type.ts, keys.ts - public types, the Router shape, injection keys
  router-fetch/     - in-box loader preset for plain-JSON backends
  testing.ts        - createTestBus, snapshot, time-travel
  iife.ts           - CDN entry -> window.VaporChamber (full variant)
  iife-core.ts      - CDN entry, core variant
  iife-elements.ts  - CDN entry, elements variant
  index.ts          - public ESM barrel

tests/                           (<!-- vc:testFiles -->326<!-- /vc:testFiles --> files, <!-- vc:tests -->3571<!-- /vc:tests --> tests)
```

Where the current numbers live, both generated and CI-verified fresh:

| | |
|---|---|
| per-file coverage, test totals | [`docs/COVERAGE.md`](./COVERAGE.md) (`npm run coverage:doc`) |
| per-export bundle sizes | [`docs/BUNDLE-SIZES.md`](./BUNDLE-SIZES.md) (`npm run size:doc`) |
| what each release changed | [`CHANGELOG.md`](../CHANGELOG.md) |
| forward plans, the version policy, per-module status | [`ROADMAP.md`](../ROADMAP.md) |

`npx vitest run` prints the authoritative file and test counts, which is
faster than reading a list that might be wrong.

---

## 17. References and licence

1. Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and
   Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
   https://zenodo.org/records/18853783
2. Vue 3.6.0-beta.8 Release (Vapor feature-complete): https://github.com/vuejs/core/releases/tag/v3.6.0-beta.8
3. Alien Signals: https://github.com/stackblitz/alien-signals
4. Vue core, where Vapor's runtime and compiler live (`packages/runtime-vapor`,
   `packages/compiler-vapor`): https://github.com/vuejs/core
5. Vite: https://vite.dev

GNU Lesser General Public License v2.1 (LGPL-2.1)

---

*vapor-chamber is built for the Vue Vapor + Laravel stack.
The core is open for anyone building similar coordination layers.*

---

## Appendix: Notes and history

Everything below is moved here from earlier revisions of this document. It holds
the origins, the per-release Vue alignment log, and the body's records of its
own corrections. Parts A, B and D were since edited to the writing rules, their
facts unchanged. Part C quotes each passage as it stood, its non-ASCII marks
written in ASCII. Part D notes the sections removed outright. The body
above describes the library as it is and may point here. It does not repeat
what is here.

### A. Origins

#### A.1 The original header

**Version 1.0.0 - March 2026**

**Revised 2026-09-23** - first full rewrite. Until this revision the document grew
by appending: every release added its material at the bottom and nothing above it
was reread.

#### A.2 The v1.0 abstract

Vapor Chamber is a command bus built for Vue Vapor, with a <!-- vc:sizeCore -->4.7<!-- /vc:sizeCore --> KB brotli dispatch core. It gives a semantic,
middleware-aware dispatch layer that connects any frontend pattern to any backend. It imposes
no framework, no build system and no opinion about your stack. v1.0 adds
e-commerce-grade features: transactional batch dispatch with undo rollback, automatic
optimistic undo through registered handlers, schema auto-validation, and full bus introspection.

#### A.3 Why no state in the bus: the reversal for package scope (was section 6)

**Reversed for PACKAGE scope. The architectural claim above stands unchanged.**
`vapor-chamber/store` ships a state layer. That contradicts one sentence here:
that adding one would create a fourth source of truth. That sentence is about
what belongs in this package, not about the bus, and the bus still stores
nothing. A store owns its own `shallowRef`. The bus's only role is that every
mutation arrives as a dispatch. "The bus coordinates state transitions. It does
not store state." is not weakened by the store - the store is its strongest
example.

What did not survive is the competition argument, which assumed a state layer
here would duplicate Pinia. It does not. Pinia grew a mini-bus of about 60
lines inside itself (4.0.3, read 2026-10-06: `action()` 44 lines, its
`$onAction` subscriptions 15). It gives actions the observability that
plugins, undo, cross-tab sync and a devtools timeline need, because no bus
existed underneath it. Here one does, so the store is
<!-- vc:sizeStore -->2.2<!-- /vc:sizeStore --> KB rather than a competitor. It is the existing plugin
catalogue applied to state, with every capability in it already written and
tested. A fourth source of truth would be a store that rebuilds persistence,
history and sync. This one cannot, because it has none of its own.

#### A.4 The comparative analysis (was section 7)

#### 7. Comparative Analysis: What Survived

Nine rounds of analysis against established tools. Each round confirmed the stateless design
and contributed specific improvements.

| Round | Tool | What survived |
|---|---|---|
| 1 | Redux Toolkit | `createChamber` - handler grouping by namespace |
| 2 | VueUse | `useCommand` shape alignment - `{ execute, isPending, error, data }` |
| 3 | XState | `createWorkflow` - sequential saga with compensation |
| 4 | TanStack Query | CQRS naming, `commandKey` export, `optimistic` vocabulary alignment |
| 5 | DDD | Bus = app service layer, bridges = adapters (vocabulary, no code) |
| 6 | Svelte Stores | `observe(bus, pattern)` - zero-dep subscribable for non-Vue use |
| 7 | RxJS | `observe(bus, pattern)` - the `vapor-chamber/observable` subpath |
| 8 | GraphQL clients | `useCommand` shape confirmed, `useMutation` vocabulary |
| 9 | ArangoDB | `createReaction` - declarative cross-chamber dispatch rules |

**What did not survive any round:** State in the bus, cache in the bus, full state machine on
the bus, normalized entity storage. The wall held every time.

That wall still holds with `vapor-chamber/store` shipped: the store owns state,
the bus does not, and a store's actions reach it only as dispatches.

### B. The Vue 3.6 alignment log, beta.8 to rc.10 (was section 9.2)


Every Vue 3.6 release gets an alignment cycle. Read each commit at source and
run both vitest projects. Measure the reactivity primitives against the
previous release, and record the decision. This is the running log and the single source
of per-release detail. Prose elsewhere in this document stays version-agnostic.

**What each entry is for.** Not a list of what happened. A record of the train of
thought. When a later release moves the ground under a decision, you can re-run
the reasoning instead of re-deriving it. Each entry carries some or all of:

- **Expected** - what we thought the release would mean for this library before
  reading it. Recorded even when wrong, especially when wrong: a forecast that
  failed is the most useful thing in the entry.
- **Landed** - what Vue actually shipped, read at source rather than from titles.
- **Decided** - what changed here, and the measurement that justified it.
- **Alternatives rejected** - the designs that were considered and turned down,
  with the cost that decided it. This is the part that ages best. A rejected
  option with its price attached can be reopened honestly when the price changes.
  A rejected option nobody wrote down gets re-proposed every year.
- **Still watching** - known limitations, parked techniques, and measurements that
  no longer reproduce.

The standard is evidence, not assertion. A cycle that changes no code says so and
says why. Several cycles found defects in this library rather than in Vue. Those
are recorded here too, because reading a renderer diff against your own
assumptions is what surfaced them.

| release | read | verdict | tests | IIFE brotli KB |
| --- | --- | --- | --- | --- |
| beta.8 - beta.15 | titles + diffs | pass-through | - | - |
| beta.16 (Jun) | every commit | pass-through | - | - |
| beta.17 (Jun) | every commit | pass-through | 884 | 10.2 / 7.0 / 7.4 |
| rc.1 (Jul) | 13 commits | pass-through | 1102 | 10.8 / 7.6 / 8.0 |
| rc.2 (Jul) | 13 commits | pass-through, `.delegate` added here | 1259 | 10.8 / 7.5 / 8.0 |
| rc.3 (Aug) | 36 commits | pass-through, two docs claims corrected | 1491 | - |
| rc.4 (Aug 14) | 12 commits | pass-through, found an inert KeepAlive gate | 1748 + 7 | - |
| rc.5 (Aug 21) | 15 commits | pass-through, found a DOM leak and a bug class | 1786 + 7 | 11.0 / 7.6 / 8.0 |
| rc.6 (Aug 28) | 14 commits | 13 pass-through, found an HMR leak and a prod-only wiring bug | 1950 + 17 | 11.1 / 7.6 / 8.1 |
| rc.7 (Sep 4) | 50 commits | all pass-through, a src-wide read found 28 defects of ours | 2076 + 22 | 11.1 / 7.6 / 8.1 |
| rc.8 (Sep 11) | 25 commits | adopt / retire / copy | 2128 + 24 | 11.3 / 7.7 / 8.2 |
| rc.9 (Sep 21) | 89 commits, 16 in full | rc.9 broke a directive here, the fix reshaped it | 2431 | 12.1 / 8.2 / 8.7 |
| rc.10 (Sep 30) | 85 commits, 83 in full | no code change, rc.10 fixed a directive case we had never tested, one defect of ours and one of Vue's found | 2632 + 25 | 12.0 / 8.0 / 8.5 |

Coverage has been 100% on all four axes since rc.6. The two test numbers are the
two vitest projects. "Pass-through" means Vue's change lands below this
library's wrappers and reaches consumers without a line changing here.

#### beta.8 to beta.15: the Vapor surface settles

**beta.8** (Mar) made Vapor feature-complete. The alien-signals rewrite itself
had landed earlier, in 3.6.0-alpha.1 (#12349). Baseline Vapor surface wrapped.

**beta.9** (Mar) brought TransitionGroup to VDOM parity:

- key inheritance, dynamic `tag` updates, v-if dynamic slots
- no invalid hooks on unkeyed interop children
- leaving-cache isolated by resolved child type, null keys treated as absent

Plus:

- `<Transition>` template children and interop vnode-identity alignment
- the v-for+v-if hook fix (counterpart to beta.8's v-if+v-for)
- teleport hydration anchor fixes for null and disabled targets
- interop vnode lifecycle hooks (`onVnodeBeforeMount`) now invoked
- static-key preservation, and KeepAlive scope-leak fixes

The transition bridge forwards whatever hooks Vue fires. So the bus simply began
receiving the corrected hook set: moves it previously missed, and no longer the
bogus hooks on unkeyed interop children. No code change.

**beta.10** (Apr): async setup components hydrate under VDOM Suspense. SSR
runtime tree-shaken out of `defineVaporCustomElement`. Interop
mount/unmount/update/hydration hook order aligned with VDOM. `<Transition>`
dynamic-slot update and `appear` with slotted v-show. Duplicate dynamic-slot
names resolve last-wins. Interop slot remount and stale-effect cleanups.
`parentComponent` null-guard.

`createVaporChamberApp` and `defineVapor*` forward Vue's app and components
untouched, so the hook-order alignment and async-Suspense hydration are
inherited. SSR here is command replay above DOM hydration, so the custom-element
SSR tree-shake does not touch it. No code change.

**beta.11** (May): tree-shake axes for slot-fallback, teleport, transition,
keep-alive and suspense. Static-template hydration fast path. Dynamic-props
stability. Mirrored here as three sized IIFE variants, `core` / `elements` /
`full` (9.6).

**beta.12**: Vapor `setup()` error recovery, restoring component context,
fallthrough props and render effects after a throw. VDOM-slot interop
normalization. SSR unresolved-tag fallback. Pass-through. Lib-side this cycle,
unrelated to Vue: AbortController extensions, `useSharedCommandState`, and
TestBus snapshot / time-travel.

**beta.13** (May): `onMove` fires for Vapor and VDOM component moves in a Vapor
`<TransitionGroup>`, having been silently skipped. Moves defer until child
updates flush. Slot-fallback transition hooks. v-for key preservation. 5 SSR
hydration fixes. Interop CSS scope IDs on Vapor roots. Lazy lifecycle update
jobs. Compiler optimizations (inline `v-bind` spreads, single-use
component-resolve lowering, static-prop inlining).

Lazy lifecycle jobs make `tryAutoCleanup` and `onScopeDispose` allocation-free
when no reactive state is tracked in the scope.

**beta.14** (Jun): HMR child/parent reload alignment, parent-reload dedup,
setup-effect preservation, context restore on error, app-instance refresh on
root reload. Transitions: `onMove` suppressed for v-show-hidden children. Custom
elements: no hook retention on shared definitions, children update from reactive
props. Async: `loadingComponent` receives props and slots.
`defineVaporAsyncComponent` becomes a main `vue` export. Interop: bridge no
longer mutated on setup, slot wrappers memoised. Vapor root: scope ID preserved
on dynamic updates. Scheduler: job-queue length reset after flush. v-for: skip
updated hooks on mount, no fast-remove for component v-for, lazy destructure
defaults.

The HMR shim gained a per-cycle dedup guard and a try/catch. That was the only
new beta.14 code here. Measured gains from the scheduler flush fix:
`useCommandState` ~+24%, `effectScope` lifecycle ~+9%, transition bridge ~+8%.

**beta.15** (Jun):

- Teleport, seven fixes: invalid-target handling, disabled-target order
  preserved, mount location tracked explicitly. CSS vars by mount location, no
  target-child moves on reorder, raw props proxy reused.
- Transitions: hooks restored after a skipped move. Key inheritance and
  stability aligned with VDOM. Unique keys for multi-root v-for items, v-if
  comment handling.
- v-show: appear timing aligned with VDOM, fragment method arguments preserved.

Also: Events:
click-modifier normalization, an opt-out for event delegation (#14924),
delegated handlers skipped on disabled elements (#14948). Interop: vnode access
guarded. Keyed direct template refs cleared on replace. Perf: fragment classes
dropped from app-only bundles.

One new line of behaviour here: `v-vc:command` now bails out on disabled,
`aria-disabled` and in-flight elements. It attaches a direct, non-delegated
listener, so Vue's #14948 runtime fix does not reach it automatically. This
mirrors it. Everything else is pass-through.

#### beta.16 (Jun): fully pass-through, every commit read

Transitions (6): transition-group leave bucketed by type. Raw-key compare before
early removal. Out-in branch key kept in sync when leave defers render. Hooks
re-resolved on prop change. Leaving cache shared for unkeyed children.
`persisted` no longer leaks onto non-v-show roots.

Hydration (7): dynamic props applied on mismatch-recreated nodes. Static-template
clone-cache reused rather than re-cloned per adoption. Exact tag-mismatch
detection. Fragment-start warning text. Full-mount fallback for empty SSR
containers. Static-text mismatches patched, production included. v-if empty
branches hydrated with static templates.

App lifecycle: no-op mount for a missing selector. Unmount safe without dev
instance state in production. Props, emit, attrs and events: nullish dynamic
props become empty. Nullish emit sources skipped. Symbol attr values stringified.
Dynamic `v-bind` event options (`Once` / `Passive` / `Capture`) parsed like VDOM.
Compiler (8): setup-let inline assignment. v-html before text. Unsafe attr names
kept out of templates. Dynamic, static and native v-model modifier key quoting.
Slot v-else-without-v-if reporting. Empty blocks return `[]`. Perf: SlotFragment
skipped for stable slot fallback (#14969).

**No lib code change.** Two consumer-visible inheritances. First,
`createTransitionBridge` / `useTransitionCommand` `onLeave` now fires for a
non-v-show root removed after a v-show branch. It was previously dropped
(`a816c9e`). And `createVaporChamberApp(...).mount('#missing')` no-ops instead of
throwing, with `.unmount()` production-safe (`05bf22a` / `52fda7c`). `rehydrate()`
sits above DOM hydration, so the seven hydration fixes are below us.

**Perf technique to evaluate, post-stable.** #14969 proves slot-fallback
reachability at compile time and encodes it as a one-bit flag on the emitted
function. The runtime selects a lighter `DynamicFragment` over `SlotFragment`
when the flag is absent. That is the prove-it-at-compile-time,
pay-for-the-wrapper-only-when-unprovable pattern. It is a candidate for our own
hot paths once the Vapor-first / bus-first identity (v2.0.0) is settled.

#### beta.17 (Jun): fully pass-through, every commit read

Compiler-vapor (7): stable slot roots kept on the fast path. Non-stable slots
avoided for stable root siblings. Slot-root tracking skipped for slot outlets.
Forwarded slot-fallback validity tracked. Unsafe repeated expression replacements
avoided. And two perf items, redundant text-run slicing avoided and
child-context analysis cached.

Runtime-vapor (7): slot validity aligned for component roots. Dynamic
native-element slots hydrated correctly (#14972). VDOM-interop update hooks
paired, `beforeUpdate` / `updated` (`bcaa753`). Tracking paused when invoking
function refs (#14986). Render-effect creation order preserved on update, as a
scheduler tiebreaker behind component id (#14984). Interop slot owner root
re-synced after child updates (`975dd4d`). Redundant slot-content validity checks
avoided.

**No lib code change.** The two interop fixes land below
`getVaporInteropPlugin()`'s pass-through. So mixed Vapor/VDOM trees inherit
paired slot hooks (`bcaa753`) and the slot-owner-root re-sync (`975dd4d`) for
free. #14972 sits below `rehydrate()`'s command replay. The seven compiler-vapor
fixes are compile-time, inherited by recompiling the Vapor SFC examples.

**Pattern noted, nothing to act on.** #14984 had to add render-effect creation
order as a scheduler tiebreaker behind component id. The bus already gets that
insertion-order invariant for free, from JavaScript's stable
`Array.prototype.sort` on equal-priority plugins (`byPriority`). The
`equal priority preserves registration order` test already pins it.

#14986, pausing tracking on function refs, is **N/A**: this library uses no
template or function refs, and only writes signals from dispatch callbacks, never
reads inside a tracked effect.

**Verified against beta.17:** `tsc` clean, 884/884 tests pass, bench green on the
recorded baselines, IIFE sizes unchanged at 10.2 / 7.0 / 7.4 KB brotli.

#### rc.1 (`6fa3447`, Jul): Vue 3.6 enters RC

Vapor is feature-complete. All 13 fixes are runtime-vapor or hydration
internals:

- slot-anchor and hydration-anchor management
- v-show transition on a VDOM child (#15074), v-if/v-show on transition roots
  (#15069)
- unsafe slot dry runs removed from VDOM interop (#15089 / #15031)
- forwarded-slot and async-setup hydration

**No lib code change**, diffs read at source. The anchor, hydration and dry-run
fixes are all renderer-internal. This library collects no slot vnodes and holds
no hydration anchors, so #15089 and `06778e7` have no analog here. The two
transition fixes reach `createTransitionBridge` and `useTransitionCommand` as a
corrected hook set.

**Verified against rc.1:** `tsc` clean, 1102/1102 pass, IIFE 10.8 / 7.6 / 8.0 KB
brotli.

#### rc.2 (Jul): event delegation flips to opt-in

**Expected.** A compiler-side change to how `@click` attaches is below this
library, which registers its own listeners directly. The forecast was
pass-through, and it held. What was not forecast: reading *why* Vue flipped the
default would change our own directive. The reasoning transferred even though the
code did not.

**Landed. BREAKING in compiler-vapor (#15127).** Compiled `@click` in Vapor SFCs now
attaches a direct per-element listener unless the template writes `.delegate`
explicitly. `compilerOptions.eventDelegation` is removed entirely: the beta.15
opt-out (#14924) is gone, because there is nothing left to opt out of.

One internal compiler-vapor codegen fix (#15124): v-for loop variables no longer
collide with runtime-helper names, for example `v-for="child in items"` clashing
with the `child()` DOM helper.

The other 12 fixes are runtime-vapor internals surfaced by testing Vapor against
Nuxt. Effect-scope was not restored to "no scope" after `setCurrentInstance`.
That froze a vapor page's watchers on its first vdom-to-vapor `<Suspense>`
navigation (#15141). A vapor block's transition hooks dropped across interop mount, unmount
and move, deadlocking a vdom `<Transition mode="out-in">` wrapped around a vapor
page (#15133, #15140). A production-only crash when a vapor `setup()` throws
under `onErrorCaptured` (#15130). A missing slot anchor for interop slot content
without SSR fragment markers, for example `RouterLink` (#15131). Vapor mount and
activated hooks and post-render effects not deferred to an owning `<Suspense>`
boundary (#15139, #15144). Vapor components never hydrating when deferred past
the root hydration pass through interop, for example `hydrateOnVisible()` (#15132).
Pending-async-component placeholder position lost across Suspense and KeepAlive
(#15147). Async setup re-entry losing instance context, warning `renderEffect
called without active EffectScope` (#15129). The logical-child hydration cache
left stale after mismatch-recovery node replacement (#15145). And vdom-interop
bypassing prop validation entirely (#15111).

**Pass-through for all 13, no lib code change**, every diff read at source rather
than the titles. `createVaporChamberApp`, `getVaporInteropPlugin` and
`defineVapor*` forward Vue's own functions untouched. `rehydrate()` replays
commands above Vue's DOM hydration. `createTransitionBridge` and
`useTransitionCommand` only supply hook bodies Vue calls into. `tryAutoCleanup()`
calls the public `getCurrentScope()` / `onScopeDispose()` pair, never the internal
restore path #15141 fixed. Confirmed no example's `v-for` variable collides with
a compiler-vapor helper name, so #15124 is N/A here.

**Two real unblocks worth knowing even though no code changed.** A vdom
`<Transition mode="out-in">` around a vapor page no longer deadlocks (#15133,
#15140), which matters to anyone pairing `useTransitionCommand` with page-level
transitions, Nuxt-style. And a first vdom-to-vapor `<Suspense>` navigation no
longer kills that page's watchers (#15141). Any composable here called from such
a page's `setup()` was swept into that teardown, with no userland workaround
possible.

**Lib-side, inspired by studying #15127 rather than needed for it.**
`v-vc:command` gains its own opt-in `.delegate` modifier (`src/directives.ts`).
It is one shared document-level listener instead of one per element. It mirrors
Vue's exact opt-in trade-off: an ancestor's `.stop` can pre-empt a delegated
descendant. It also mirrors the incompatibility with `.capture` / `.once` /
`.passive`, where it dev-warns and falls back to direct.

**Measured, not assumed** (`tests/perf.bench.ts`, 5k elements): delegate mode is
**~1.3x slower to mount and unmount**, not faster. That corrects the initial
assumption, and it is the reason `.delegate` is opt-in here rather than the
default. Its real payoff is standing listener count, 1 rather than N, for large
mostly-static lists. So it is documented as a memory trade and not a speed one.
`examples/vapor-island-cart`'s 3-item product list stays plain `@click`, since
there is nothing to win at that size. A comment there explains when to reach for
`.delegate` instead.

**Alternative rejected: make `.delegate` the default**, which was the assumption
going in. The 1.3x measurement killed it. That default would be slower for the
common case and cheaper only in standing memory for large static lists. The
consumer should make that decision, not us.

**Verified against rc.2:** `tsc` clean, 1259/1259 tests pass across 71 files,
coverage 95.86 / 88.92 / 96.88 / 97.36 statements / branches / functions / lines,
all above the floors. (The floors are lines 95, functions 94, branches 86,
statements 93. That is `vitest.config.ts` declaration order, not the order the
four numbers above are printed in.) Lint clean, IIFE 10.8 / 7.5 / 8.0 KB brotli,
unchanged from rc.1 within rounding.

#### rc.3 (Aug): KeepAlive, and two of our own docs claims disproved

**Expected.** A KeepAlive-themed release touching a guard this library owns. The
forecast was pass-through plus a possible adjustment to `tryKeepAliveHooks`.
Pass-through held. The guard needed no adjustment. What the read actually
overturned was two claims in our own documentation that no test had ever
compiled. The forecast had no category for that failure mode, and it recurs
through rc.4, rc.5 and rc.9.

**Landed.** 36 commits, all read at source.

**KeepAlive is the theme** (6). Cached component props and dynamic slots are
isolated behind a commit boundary. So a cached child stops observing transient
parent values (#15251, closing #15228). Branch removal deferred until cache pruning
(#15189). Leaving cache entries unmounted from their real parent (#15190).
Updates deferred while async setup is pending (#15172). Interop entries fully
pruned at `max` (#15181). And KeepAlive scopes now paused while deactivated
(closing #15237).

**Custom directives** hardened in three places: the compiler wraps the value in
parens (#15258). Async component roots are treated as pending rather than warned
about (#15167). Fragment roots re-applied through a detached scope (#15158).

**v-show stops over-tracking** twice, in transition hooks (#15203) and in the
source inside fragment effects (#15204), both by running callbacks with tracking
disabled.

**App unmount lifecycle aligned with vDOM** (#15262): `onBeforeUnmount` ->
`onScopeDispose` -> `onUnmounted`, children before parents.

Plus:

- vDOM slot content in `<Transition>` (#15159)
- teleport target cleanup on scope disposal (#15236)
- interop prop normalization (#15254), class-prop normalization (#15227)
- functional-component root bindings
- 4 async-hydration fixes, 6 slot-fallback and hydration fixes, and 2 type-only
  fixes

**Pass-through for the runtime fixes**, no wrapper change. But the read surfaced
two things this library had wrong, both now corrected with fixtures rather than
argument.

1. **Custom directives are NOT VDOM-only.** `withVaporDirectives` is a public
   export shipping since 3.6.0-alpha.3. That was verified by unpacking published
   dists from alpha.3 to rc.3. rc.3 only hardened it. Four places in this repo asserted
   the opposite, including a runtime `console.warn`. What genuinely blocks
   `v-vc:command` is the shape, since Vapor directives are
   `(el, value, arg, mods) => cleanup` with no `updated` hook, not upstream
   policy. Fixture: `tests/vapor-directives-fixture.test.ts`.
2. **The `tryKeepAliveHooks` removal note was wrong.** `docs/router.md` said
   #15237 landing would make it double-suppression. Measured: Vue pauses
   *effects*, while that guard protects a `bus.onAfter` callback the bus invokes
   directly, which still fires under a paused scope. Guard kept, note corrected.
   Fixture: `tests/keepalive-pause-fixture.test.ts`.

**Technique logged, then applied.** #15203 and #15204 run callbacks with tracking
disabled (`setActiveSub`). The bus has the same exposure, reproduced: a
`dispatch()` from inside an effect leaks the handler's reads into the caller's
dependency set. `setActiveSub` is not on the `vue` entry, but `pauseTracking` and
`resetTracking` are exported by `@vue/reactivity`, which resolves to the same
module instance. `untracked()` is built on those, and every composable routes its
dispatch through it. Getting them at build time rather than through a runtime
probe is what `vapor-chamber/vue` exists for, see 7.2.

**Lib-side this cycle:** Vapor detection gains an owned global slot and
`configureVue()`, see 9.6.

**Verified against rc.3:** `tsc` clean, 1491/1491 tests across 92 files.

#### rc.4 (Aug 14): a KeepAlive gate that was inert in every Vapor component

**Expected.** Scope and lifecycle internals, forecast pass-through. It was, for
all 12. But rc.3 had just established that reading a diff against our own
assumptions is what finds our bugs. rc.4 proved it twice over. #15293 exposed a
guard that had never worked in Vapor. A re-reading of an old decision showed its
justifying number was wrong by a factor of fourteen.

**Landed.** 12 commits, all read at source.

**v-for item scopes reworked** (3). Every item, component-shaped included, gets
its own `EffectScope` again and is stopped on unmount. `7db1454` reverses the
beta.14-era "the component already has a scope, skip the outer one" rationale.
Component items are structurally removed before their scope stops, so item
cleanups such as template refs observe a detached node (`aac355d`). And the
`IS_COMPONENT` flag is re-documented upstream as "requires component teardown
ordering", not "owns its own scope".

**Prop-source caches re-scoped** (2). A `computed` cache created by a
parent-owned prop source is collected in the consuming scope (`22b9b41`). It is
then narrowed again to the active consumer through `getCurrentScope()`
(`e8a09b3`). So a v-for fallback that renders a plain DOM node stops
accumulating caches on the owner.

**KeepAlive input isolation moved off the branch scope** (#15293). Raw prop and
slot commit effects now live in a per-instance `inputScope` that `activate()` and
`deactivate()` resume and pause. That leaves the branch-scope pause to
branch-owned effects only. This refines the rc.3 entry's "KeepAlive scopes are paused while
deactivated", which described a mechanism Vue no longer uses on this path.

Plus: nested-fragment child keys no longer overwritten by an outer wrapper key
(#15292, `setBlockKey` gains `overwrite`). Declared `style` props normalized like
vdom (#15286). `inheritAttrs: false` ownership read from the parent type
(#15279). Dynamic v-for slot state preserved across re-resolution (#15280, where
`createForSlots` becomes a keyed, ref-reusing factory, a compile-time signature
change). Merged event handlers keep their modifiers (#15265). Component root
propagated through `<Transition>` so fallthrough class and style merge at the
root (#15275). Redundant transition block resolution skipped when no v-shows are
pending (#15272).

**Pass-through for all 12, no wrapper change**, and three verified N/A rather
than assumed. This library declares no `inheritAttrs`, passes no `style` props,
and runs no DOM-connectivity check in a cleanup. So #15279, #15286 and
`aac355d`'s reordering cannot reach it. The v-for scope rework sits below
`tryAutoCleanup()`, which calls the public `getCurrentScope()` /
`onScopeDispose()` pair and is indifferent to how many scopes are nested above
it. `createForSlots` is compiler output. The Vapor SFC examples inherit it by
recompiling.

**Reading #15293 found a real bug of ours.** It is the only reason this cycle has
code in it. `tryKeepAliveHooks` gated itself on `getCurrentInstance()`, which
reads VDOM's `currentInstance`. Measured on rc.4, that returns null inside
`defineVaporComponent({ setup() })` while an `onDeactivated()` registered at the
same point works and fires. So the KeepAlive pause/resume in `useCommandHistory`
and `useCommandError` was **inert in every Vapor component**. It silently
recorded commands dispatched into a deactivated view, while working in VDOM. That is why
1508 passing tests never saw it, and the rc.3 fixture could not have: a bare
`effectScope()` stand-in never calls our guard.

Fixed by probing `hasInjectionContext()`: Vue 3.3+, measured true in Vapor and in
VDOM setup, false in a bare scope. `getCurrentInstance()` stays as the fallback
for a partial Vue namespace. Fixture: `tests/keepalive-input-scope-fixture.test.ts`
drives a real `VaporKeepAlive` and pins both halves. Our guard suppresses
recording while deactivated. An unguarded `bus.onAfter` at the same site still
fires, the fact the whole not-double-suppression argument rests on.

**Alternative re-examined and rejected on cost: untracking every dispatch by
default.** It had been carried as *blocked* on `setActiveSub` not being exported.
That framing was wrong on both counts.

First, availability was never the constraint. `pauseTracking` and `resetTracking`
are the same mechanism as `setActiveSub`. They are typed public API in rc.4
(`enableTracking` too), and `untracked()` is already built on them.
Re-verified that `setActiveSub` itself remains JS-only, absent from the `.d.ts`
of both `vue` and `@vue/reactivity` in rc.3 and rc.4, but that no longer decides
anything.

Second, and decisively: making untracking the default costs too much. Measured on
rc.4, interleaved A/B, 20k dispatches: a bare `bus.dispatch()` is 35.9 ns. The
same dispatch wrapped in `pauseTracking` / `resetTracking` is 111 ns: **3.1x,
+75.4 ns each**. (Not reproduced: the rc.7 entry re-measured it through the real
dispatch path at 1.22x, +5.4 ns.)

So the item is not waiting on upstream. It is **declined on cost**, and would be
declined identically if `setActiveSub` were exported tomorrow. The design that
survives is the one already shipped. Composables route their dispatch through
`untracked()`, where the guard rides on work that is already doing signal
writes. There the relative cost disappears, while the bare bus stays free. The
residual
exposure, a direct `bus.dispatch()` from user code inside a reactive effect, is a
documented boundary, not a bug awaiting an API.

**Verified against rc.4:** `tsc` clean, 1748 + 7 tests across 114 files in both
projects.

#### rc.5 (Aug 21): attrs fallthrough, and a leak in our own documented binding

**Expected.** Attrs fallthrough is renderer-internal and this library declares no
props, so the forecast was pass-through. It held for all 15 commits. But the
fallthrough cluster is about *which object keys reach the DOM*. We asked that
question of our own documented `<Transition v-bind="t">` binding. Two internals
had been reaching the DOM since v1.1.0. The pattern by now is explicit: **the
value of reading a diff is not the diff. It is the question the diff makes you
ask about your own code.**

**Landed.** 15 commits, all read at source.

**Attrs fallthrough is the theme** (5).

- Semantics aligned with vdom (`293ca1c`): `filterModelListeners` exported from
  runtime-core and reused. A new `resolveFallthroughAttrs()` returns `{}` rather
  than `undefined` for stable diffing. `hasFallthroughAttrs()` checks dynamic
  sources (`rawProps.$`) before static undeclared keys.
- Fallthrough attr effects re-parented onto the innermost dynamic fragment's
  branch scope, so a detached branch stops updating (`be7157e`). An
  `EffectScope` is retrofitted onto compiler-proven no-scope branches that carry
  them. `DynamicFragment.hasFallthroughAttrs` becomes a `fallthrough(nodes)`
  callback invoked inside `runWithRenderCtx`, replacing the old `onBeforeInsert`
  hook.
 Attrs reach interop vnode roots by cloning the vnode and
re-cloning under a `renderEffect`, patching rather than remounting so inner state
survives (`5073eb5`). Functional components that declare props now get full
fallthrough like vdom, instead of the class/style/listener subset (`ef83790`).
And resolution stops descending at slot outlets instead of warning and continuing
into slot content (`10f666e`).

**TransitionGroup is the second theme** (7). Pending enter and move callbacks are
flushed on the resolved element, because "for interop children [it] is not the
block itself" (`f2fa54d`). Group hooks are re-applied onto already-mounted
children on prop change, extending beta.16's element-path fix, with the
FLIP-measurement latch preserved across re-resolution (`d3fde91`).
`forceReflow(firstChild)` makes the reflow use the group's own document, so it
"works inside iframes / foreign documents" (`36dd186`). Plus four perf items: a
collect-only child snapshot in `beforeUpdate` (`744d64d`). No bookkeeping on
ForBlock wrappers, which "have no transition consumers of their own" (`2c914ef`).
Per-child props tracking skipped when `hasDynamicPropsSource()` is false
(`c526d45`). And v-for hot-path allocations trimmed through an LIS planner,
indices-only reordering, lazy `RenderEffect` job creation and dropped
`ForBlock.prev` / `next` / `prevAnchor` (#15329).

Plus element namespace resolved at interop boundaries, including the
`annotation-xml encoding=html` escape back to HTML (#15321). Nested vdom slot
content preserved under a Vapor Transition root through an `isDirectSlotRoot`
discriminator (#15304 / #15303). And the rendering Suspense boundary restored in
fragment context. So a late branch's post-render effects queue on the pending
boundary rather than the global queue (`5c2805d`).

**Pass-through for all 15, no wrapper change.** But studying the fallthrough
cluster turned the question on this library's own documented usage. It found a
bug there, which is the only reason this cycle has code in it.

**`<Transition v-bind="t">` was putting bridge internals into the DOM.** That is
the binding this module's JSDoc, the README and `docs/` all tell you to write.
`v-bind="obj"` spreads own enumerable keys as props. Vue matches the nine `on*`
hooks to `<Transition>`'s declared props and passes the rest through as
fallthrough attributes. `phase` (a signal object) and `dispose` (a function)
matched no declared prop, so both were stringified onto the transitioned element.
Measured on a real mount:

    <div class="panel" phase="[object Object]" dispose="() => {}">hi</div>

on every consumer following the docs since v1.1.0.

Fixed by defining both **non-enumerable** (`assembleBridge`). That changes what
*spreading* yields and nothing else. `t.phase.value`, `t.dispose()` and
`const { phase } = t` read the property directly and are unaffected, since
destructuring does not need enumerability. The one intentional casualty,
`{ ...bridge }` dropping them, is exactly the operation that caused the leak.

**Alternatives rejected: rename the keys, or move the hooks under `t.hooks`.**
Both fix the leak by breaking the documented call site. Non-enumerability fixes it
by changing only the operation that was wrong.

**Why 1750 passing tests never saw it.** Every test in `tests/transitions.test.ts`
calls the hooks directly on a mock element. So nothing ever handed the bridge to
Vue. That is the rc.4 KeepAlive lesson repeating itself. A fixture that
substitutes a mock for the integration it reasons about can only check the half
you already understood. Fixture: `tests/transition-bind-fixture.test.ts`, which mounts, and
is verified to fail 3 of 4 against the pre-fix code.

**Four items N/A by verification**, each grepped across `src` and `examples`
rather than assumed:

- we declare no `inheritAttrs`, so the inheritAttrs gating in `293ca1c` and
  `5073eb5` cannot reach us
- we define no functional components (`ef83790`)
- we render no SVG, MathML or `foreignObject` (#15321)
- we use no template refs (`5c2805d`)

`be7157e` newly creates EffectScopes inside branches, but that is below
`tryAutoCleanup()`. It registers on whatever `getCurrentScope()` returns from a
`setup()`, and is indifferent to nesting depth above it.

**The one module rc.5 conceptually reaches is `transitions.ts`, and it is
idempotent by construction.** `buildHooks` resolves all nine hook identities once
per bridge and never rebuilds the object. So `d3fde91`'s re-application
re-registers the same nine functions. Re-registration is not invocation, so a
prop change dispatches no extra `*Move` or `*Enter`. `f2fa54d` is a straight
unblock in our favour. `onMove` dispatches per move. An interop child whose
pending callbacks were flushed against the block instead of the element is
exactly the shape that strands one.

**Two upstream commits converge on decisions this repo already made
independently**, recorded because corroboration is worth as much as a diff.
`36dd186`'s "use the element's own document" is the rule `directives.ts` enforces
with its per-`Document` `delegatedDocs` map. It was added in the rc.2 cycle. A
single global count had stranded the shared listener on the wrong document and
turned delegated controls into dead ones. And `8d83bb2`'s switch to direct
`el.addEventListener()` to kill disposer-closure allocation is what
`v-vc:command` has always done.

**From the Vapor roadmap read (#13687), one finding that outranks the diffs.**
The rc.4 `hasInjectionContext()` gate was justified by measurement alone. That
left open whether Vue would later make `getCurrentInstance()` answer in Vapor
and render it dead weight. A core maintainer has since confirmed the null is
**intentional** (Jul 20), with an internal `useInstanceOption` kept deliberately
non-public. The maintainer reaffirmed (Aug) that Vapor exposes no
general-purpose component instance tree by design. So the gate is permanent, not scaffolding.

The same statement settles two unchecked roadmap boxes. **Vue Test Utils**:
instance traversal is what upstream ruled out, and `createTestBus` asserts at the
bus boundary and needs no revision. **DevTools**: `src/devtools.ts` builds its
inspector tree from buffered `bus.onAfter` entries, never from Vue's component
tree, so it does not wait on Vapor component-tree bookkeeping.

**Perf patterns harvested from the four rc.5 optimization commits: three already
shipped here, one measured and parked.**

Already applied, in two cases with evidence going further than upstream's. Take
`c526d45`'s "skip the tracking effect when nothing is dynamic" and `2c914ef`'s
"skip bookkeeping for wrappers with no consumers". They are the same idea as
`_syncDispatchInner`'s bare-bus fast path (five O(1) reads) and
`_syncEmitInner`'s no-listener early return. The fast path's comment records that
a cached `isBare` boolean was tested and **measured 25% worse**, because the added
state field broke the hidden class. `293ca1c`'s "return `{}` not `undefined` so
diffing stays stable" is the shape-stability rule behind `okResult` / `errResult`
always setting both `value` and `error`. `8d83bb2`'s allocation trimming is the
index-loop-with-length-snapshot, no-`.slice()`, frozen `EMIT_RESULT` singleton
work already in the hot paths.

**The one genuinely unapplied pattern is `744d64d`'s collect-only distinction**, a
pass that only reads skipping the bookkeeping the write pass does. Our read path
does not. `bus.emit()` deliberately skips `stampMeta` with a recorded rationale.
But `bus.query()`, also a read, stamps full meta (`Date.now()` + `uid()` + a
5-field object) exactly like `dispatch`.

Measured with 41 interleaved rounds of 200k iterations, by the isolated-cost
method, so an upper bound on the marginal delta rather than an exact one. A bare
`bus.query()` is 45.1 ns and `stampMeta`'s own work is 29.8 ns, 66% of it.

**Acted on, after the isolated number was disproved by a better measurement.**
That 29.8 ns came from an isolated loop. `docs/performance.md` warns that the
method produces garbage, because a loop-invariant variable read is hoisted while
`Date.now()` survives.

It was re-measured through the real dispatch path
(`tests/clock-source-ab.test.ts`, interleaved). An `emit` control row never
stamps, and so calibrates the harness at a ~2-6% noise floor. The recoverable
cost is **15-25 ns per command, fixed**:

- 1.42-1.67x on a bare bus, 1.42-1.57x on `dispatchBatch`
- 1.38-1.50x with an ordinary handler, 1.18-1.24x with three plugins
- nothing once 50 listeners dominate

The lever turned out not to be `uid()` or the allocation at all, but `Date.now()`
itself (32.9 ns isolated on this host). Breaking `stampMeta` down showed
`toString(36)` at 0.5 ns. So `meta.ts` now reads the clock **once per microtask
turn**, eagerly on the first call of each turn so that command is exact.
Confirmed on the bench: `bus.dispatch` moved from 197.7x to **140.0x** slower
than a direct call, `emit` unchanged as the control.

No API was added. A runtime knob was built, measured and deleted, since an option
only earns its place when both settings suit different people. The rare
exact-clock need is a user plugin. Containment is pinned by
`tests/clock-source-contained.test.ts`: every TTL and expiry path reads
`Date.now()` directly, so a frozen clock cannot extend a cache entry.

**A second, larger lib-side finding came from reading vue-router v5 rather than
Vue itself.** It is recorded here because this router deliberately shares no
code with it. That is exactly why the lessons have to be imported by hand.

v5 protects its query objects with `Object.create(null)`. Checking whether ours
needed the same turned up **one bug class at four sites, three of them live**.
`parseQuery` read `query[key]` on a `{}` to detect repeated keys. So
`?constructor=1` came back "already set" and produced `[Object, '1']` instead of
`'1'`. And `?__proto__=a` assigned through the inherited setter and replaced the
parsed object's prototype. `defaultAffects` used `key in record.queryDefs`,
reporting `?toString=` and `?valueOf=` as declared params and refetching a loader
for a key never declared. `form.ts` ran a rule for an absent field against an
inherited function.

Worst of the four, and the one furthest from where the search started:
`commandKey`'s canonical serializer copied sorted keys into a `{}`. Take an own
`__proto__` key, precisely what `JSON.parse` of a server response yields. The
setter swallowed it, and it was dropped from the output. Measured:
`{"__proto__":"A","id":1}` and `{"__proto__":"B","id":1}` both keyed to
`act:{"id":1}`, and that key backs `idempotent`, `cache`, `serialize` and
`supersede`, so two distinct commands deduped into one.

The rule now lives once in `src/dict.ts` with its evidence, rather than as four
independent rediscoveries. The reads use `Object.hasOwn`, the same fix v1.15.0
applied to the MCP gate, which was this class's first appearance. Whole
class cost **0.0 KB brotli** (+0.1 KB raw). Fixtures:
`tests/prototype-keys.test.ts`, `tests/router/query-prototype.test.ts`.

**Verified against rc.5:** `tsc` clean, lint clean, 1786 + 7 tests across both
projects (120 files). IIFE 11.0 / 7.6 / 8.0 KB brotli, all under budget and
unchanged from rc.4.

**Performance measured, not asserted** (`npm run ab:vue -- 3.6.0-rc.4`, 51
interleaved rounds, both sides the production with-vapor dist). Scope
create/dispose 1.026x, shallowRef writes 0.999x, watcher notify 1.042x, computed
read-after-write 0.926x. Worst ratio 1.042x, inside the harness noise band, so no
regression on the primitives this library sits on.

#### rc.6 (Aug 28): DOM prop writes, an HMR leak, and a production-only wiring bug

**Expected.** DOM property writes and hydration internals, forecast pass-through
and N/A. Correct for 13 of 14. The fourteenth, a per-render `EffectScope` for HMR,
was forecast as irrelevant. It turned out to fix a listener leak that had been
multiplying our fan-out once per hot reload. In this cycle too, an N/A call
recorded in this very entry gets **reversed inside the same release window**.
`vapor-chamber/router/vapor` began using the exact helpers the entry had just
declared unreachable. That reversal is the strongest argument in
this document for reading every commit rather than filtering by what today's code
calls.

**Landed.** 14 commits, all read at source.

**DOM prop writes are the theme** (3). They converge on one rule: compare against
what you were GIVEN, not what the sink normalized it to.

- `setDOMProp` stopped skipping the initial write when the value happened to
  equal the element default. In #15341 `<input type="text">` set no attribute at
  all, because `el.type` already read `"text"`.
- It then moved change detection off the live property entirely, onto a
  `$p$`-prefixed expando holding the previous **raw binding** (#15343). So
  `:type="invalid"` -> `:type="text"` now writes, even though the DOM normalized
  both to `text`.
- `setValue` also mirrors `value` into the **attribute** (#15340 / #6007). So
  `<form>.reset()` restores the bound value rather than the empty string.

**Hydration is the second theme** (4).

- A double `exitHydrationCursor` no longer decrements the live-cursor count
  twice (`7710394`). Nor does it re-run the restore that would rewind over a
  sibling's claimed nodes (`9e6d1e5`).
- Leaving a hydration boundary asks `compareDocumentPosition` instead of walking
  forward for a node already behind the cursor. The walk was quadratic over a
  list of boundaries (`9905d7d`).
- `template()` now parses each template string once into an `AdoptTarget`
  descriptor (type / tag / tagUpper / blank) that every later instance compares
  against. It no longer re-scans the string per adoption (`29ed4b0`,
  upstream-measured v-for single-root +15.5%, multi-root +9.2%).

Plus:

- A null `<component :is>` renders as a genuine empty branch rather than a
  placeholder node (`a447d80`). A build-dependent placeholder (dev comment,
  production text) in the semantic content tree had made production hydration
  mistake detached text for content and crash. The branch is then keyed by its
  resolved sentinel rather than the raw value (`7c8d34a`).
- Runtime structural anchors are claimed, so `isValidBlock` rejects them by
  marker. Block validity is now identical across dev (comment) and production
  (text) shapes. Previously a production anchor read as renderable content and
  suppressed slot fallback in production only (`2473b78`).
- `v-for`'s index alias is cleared when the source switches from object to array
  (#15364).
- The scheduler restores its own state after a flush error (`70bd789`). It
  re-queues leftovers on a fresh microtask and clears `QUEUED` flags in
  `finally`, so a throwing post job cannot strand later work.
- HMR gains a `runWithHmrUpdating` wrapper that covers the Vapor fast-path reload
  (`991a885`). Critically, it resets the flag at once when an update fails,
  instead of leaving it set forever. Each dev render generation becomes owned by
  its own `EffectScope` (`9ab65a1`).

**Pass-through for 13 of 14**, with a src fix of this library's own found while
auditing the wiring path, below.

**The DOM-prop cluster is N/A by verification rather than assumption.** `src`
contains no `setAttribute` or `removeAttribute` outside `router/dom.ts`'s two
`data-active` calls. It writes no DOM properties and reads no `value` attribute.
So nothing here can observe #15340, #15341 or #15343. The SFC examples inherit
them by recompiling. The same holds for the hydration cluster, since our SSR is
command replay above DOM hydration (12). And for `<component :is>`, which
appears nowhere in `src` or `examples`. `RouterOutlet` is a VDOM `defineComponent` returning `h()` or
`null`, never a Vapor `createDynamicComponent`. (That last call is reversed later
in this entry.)

**The scheduler's restore-state-in-`finally` fix is the one whose class could have
reached us.** It was audited rather than waved through. All three
`dispatchDepth` guards (both bus variants plus `createTestBus`) already restore
in `finally`. `runDispatch` already clears `loading` on every exit path,
including the throw. The class is clean here, verified by reading each site.

**The 14th commit is the exception, and it found real behaviour.** `9ab65a1`'s
per-render `EffectScope` exists to tear down element-nested child components on
HMR rerender. Those are children mounted inside an element rather than returned
as the parent's block, which the block graph cannot reach.

A leaked Vapor instance is a leaked `setup()` scope. `useCommand()` hangs its
cleanup on exactly that scope. So before rc.6 a hot reload left the old
generation subscribed. Measured on rc.5: after two reloads, one dispatch fired a
`useCommand().on()` listener **three times**, once per generation ever rendered.
Those are duplicate side effects growing with dev-session length. rc.6 disposes
each superseded generation and the fan-out returns to one.

The asymmetry is why nobody noticed. `register()` is keyed in a Map, so the
newest handler always wins regardless of teardown. `on()` appends to an array,
and nothing overwrites a leak.

**No code change on our side**: `tryAutoCleanup` was already registering the right
cleanup on the right scope, and Vue simply began stopping that scope. Fixture:
`tests/hmr-render-scope-fixture.test.ts`, which drives the real
`__VUE_HMR_RUNTIME__` against a real `createVaporApp` and is verified to FAIL on
rc.5.

**One perf pattern harvested, measured, and shipped.** `29ed4b0`'s move hoists a
per-call string scan into a descriptor the factory computes once. It pointed at
our own fan-out. `on()` classifies a pattern as a wildcard to pick a bucket, then
throws that result away. Every dispatch re-derives it inside `matchesPattern`
(`=== '*'`, a `charCodeAt`, a `Map.get` on its prefix cache).

Wildcard entries now carry `prefix = pattern.slice(0, -1)`. That is correct for
both shapes with no special case, since `'*'` slices to `''` and
`startsWith('')` is always true. It was measured on the real dispatch path,
interleaved, with the baseline arm derived from the shipped source, so it is the
genuine old code. **1.14-1.32x on wildcard fan-out** (10-31 ns per dispatch,
scaling with listener count), **0 B brotli**.

Two rows deliberately do not move, and they are the honesty check. No wildcard
listeners reads ~1.00x: the control, since that shape already short-circuits. A
lone `'*'` listener reads ~1.02x: `matchesPattern` already returned on its first
comparison. The isolated matcher loop reported 3.66x. Per `docs/performance.md`
that number is an inflated upper bound, and the real-path figure is the one
recorded.

Public `matchesPattern` keeps its prefix cache untouched. It takes arbitrary
caller-supplied patterns (plugin `actions:` filters), where nothing has
classified anything in advance.

**Re-running the ritual's reopen-condition check corrected a fact this document
got wrong for two cycles.** The rc.5 entry stated that exactly one of the four
wrapped Vapor APIs is statically importable from `vue`. All four are, plus
`vaporInteropPlugin`: **18 Vapor names**. Seen through the test's name filter,
the list is byte-identical on rc.5 and rc.6. (The entry's full surface changed
at rc.8: `withOnce` added, runtime-vapor `withAsyncContext` removed.) So the error
was never about rc.6.

`vue.runtime.esm-bundler.js` is 23 lines. The rc.5 entry quoted the named `import`
and `export` lines and missed the `export * from "@vue/runtime-vapor"` between
them. That is precisely the failure mode the same paragraph warns about,
inverted. **A star re-export has no name to grep for and none to quote. So an
absence in a quote is not an absence from the module.**

The roadmap's reopen condition was a with-vapor bundler entry OR a vapor subpath
or condition. It is therefore met on its first half, and has been since rc.5.
That does not revive the `vue36` flavor, since the `__vapor`-marker fact and the
<0.9 KB measurement are independently fatal. But it does mean the flavor now
stands on "not worth building" rather than "nothing to import from". Enumeration is
automated in `tests/vue-bundler-vapor-exports.test.ts`.

**A second lib-side bug came out of auditing the WIRING path rather than the
guard.** It is the rc.4 KeepAlive finding by another road. rc.4 established
that `tryKeepAliveHooks` must gate on `hasInjectionContext()` because
`getCurrentInstance()` is null in Vapor by design. The guard was right. What
nobody checked is whether the thing it depends on reaches the registry.

It did not. `src/vue.ts` is the entry whose entire purpose is build-time Vue
wiring. It passed seven names to `configureVue()`, and `hasInjectionContext` was
not one of them, while `applyVueModule` reads it. Unset, the gate falls back to
`getCurrentInstance()` and goes inert, so `useCommandHistory` and
`useCommandError` record commands dispatched into a deactivated KeepAlive view.

**Why the suite could not see it:** `tryKeepAliveHooks` calls `probeVue()` first,
and under vitest a bare `import('vue')` resolves and supplies the full namespace.
The omission is invisible wherever the suite runs. It bites only in a production
bundle, where the specifier cannot resolve and the registry holds only what the
static list passed. Dev-correct and production-broken: the same asymmetry that
caused `vapor-chamber/vue` to exist at all.

Fixed by adding the name. Fixture `tests/vue-subpath-wiring-fixture.test.ts`
blocks the probe, mounts a real `VaporKeepAlive`, and pins both halves. The guard
holds with the full list, and fails to suppress with that one name withheld. It
proves the mechanism instead of asserting it. The generalized rule now sits in
`src/vue.ts`'s header: **that list is load-bearing. Any registry entry
`chamber.ts` begins reading must be added to it, or it serves probe-path
consumers only.**

Relatedly, `configureVue()` was confirmed to MERGE (every assignment is
`typeof`-guarded, so unsupplied entries are left unchanged). That was never
documented, so the vapor-sfc example had been defensively re-enumerating all eight
names on top of what `vapor-chamber/vue` already configured. Its preamble is now
one `configureVue({ createVaporApp })`.

**Two things the corrected fact then unlocked, both measured.**

First, **`vapor-chamber/vapor`**, the 3.6-only subpath `src/vue.ts` has prescribed
in writing since it was authored, now shipped. It statically imports Vue's Vapor
APIs, so the registry is seeded at build time. A probe that cannot resolve in a
production bundle no longer seeds it. That probe is the failure mode behind both
production-only bugs above.

The wired set is measured rather than maximal, because a static import is retained
by the consumer's bundler whether the app calls it or not. On the vapor-sfc
example: `createVaporApp` alone is 80.23 KB raw, `+defineVaporComponent` +0.03,
`+defineVaporAsyncComponent` +1.84, `+defineVaporCustomElement` +9.21, and
`+vaporInteropPlugin` **+78.27, roughly doubling the app**. The entry wires the
first three and leaves the last two behind one composable `configureVue()` line,
the same audience axis the IIFE variants split on.

Second, smaller but cleaner. **Both Vapor examples' `vue` alias and their
hand-written `vue-with-vapor.ts` shim are now dead code and were deleted.** That
shim was `export * from '@vue/runtime-dom'; export * from '@vue/runtime-vapor';`,
which is character-for-character what `vue.runtime.esm-bundler.js` now contains.
Verified by building each example with and without the alias: byte-identical
output, same sizes and same content hashes, all four chunks for island-cart.
Consumers copying those configs were carrying a workaround for a problem Vue had
already fixed.

**The same hoist paid a second time, in the router.** `stampActiveLinks` runs
after every navigation over every in-base anchor. It re-derived `new URL()` plus
`stripBase()` per anchor per commit, from an href that almost never changes.
`routableTarget` now memoizes per anchor, keyed on the raw href it was derived
from. That is rc.6's `84833e2` lesson: validate against the input, not against
element identity, since a Blade menu can rewrite an href in place.

It was measured on the real function, with the baseline arm derived from shipped
source: **1.77-1.86x**. It saves 42 us per commit at 50 anchors, 172 us at 200
and **828 us at 1000**. 1000 is not hypothetical for the server-rendered menus
this feature exists to light up. A `WeakMap` rather than a node expando: that
choice also measured at 0.98-1.02x, inside noise, so the non-invasive one wins
for free.

**One correction recorded with it:** an earlier pass reported 3.12x. It timed the
imported function against a cached variant defined inside the test file, which
V8 does not optimise identically. That is the isolated-loop error in a different
costume. The derived-baseline method is what produced the honest figure.

**Verified against rc.6:** `tsc` clean, lint clean, 1872 + 10 tests across both
projects (130 files). IIFE 11.1 / 7.6 / 8.1 KB brotli, all under budget and
unchanged from rc.5.

**Performance measured, not asserted** (`npm run ab:vue -- 3.6.0-rc.5`, 51
interleaved rounds). Scope create/dispose 1.012x, shallowRef writes 0.997x,
watcher notify 1.055x, computed read-after-write 0.939x. Worst ratio 1.055x,
inside the documented noise band.

##### The Vapor outlet, and an N/A call this entry reverses

A later pass in the same window built on this cycle's dynamic-component work, and
it **reverses one of this entry's own N/A calls**. Above, `<component :is>` is
listed as not reaching us, on the grounds that `RouterOutlet` is a VDOM
`defineComponent` returning `h()` or `null`, never a Vapor
`createDynamicComponent`. That was true of the only outlet that existed when this
was written. It is no longer true of the library.

**`vapor-chamber/router/vapor`** ships a second render surface over the same route
snapshot. It is built on exactly the helpers `a447d80` and `7c8d34a` reshaped:

- `createDynamicComponent` for the branch, accepting a block, with null
  rendering as a true empty branch keyed by its resolved sentinel
- `createSlot` for the no-match fallback, whose dev/production validity parity
  is `2473b78`

So three rc.6 commits went from inherited-but-unused to load-bearing inside one
cycle. That is the clearest available illustration of why the alignment ritual
reads diffs at source. It does not filter them by what today's code happens to
call. Upstream's own comment on `a447d80` reads *"Support integration with
VaporRouterView/VaporRouterLink by accepting blocks"*. This is that integration,
built against it.

**The prize is startup, and it is transfer and parse rather than steady state.** A
pure-Vapor app rendering a route through the vDOM outlet must install
`vaporInteropPlugin`, which drags in the vDOM renderer. Building the outlet from
Vapor's own helpers drops **20.02 KB brotli / 60.8 KB raw** from an executed
production bundle. It is measured against an interop baseline derived by the
same harness, so neither arm can differ by method
(`tests/vapor/vapor-outlet-size.test.ts`). No steady-state per-navigation claim
ships, because no committed A/B bench exists for it. That is 7.6's discipline,
unchanged.

**The guard holds two limits**, measured on a Vite production build since the rc.8
cycle:

- the saving stays >= <!-- vc:outletFloor -->15.0<!-- /vc:outletFloor --> KB
  (today <!-- vc:outletSaving -->22.06<!-- /vc:outletSaving -->)
- the Vapor outlet's own machinery over the router-without-outlet floor stays <=
  <!-- vc:outletOwnArmCeiling -->5.0<!-- /vc:outletOwnArmCeiling --> KB (today
  <!-- vc:outletOwnArm -->4.75<!-- /vc:outletOwnArm -->)

It is deliberately written to fail when a later RC erodes either. Growth in
`DynamicFragment` or `SlotFragment` lands in the second, and that failure is a
decision trigger rather than a threshold to raise. (At this entry's time it was
one esbuild-measured bar on the difference. The rc.8 entry records why it was
replaced.)

**Two alternatives the design refuses on purpose.**

- It does not reach Vue through the registry. Every helper is a static import
  from bare `vue`, so an upstream rename is a consumer *build error*. A probe
  miss would produce a silent runtime null in a production bundle instead. That
  is the exact failure class `vapor-chamber/vue` and `vapor-chamber/vapor` were
  shipped to kill.
- It does not fall back to interop when handed a vDOM component.
  `createDynamicComponent` gates its vnode branch on `appContext.vdom`. So
  without interop a vDOM component silently renders in the wrong mode, with no
  upstream error. The outlet therefore reads the `__vapor` marker itself and
  throws a coded `router:invalid:component`. A silent fallback would have
  restored the entire 20 KB the subpath exists to save, while looking like it
  worked.

Blade rows still need the vDOM outlet, since `makeBladeComponent` is itself
`defineComponent` and `h`. That is documented, and made loud at runtime by that
error's blade-specific message.

**The new dependency surface is nine items and is enumerated, not described.**
It is eight named imports plus one property read, `instance.slots`. Vapor's
`setup` receives the instance as its second argument, and no public
slot-existence helper exists. `tests/vapor/vapor-outlet-helpers.test.ts` pins
them through the bundler entry, for the star-re-export reason this entry already
records twice.

The Phase 1 spike that gated all of this (`tests/vapor/vapor-outlet-spike*`) was
**deleted** on landing. Permanent fixtures now carry its every behaviour. There
are six of them, including one that asserts the whole contract against an
*executed* production bundle. The anchor a null branch leaves behind is a
comment in dev and an empty text node in production. Only node-KIND assertions
survive both.

Re-verified at this pass, superseding the counts quoted earlier in this entry:
`tsc` clean, lint clean, 1950 + 17 tests across both projects (137 files).
Coverage 100.0% on all four axes. IIFE 11.1 / 7.6 / 8.1 KB brotli, unchanged
and under budget, since the subpath adds nothing to them.

#### rc.7 (Sep 4): 50 commits, none of them ours, and 28 defects that were

**Expected.** rc.7's changelog is dominated by slots, async components and
transitions. The forecast going in was pass-through: nothing in this library
renders, so slot arbitration and transition persistence land below it. That
forecast held for all 50 commits. It did not predict what reading 50 renderer
commits carefully would do. It left the team calibrated enough to read our own
`src` the same way, and the second read found far more than the first.

**Landed.** 21 compiler-vapor, 50 files of runtime-vapor, 5 runtime-core, plus
types and tests. **All 50 are pass-through.** The themes, for the record:

- **Slots.** `VaporSlotFlags` collapses to a 2-bit FORWARDED / SHARED_FALLBACK
  mode, with `isForwardedSlot`, `slotInheritsFallback` and `slotNotifiesBoundary`
  exported from `shared` so the vapor and interop paths cannot drift. `NON_STABLE`
  splits out into its own `VaporSlotStability`. The fast path widens twice, each
  step pinned by a coverage guard that a later commit then flips.
- **Async components.** A resolved one is created AS its resolved component with
  no wrapper, and branches are keyed by state. An `asyncComponentState` module
  gates every wrapper-aware branch through `isAsyncComponentEnabled`.
- **Transitions.** `persisted` is derived by walking from the root on every apply,
  deleting `capturePendingVShows`, `applyPendingVShows`, `hasVShowMarker` and an
  ambient stack. Composed TransitionGroup keys move off `$key` into a WeakMap with
  a `getTransitionKey()` accessor. A `disabled` suppression latch is deleted in
  favour of `MoveType.REORDER` at the call site.

**Performance: neutral, and the instrument needed fixing first.**
`npm run ab:vue -- 3.6.0-rc.6` (51 interleaved rounds) reports 0.993x and 0.991x
on scope create-dispose and shallowRef writes. It reports apparent 0.760x and
0.696x "speedups" on watcher-notify and computed.

Those two are **artefacts**. Running the same harness with rc.7 on BOTH arms
reports 0.756x and 0.696x. Two byte-identical copies of one dist, loaded through
the identical path, differ by up to 1.425x in opposite directions per workload. The cause is per-module-instance reactivity state, indistinguishable
from a version difference by construction. The diff corroborates the neutral
reading: the only `packages/reactivity` file changed is its `package.json` version
line.

So the printed 0.87-1.15 band is sound for the two workloads that build no
persistent graph and much too tight for the two that do. **Still watching:** a
self-A/B control pass is the fix and is not yet written.

**Decided (first pass): five defects found by reading, none of them rc.7's.**

- `createFormBus().submit()` ran `onSubmit` twice on a double-click, because the
  re-entry guard read a signal set only after an await.
- Four more prototype-key sites in the plugin layer (`validator`, `optimistic`,
  `validateSchemas`, `validateSchemasAsync`), one of which made `bus.dispatch()`
  THROW on an action named `toString`.
- `defineVaporCommand` and `useVaporAsyncCommand` were the only dispatch paths not
  wrapped in `untracked()`: the two Vapor ones, and one documented for hot paths.
- The router re-ran a guard or `afterEach` hook that unregistered a LATER sibling,
  using the length-based cursor `command-bus.ts` already records as wrong.
- `createReaction`'s `maxHops` cap was inert whenever `mapPayload` returned a
  primitive or array, which left only the dispatch depth bound (16).

The last needed a core channel: a one-shot causation slot in `stampMeta`, the
mechanism `_withOrigin` already proved, at +18 B brotli.

**Alternative rejected: raising the tree-shake ceiling to absorb it.** Instead
four pass-through wrappers came out of `command-bus.ts` for -9 B. One of them,
`asyncQuery`, was an `async` wrapper whose body was `return await inner(...)`,
costing a microtask per query. Net +9 B under an unchanged 6560.

**Corrected: a measurement this document relies on.** The rc.4 entry declines
untracking-by-default on 35.9 ns vs 111 ns, "3.1x, +75.4 ns each". It was
re-measured through the real dispatch path on rc.7, four runs: **24.7 ns vs
30.2 ns, 1.22x, +5.4 ns**. That is fourteen times cheaper than the figure the
decision rests on. The
decision is not revisited here, but the number behind it no longer reproduces.
Anyone reopening untracking-by-default should start from 1.22x, not 3.1x.

**Verified against rc.7:** `tsc` clean, lint clean, 2076 + 22 tests across both
projects (145 files). Coverage 100.0% on all four axes. IIFE 11.1 / 7.6 / 8.1 KB
brotli, all three examples rebuilt.

##### The second pass: every module in src, and 23 more defects

A second pass in the same window read every module in `src` (62 files) plus all 16
scripts. The three largest groups each turned out to be one cause, which is why
they are grouped rather than listed.

**Five plugins were broken on the async bus.** `next()` returns a PROMISE there.
`logger`, `history`, `circuitBreaker`, `metrics` and `persist` all read it as the
result. `promise.ok` is `undefined`, so `logger` reported every SUCCESS
through `console.error` as `error: undefined`. `history` recorded nothing.
`circuitBreaker` went OPEN after five consecutive successes and began refusing
working traffic. `metrics` timed 0.02 ms for a 30 ms handler. `persist` never
saved.

**Numeric options fail in the direction of their comparison.** Every comparison
against NaN is false, so `length < max` fails safe while `length > max` and
`count >= max` fail OPEN. Measured: `history({maxSize: NaN})` kept 500 against a
cap of 50, and `StreamParser({maxDepth: NaN})` accepted 5,000 levels of nesting.
The eight sites on the list turned out to be 53 candidates and 12 real defects,
now one rule in `src/bounds.ts`.

**Shared things whose lifetime belonged to whoever got there first.** A store died
with the component that created it, leaving every later action returning
`ok: false`. Two forms on one bus wrote into each other's state.

The router alone carried eight, including a cyclic parent chain that HUNG the tab.
It was a synchronous walk with no terminator, no error and no stack. It held a
vitest worker until the run was killed at 120s.

The Vite plugin's SFC injection had **never once worked** across six releases.
`enforce: 'pre'` sees raw SFC text, where compiler-sfc discards anything outside a
block. `transformRequest` output, byte-identical with the plugin and without it,
proved it.

**And one bug was worth ~10% of a consumer's bundle.** `src/dev.ts` documented
that the ESM build defers DEV to the consumer's bundler, and it did not. The
`typeof __VC_DEV__` wrapper cannot be evaluated by any bundler. So every dev-only
diagnostic string shipped to production. Measured on a real `vite build` of a
consumer app: 14,037 -> 12,764 raw, 4,453 -> 3,999 brotli. (One-chunk apps. In a
code-split app a chunk that imported DEV kept its strings until v1.20.0 derived
DEV per module.)

**That fix is also why the outlet bar moved.** It is worth understanding before
touching that guard. The guard measures interop MINUS vapor, and both arms carry
the router. So making the LIBRARY smaller makes the DIFFERENCE smaller. Folding
DEV shed 97 B from the interop arm against 23 B from the Vapor one. A 10%
consumer win registered as a 0.07 KB regression. The bar was re-baselined once,
from 20 to 19.5, declared in exactly one place and stamped like every other
measured number here. (The rc.8 cycle retired that bar for two limits measured on
a Vite build, after a second firing on an improvement. See the rc.8 entry.)

**The methodological finding, and the one worth carrying forward.** Six "complete"
lists in this cycle were incomplete, and every one reported clean:

- the ASCII guard's alphabet (9,300 characters it had no opinion about)
- the numeric-option list
- the read-every-module list itself (missing `form`, `store` and `vue`)
- an A/B harness's import rewrites
- the example typecheck's include
- the size table's subpaths (`./devtools` and `./stream-parser` were published
  exports with no size row anywhere)

**The rule adopted from it: where a rule can be INVERTED rather than enumerated,
invert it.** `src/` is held to plain ASCII by rejecting everything above U+007F.
The size table, the API reference and the build's entry map are all derived from
`package.json` "exports" rather than retyped beside it.

#### rc.8 (Sep 11): the first cycle not written as pass-through

**Expected.** After seven cycles of pass-through the working assumption was that
an RC either lands below us or does not reach us. rc.8 broke that assumption in
both directions at once. Two commits changed behaviour we depend on and had to be
adopted with fixtures. One measurement method had to be thrown away, because the
tool it used does not agree with what consumers ship.

**Landed.** 25 commits, all read at source. The release notes list 14. The other
11 are refactors, CI, a build change and the release.

- **v-once is reworked** around a public `withOnce` (03). A v-once component
  snapshots its props AND its slot set while slot content stays live. The
  directive helpers run inside it.
- **Props merge like vDOM**: events across prop sources (02). Declared `class`,
  `style` and `on*` props across sources in raw-key order (10). rawProps copied
  rather than mutated when fallthrough attrs are injected (04).
- **Lifecycle**: a component instance created but never mounted is disposed (12).
  Async setup registers with the nearest Suspense (11). An awaiting
  `<script setup vapor>` compiles to an `async setup()` returning its template as
  a render closure run once setup settles (20). Runtime-vapor's
  `withAsyncContext` is removed in favour of runtime-core's.
- **Hydration leaves client render**: no hydration-boundary closure on client
  render (13), slot hydration moved into top-level functions (19). Vue's CI now
  fails a Vapor CSR bundle that carries hydration code (21).
- **Dynamic components**: branch keyed by the RESOLVED component (05). `:key`
  passed to `createDynamicComponent` as a fifth argument, with KeepAlive caching
  by it (08). A vnode branch mounted through interop, invalid `:is` types warned
  and rendered empty, an unchanged key skipping the branch closure (09).

Plus:

- `is="vue:X"` on native tags (06), SVG/MathML namespace for element fallbacks
  (07)
- a `RenderContext` object replacing four slot/suspense module globals (18)
- fragment `move()` split from insert (15/16)
- perf on dynamic props and DEV-only fallthrough bookkeeping (23, 24)
- a build change inlining aliased enum members (22). It is the only reason the
  reactivity dist differs. Its source is untouched.

**Decided: adopt.** Each is pinned by a real-mount fixture verified to FAIL on
rc.7. Every `@vue/*` package that follows `vue`'s version (eleven of them) is
pinned together.

- Commit 12: a child created before a sibling's render threw was never disposed,
  so its `useCommand().on()` listener outlived `app.unmount()`
  (`tests/never-mounted-disposal-fixture.test.ts`).
- Commits 02 and 10: `<Transition v-bind="t" @enter="mine">` kept only the
  LATER-written source on rc.7. In the documented order that dropped the bridge's
  own `onEnter`. rc.8 runs both (`tests/transition-bind-merge-fixture.test.ts`,
  both attribute orders).
- Commits 13, 19 and 21: the two Vapor examples shrank 607 and 596 B raw, 299 and
  164 B brotli, on clean trees. An earlier -14.6 KB raw reading came from a mixed
  tree and is **withdrawn**.

**Decided: docs only.** Commits 11 and 20 mean `useCommand()` after a top-level
await arms its cleanup, including across an unmount during the await. That already
held on rc.7 (`tests/async-vapor-setup-fixture.test.ts`, which compiles the SFC at
test time).

**Decided: retire nothing.** The `router/vapor` mode guard, the
`hasInjectionContext()` KeepAlive gate and the transition `settled` latch were
each re-checked, and each still carries weight. This is the step the ritual
exists to force. A guard added for an old RC is dead weight unless re-justified.
Three were re-justified rather than assumed.

**N/A by reading:** `withOnce`, `is="vue:X"`, the fallback namespace, keyed
`<component :is>`, and the removed runtime-vapor `withAsyncContext`, never
imported here. (`router/vapor` passes no key, and a component object is its own
branch key.)

**Decided: the outlet guard moves to rolldown, and stops measuring a difference.**
The esbuild guard read 19.43 KB against its 19.5 bar and failed. On clean trees
esbuild read the saving 20.06 -> 19.40, while Vite 8 / rolldown read 18.85 ->
20.42. Esbuild keeps rc.8's new top-level hydration functions, and rolldown
shakes them. **Rolldown is what consumers ship**, which is the stance Vue's own
commit 21 takes for its CSR bundles.

The interop arm's movement is Vue-originated: under rolldown it GREW 1,774 B
brotli and the Vapor arm 166 B. Attribution to individual commits is not
established.

The guard now builds with Vite's API. It asserts two limits instead of a
difference that had fired twice on improvements. Own machinery stays <= 5.0 KB
(4.23) and the saving >= 15 KB (20.42), both stamped. **The general lesson, and the reason
this is written down rather than just changed: a guard on a DIFFERENCE fires when
either arm improves. Two absolute limits cannot.**

**Alternative rejected: copying commit 18's registry object.** Measured and
declined. Not slower, but **+71 B brotli on the full IIFE**. A refactor that buys
upstream clarity buys us nothing here, and bytes are not free.

**Also in the rc.8 window**, lib-side:

- `vaporChamberWire()`, a build-only Vite plugin that wires Vue into an app
  importing the root with no import changed.
- `vcCommandVapor`, `v-vc:command` for Vapor components, reading its binding
  getter at dispatch. The `renderEffect` a tracked port needs would break the
  subpath on Vue 3.5.
- A marker guard on a Vapor consumer's Vite bundle. It asserts no vDOM binding,
  one chamber module, and a runtime probe that stays a bare `import("vue")` even
  with Vue bundled.

**Verified against rc.8:** `tsc` clean, lint clean, 2128 + 24 tests across both
projects (151 + 8 files). Coverage 100.0% on all four axes. IIFE 11.3 / 7.7 /
8.2 KB brotli, all three examples rebuilt.

#### rc.9 (Sep 21): rc.9 broke a directive here, and the fix deleted its cause

**Expected.** Eight cycles of pass-through had made a working assumption
comfortable: a renderer change lands below this library. rc.9 disproved it. One
commit, #15490, changed the shape of a value `vcCommandVapor` compares against.
Every `v-vc:command` in every compiled Vapor template stopped working, with no
warning and no error. The cycle's whole train of thought runs from that defect
to a conclusion bigger than the fix. **The notation itself was a category error,
and the defect was downstream of it.**

**Landed.** 89 commits in `v3.6.0-rc.8..v3.6.0-rc.9`, the full log rather than
first-parent. Sixteen were read in full or closed by a probe or a committed test.
The rest are closed from their title and touched files, and are marked as such in
the cycle record. The peer range narrows to `>=3.5.0 || >=3.6.0-rc.9` for `vue`
and `@vue/reactivity`. Both Vapor examples repinned and rebuilt.

**The defect.** #15490 made a Vapor custom directive's ARGUMENT a getter, so
compiler-vapor emits:

    rc.8  [_directive_vc, () => (_ctx.action), "command",         { stop: true }]
    rc.9  [_directive_vc, () => (_ctx.action), () => ("command"), { stop: true }]

and `vcCommandVapor` opened with `if (argument !== 'command') return;`. A function
never equals that string, so the directive returned before mounting: no listener,
no state, no warning, no error.

**Why 2,431 passing tests did not see it.** Both Vapor directive fixtures
hand-wrote the tuple, copied from an older compiler release, and their headers
said so. **A literal records a compiler release and then agrees with it forever.**
`tests/compile-vapor.ts` is the fix. One helper compiles the consumer's template
on the INSTALLED Vue, and reads the generated module's imports rather than
listing them. Every Vapor test that matters now runs compiler output. And
`examples/vapor-sfc` had no `v-vc:command` anywhere. So rebuilding all three
examples, which this ritual does every cycle, passed while the feature was dead.
`npm run check:example` now builds that example and drives the button in a real
page.

**Alternative rejected: accept both shapes.** Vue's own `VaporDirective` type
declares `argument?: () => Arg` with no union. So the string is not a legacy
shape but an illegal one. No Vue inside this package's peer range can emit it.
3.5 ships neither runtime-vapor nor compiler-vapor, and the second arm of the
range starts at rc.9. Accepting both would be a branch no installable Vue can
reach. Only a hand-written literal could prove it, which is **the exact
construct that hid this bug for a release**. A DEV guard names the version
needed instead, and folds to nothing in a consumer's production build.

**Decided, and it is the real conclusion of the cycle: the selector moved into the
NAME. `v-vc:command` is now `v-vc-command`.**

Vue's directive ARGUMENT is a *parameter* slot, like `v-bind:href` and
`v-on:click`, meant to be dynamic, and reactive since #15490. This package was
using it as a *selector*: the argument said which of `command`, `payload` or
`optimistic` a binding was. That is a category error. **A selector must not move.
A parameter is built to.** The two needs were in direct conflict, and the
conflict shipped a dead control.

The three names now have one shape, registered as `vc-command`, `vc-payload` and
`vc-optimistic`:

    v-vc-command    v-vc-payload    v-vc-optimistic

**It is a deletion, not a rename.** Gone with the argument read:

- the `argument()` call, and the DEV guard on a non-getter argument
- the below-floor Vue version warning that existed only to explain that guard
- both `binding.arg` guards in the vDOM registration
- the documented `v-vc:[kind]` latch, unreachable once there is no argument to
  be dynamic

Measured on a Vite production consumer bundle of `./directives`, brotli q11:
**-387 raw / -144 brotli**. All three IIFE variants are
byte-identical, since none carries directives code. They are the control, not the
target.

**Alternative rejected: a deprecation alias.** It would have to keep the exact
machinery this change exists to delete. Refused deliberately, and this is the
reason to write it down: the alias is cheap to add and permanently expensive to
carry.

**`v-vc:payload` was inert, and this fixes it.** That is the drift the split
caused. `v-vc:payload` compiled to `[_directive_vc, _ctx.p, "payload"]`: the `vc`
directive with an argument its `mounted` rejected. So it did nothing, while the
README, this whitepaper, an example header and the generated API reference all
documented it. The working spelling was always `v-vc-payload`. It now compiles
to its own `resolveDirective("vc-payload")`. Two new tests compile the notation
a consumer actually types, rather than resolving a name we chose.

**It also closes a `vue-tsc` gap.** That was not the point, and it is worth
stating carefully. vue-tsc type-checked the template call by passing the
ARGUMENT as a raw string, the pre-#15490 shape. It rejected the idiomatic
`import { vcCommandVapor as vVc }` form with TS2345. With no argument there is
nothing to mis-check. A/B in the example's own project, with a control:

- the colon form still reports TS2345
- the hyphen form exits clean
- a deliberate error in the same probe still reports TS2339, so the template is
  genuinely being checked

**The tool has not caught up.** The bug is still there for anyone using an
argument. Our usage no longer has the shape that triggers it. **If an
argument-based notation is ever proposed again, this is part of its cost.**

So `examples/vapor-sfc` no longer registers the directive app-wide. That
registration was never a style choice. It existed only to give `vue-tsc` no
declaration to check, which is opting out of checking rather than satisfying it.
The example now imports the binding, the way the documentation recommends, and its
own `vue-tsc --noEmit` build step is the proof. `npm run check:tsc-gap` and
`scripts/check-vue-tsc-directive-gap.mjs` are deleted: **a guard that can only go
red for a reason that cannot affect this package carries no information about it.**

**Upgrading**, and both halves fail silently if missed:

    - <button v-vc:command="'cartAdd'">
    + <button v-vc-command="'cartAdd'">

    - createVaporApp(App).directive('vc', vcCommandVapor)
    + createVaporApp(App).directive('vc-command', vcCommandVapor)

Vue resolves an SFC directive by camelCasing the FULL name, so `v-vc-command`
looks for `vVcCommand`. Under the old spelling the directive was named `vc` with
`command` as its argument, so the binding was `vVc`:

    - import { vcCommandVapor as vVc } from 'vapor-chamber/directives'
    + import { vcCommandVapor as vVcCommand } from 'vapor-chamber/directives'

An import left aliased to `vVc` compiles, type-checks and mounts nothing: the same
silent dead control #15490 produced. This was caught by `npm run check:example`,
which clicks the built example's button and asserts the directive responded, and
by nothing else.

##### `v-vc-payload` and `v-vc-optimistic` now work on Vapor

Two new exports, `vcPayloadVapor` and `vcOptimisticVapor`, beside
`vcCommandVapor`. All three directives now mean the same thing on both renderers,
and there is nothing left to document as unavailable on Vapor.

**What was actually missing.** `v-vc-payload` had a substitute and
`v-vc-optimistic` had none. The substitute was lossy in a way that is easy to
miss. `data-vc-payload` is JSON in an attribute. Measured through it, a `Date`
arrives as a string, a `Map` as `{}`, a class instance as a plain object. A
function and an `undefined` key disappear entirely. A handler calling
`cmd.payload.when.getTime()` worked through the binding and threw through the
attribute.

For optimistic-with-rollback there was no route at all. The Vapor consumer had to
drop `v-vc-command` for that button and hand-roll the dispatch. That forfeited
`vc-loading` / `vc-error`, disable-while-busy, the re-entrancy guard, the timeout
and the modifiers. An `@click` beside the directive could not do it either.
Since #15490's sibling `80b3a046`, that handler registers first and can veto the
dispatch.

**Read at dispatch time**, like the action, because Vapor has no `updated` hook. A
changed payload re-targets the next click without the directive re-running. A
binding beats `data-vc-payload` on both renderers, unchanged.

**Order does not matter**, and that is not free and not defensive. A compiled
template applies directives in SOURCE order. Mounting the command clears the
element's state first. So the naive port loses a payload written before the
command: a button that dispatches with nothing, silently. Tests pin both orders.

**Alternative rejected: warn on the losing order.** A consumer has no reason to
think attribute order matters. A warning would teach them to work around a
defect instead of fixing it.

**Cost** (Vite production consumer bundle of `./directives`, brotli q11): **+500
raw / +125 brotli**. The three IIFE variants are byte-identical. The `.d.ts` grows
3,238 B, which is types and JSDoc and reaches no consumer's bundle.

**The alias rule applies to these too, and it fails silently.** Vue camelCases the
whole directive name, so the imports must alias as `vVcPayload` and
`vVcOptimistic`. Anything shorter compiles, type-checks, and falls back to a
directive nobody registered. Vue warns about that in DEV and not in a production
build. `npm run check:example` now clicks the example's button. It asserts the
optimistic counter moved by the payload's `qty`. So a dead binding shows up as 1
instead of 3, rather than as nothing at all.

##### Fixed: on vDOM, a payload written before the command was silently dropped

The order-independence above was Vapor's alone. On the vDOM plugin,
`<button v-vc-payload="p" v-vc-command="a">` dispatched with **no payload**, and
`v-vc-optimistic` before the command **never ran**. No warning, no error: a
control that renders and quietly does less than it says.

Measured against the real vDOM runtime, first click, no re-render since mount:

    <button v-vc-command    v-vc-payload>    payload {qty:3}    delivered
    <button v-vc-payload    v-vc-command>    payload undefined  DROPPED
    <button v-vc-optimistic v-vc-command>    optimistic never ran

**Why it survived.** After any re-render the `updated` hook re-applies the binding
and both recover. So it is a FIRST-CLICK defect: every test that renders before
it asserts passes. The source said in as many words that the vDOM half "needs
nothing equivalent", because the next patch would fix it. That is true from the
second click. The element is clickable before the first. Take a page with no
reactive state, the Blade or sprinkled shape this library exists to serve. There
is no next patch, and it never works at all.

**What it cost beyond the payload.** One public spelling meant two things:
order-independent on Vapor, dead on vDOM. `examples/vapor-sfc` writes
payload-before-command and states that the order does not matter, which holds only
because that file is `<script setup vapor>`. A reader copying that markup into a
vDOM component got a silent no-op.

**The fix** is the one Vapor already had. The holding slot now takes vDOM values
as well as Vapor getters, and both registrations write through it. So a binding
that arrives before the command is held and claimed instead of discarded. `payload` and
`optimisticFn` join the state literal, so the hidden class no longer depends on
which renderer mounted the element.

    before   raw  27,435   brotli  7,324
    after    raw  27,419   brotli  7,340
    delta          -16             +16

Raw shrinks because four repeated hook bodies collapse into one shared writer.
Brotli grows by the same small amount because that repetition compressed almost
perfectly.

Four tests pin it:

- both before-command cases (the regression)
- the after-command case (the control, **because the cheapest wrong fix swaps
  which order works**)
- an `updated` after a claim
- an element that never mounts a command at all

##### Teardown is keyed to what was mounted, never to the current binding

Found while measuring the fix above, and older than rc.9. The vDOM `v-vc`'s
`beforeUnmount` guarded on `binding.arg !== 'command'`, and Vue passes the LATEST
binding. So after a dynamic argument moved off `command`, teardown never ran and
the element's listener outlived it.

Honest scope: reachable only through `v-vc:[kind]`, which nothing uses. The
delegated refcount is otherwise complete and correct, with plain unmount, partial,
full and double-unmount all measured correct BEFORE the fix. The fix is the
deletion of that line, since `unmountCommand` already no-ops on an element with no
state, so the guard bought nothing. **Net -56 B.** A dynamic `v-vc:[kind]` LATCHES
on both renderers alike, and is documented rather than warned about.

##### One listener-options object

Recorded at mount and handed to both `addEventListener` and
`removeEventListener`, replacing a `capture` boolean that existed only to rebuild
what was already there (**-16 B**).

`removeEventListener` is a silent no-op when the handler or the capture flag
differ. The two calls had disagreed harmlessly (`{}` against `undefined`). That
had forced the test comparing them to compare capture flags rather than
arguments. **A comparison weakened to pass will not catch what it is for:** add
`{ once: true }` to one side and removal stops matching, with no error.

##### The argument guard is DEV-only, and the state literal is one shape

Two items in `vcCommandVapor`'s mount path, found by re-reading this cycle's own
changes against the built output rather than the source.

- **The argument-shape guard shipped to production.** Only the `console.warn` was
  gated. So `if (argument !== undefined && typeof argument !== 'function') return;`
  survived a production build: a branch this entry itself argues no installable
  Vue can reach. Measured on `./directives`, production-minified with DEV folded off:
  37 bytes min, 12 gzip, 14 brotli. The behaviour ran the same way. A `return` on a
  string is a control that renders, clicks and does nothing, with no error, which
  is the exact shape #15490 left behind. Now DEV-only. Production reaches the bare
  `argument()` and throws at the line that caused it.
- **The state literal gained a hidden-class transition.** `capture` left the
  literal when it became `listenerOpts`, and the write moved after it. That
  transitioned V8's map once per mount on the direct-listener path.
  `delegatedDoc` had the same shape on the delegated path. Both are declared in
  the literal now, so every `DirectiveState` leaves `mountCommand` with one map.
  **Not benched and not claimed as faster.** It removes a transition, it cannot
  be slower, and it is not a size loss. Two `undefined` slots cost 40 bytes raw
  and give back 3 brotli.

Net on `./directives`, production-minified with DEV folded: -3 brotli, -2 gzip,
+3 min.

##### `createDirectivePlugin()` on a Vapor app now says so, in DEV

Installing the vDOM plugin on a Vapor app leaves every `v-vc-command` inert. From
rc.9 Vue skips a vDOM object directive in a Vapor template with a warning of its
own (#15489). Before that it called the object and threw a TypeError at mount. Vue
names the symptom, "Received a VDOM object directive", so ours carries only the
fix: **"On a Vapor app use vcCommandVapor."**

One own-property read (`app.vapor`, which a Vapor app carries and a vDOM app does
not), and the whole branch folds out of a production build. Measured on
`dist/directives2.js`: **+94 B raw / +21 B brotli**, of which the `if` costs 8 and
the string 13.

All three directives have a Vapor registration as of this release, so the remedy
is always an import rather than a workaround.

##### Upgrade note: a template `@click` now runs before `v-vc-command`

**Scope: only an element carrying BOTH a template `@click` and `v-vc-command`.**
Nothing else changes. No example or documented recipe pairs them.
`examples/feature-directives.html` says in as many words that there is no click
handler anywhere in it, because the directive owns the whole interaction.

`80b3a046` moved compiled custom directives to the END of a block, after the
element's props, children and `v-model`. Measured on one template with both
compilers: rc.8 emitted `_withVaporDirectives` and then `_on`. rc.9 emits them the
other way round. The directive's listener ran FIRST on rc.8 and runs SECOND on
rc.9. So a template handler now gets to veto the dispatch through
`buildHandler`'s disabled / `aria-disabled` / in-flight guard. That guard is
deliberate since v1.6.0, mirrors Vue's #14948, and is unchanged. The platform does not retract an event already in
flight, so disabling the element from that handler does not stop the click
reaching us. The guard is what stops the dispatch.

What each kind of veto does, measured on one element carrying both:

| the `@click` handler does | vDOM | Vapor direct | Vapor `.delegate` |
| --- | --- | --- | --- |
| nothing | dispatches | dispatches | dispatches |
| `el.disabled = true` | skips | skips | skips |
| `stopImmediatePropagation()` | skips | skips | skips |
| `stopPropagation()` | dispatches | dispatches | **skips** |

**This makes Vapor match vDOM rather than depart from it.** Vue patches an
element's props before it runs a directive's `mounted`. So the vDOM registration
has run second all along. On rc.8 neither veto reached the Vapor directive at
all: measured, both dispatched.

**`.delegate` is unaffected by the rc.9 reordering, and always was.** Its listener
is on the DOCUMENT and fires during bubbling, after every element-level listener,
whatever order they registered in. So emission order never decided anything for
it. The same property is why `.delegate` is the one mode that plain
`stopPropagation()` on the element vetoes. It stops the event reaching the
document, while a direct listener on that same element is not stopped by it.
**Both facts are pre-existing and inherent to delegation**. Neither was
introduced by rc.9, and neither changes with it.

If you want the dispatch to happen regardless, move the `@click` work into the
command handler, or put it on a wrapper element.

##### Inherited from rc.9, no code change here

Each reaches consumers only through an API this package re-exports.

- **`958580bf`**: a Vapor component's props are marked shallow, so `watch(props)`
  is no longer deep. Nothing here watches props or teaches it, grepped across src,
  examples, docs and README, but an app that does, through `defineVaporComponent`,
  gets the shallower watcher.
- **`ab722d18`**: reserved props are skipped in attrs and dynamic props.
- **`0e4ff650`**: an empty-string dynamic component renders an empty branch.
  `router/vapor` already passes a getter that can answer null, and this is the same
  arbitration one value further out.
- **`90ddc697`**: hydration advances past a multi-root async component.

##### BREAKING: `sync` carries facts, not commands, and leaves the dispatch chain

`sync` was a bus plugin that re-broadcast every successful dispatch and
re-dispatched it in the receiving tab. **That replicates INTENT:** each tab re-runs
the handler and derives its own outcome. Measured against a real
`BroadcastChannel` rather than the channel stub the old tests used, three things
follow, and none of them were documented:

- A handler that is not deterministic does not mirror. Two tabs running the same
  `cartAdd` minted `A-line-1-936891` and `B-line-1-675288` and stayed different.
- A tab seeded differently stays different: one ended at 1, the other at 6.
- A handler that dispatches a nested command applied that derivation **twice per
  tab**, because each tab derived its own and then received the peer's.

**Alternative rejected: suppress the receive side.** It does not fix the third
case: 6 runs become 5, not 4. The ORIGINATING tab is still broadcasting its
derivations.

**Alternative rejected: infer root from derived dispatches.** That needs the core
to distinguish them, which it does not: a root and a nested dispatch carry
identical meta. Adding a counter to do so taxes every dispatch on the bus.

**Decided: the app declares what crosses instead.** A handler computes a fact and
emits it on an event channel. The bridge puts that fact on the wire and every other
tab applies it. A derivation is not a fact unless the app emits it. So there is
nothing to infer and no counter to pay for. The receiving tab applies values
rather than recomputing them: the ordinary CQRS split between a command and
something that already happened.

```typescript
const lane = createFastLane()
lane.on('cartAdded', fact => applyToCart(fact))   // local AND remote land here
bus.register('cartAdd', cmd => { lane.emit('cartAdded', computeAdd(cmd.target)) })
const tabSync = createChannel({ channel: 'vc:app', lane, events: ['cartAdded'] })
```

**It is also roughly twice as fast, and that is the same change.** As a plugin this
cost more than half the bus's dispatch throughput. It cost that on every dispatch
of every action, whether or not it synced. Over 11 shuffled rounds of 200,000
dispatches with `gc()` per round, against a byte-identical self-control arm:

| wiring | ops/s | ratio vs bare |
|---|--:|--:|
| bare bus | 28,779,223 | 1.000 |
| as a plugin (before) | 13,199,687 | 0.459 |
| self-control, identical code | 13,062,433 | 0.454 |
| `onAfter` listener | 15,486,719 | 0.538 |
| **fast lane (now)** | **24,965,803** | **0.867** |

Migration: `sync(opts, busRef)` becomes `createChannel({ channel, lane, events })` and is no
longer passed to `bus.use()`. `filter` is gone. `events` names what crosses.
`onReceive(cmd)` becomes `onReceive(event, data)`. `_withOrigin`'s sync usage and
the `meta.origin === 'sync'` echo check are both deleted. A lane emit is
synchronous, so a plain boolean suppresses the echo. That leaves no window for
the async race that forced the origin marker.

**What it still does not do.** Facts mirror. Seeds do not. Tabs converge only if
the facts are absolute ("the count is 2") rather than relative ("add one"). And a
payload crosses through structured clone, so it cannot carry functions. A
non-cloneable payload warns in DEV, naming the event, and never takes the local
emit down with it.

##### Four sweeps, and the rule behind them

Three parts of this cycle are the same shape, and a fourth that came just after
it. The shape is the point, not which release carried each one.

**The `onSettled` sweep missed two plugins.** `src/settled.ts` records a defect
found in five shipped plugins. They read `next()`'s return value as though it
were the result. On an async bus `next()` returns a PROMISE, so `promise.ok` is
`undefined`. It was fixed with one helper. That file's closing line: a rule
applied by hand at each call site goes missing wherever nobody remembered it.

**The sweep itself was one of those hands.** It was run over the plugin family,
`plugins-core.ts`, `plugins-extra.ts`, `plugins-io.ts`, and two plugins live
outside it. Both had the identical defect, for two releases:

- **`createSSRPlugin()` recorded NOTHING on an async bus.** `dehydrate()` came back
  empty, so the client rehydrated no state at all. Measured through the public API,
  same dispatch, both bus kinds:

      sync  dehydrate: [{"action":"cartAdd","target":{"id":1}}]
      async dehydrate: []

  No error, no warning. It reads exactly like a render that had no commands to
  record, which is the same shape as every other defect in this class.
- **`schemaLogger()` printed the error branch for every command,** successes
  included, with `undefined` as the error: the defect `logger()` had, three modules
  away from `logger()`.

**The rule is now a test, not a memory.** `tests/settled-sweep.test.ts` scans every
`.ts` under `src/` for a `next()` result that is bound and then read without
being settled. It separately asserts the scan covers every module that produces
a `Plugin`: sixteen of them, not the three whose filenames begin with `plugins-`.
Comments are blanked before scanning, because `settled.ts`'s own docblock quotes
the pattern it looks for.

**Why the type system did not catch it, and does now.** `Plugin` used to declare
`next: () => CommandResult` while being usable on either bus, a lie on the async
one. Three plugins escaped it with `const plugin: any`. Collapsing, overloading
and intersecting the two types each forced one body to satisfy both signatures.
A generic does not. `Plugin` is
`<R extends CommandResult | Promise<CommandResult>>(cmd, next: () => R, fail) => R | CommandResult`.
That is a sync plugin at `R = CommandResult` and an async one at the union. So
a plugin that settles through `onSettled` (generic in `R`, and exported) fits
both buses with no cast. One that reads `.ok` off `next()` does not compile.
`SyncPlugin` is the sync-only shape. The async bus has one `use(AsyncPlugin)`.
The change found two example plugins with the defect (`examples/custom-plugins.ts`)
and the README's timing example.

**The prototype-key rule is a sweep too, before it needs to be.** `src/dict.ts` is
`src/settled.ts` one release earlier, and the shape is identical:

- a bug class found six times, each site written as if it were the first
- centralized into one helper, the rule stated in prose
- the known sites pinned by `tests/prototype-keys.test.ts`, which says outright
  that it "pins the two non-router sites"

Nothing stood between the codebase and site seven except somebody remembering.

Swept, and it currently holds. No module tests membership with `in` or with
`!== undefined`. No prototype-free object is spread back into a plain one. All
six sites `dict.ts` names call the helper. The same was true of `onSettled`,
right up until two modules grew a `Plugin` outside the family someone had
grepped. So `tests/dict-sweep.test.ts` now holds it instead of a person. Each
of its three assertions is armed by injecting the construct it bans into a real
module and watching the sweep fail.

Two things the sweep needs, because both produced false readings first. **String
literals have to be blanked as well as comments.** Without that the scan reports
26 sites, every one an error message containing the word "in" ("Retry in
200ms"). And
**a TypeScript mapped type `[K in keyof T]` is not a membership test.**

**The console-argument convention is a sweep too, and this one was swept before a
single site had broken it.** The convention:

- identifying text (an action name, a key, a count, a limit, a code) is
  interpolated into the message
- a value with structure (a caught error, an element, a command, a result, an
  options bag) is passed as a SEPARATE console argument. Devtools renders it live
  and expandable instead of flattening it to "[object Object]".

Censused 2026-09-22 over every `console.*` call in `src/`. Every interpolated
value is identifying text, and every inspectable value is already a second
argument. `JSON.stringify`, `String(...)` and `.toString()` appear zero times
inside a console argument. Nothing held that but memory, so
`scripts/check-console-shape.mjs` holds it now, in `lint:check` beside the other
guards. It prints its own counts, so the numbers here cannot go stale.

**The error-code registry is a sweep too.** It was added in v1.23.0 rather than
this cycle, and is listed here because it is the same shape. It exists because a
table called itself complete while nothing checked it. `ERROR_CODE_REGISTRY`
describes itself as "the single source of truth" and "the complete registry of
all BusError codes". `getErrorEntry(code).fix` reads it, and
`describeErrorCodes()` prints it into an LLM system prompt. So a code with no row
is a failure the library can emit and cannot explain. It surfaces as `undefined`
at the moment a developer most wants an answer. The transport work added five
codes at once. Only somebody remembering stood between that and a missing row.

`tests/error-registry-sweep.test.ts` takes BOTH sides from source: the codes
parsed out of the `BusErrorCode` union, and the rows read from the exported
registry. So there is no allowlist, nothing to update on a rename, and no
judgement call. Both directions are asserted, duplicates too, and each was armed
by injection:

- a code with no row
- a row with no code
- a renamed union declaration, which makes the parse THROW rather than return an
  empty list. A sweep that reports clean over a moved declaration is the one
  result it must never produce.

**Its limit is stated in the file, and it is the interesting part.** A completeness
diff cannot see a row that is false in a way both sides agree on.
`core:failed:handler` is exactly that: declared, registered, listed as retryable.
And no site in `src/` emits it, because a handler's throw reaches `result.error`
unwrapped (`tryCatchHandler` is `catch (e) { return errResult(e as Error) }`).
Its row promised that a handler throw arrives as that code, which was never true.
The row was corrected and the code left in place, being public API. Catching the
class needs a third question, "which site mints this?". That needs an allowlist
for the codes deliberately never minted. By this repo's bar that makes it a chore
rather than a guard.

**It classifies by TYPE rather than by a list of names that look inspectable.** A
value may be interpolated only if the type checker says it is a string, number,
boolean or bigint, or a union of those. A string enum and `typeof x` are such
unions. Everything else fails, `any` and `unknown` included. That is
`check-ascii.mjs`'s lesson applied on purpose: **an alphabet is worth exactly the
characters somebody thought of. That list has been wrong here three times.**

The two calls that look like exceptions need no allowlist entry, because they
pass on shape. `validateNaming`'s `console.warn(msg)` interpolates nothing at the
call. The router's `console.error(error)` is the convention itself.

**The arming is in the guard, not in a session's notes.** `--self-test` injects
five violations into real modules. They are an object in a template,
`JSON.stringify` in a message, `String()` around a value, and both exempt sites
rewritten into the violating shape. It confirms each is caught. It restores every file by copy in a
`finally`, asserting the restore rather than assuming it.

It refuses to start unless git says every file it will write is clean. A
`finally` does not run on SIGKILL, so an interrupted run would leave an injected
defect in a real module. And this repo has had two sessions editing one working
tree at once. Refusing also makes that trace DETECTABLE: the file shows as
modified next time rather than being quietly re-mutated on top.

The two exempt sites are in there for a reason. A shape-based exemption that
quietly matches too much is indistinguishable from a working check. That is the
`onSettled` sweep's filename-scoping failure in another costume.

It is not in `lint:check`: it rebuilds the program per mutation and writes to
`src/`. It is not in the suite: no test here drives a `scripts/check-*.mjs`, and
a second-long `ts.createProgram` does not belong in a vitest run. Blunt the
classifier and the gate still reports OK while `--self-test` exits 1, measured.
That is the point of having it.

**Two limits stated rather than discovered later.**

- A value that is genuinely a string but typed `any` fails this check.
  `String(...)` is rejected by the same guard. So the way out is a cast at the
  call site, a claim a reviewer can see. The failure message says so.
- The blind spot: a message assembled into a local and then logged passes
  unexamined. Following an initializer means deciding which declaration a name
  refers to. Being wrong about that is worse than a limit written down.

**`CONTRIBUTING.md` opened its `lint:check` paragraph with "Four guards" and then
named exactly four.** The fifth made both wrong, and nothing watched that
sentence. `check-doc-claims` reads docblocks, absent defaults and release status,
not prose counts. **The count is gone rather than bumped**, since five would have left the
same trap armed for guard six. The paragraph names its guards now.

**The general rule this repository keeps rediscovering.** A bug class fixed by
writing the rule down is not fixed. It is deferred to whoever reads the prose next.
Two helpers now exist solely to centralize such a rule, and both had the same gap.
**From here, a helper introduced to centralize a bug class ships with a sweep.**
The sweep scans every module for the construct it replaces. Not a test per known
site, and not a grep scoped to the filenames that happened to be involved the
first time.

##### Still watching

- **The `Plugin` / `AsyncPlugin` overload: CLOSED** by a generic `Plugin` (see
  "Why the type system did not catch it, and does now").

- **A bound update overwrites what `v-vc-command` writes by hand.** The directive
  adds `vc-loading` / `vc-error` directly on the element. On a button it also
  adds `aria-disabled` while in flight, not `disabled` since the focus fix (see
  the v1.25.0 CHANGELOG entry). Vue compares a binding against its own previous
  value, not against the live DOM. So a hand-written value survives until that
  binding next moves, and is then overwritten wholesale.

  Measured on compiled templates. On an element that is NOT the component root,
  a `:class` update drops `vc-loading` on BOTH renderers. On a component root,
  where the class arrives as a fallthrough prop and Vue patches it through
  `classList`, it survives. `:aria-disabled` behaves the same way. A binding that
  flips mid-dispatch leaves the button announced as enabled while presses do
  nothing. Re-entrancy is blocked by internal state a binding cannot reach.
  `:disabled` no longer competes with the directive at all. It stopped writing
  `disabled`, so a value the app binds is left alone.

  rc.9's `a5f7a2c1` ("keep transition classes when updating class binding") is
  upstream solving the same class of problem for its OWN classes. It does so
  through a list userland cannot join. **Until this is fixed, do not put
  `:class` or `:aria-disabled` on the same element as `v-vc-command` unless that
  element is a component root.**
- **Composables imported from the package ROOT degrade in a production bundle.**
  Known since v1.20.0, and now measured in a real production bundle rather than a
  model of one. `loading` is not a Vue ref, a listener registered through
  `useCommand().on()` outlives `app.unmount()`, and the KeepAlive guard is inert.
  Stated precisely, because the obvious phrasing is wrong. The state still
  ADVANCES: the reducer runs and `state.value` changes. It is simply not
  reactive, so a template bound to it never re-renders. The remedy is unchanged and
  three-fold: import from `vapor-chamber/vue` or `vapor-chamber/vapor`, or let
  `vaporChamberWire()` do it at build time. The production warning that names those
  remedies fires in that bundle, which this cycle confirmed.

**Sizes.** All three IIFE variants are **byte-identical across the whole series**
(40,944 / 27,891 / 29,655 raw, 12,094 / 8,177 / 8,673 brotli): `src/directives.ts`
ships in none of them. The whole cost of the cycle is **+310 B raw / +117 B brotli
on `dist/directives2.js`**, the opt-in directives subpath. It is the DEV version
guard, which a consumer's production build folds away, and the listener-options
field.

Vue's own numbers moved, and the generated table now says so:

- the hand-wired `createVaporApp` minimum 44.1 -> 44.5 KB minified
- `vapor-chamber/vapor` over it 4.8 -> 4.4
- `+ vaporInteropPlugin` 81.7 -> 84.2

Every vapor-chamber export row is unchanged at brotli. The committed guard, on
this tree, reads the Vapor outlet's saving at 21.14 KB brotli against the 20.42
recorded on rc.8. Own machinery reads 4.21 against 4.23. The direction, that rc.9 makes the
vDOM-plus-interop alternative more expensive rather than less, is what the numbers
support.

**Added: `npm run gate`.** One chain in the house order: typecheck, build,
test:run, test:vapor, size:check, lint, coverage, stamp check, docs, size:doc,
clean tree. It fails fast, prints one result line per step, and a failure names
the step. So `git rebase --exec` identifies both the commit and the step.
`npm run docs` and `npm run size:doc` regenerate files, so each is followed by a
scoped `git diff --exit-code`. The chain ends by asserting a clean tree: **drift
fails the gate instead of being repaired by it.** The rule it enforces had failed three
times before this.

[#15490]: https://github.com/vuejs/core/pull/15490

#### rc.10 (Sep 30): nothing changed here, and the reading found what we had never tested

**Expected.** rc.9 had broken a directive, so the forecast for rc.10 was the
same kind of damage. It had 85 commits, 27 of them in `vdomInterop.ts`, one
rewriting how a Vapor component receives its inputs. The forecast was wrong. Nothing in
`src` needed a line. What the cycle found instead was a configuration this
library documents and had never mounted.

**Landed.** 85 commits in `v3.6.0-rc.9..v3.6.0-rc.10`, the full log. Eighty-three
were read in full at source. The other two are the Vitest 5 chore and the release
commit. The peer range narrows to `>=3.5.0 || >=3.6.0-rc.10`. Both Vapor examples
repinned and rebuilt.

**Decided: no code change, three tests.** Eight probes were written and run on
rc.9 BEFORE the bump, then again after it. So each claim about rc.10 has a
measured before. Three of them became committed tests, each failing on rc.9 in a
clean worktree and passing on rc.10:

- The vDOM directive plugin on a Vapor child under `vaporInteropPlugin`. On rc.9 a
  root `v-if` / `v-else` left `v-vc-command` on the element that had gone. The
  new root dispatched nothing, the detached one still did, and `.delegate` never
  released its document listener. Upstream moved directive hooks for a Vapor child
  into interop, which follows the root and unmounts with the bindings it mounted
  with. That is the rule at the top of `directives.ts`, built on Vue's side.
  No test of ours had installed the plugin together with interop.
- A function set on a `defineWidget` property arrives as the function. rc.9 called
  it as a prop getter.
- `:onClick` beside `v-vc-command` in a Vapor template is a listener, so it can
  veto the dispatch. On rc.9 it compiled to a property write that never ran.

**Forecasts that failed, kept because they failed.** The reading pass predicted
that the function-valued input change also reached `createVaporChamberApp`'s root
props. Measured: it does not. A function there is still a getter. It predicted
the keyed-insert reordering flipped the handler owner for every N-row insert.
Measured: only when rows join a list that already has rows. An initial mount was
source order on rc.9 already.

**Measured.** The A/B against rc.9 reads SAME on both workloads, five runs.
Sizes grew, and all of it is Vue's:

- the hand-wired `createVaporApp` minimum 15.1 -> 16.0 KB brotli
- `+ vaporInteropPlugin` 26.4 -> 28.0
- the Vapor outlet's own machinery 4.13 -> 4.58 against its 5.0 ceiling
- its saving over interop 21.18 -> 22.22

Every vapor-chamber export row is unchanged.

**Still watching.**

- The outlet ceiling had 0.42 KB left after the bump, with the outlet's source
  unchanged. The slot fix below took 0.16 of it: 4.74 of 5.0.
- The `vc-loading` limitation above is unchanged, now measured in six arms. It is
  lost on a non-root Vapor element and on any vDOM element, and kept on a Vapor
  component root.
- Two defects found by the probes, both present on rc.9 as well.
  - The Vapor `RouterOutlet`'s reactive default slot stopped reacting once a
    child route had shown. Ours, and fixed after the alignment was gated, as its
    own change. The outlet built the slot once in setup, and reused the block
    after Vue had removed it. Removing a fragment stops its scope. It now creates
    the slot inside a `createIf` branch, the call compiler-vapor emits for the
    same template.
  - vDOM `<Transition mode="out-in">` throws when `done()` is called
    synchronously. A plain hook does that as readily as the transition bridge on
    a sync bus. Vue's, not fixed here. Reproductions are in the cycle record,
    section 35.10. Reported as vuejs/core#15727. A fix is proposed in
    vuejs/core#11824 (section 35.39).
- Server and client must be on the same RC: rc.10 changed the markers the server
  writes around a slot fallback and inside a Vapor `<TransitionGroup>`.

---


### C. Corrections this document recorded about itself

Each passage as it stood, under the section it stood in. Its non-ASCII marks
are written in ASCII.

#### From 5.2 Dispatch flow

Until v1.20.0 step 1 read "check sealed / disposed / recursion depth". Dispatch
checked neither of the first two, and still does not: `seal()` gates
configuration (register, use, the hooks, respond, clear), not dispatch, and there
is no disposed state - `dispose()` settles pending requests and leaves the bus
usable.

#### From 5.2 Dispatch flow

The plugin chain is built once when plugins are added or removed. Each dispatch creates the
innermost `execute` closure and one `next` closure per plugin level: the runners are re-entrant, so
the bus's retry and deferred continuations re-enter the chain at the right level (`buildRunner`'s PERF
NOTE in `src/command-bus.ts` records the cost). This paragraph used to end "no per-dispatch
allocations for the chain traversal", the claim docs/performance.md also corrected.

#### From 9.4 Lifecycle cleanup

This section previously extended that to `onUnmounted()`, claiming it "will silently fail"
in Vapor too. **That is false, measured on rc.4.** In a real `defineVaporComponent`, all of
`onMounted`, `onBeforeUnmount`, `onScopeDispose` and `onUnmounted` fire, in exactly that
order - the vDOM-aligned sequence rc.3's #15262 landed, which the rc.3 row of the alignment
log (section 9) already records. The two statements contradicted each other in this document. `onScopeDispose` is still the right choice, but for a better reason than a broken
alternative: it is the one hook that works in component `setup()`, a bare `effectScope()`,
Vapor, and SSR alike, which is why Vue's own composables use it.

#### From 9.4 Lifecycle cleanup

- `tryAutoCleanup()` uses `onScopeDispose` **only** - there is no `onUnmounted` fallback,
  and this section used to claim there was. It was removed once `getCurrentScope()` made the
  try/catch unnecessary: inside any `setup()` a scope is always present, so the fallback was
  unreachable code describing a hazard that no longer existed.

#### From 9.4 Lifecycle cleanup

The rule above was documented here **before** it was followed everywhere: `tryKeepAliveHooks`
gated on `getCurrentInstance()` until the rc.4 cycle, so KeepAlive pause/resume was inert in
every Vapor component while this page described the hazard correctly. A documented invariant
is not an enforced one - that is what the fixture is for.

#### From 10.3 Directive plugin

`vcCommandVapor` reads that getter at dispatch time, so a changed binding
re-targets the next click without the directive re-running. It deliberately
tracks nothing: an effect would need `renderEffect`, which only Vue's Vapor
build exports, and a static import of it would break this subpath for Vue 3.5
consumers of the plugin. `v-vc-payload` and `v-vc-optimistic` are Vapor
directives too as of **v1.22.0** (`vcPayloadVapor`, `vcOptimisticVapor`), read
at dispatch time for the same reason the action is. They were vDOM-only before
that, and the asymmetry is what closed it: the same public spelling meant
different things per renderer, which is the shape that produced the
`v-vc:payload` drift in the first place. The payload had a lossy substitute -
`data-vc-payload` is JSON in an attribute, so a `Date` arrives as a string, a
`Map` as `{}`, a class instance as a plain object and a function not at all -
and optimistic-with-rollback had none, so a Vapor consumer had to abandon the
directive and hand-roll the dispatch, losing `vc-loading`, disable-while-busy,
the re-entrancy guard, the timeout and the modifiers with it. A binding beats
`data-vc-payload` on both renderers, and the two may be written in either order
relative to `v-vc-command`.
`tests/directives-vapor-fixture.test.ts` pins it on a real Vapor mount (click,
`.stop`, re-target, unmount, `.delegate`, app-wide registration). The plugin's
install-time warning no longer says "not ported to Vapor", because it now is:
it reads `[vapor-chamber] On a Vapor app use vcCommandVapor.` The warning
itself stays, and has to. `createDirectivePlugin()` registers vDOM OBJECT
directives, which a Vapor template skips (Vue's own #15489 warning fires
beside ours), so installed on a Vapor app the plugin does nothing at all. DEV
only, behind one own-property read - a Vapor app carries `vapor`, a vDOM app
does not - and the branch folds out of a production build. The same fixture
pins that both messages fire and that they are different messages.

#### From 10.3 Directive plugin

This section once called the feature itself VDOM-only. That was never true:
`withVaporDirectives` ships in every `@vue/runtime-vapor` dist that was
unpacked to check, 3.6.0-alpha.3 through rc.3, and rc.3 only hardened it
(#15258 codegen, #15167 async component roots, #15158 fragment roots). The
releases after rc.3 were not unpacked for this, so the claim is the range, not
every version this project has since tracked.

#### From 10.4 Vite HMR plugin

**The transform takes SCRIPTS only**: `.ts`, `.js`, `.tsx`, `.jsx`. `.vue` and
`.vapor.vue` were in that list and were removed, because the injection into
them never once reached the browser: the plugin is `enforce: 'pre'`, so it sees
the raw SFC text and a prepended import lands outside every block, where
`compiler-sfc` discards it without a word. Nothing was lost, because nothing
was ever gained - the shim reaches the graph through the entry script, and the
virtual module is a singleton, so one import anywhere is the whole mechanism.
An `index.html` that Vite itself serves gets the shim regardless, injected
ahead of the app's own module script. What is left uncovered is an app served
from a backend template whose entry script never names the package, which no
amount of module matching can fix.

#### From 11.5 WebSocket-based realtime

A protocol-aware `createEchoBridge` adapter for Laravel Reverb / Echo (native
channels, private channels, presence) **shipped in v1.5.0** and is exported from
`vapor-chamber/transports`. (This paragraph said "on the roadmap - not yet
shipped" for twelve minor versions, and section 18 has recorded that as a known error
of this document since it was noticed - without the sentence itself ever being
corrected. A correction logged somewhere else is not a correction.)

#### From 11.6 Blade + CDN

**Vapor mode detection without a bundler.** `isVaporAvailable()` /
`createVaporChamberApp()` will report Vapor as unavailable here even with
Vue 3.6 installed, and that is correct, not a bug: Vue ships Vapor as a
**physically separate build** (`vue.runtime-with-vapor.esm-browser.js`) -
the plain `vue.esm-browser.js` a `<script type="module">` or bare
`import('vue')` resolves to never contains it. A bundler reaches Vapor through the bundler entry
(`vue.runtime.esm-bundler.js`), which re-exports `@vue/runtime-vapor`; that is
why the Vite examples reach Vapor and this zero-build path does not.
(This section used to say the Vite examples alias `vue` to the with-vapor build
in `vite.config.ts`. They did until v1.17.0; the alias was then deleted because
building each example with and without it produced byte-identical output.)

That alias, though, only makes Vapor *present* - it does not make it
*detectable*. `configureVue()` is what makes it detectable, and it is needed
under a bundler too: see the correction at the end of this section, where the
built `vapor-sfc` example threw on a page that had Vapor bundled into it. Treat
the recipes below as the general wiring, not a no-build workaround.

#### From 11.6 Blade + CDN

**Why not `window.__VUE__`, which earlier versions of this section recommended.**
That key belongs to Vue, and Vue writes a **boolean** to it: `target.__VUE__ = true`,
assigned from `prepareApp()` (Vapor) and `baseCreateRenderer()` (vDOM) - i.e.
the moment the first app is created, in both dev and production builds. So a
namespace parked there survives only until something mounts. The old recipe
still works when vapor-chamber's one-shot probe wins the race against your own
`mount()`, which is why it held up in practice - but it fails, silently, in any
arrangement where the library is evaluated after the first app: a code-split
chunk, a second island, an MPA page with different script order. Detection then
falls through to the async `import('vue')`, which on a no-bundler page is a
bare specifier the browser cannot resolve at all, and
`createVaporChamberApp()` throws "Vue 3.6+ with Vapor mode required" on a page
that demonstrably has Vapor.

`tests/vue-detection-real-ordering.test.ts` (real build, real
`createVaporApp().mount()`, real freshly-evaluated `chamber.ts`, nothing
mocked) and `tests/vue-detection-global-clobber.test.ts` measure this end to end.
`chamber.ts` no longer reads `__VUE__` (`tests/vue-global-detection.test.ts`).
A page that parked Vue there moves it to `__VAPOR_CHAMBER_VUE__`, or calls
`configureVue(Vue)`.

#### From 11.6 Blade + CDN

**Correction - the scope is wider than this section first claimed.** It said
"under a bundler the async fallback resolves and the bug is invisible". That is
true in `vite dev` and **false in `vite build`**, and the flagship
`examples/vapor-sfc` was shipping broken because of it: the built page rendered
nothing and threw *"Vue 3.6+ with Vapor mode required. No Vue detected."* while
the with-vapor runtime sat bundled in the very same 94 KB file. This was found by
loading the built `dist/` over plain HTTP and capturing the throw, not by
reasoning about it.

Both channels are absent in a production bundle:

- the **synchronous** channel reads the owned global slot, and the only thing
  that primes it under Vite is `vaporChamberHMR()`'s companion module - which is
  `apply: 'serve'`, deliberately, so it never runs in a build;
- the **async** channel is a bare `import('vue')`, which a browser cannot resolve
  from a built bundle with no import map. It rejects into an empty `catch`.

So any app that calls `createVaporChamberApp()` synchronously at module scope -
the shape every example and every doc snippet used - depends on a channel that
only exists in dev. What made this invisible is narrower than "a bundler": it is
*the dev server*. The suite missed it because the tests exercise `chamber.ts`
directly and the examples were only ever opened via `vite dev`.

The fix is `configureVue(Vue)`, and it is **required** rather than advisory for
bundled Vapor apps: it seeds the registry synchronously from the same aliased
`vue` instance the compiled SFCs use, so there is no channel to race.
`examples/vapor-sfc/src/main.ts` now does this and its built output renders;
pinned by `tests/vapor-sfc-prod-detection.test.ts`. The alternative - `await
waitForVueDetection()` before the first call - cannot help here, because the
async channel it waits on is the one that rejects.

The failure is also no longer silent: the thrown message now distinguishes
"no Vue here", "Vue here without the Vapor build", and "Vue here but its
namespace could not be reached", and names `configureVue()`.

#### From 19 Core Guarantee

- **<!-- vc:sizeCore -->4.7<!-- /vc:sizeCore --> KB brotli dispatch core** - measured ([BUNDLE-SIZES.md](./BUNDLE-SIZES.md)); this line read "~4 KB gzipped" while every other size in this document is brotli, which is a different number for the same artifact

#### From 21 File Map

The per-file test inventory that used to sit here was removed rather than
re-synced. It drifted four times (13 -> 40 -> 47 -> 85 files) because it is a
third copy of something two other places already track, and the project has
made this call before: v1.10.0 deleted the README's size table instead of
re-syncing it, and v1.11.0 did the same to `ROADMAP.md`'s version table. A
third copy is a third thing to keep true.

#### From 17 Comparison (its peer sizes were never verified here, and naming is opt-in, not enforced)

| | Livewire | Alpine.js | HTMX | Vapor Chamber |
|---|---|---|---|---|
| Backend coupling | Laravel only | none | none | none |
| Build required | no | no | no | no (IIFE available) |
| Reactivity model | server-driven | x-data | hypermedia | Vue Vapor signals |
| Transport | AJAX/WS (built-in) | none | AJAX (built-in) | plugin |
| Bundle size | ~50KB | ~15KB | ~14KB | <!-- vc:sizeCore -->4.7<!-- /vc:sizeCore --> KB brotli core |
| TypeScript | partial | no | no | full |
| Vue DevTools | no | no | no | yes |
| Undo/redo | no | no | no | built-in |
| Cross-tab sync | no | no | no | built-in (a store's `share`; `createChannel` for facts) |
| State persistence | no | no | no | built-in |
| Retry/backoff | no | no | no | built-in |
| LLM-token efficient naming | no | no | no | enforced |

#### From 7 Comparative Analysis, the positioning table

### Vue has Pinia and vue-router: positioning, stated plainly

Both official libraries are good and are the right default for a generic Vue SPA. This repo ships its own router and its own store anyway, so the
justification has to stay sharp or the honest answer is "use theirs".

| | official | here | the difference that justifies existing |
| --- | --- | --- | --- |
| router | vue-router | `vapor-chamber/router` | built for the server-owned catch-all: generated route tables, blade rows, typed query-as-state, a vDOM-free core with the renderer opt-in by subpath. vue-router renders through a vDOM `RouterView` and owns its own conventions |
| store | Pinia | `vapor-chamber/store` | mutations-as-commands: undo, persist, optimistic, idempotent and per-key ordering exist *because* a bus exists underneath. Pinia grew a mini-bus (`action()` / `$onAction`) because one does not. Across tabs a store shares the state it reached (`share`), never the command; `createChannel` (named `sync` until v1.23.0) carries facts on a fast lane since v1.22.0 and never sees a dispatch (docs/store.md) |

Two honesty rules keep this from drifting into not-invented-here. **Lessons flow
in**: vue-router v5's query hardening became the prototype-key rule in
`src/dict.ts`; Pinia's root-state-ref, scope hierarchy and state-factory
patterns are the store's skeleton, studied at source and never copied as code.
And **the recommendation stays audience-scoped**: an app that is not behind a
server-owned catch-all, does not speak the bus, and renders vDOM should use
vue-router and Pinia, and these docs must keep saying so.

#### From 6 Design Decisions, why no state in the bus (its first paragraph, before the reversal in A.3)

### Why no state in the bus?

Every tool that owns state also owns the responsibility for invalidation, hydration, persistence,
and synchronization. Pinia, TanStack Query, and Inertia already solve these problems well within
the Vue + Laravel stack. Adding a state layer to vapor-chamber would create a fourth source of
truth and a competition problem. The bus coordinates state transitions. It does not store state.

#### From 6 Design Decisions, why commandKey

### Why `commandKey`?

A stable `action:target` string key enables cache invalidation integration with TanStack Query.
It was already internal (used by the throttle plugin). Making it public is a one-line export
that unlocks a documented integration pattern.

#### From 8 Full Plugin Catalogue, the retry row (retry is the async bus option, not a plugin)

| `retry` | Resilience | Exponential/linear/fixed backoff on failure |

#### From 5.6 Transport plugins, a version note in the example

  scopeController: ctrl,                     // v0.6.0: all requests cancelled on dispose

#### From 9.1 The reactivity rewrite (dated)

**Vapor has been feature-complete since beta.8** (March 2026): `<script setup vapor>`,
`createVaporApp()`, `vaporInteropPlugin`, `<Teleport>` / `<Suspense>` / `<KeepAlive>`, and
`defineAsyncComponent` all work, with the `vapor` attribute as the per-SFC opt-in. The
alien-signals reactivity that shipped with it brought Vue's headline gains: ~14% less memory for
reactive state, ~40% less CPU on complex visualizations, ~100k components mounted in ~100 ms
(SolidJS parity), sub-10 KB Vapor-only bundles, ~66% smaller JS payload.

#### From 9.3 Vapor mode (an unmeasured figure)

// Pure Vapor app (~40KB smaller - no VDOM runtime). The static entry wires Vue

#### From 9.5 Memory: useCommand vs defineVaporCommand (estimates, never measured)

### 9.5 Memory: useCommand vs defineVaporCommand

Each `useCommand()` call creates 2 signals (`loading`, `lastError`):

| Vue version | Per signal | 50 components using useCommand |
|-------------|-----------|-------------------------------|
| Vue 3.5 (Proxy) | ~200 bytes | ~20 KB |
| Vue 3.6 (alien-signals) | ~64 bytes | ~6.4 KB |

_Byte figures are order-of-magnitude **estimates** (an alien-signals reactive node vs a Vue 3.5
reactive `Proxy` + dep wrapper), **not measured heap allocations** - our bench suite measures
throughput, not memory. The robust claim is the **direction**: 3.6's alien-signals backing is
materially lighter than 3.5's Proxy._

`useCommand()` is the single command composable: it bundles reactive `loading`/`lastError`
state with `register()`, `on()`, `emit()`, and `dispose()`, and never calls
`getCurrentInstance()`, making it safe in both Vapor and VDOM components. Cleanup runs
automatically on scope disposal.

`defineVaporCommand()` creates 0 signals - suitable for fire-and-forget dispatches where
loading/error state is not needed in the template.

| Composable | Signals | Vapor-safe | Use case |
|------------|---------|------------|----------|
| `useCommand()` | 2 | yes | UI-bound dispatch + register/on/emit (Vapor & VDOM) |
| `defineVaporCommand()` | 0 | yes | Fire-and-forget (analytics, scroll, search) |

#### From 10.3 Directive plugin (wrong since the focus fix: in flight it sets aria-disabled, never disabled)

The directive applies `.vc-loading` (which disables the button) and, on failure, `.vc-error`.

#### From 11.9 The composed Vapor surface (wrong: createCommandBus takes no plugins option, so this never installed revalidateRoutes. Also a dated note)

const bus = createCommandBus({ plugins: [revalidateRoutes(router, loaders, MAP)] });
const cart = useCart(bus);

createVaporChamberApp(App).use(router).mount('#app');
```

Every import reaches Vue statically, so there is no `vaporInteropPlugin`, no
`configureVue()` call and no wiring list to forget. The prod-only probe failure
class v1.17.0 killed stays killed across all of them.

#### From 11.2 With TanStack Query (the evaluation's outcome)

shared read state. What survived that evaluation was this repo's own
unconnected wiring - the loader cache above, and the `isRevalidating` lane that
makes a stale-while-revalidate commit expressible.

#### From 13 Migration Strategy (an unmeasured figure)

// No VDOM runtime loaded - ~40KB baseline savings

#### From 14.3 Dehydrate on server, rehydrate on client (the hand-written recipe, before the library's createSSRPlugin and rehydrate)

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


#### From 21 File Map (the map before it was completed: five modules, transitions/vapor.ts and ten router modules missing; the shared bus listed in chamber.ts)

#### 21. File Map

```
src/
  command-bus.ts    - core sync/async bus, plugin pipeline, BusError, inspectBus, types
  chamber.ts        - signal probe, shared bus, tryAutoCleanup, useCommand,
                      useCommandState, useCommandHistory, useCommandGroup,
                      useCommandError
  chamber-vapor.ts  - createVaporChamberApp, getVaporInteropPlugin,
                      defineVaporCommand, useVaporAsyncCommand
  fast-lane.ts      - createFastLane (minimal-allocation single-handler hot dispatcher)
  signal.ts         - signal() + configureSignal (Vue shallowRef auto-detect -> plain-object fallback)
  alien-signals.ts  - alienSignalAdapter, configureAlienSignals (opt-in alien-signals backing)
  reactive.ts       - deepSignal, useDeepCommandState (deep-reactivity companion, vapor-chamber/reactive)
  observable.ts     - observe, dispatchFrom (RxJS-style observable adapter)
  plugins-core.ts   - logger, validator, history, debounce, throttle, authGuard, optimistic
  plugins-io.ts     - persist, createChannel
  plugins-extra.ts  - cache, circuitBreaker, rateLimit, metrics
  plugins-schema.ts - validateSchemas / validateSchemasAsync
  plugins.ts        - barrel re-export of plugins-core + plugins-io
  schema.ts         - schema bus, toTools / toAnthropicTools / toOpenAITools, schemaValidator, LlmAdapter
  form.ts           - createFormBus (validation, async validators, the server's `errors` pointers)
  http.ts           - createHttpClient, postCommand, readCsrfToken, invalidateCsrfCache
  http-cache.ts     - createResponseCache (per client: one cache and dedupe map per createHttpClient)
  http-errors.ts    - the HTTP contract: problemOf, isRetryableStatus, classifyError, ProblemDetails
  http-query.ts     - buildFullUrl (URL + query-string builder)
  transports.ts     - createHttpBridge, createWsBridge, createSseBridge, createEchoBridge
  transitions.ts    - createTransitionBridge, useTransitionCommand
  directives.ts     - createDirectivePlugin (v-vc-command + event modifiers)
  ssr.ts            - createSSRPlugin, rehydrate (dehydrate / replay)
  utilities.ts      - createChamber, createWorkflow, createReaction
  store.ts          - defineChamberStore (state whose every mutation is a command)
  outbox.ts         - durable offline queue, replayed in order on reconnect
  mcp.ts            - MCP server layer: a schema action becomes an MCP tool
  stream-parser.ts  - dependency-free incremental JSON parser
  vue.ts            - the entry for apps that have Vue (wires Vue at build time)
  vapor.ts          - the entry for Vue 3.6 Vapor apps (same, plus Vapor)
  vitest.ts         - the Vitest entry, with its side effects (setup file)
  vitest-pure.ts    - the same helpers, registering nothing
  vitest-mcp.ts     - a Vitest MCP server: runTests / getTestResults / getCoverageGaps
  vite-hmr.ts       - vaporChamberHMR() and vaporChamberWire() Vite plugins
  devtools.ts       - Vue DevTools integration (dynamic import)
  dict.ts           - prototype-free dictionaries (one rule, one place)
  settled.ts        - onSettled: read a result that may be a promise, on either bus
  scheduler.ts      - lanes (serialize) and cancellable waits (the bus's retry, the outbox)
  ledger.ts         - the one undo/redo ledger behind history() and useCommandHistory()
  a11y.ts           - announce() / setAnnouncer(): status messages for assistive technology
  router/           - the router subpath (Vue 3.6 over a server-owned catch-all)
    engine.ts       - navigation: guards, two-phase commit, query fast path
    table.ts        - rows -> compiled table (chains, query defs, matching)
    history.ts      - base-aware web + memory history
    loaders.ts      - loader SPI; presets resolve a row's `load` string
    composables.ts  - useRoute / useQueryParam / usePagination / useMenu / ...
    dom.ts          - link interception, data-active stamping, idle preheat
    vdom.ts         - RouterOutlet (vDOM), makeBladeComponent
    vapor.ts        - RouterOutlet (Vapor-native, experimental)
    remote.ts       - routerHttp, bladeFetcher (opts into the http client)
  router-fetch/     - in-box loader preset for plain-JSON backends
  testing.ts        - createTestBus, snapshot, time-travel
  iife.ts           - CDN entry -> window.VaporChamber (full variant)
  iife-core.ts      - CDN entry, core variant
  iife-elements.ts  - CDN entry, elements variant
  index.ts          - public ESM barrel

tests/                           (<!-- vc:testFiles -->326<!-- /vc:testFiles --> files, <!-- vc:tests -->3571<!-- /vc:tests --> tests)
```

The per-file test inventory that used to sit here was removed rather than
re-synced. It drifted four times (13 -> 40 -> 47 -> 85 files) because it is a
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


#### From 22 References (two replaced: Vite 7.0, and the vuejs/vue-vapor repository; Vapor lives in vuejs/core)

#### 22. References

1. Pereira, L. F. (2026). *Empirical Validation of Cognitive-Derived Coding Constraints and
   Tokenization Asymmetries in LLM-Assisted Software Engineering*. Zenodo.
   https://zenodo.org/records/18853783
2. Vue 3.6.0-beta.8 Release (Vapor feature-complete): https://github.com/vuejs/core/releases/tag/v3.6.0-beta.8
3. Alien Signals: https://github.com/stackblitz/alien-signals
4. Vue Vapor Repository: https://github.com/vuejs/vue-vapor
5. Vite 7.0: https://vite.dev/blog/announcing-vite7

---


#### From 4.3 Build optional (unbacked: no measurement of the 30 seconds exists here)

##### 4.3 Build optional

Vapor Chamber ships as an ES module and as an IIFE. Load it from a CDN inside a Blade template
and a reactive command bus runs in under 30 seconds, with no npm involved.

#### From 4.5 camelCase action names (wrong: no lint rule enforces a complexity bound)

**The CDCC constraint:** The same paper finds that functions at cyclomatic complexity <= 10
receive **3.3x more LLM output per input token** than functions that violate that bound
(output/input ratio 0.141 vs 0.043, p < 0.001). Vapor Chamber therefore enforces CDCC-compliant
function sizes throughout the codebase, and handler design encourages small, single-responsibility
functions: one action, one function, one outcome.

### D. Removed sections

#### 18. Roadmap

This section used to carry a per-version feature list. It was a frozen snapshot
from the v1.0 era and had stopped being true. Twelve minor releases later, it
still presented **v0.8.0** and **v0.9.0** as *upcoming* and **v1.0.0** as
*current*. It listed `createEchoBridge` as unshipped when it landed in
**v1.5.0**.

Removed rather than re-synced, on the rule the old file map applied (part C,
"From 21 File Map"): a third copy is a third thing to keep true. Forward-looking
plans and the version policy live in [`ROADMAP.md`](../ROADMAP.md). What each
release actually changed lives in [`CHANGELOG.md`](../CHANGELOG.md). Per-release
Vue alignment detail is part B's table above.

#### 20. Implementation Status

Removed for the same reason as section 18 above, and with the same evidence. It
was headed "Implemented (v0.6.0)" / "Implemented (v1.0)". Its "Remaining" list
still had `createEchoBridge` (shipped v1.5.0) and the `vapor-chamber/rx` bridge.
The shipped `vapor-chamber/observable` subpath superseded that bridge: it is the
`Symbol.observable` interop RxJS reads natively through `from()`.

Per-module status with test coverage now lives in exactly one place:
[`ROADMAP.md`](../ROADMAP.md)'s feature-matrix appendix, beside the generated
[`docs/COVERAGE.md`](./COVERAGE.md).
