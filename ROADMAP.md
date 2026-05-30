# Roadmap

This project tracks Vue 3.6 while it is in beta. That has direct consequences
for what's stable, what's transitional, and what will change once Vue 3.6
ships stable. This file is the source of truth for that distinction.

Last reviewed against **Vue 3.6.0-beta.13** (released 2026-05-28).

---

## Current posture: beta territory

- **Peer dependency:** `vue: ">=3.5.0 || >=3.6.0-beta.13"`. The lib supports
  Vue 3.5 (composables only) and Vue 3.6 betas (full Vapor surface).
- **Vapor APIs are still moving.** `defineVaporCustomElement`, `defineVaporComponent`,
  `defineVaporAsyncComponent` are stable in shape but their underlying behavior
  has shifted between beta.10 and beta.13 (generics inference, emits/attrs split,
  VDOM slots interop normalization, error recovery, TransitionGroup move hooks,
  lazy lifecycle update jobs). The lib's wrappers are pass-through, so consumers
  inherit each beta's improvements without code changes — but the wrappers
  themselves exist precisely because the API is not yet final.
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
  optimistic, retry, persist, sync, cache, circuitBreaker, rateLimit, metrics.
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

### `useVaporCommand` and `useCommand` will converge

The split exists because pre-3.6, `getCurrentInstance()`-based cleanup fails
in Vapor components. By Vue 3.6 stable, `onScopeDispose` works in every
component context, so `useCommand` can be Vapor-safe on its own.

**Plan (v1.3 or v2):** Fold `useVaporCommand` into `useCommand`. Single
composable, `onScopeDispose`-only cleanup. `useVaporCommand` becomes a
deprecated re-export of `useCommand` for one minor cycle, then removed.

**Removes:** ~60 lines of duplicated logic, plus the "which one do I use?"
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

| Version | Trigger                          | Headline                                                                 |
|---------|----------------------------------|--------------------------------------------------------------------------|
| v1.2.x  | Vue 3.6.0-beta.11+               | Beta-aligned: docs, build pipeline, IIFE split, regression tests, V8-aligned hot path, listener bucketing, persist coalescing |
| v1.3.0  | Vue 3.6.0-beta.12                | SSR/Hydration alignment, AbortController extensions (request/respond, dispatchBatch, child signals, WS/SSE bridge), useSharedCommandState, TestBus snapshot/time-travel |
| v1.4.0  | Vue 3.6.0-beta.13                | TransitionGroup fixes, interop scope IDs, SSR hydration fixes, lazy lifecycle jobs, signal.ts plain-object fallback, alien-signals class adapter, alien-signals promoted to dep |
| v1.5.0  | Next Vue 3.6 beta or RC          | Build-flag wrapper elimination; `vue36` conditional export; soft-deprecations begin; protocol-aware `createEchoBridge` for Laravel Reverb / Echo (channels / private / presence) |
| v2.0.0  | One minor cycle after 3.6 stable | Drop `useVaporCommand` (folded into `useCommand`); registry collapse; remove wrappers' null path |

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
