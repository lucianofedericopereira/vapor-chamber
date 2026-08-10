# Roadmap

This project tracks Vue 3.6 through its **release-candidate** phase (rc.1
landed 2026-07-18; rc.2 on 2026-07-22). That has direct consequences for what's
stable, what's transitional, and what will change once Vue 3.6 ships stable.
This file is the source of truth for that distinction.

Last reviewed against **Vue 3.6.0-rc.2** (2026-07-22).

---

## Posture: feature-complete; tracking Vue to stable

**The feature set is complete as of v1.5.0 and now locked.** v1.5.0 closed the last
planned capabilities — `serialize`, `idempotent`, `onMissing:'buffer'` deferred
dispatch, `createEchoBridge`, and the `vapor-chamber/reactive` companion — so the
command bus, plugins, transports, composables, schema/LLM layer, form bus, HTTP
client, testing utilities, and the Vapor surface are considered done. From here the
only forward motion until Vue 3.6 ships stable is:

1. **Tracking each new Vue 3.6 beta/RC** — verify the pass-through wrappers still
   hold, fold any behavioral notes into the alignment table, bump the peer dep.
2. **The stable-landing realignment** (see "What flips at Vue 3.6 stable" below) —
   wrapper elimination, registry collapse.

Maintenance work (correctness hardening, coverage, doc currency, perf re-measurement)
continues; new feature work does not. A genuinely new capability request is parked
until after 3.6 stable, when the deployment patterns that would justify it are
observable.

## Pre-stable specifics

- **Peer dependency:** `vue: ">=3.5.0 || >=3.6.0-rc.2"`. The lib supports
  Vue 3.5 (composables only) and Vue 3.6 RCs (full Vapor surface).
