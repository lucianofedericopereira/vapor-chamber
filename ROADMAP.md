# Roadmap

This project tracks Vue 3.6 while it is in beta. That has direct consequences
for what's stable, what's transitional, and what will change once Vue 3.6
ships stable. This file is the source of truth for that distinction.

Last reviewed against **Vue 3.6.0-beta.17** (2026-06-24).

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

## Beta-territory specifics

- **Peer dependency:** `vue: ">=3.5.0 || >=3.6.0-beta.17"`. The lib supports
  Vue 3.5 (composables only) and Vue 3.6 betas (full Vapor surface).
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

| Version | Trigger                          | Headline                                                                 |
|---------|----------------------------------|--------------------------------------------------------------------------|
| v1.2.x  | Vue 3.6.0-beta.11+               | Beta-aligned: docs, build pipeline, IIFE split, regression tests, V8-aligned hot path, listener bucketing, persist coalescing |
| v1.3.0  | Vue 3.6.0-beta.12                | SSR/Hydration alignment, AbortController extensions (request/respond, dispatchBatch, child signals, WS/SSE bridge), useSharedCommandState, TestBus snapshot/time-travel |
| v1.4.0  | Vue 3.6.0-beta.13                | TransitionGroup fixes, interop scope IDs, SSR hydration fixes, lazy lifecycle jobs, signal.ts plain-object fallback, alien-signals class adapter, alien-signals promoted to dep |
| v1.5.0  | Vue 3.6.0-beta.14                | Beta.14 alignment (HMR reload dedup, v-show move-hook suppression, custom-element/interop fixes); `signal()` → `shallowRef` (skips deep-Proxy on object/array state); `serialize` plugin (per-key sequential, + cross-tab via Web Locks); `vapor-chamber/reactive` deep-reactivity companion; `onMissing:'buffer'` deferred dispatch (buffer-until-registered, for lazy/island hydration); `idempotent` plugin + HTTP `Idempotency-Key` forwarding (client+wire exactly-once). **Feature set locked here.** |
| v1.6.x  | Each subsequent 3.6 beta / RC    | **Tracking only** — alignment notes folded into the version table, peer-dep bump, perf re-measure. (beta.16 broke this expectation: it carried a breaking consolidation, so it landed as the v1.7.0 minor instead of a 1.6.x patch; **beta.17 then folded into that same still-unreleased v1.7.0 as a pure pass-through tracking bump** — no code change.) |
| v1.7.0  | Vue 3.6.0-beta.16 → beta.17      | **First post-lock delivery (unreleased).** Beta.16 **+ beta.17** alignment (beta.17 is fully pass-through — its compiler/runtime slot, interop, hydration, and reactivity fixes are all below us or inherited through the interop plugin); `v-vc:command` event modifiers; **breaking: `useVaporCommand` removed → `useCommand` is the single composable** (the v2.0 merge, *delivered early* — it never depended on the stable identity call); dispatch core to 100% line+branch+func coverage + lazy buffer allocation; honest size/coverage/perf docs. Ships as a **minor** under the beta-window version policy below. |
| v2.0.0  | One minor cycle after 3.6 stable | Stable-landing realignment: `vue36` flavor wrapper elimination + registry collapse; remove wrappers' null path; finalize the identity decision. The `useVaporCommand`→`useCommand` merge is already **done** (shipped early in **v1.7.0** — see below). See checklist below. |

**Version policy during the beta window.** While Vue 3.6 is still beta, breaking
changes ship as **minors**, not majors — the peer dep is a moving beta and there is
effectively no userspace to protect, so a deprecation cycle would cost more than it
saves. **2.0.0 is reserved for the post-stable identity decision** (Vapor-first vs
bus-first; the `vue36` flavor + registry collapse), keeping the major bump meaningful.
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
(`>=3.5.0 || >=3.6.0-beta.17`); this table is the *tested* support statement.

| vapor-chamber | Vue 3.5 (composables only) | Vue 3.6 beta | Notes |
|---------------|----------------------------|--------------|-------|
| v1.2.x        | ✅                          | beta.11+     | first beta-aligned line |
| v1.3.0        | ✅                          | beta.12      | |
| v1.4.0        | ✅                          | beta.13      | |
| v1.5.x        | ✅                          | beta.14      | feature-locked |
| **v1.6.x**    | ✅                          | **beta.15 → beta.17** | current; tracking-only bumps |
| v2.0.0        | ✅ (composables)            | **3.6 stable** | `vue36` flavor adds zero-overhead path |

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