- **Vapor APIs are still moving.** `defineVaporCustomElement`, `defineVaporComponent`,
  `defineVaporAsyncComponent` are stable in shape but their underlying behavior
  keeps shifting. The APIs were introduced across **3.6.0-alpha.3–5**
  (#13059 / #14017 / #13831), not beta.10; behavior has since moved with nearly
  every beta (generics inference, emits/attrs split,
  VDOM slots interop normalization, error recovery, TransitionGroup move hooks,
  lazy lifecycle update jobs, HMR reload dedup, v-show move-hook suppression,
  shared-definition hook retention, interop-bridge immutability). The lib's
  wrappers are pass-through, so consumers inherit each beta's improvements without
  code changes — but the wrappers themselves exist precisely because the API is
  not yet final. See [the whitepaper's Vue 3.6 alignment table](./docs/whitepaper.md)
  for the per-beta detail.
- **The lib's value during beta** is graceful degradation (`null` returns when
  Vue's API is absent or not yet present), version probing (`isVaporAvailable`),
  and a stable surface for consumers to code against while Vue itself iterates.

## What is stable, regardless of Vue's beta cycle

These layers are framework-agnostic and will not change shape across
Vue 3.6 stable:

- **Command bus** — `createCommandBus`, `createAsyncCommandBus`, plugins,
  hooks, before-hooks, wildcard listeners, request/response, batch, query,
  emit, meta, BusError, introspection.
- **Transports** — HTTP, WebSocket, SSE bridges. Independent of Vue.
- **Plugins** — logger, validator, history, debounce, throttle, authGuard,
  optimistic, retry, persist, sync, cache, circuitBreaker, rateLimit, metrics,
  serialize (per-key sequential processing, async),
  idempotent (collapse duplicate commands + stamp Idempotency-Key).
- **Schema / LLM layer** — bus → tool-call adapters for Anthropic / OpenAI.
- **Form bus** — reactive form state with async validation.
- **HTTP client** — fetch wrapper with CSRF, interceptors, dedup.
- **Testing utilities** — createTestBus, snapshot, time-travel.
- **`defineVaporCommand`** — the zero-overhead command dispatch primitive
  has no Vue equivalent and stays.
- **IIFE distribution** — three sized variants (core / elements / full)
  matching Vue's tree-shake axes. Stable shape.

## What is transitional and will realign post-3.6-stable

Everything below exists primarily to bridge the 3.5→3.6 gap. None will be
removed silently — each gets a deprecation cycle with a working escape hatch.

### `useVaporCommand` and `useCommand` have converged — **DONE**

The split existed because pre-3.6, `getCurrentInstance()`-based cleanup fails
in Vapor components. `useCommand` now uses `onScopeDispose`-only cleanup and
no `getCurrentInstance()`, so it is Vapor-safe on its own.

**Done:** `useVaporCommand` was folded into `useCommand`. There is now a single
command composable — `register`/`on`/`emit`/`dispose` plus reactive
`loading`/`lastError`, Vapor-safe in `<script setup vapor>` and VDOM alike.
`useVaporCommand` was **removed entirely** — not left as a deprecated alias.
The project tracks pre-release Vue with a tiny userbase, so the clean removal
was preferred over a deprecation cycle.

**Removed:** ~60 lines of duplicated logic, plus the "which one do I use?"
question from the docs.

### Thin Vapor wrappers will become opt-in via build flag

`defineVaporComponent`, `defineVaporCustomElement`, `defineVaporAsyncComponent`,
and `createVaporChamberApp` exist to provide a `null`-returning safety surface
when Vue's API is not present. After Vue 3.6 stable, that null path is dead
code for any consumer who has Vue ≥ 3.6 in their dependency tree.

**Plan (v1.3 cutover):** Ship two flavors from one source via Vite build flag
+ `package.json` conditional exports.

```
src/wrapper.ts:
  const HAS_NATIVE_VAPOR = /* #__PURE__ */ __VAPOR_NATIVE__;
  export function defineVaporComponent(options) {
    if (HAS_NATIVE_VAPOR) return options;          // DCE drops this branch
    const fn = getDefineVaporComponentFn();
    if (!fn) return null;
    return fn(options);
  }

scripts/build.mjs:
  build with __VAPOR_NATIVE__ = false  → dist/index.js          (legacy/beta)
  build with __VAPOR_NATIVE__ = true   → dist/index.modern.js   (3.6 stable+)

package.json#exports:
  ".": {
    "vue36": "./dist/index.modern.js",
    "import": "./dist/index.js",
    "types": "./dist/index.d.ts"
  }
```

Consumers on Vue 3.6 stable add `vue36` to their Vite `resolve.conditions`
once and the wrapper bodies + entire feature-detection registry in
`chamber.ts` (`getDefineVaporComponentFn`, `_defineVaporCustomElementFn`, etc.)
are tree-shaken to zero.

**No source split, no API breakage.** The wrapper functions still exist by
name in both flavors — the modern flavor just inlines them as identity calls.

### Runtime feature-detection registry will shrink

`chamber.ts` currently maintains a registry of probed Vue functions
(`_defineVaporCustomElementFn`, `_vueOnScopeDispose`, `_vueOnUnmounted`,
`_vueOnActivated`, `_vueOnDeactivated`, etc.). Each entry exists because the
specific Vue version may or may not have it.

**Plan (post-3.6-stable):** When `vue36` build flavor is active, the registry
collapses to a direct `import { onScopeDispose, ... } from 'vue'`. No more
property probing, no more null guards. Still tree-shaken when unused.

### `createVaporChamberApp` will become a soft-deprecated convenience

It throws nicer than `createVaporApp` would when Vue Vapor is absent. Useful
during beta for discoverability. Post-stable, point users at `import { createVaporApp } from 'vue'` directly.

**Plan:** JSDoc `@deprecated` in v1.3, working through v2.

## Variant contents are not under semver before v2.0

The IIFE variants (`core`, `elements`, `full`) are split along **audience /
deployment-shape** axes — sprinkled JS, embeddable widgets, kitchen-sink SPAs.
While Vue 3.6 is in beta, the lib reserves the right to move APIs between
variants. Concretely:

- An API that lives in `core` today may move to `full` in a later v1.x release
  if usage data or audience clarification suggests it doesn't fit the variant's
  identity. Example: WebSocket / SSE bridges moved out of `core` in v1.2.0
  because realtime is a different deployment shape than sprinkled-JS.
- A new API may appear in `core` that wasn't there before, if it's idiomatic
  for the audience. Example: `connect()` was added in v1.2.0 as a one-liner
  for the sprinkled-JS audience.
- ESM consumers (the `vapor-chamber` main entry) are unaffected — the main
  entry exposes the union of all variants and obeys strict semver.

This contract relaxes at v2.0: once Vue 3.6 ships stable and consumer
deployment patterns are observable, variant boundaries become semver-stable.
Until then, treat IIFE variant *names* as stable but variant *contents* as
beta-era refinement.

If you pin to a specific variant's API surface, do so against `dist/` in your
own infrastructure, not the public CDN. The full surface is always in `full`.

## Two doorways: general bus and fast lane

The lib ships **two dispatch paths** under the same package, with deliberately
different shapes:

- **`createCommandBus()` — general purpose.** Command envelope, CommandResult,
  plugin chain, before/after hooks, listeners (exact + wildcard), schema,
  batch with rollback, request/response, AbortController, persist/sync/retry,
  HTTP/WS/SSE transports, Vapor wrappers. Ergonomics-first. Use for app-level
  commands.
- **`createFastLane()` (`vapor-chamber/fast-lane`) — real-real-hot path.**
  Strips everything: no envelope, no result, no plugins, no hooks, no
  wildcards, no abort. Just `compile(action, handler)` returning a
  callable, plus `on`/`emit` for fan-out. Use for per-frame game ticks,
  trading data feeds, audio buffer processing, scroll/mousemove sampling,
  physics steps. ~36× faster than `bus.dispatch` (25,400 vs 700 ops/sec on
  the 10k-dispatch bench).

The two are not interchangeable. The fast lane is **not** a faster bus —
it's a different tool for a different workload. Don't reach for it because
it's faster; reach for it because you've measured the general bus as a
bottleneck on a hot loop.

See [docs/performance.md](./docs/performance.md) for the full positioning,
benchmark numbers, and decision tree.

## What is not on the roadmap

- **Directives in Vapor.** The Vue team has consistently signaled directives
  remain a VDOM-only feature. The lib's `createDirectivePlugin` will stay as
  a VDOM helper; no Vapor-port effort planned. Directives are not in the
  growth path.
- **Forking Vue internals.** The lib intentionally wraps Vue's public API
  and detects features at runtime. Bundling polyfills or forking compiler
  output is out of scope.
- **A full SFC-aware HMR replacement.** `vite-hmr.ts` will keep tracking
  `@vitejs/plugin-vue` rather than re-implementing HMR.

## Version targets

Per-release detail lives in **one** place: whitepaper §9's per-release rows
(`docs/whitepaper.md`), with `CHANGELOG.md` as the narrative. This file used to
carry a third copy of that table, which drifted — it still ended at
*v1.7.0 (unreleased)* long after v1.11.0 shipped. v1.10.0 made the same call for
the README's size table (deleted rather than re-synced) and it holds here:
a third copy is a third thing to keep true.

What this file still owns, because §9 does not:

| Version | Trigger | What changes about the *contract* |
|---------|---------|-----------------------------------|
| current line | Each 3.6 RC | Tracking bumps: peer dep, alignment notes, perf re-measure. No contract change. |
| v2.0.0 | One minor cycle after 3.6 stable | Stable-landing realignment: `vue36` flavor wrapper elimination + registry collapse; remove wrappers' null path; finalize the identity decision. The `useVaporCommand`→`useCommand` merge already shipped early, in v1.7.0. See the checklist below. |

**Version policy before 3.6 stable.** Breaking changes ship as **minors**, not
majors. The original justification was "the peer dep is a moving beta" — Vue is
no longer in beta, so that basis has expired and is not what the policy now
rests on. What it rests on: the pre-stable peer dep is still a moving target
(rc.2 today), and the surfaces that have actually taken breaking changes are the
ones documented experimental — v1.11.0's `RouterOutlet` subpath move cited the
router's experimental status, not the beta window, and that is the standard
going forward. A breaking change to a surface documented as stable needs a
major, beta window or not. **2.0.0 remains reserved for the post-stable identity
decision** (Vapor-first vs bus-first; the `vue36` flavor + registry collapse),
keeping the major bump meaningful.
Corollary — **we deliver first**: any v2.0-roadmapped item that does *not* depend on
the stable identity call ships early in a minor as soon as it's ready (the
`useVaporCommand`→`useCommand` merge landed this way in v1.7.0).

Note: the `vue36` build-flag wrapper elimination was once tentatively slated for
v1.5.0 — it is **blocked on Vue 3.6 RC/stable** (the dead-code branch only pays
off once consumers have a non-beta Vue in their tree), so it lands at v2.0.0, not
during beta. `createEchoBridge` (protocol-aware Reverb/Echo realtime — public /
private / presence channels → bus) **shipped in v1.5.0** (it's a receive-only
transport adapter, fully decoupled from Vue, so it wasn't blocked); see
[docs/integrations/laravel.md](./docs/integrations/laravel.md).

## Vue version-support matrix

Which Vue versions each released lib line supports. The peer dep is permissive
(`>=3.5.0 || >=3.6.0-rc.2`, matching `package.json`); this table is the *tested*
support statement.

| vapor-chamber | Vue 3.5 (composables only) | Vue 3.6 | Notes |
|---------------|----------------------------|---------|-------|
| v1.2.x – v1.5.x | ✅ | beta.11 → beta.14 | the beta-aligned lines; v1.5.x feature-locked |
| v1.6.x – v1.7.0 | ✅ | beta.15 → beta.17 | tracking-only bumps + the first post-lock delivery |
| **v1.8.0 →** | ✅ | **rc.1 → rc.2** | current; tested against rc.2 |
| v2.0.0 | ✅ (composables) | **3.6 stable** | `vue36` flavor adds zero-overhead path |

On Vue 3.5 you get the framework-agnostic surface (bus, plugins, transports,
composables with `onScopeDispose` cleanup). The full Vapor surface
(`defineVapor*`, `createVaporChamberApp`, interop plugin) requires Vue 3.6 and
returns `null` / throws with a clear message when Vapor is absent.

## What flips at Vue 3.6 stable

A single checklist for the stable landing (v2.0.0). Each item is detailed in
"What is transitional" above; this is the operational summary so the bump is
mechanical, not archaeological:

- [ ] **Peer dep** — add `^3.6.0` (stable) to the supported range.
- [ ] **`vue36` build flavor** — ship the second build with `__VAPOR_NATIVE__ = true`;
      wrapper bodies inline to identity, the `chamber.ts` feature-detection
      registry (`getDefineVaporComponentFn`, `_vueOnScopeDispose`, …) tree-shakes
      to zero. Add the `vue36` conditional export.
- [x] **`useVaporCommand` → `useCommand`** — **done** (shipped early in v1.7.0, ahead of v2.0). The
      two composables were folded into a single Vapor-safe `useCommand`
      (`onScopeDispose`-only cleanup, `register`/`on`/`emit`/`dispose`).
      `useVaporCommand` was removed clean — no deprecated re-export.
- [ ] **`createVaporChamberApp`** — soft-deprecate (`@deprecated` JSDoc), point at
      `import { createVaporApp } from 'vue'`.
- [ ] **Typed Vapor surface** — once Vue's Vapor types settle at stable, give the
      `defineVapor*` wrappers first-class inference using Vue's exported types
      (`DefineVaporComponent`, `VaporComponent`, `VaporPublicProps`) via an isolated
      `vapor-chamber/vapor` subpath export, so the `vue` type dependency never touches
      the Vue-less main barrel. Until then the wrappers keep the opt-in `<T = any>`
      generic added in v1.6.0 (no Vue-type dependency).
- [ ] **plugin-vue 6.x** — test, then bump the optional peer-dep range.
- [ ] **Re-measure** IIFE sizes (Rolldown/Vite 8 may shift them) and update README.
- [ ] **Variant contents** become semver-stable (the beta-era reshuffle freedom ends).

None of these is a behavior change for consumers who use the documented API —
they're internal collapses that the deprecation cycle (landing first in a v1.x
minor) makes safe.

## Vite + plugin-vue alignment

The library is currently aligned to **Vite ≥ 7.0.0** and **@vitejs/plugin-vue
≥ 5.0.0**. Both are declared as optional peerDependencies — they only matter
if a consumer uses the `vapor-chamber/vite` HMR plugin or compiles Vue SFCs
that target Vapor mode.

**Tracking forward:**

- **Vite 8 + Rolldown.** Vite 8 (expected late 2026) is anticipated to ship
  with Rolldown — a Rust-based Rollup successor — as the default bundler. The
  build pipeline ([scripts/build.mjs](./scripts/build.mjs)) uses Vite's
  programmatic `build()` API which is stable across Rolldown's migration; no
  source changes are anticipated. We'll re-measure IIFE sizes after the swap
  and update README numbers if they shift materially.
- **plugin-vue 6.x.** Expected alongside Vue 3.6 stable. Will be tested
  before bumping the peerDep range.
- **Lightning CSS.** Vite's CSS pipeline doesn't affect vapor-chamber (the
  lib emits no CSS), so no action needed.

Versioning is semver-strict: the v2 changes only happen behind a major bump
because the deprecations land first in v1.3 with at least one release cycle
of warnings.

## How to read this file

If you're a consumer choosing between APIs in this lib:

- **Stable today, stable in v2:** the "stable, regardless of Vue's beta cycle"
  list above. Use freely.
- **Working today, will be reshaped in v2:** the "transitional" list. Use, but
  expect a deprecation cycle. The escape hatch will always exist for one minor
  before removal.
- **Avoid:** anything not listed above is internal. The `_*` prefixed and
  `getXxxFn()` exports in `chamber.ts` are explicitly internal.

If you're contributing: the build-flag wrapper-elimination work is the single
biggest pending change. It's blocked on Vue 3.6 RC — no need to land it in beta.

For performance characteristics, optimization philosophy, and tuning options
see [docs/performance.md](./docs/performance.md).

---

## Appendix: feature matrix

Per-module implementation status (moved here from the README — this file is the
single source of truth for feature status).

### Core

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| Dispatch / register / unregister | `command-bus` | ✅ v0.1.0 | ✅ 100% (line/branch/func) |
| Plugin pipeline (sync + async) | `command-bus` | ✅ v0.1.0 | ✅ 100% (line/branch/func) |
| Plugin priority ordering | `command-bus` | ✅ v0.2.0 | ✅ covered |
| `onAfter` hooks | `command-bus` | ✅ v0.2.0 | ✅ covered |
| Dead letter handling (`onMissing`) | `command-bus` | ✅ v0.2.0 | ✅ covered |
| Command batching + `continueOnError` + `successCount`/`failCount` | `command-bus` | ✅ v0.6.0 | ✅ covered |
| Naming convention enforcement | `command-bus` | ✅ v0.3.0 | ✅ covered |
| Wildcard listeners (`on`, `prefix*`) | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `once()` — one-shot listener | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `offAll(pattern?)` — mass unsubscribe | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `onBefore(hook)` — pre-dispatch hook, cancelable | `command-bus` | ✅ v0.6.0 | ✅ covered |
| Request / response pattern + timeout | `command-bus` | ✅ v0.3.0 | ✅ covered |
| Per-command throttle + undo at register | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `bus.hasHandler()` introspection | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `bus.clear()` | `command-bus` | ✅ v0.5.0 | ✅ covered |
| `BaseBus` structural interface | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `query()` — CQRS read-only dispatch (skips beforeHooks) | `command-bus` | ✅ v1.0 | ✅ covered |
| `emit()` — domain events (no handler, no result) | `command-bus` | ✅ v1.0 | ✅ covered |
| `Command.meta` — auto-stamped id, ts, correlationId, causationId | `command-bus` | ✅ v1.0 | ✅ covered |
| `registeredActions()` — introspection | `command-bus` | ✅ v1.0 | ✅ covered |
| `commandKey(action, target)` export | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `BusError` structured error class (code, severity, emitter) | `command-bus` | ✅ v1.0 | ✅ covered |
| `inspectBus(bus)` — tree-shakeable topology introspection | `command-bus` | ✅ v1.0 | ✅ covered |
| `bus.seal()` / `unsealBus(bus)` — freeze configuration | `command-bus` | ✅ v1.0 | ✅ covered |
| `bus.dispose()` — clean teardown with timer cancellation | `command-bus` | ✅ v1.0 | ✅ covered |
| `createCommandPool(size)` — pre-allocated object pool | `command-bus` | ✅ v1.0 | ✅ covered |
| Transactional batch with undo rollback | `command-bus` | ✅ v1.0 | ✅ covered |
| Recursion depth guard (max 10) | `command-bus` | ✅ v1.0 | ✅ covered |
| V8 optimizations (monomorphic shapes, index loops, extracted try/catch) | `command-bus` | ✅ v1.0 | ✅ bench |
| SSR isolation (independent bus instances) | `command-bus` | ✅ v0.5.0 | ✅ covered |
| `createTestBus` record + assert | `testing` | ✅ v0.2.0 | ✅ harness (excluded) |
| `createTestBus` snapshot & time-travel | `testing` | ✅ v0.4.3 | ✅ covered |
| `TestBus.on()` / `once()` / `offAll()` real implementations | `testing` | ✅ v0.6.0 | ✅ covered |

### Plugins

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `logger` | `plugins-core` | ✅ v0.1.0 | ✅ 100% lines |
| `validator` | `plugins-core` | ✅ v0.1.0 | ✅ covered |
| `history` + bus-backed undo/redo | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `debounce` (stale-closure fix) | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `throttle` | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `authGuard` | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `optimistic` | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `optimisticUndo` — auto-rollback via registered undo handlers | `plugins-core` | ✅ v1.0 | ✅ covered |
| `retry` with configurable backoff + glob filter | `plugins-io` | ✅ v0.4.2 | ✅ 100% lines |
| `persist` (localStorage / custom storage) | `plugins-io` | ✅ v0.4.2 | ✅ covered |
| `sync` (BroadcastChannel cross-tab) | `plugins-io` | ✅ v0.4.2 | ✅ covered |
| `cache` — LRU query result caching with TTL + glob filter | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `circuitBreaker` — per-action closed/open/half-open resilience | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `rateLimit` — per-action sliding window limiter | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `metrics` — lightweight telemetry (count, duration, errorRate) | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `serialize` — per-key sequential processing (async; prevents same-key races; `scope:'cross-tab'` via Web Locks) | `plugins-extra` | ✅ v1.5 | ✅ covered |
| `idempotent` — collapse duplicate commands (double-submit/retry); stamps `Idempotency-Key` for the HTTP bridge | `plugins-extra` | ✅ v1.5 | ✅ covered |

### Utilities

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createChamber` — declarative namespace grouping | `utilities` | ✅ v1.0 | ✅ covered |
| `createWorkflow` — saga pattern with compensation | `utilities` | ✅ v1.0 | ✅ covered |
| `createReaction` — declarative cross-domain rules | `utilities` | ✅ v1.0 | ✅ covered |

### Transport layer

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `postCommand` — POST with retry, CSRF, timeout, session | `http` | ✅ v0.5.0 | ✅ 100% lines |
| `readCsrfToken` — meta / cookie / hidden input | `http` | ✅ v0.5.0 | ✅ covered |
| `HttpError.code` — machine-readable code from response body | `http` | ✅ v0.6.0 | ✅ covered |
| 419 vs 401 fix — CSRF expiry ≠ session expiry | `http` | ✅ v0.6.0 | ✅ covered |
| `createHttpBridge` — fetch plugin | `transports` | ✅ v0.4.2 | ✅ 100% lines |
| `HttpBridgeOptions.noRetry` — per-action retry disable | `transports` | ✅ v0.6.0 | ✅ covered |
| `HttpBridgeOptions.scopeController` — Vapor lifecycle abort | `transports` | ✅ v0.6.0 | ✅ covered |
| `createWsBridge` — WebSocket plugin + reconnect + bounded queue | `transports` | ✅ v0.6.0 | ✅ covered |
| `WsBridge.connected` — reactive signal for connection state | `transports` | ✅ v0.6.0 | ✅ covered |
| `createSseBridge` — server-push EventSource, accepts `BaseBus` | `transports` | ✅ v0.6.0 | ✅ covered |
| `createEchoBridge` — Laravel Echo/Reverb realtime (public/private/presence → bus) | `transports` | ✅ v1.5.0 | ✅ covered |

### Vue composables (requires Vue ≥3.5)

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `useCommand` — Vapor-safe reactive composable (register/on/emit/dispose, loading/error) | `chamber` | ✅ v0.6.0 | ✅ ~96% lines |
| `useCommandState` | `chamber` | ✅ v0.2.0 | ✅ covered |
| `useCommandHistory` — reactive undo/redo | `chamber` | ✅ v0.2.0 | ✅ covered |
| `useCommandGroup` — namespace isolation | `chamber` | ✅ v0.4.1 | ✅ covered |
| `useCommandError` — error boundary | `chamber` | ✅ v0.4.1 | ✅ covered |
| `getCommandBus` / `setCommandBus` / `resetCommandBus` | `chamber` | ✅ v0.1.0 | ✅ covered |
| Signal shim + `configureSignal` | `chamber` | ✅ v0.3.0 | ✅ covered |
| `onScopeDispose` lifecycle alignment | `chamber` | ✅ v0.4.0 | ✅ covered |
| `isVaporAvailable()` | `chamber` | ✅ v0.4.0 | ✅ covered |
| `createVaporChamberApp` / `getVaporInteropPlugin` / `defineVaporCommand` | `chamber-vapor` | ✅ v0.4.0 | ✅ covered |
| `tryAutoCleanup` dev warning (no scope/instance) | `chamber` | ✅ v0.6.0 | ✅ covered |
| `waitForVueDetection()` — async Vue probe | `chamber` | ✅ v0.6.0 | ✅ covered |

### Extras

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createFormBus` — reactive form + sync/async validation | `form` | ✅ v0.6.0 | ✅ ~92% lines |
| `FormBus` headless mode (`reactive: false`) | `form` | ✅ v0.6.0 | ✅ covered |
| Schema layer — `createSchemaCommandBus`, `toTools`, `synthesize` | `schema` | ✅ v0.5.0 | ✅ 100% lines |
| Schema auto-validation (`schemaValidator` auto-installed) | `schema` | ✅ v1.0 | ✅ covered |
| `SynthesizeOptions.adapter` — custom LLM adapter | `schema` | ✅ v0.6.0 | ✅ covered |
| `ERROR_CODE_REGISTRY` — structured error lookup table | `schema` | ✅ v1.0 | ✅ covered |
| `busApiSchema()` — JSON schema of bus API for LLM prompts | `schema` | ✅ v1.0 | ✅ covered |
| `describeErrorCodes()` — plain-text error table for LLM system prompts | `schema` | ✅ v1.0 | ✅ covered |
| `setupDevtools` — Vue DevTools panel | `devtools` | ✅ v0.4.0 | ✅ covered |
| `createDirectivePlugin` — `v-command` directive + Vapor compat warning | `directives` | ✅ v0.6.0 | ✅ covered |
| Vite HMR plugin (+ `.vapor.vue` support) | `vite-hmr` | ✅ v0.6.0 | ✅ covered |
| IIFE / CDN bundle | `iife` | ✅ v0.5.0 | 🔧 bundle entry |
