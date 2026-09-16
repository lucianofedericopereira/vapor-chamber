# Roadmap

This project tracks Vue 3.6 through its **release-candidate** phase (rc.1
landed 2026-07-18; rc.2 on 2026-07-22; rc.3 on 2026-08-11; rc.4 on 2026-08-14;
rc.5 on 2026-08-21; rc.6 on 2026-08-28; rc.7 on 2026-09-04; rc.8 on
2026-09-11). That phase decides what is stable, what is transitional, and what
will change once Vue 3.6 ships stable; this file is the source of truth for the
distinction.

Last reviewed against **Vue 3.6.0-rc.8** (2026-09-11).

---

## Posture: feature-complete; tracking Vue to stable

**The feature set is complete as of v1.5.0 and now locked.** v1.5.0 closed the last
planned capabilities - `serialize`, `idempotent`, `onMissing:'buffer'` deferred
dispatch, `createEchoBridge`, and the `vapor-chamber/reactive` companion - so the
command bus, plugins, transports, composables, schema/LLM layer, form bus, HTTP
client, testing utilities, and the Vapor surface are done. From here the
only forward motion until Vue 3.6 ships stable is:

1. **Tracking each new Vue 3.6 beta/RC** - verify the pass-through wrappers still
   hold, fold any behavioral notes into the alignment table, bump the peer dep.
2. **The stable-landing realignment** (see "What flips at Vue 3.6 stable" below) -
   wrapper elimination, registry collapse.

Maintenance work (correctness hardening, coverage, doc currency, perf re-measurement)
continues; new feature work does not. A request for a genuinely new capability
waits until after 3.6 stable, when the deployment patterns that would justify it
are observable.

**Superseded for composition work, by the decision owner: the RC window is the
runway, not the waiting room.** The freeze above still governs ordinary feature
requests, and its real job is unchanged - standing pressure to justify every
byte with evidence. What changed is the conclusion drawn from a tiny userbase
and a pre-release peer dep. This repo's own history is the argument: the bus
hardened over the betas, and the router was built and realigned from rc.1 to rc.8.
Waiting for stable buys safety at the cost of arriving unproven. Building now
means v2.0 at stable is the promotion and semver stabilization of a system that
has already survived N alignment cycles, not a construction start.

A piece may therefore land experimental in a 1.x minor once it clears the
v1.17.0 template: measured cost, what it buys, fixtures to the house standard.
"Improves the architecture" clears that bar and "change for its own sake" does
not. Four pieces have landed under it - `revalidateRoutes`,
`vapor-chamber/router/vapor`, `vapor-chamber/store` and `vcCommandVapor` - each
shipping independently, each with a dated row in `docs/decisions.md`. **At stable the remaining work is arrival, not
construction:** re-measure every number, run the v2.0 identity decision over a
proven surface, stabilize semver.

**Exception, v1.14.0:** `on()`/`once()` gained `{ signal }` (AbortSignal
auto-unsubscribe) and `Symbol.dispose` on every returned unsubscribe fn
(`using` support). Both are plain JS-platform ergonomics - nothing here
depends on or waits for Vue's own API surface, so they don't touch the
question this freeze exists to wait out. Kept small on purpose: they add
~100 B brotli or less to each IIFE variant (see CHANGELOG). The freeze on genuinely new
*capability* - state or behavior tied to Vue's still-moving API - stands.

**Not an exception, v1.16.0 - no API was added.** `meta.ts` now reads the clock
once per microtask turn instead of once per command. That is a behaviour change
inside an existing field, not new capability, so the freeze is untouched: no
export, no option, no config. Worth a **1.18-1.67x speedup on dispatch-shaped
work**: a fixed 15-25 ns saved per command, and nothing once listener fan-out
dominates. The bench confirms it: `bus.dispatch` went from 197.7x to 140.0x
slower than a direct call. A runtime knob was built, measured and then
**deleted**: an option earns its place only when each setting is right for
different people, and one setting is right for essentially everyone. A user
plugin covers the rare need for an exact per-command wall clock. `ts` is a wall
clock, not an ordering key; order comes from `meta.id`'s monotonic counter
either way. Evidence: `tests/clock-source-ab.test.ts` (the gain, with a control
row that never stamps) and `tests/clock-source-contained.test.ts` (no TTL/expiry
path can be affected).

**v1.17.0 - `vapor-chamber/vapor`, and what it cost.** A new public subpath. This
section does not ask "is an exception permitted": the freeze is not a rule to be
waived but the standing pressure to justify bytes and nanoseconds, and that
pressure is where most of this project's bugs have actually come from. So the
entry records the only things that matter: what it costs, measured, and what it
buys.

**Cost, on the `examples/vapor-sfc` app bundle:** `+1.84 KB raw / +0.74 KB gzip`
over wiring `createVaporApp` by hand. **Buys:** a whole failure class removed.
The runtime probe resolves under a dev server but cannot resolve in a production
bundle, and that gap has produced two shipped prod-only bugs
(`createVaporChamberApp()` throwing on a page with Vapor bundled into it, and
v1.17.0's own inert KeepAlive guard). A static import has no such failure mode.
No new capability: every function it exposes already existed elsewhere; what
changes is *how Vue reaches the registry*.

**And the squeeze is what shaped it.** The first version wired all five Vapor
names and took the example bundle from 80 KB to **158 KB** raw. The consumer's
bundler retains a static import whether the app calls it or not, so "wire
everything" is billed to everyone, including those who use none of it. Measuring
each name separately produced the shipped design:

| wired | raw KB | Δ |
| --- | --- | --- |
| `createVaporApp` | 80.23 | - |
| `+ defineVaporComponent` | 80.26 | +0.03 |
| `+ defineVaporAsyncComponent` | 82.07 | +1.84 |
| `+ defineVaporCustomElement` | 89.44 | +9.21 |
| `+ vaporInteropPlugin` | 158.50 | **+78.27** |

The entry wires the first three. Custom elements and the VDOM interop renderer
stay opt-in behind one `configureVue()` line - which composes, because
`configureVue` merges. Had the size not been measured, the shipped default would
have roughly doubled every pure-Vapor consumer's bundle to carry a renderer that
audience does not use.

And it is **over-delivery, not a policy break**. The v2.0 checklist reserves this
exact subpath name for the typed Vapor surface, and the "we deliver first"
corollary below says a v2.0-roadmapped item that does not depend on the stable
identity call ships as soon as it is ready. The runtime wiring does not depend on
it, so it lands now; the types follow at v2.0 in the same entry. Same shape as
`useVaporCommand`->`useCommand`, which landed early in v1.7.0.

**Not an exception, v1.17.0 - no API was added.** Wildcard listeners now carry a
`prefix` computed once in `on()`, so the dispatch-time match is a single
`startsWith` instead of a re-derivation through `matchesPattern`'s LRU. Same
freeze reasoning as v1.16.0: a behaviour change inside existing machinery, no
export, no option, no config, and the public `matchesPattern` is untouched
(it keeps its cache - it takes arbitrary caller-supplied patterns and nothing has
classified them in advance). Worth a **1.14-1.32x speedup on wildcard fan-out**
(10-31 ns saved per dispatch, growing with listener count) at **0 B brotli**.
Two rows deliberately do *not* move: a bus with no wildcard listeners (~1.00x,
the control - that shape already short-circuits) and a lone `'*'` listener
(~1.02x, because `matchesPattern` already returned on its first comparison).
The idea comes from Vue rc.6's commit `29ed4b0`, which does the same hoist for
template adoption. Evidence: `tests/wildcard-prefix-ab.test.ts`, which builds its baseline
arm by reverting the shipped source so both arms are the real dispatch path.

## Pre-stable specifics

- **Peer dependency:** `vue: ">=3.5.0 || >=3.6.0-rc.8"`. The lib supports
  Vue 3.5 (composables only) and Vue 3.6 RCs (full Vapor surface).
- **Vapor APIs are still moving.** `defineVaporCustomElement`, `defineVaporComponent`,
  `defineVaporAsyncComponent` are stable in shape, but their behavior keeps
  shifting. Vue introduced them across **3.6.0-alpha.3-5**
  (#13059 / #14017 / #13831), not beta.10, and their behavior has moved with
  nearly every beta since (generics inference, emits/attrs split,
  VDOM slots interop normalization, error recovery, TransitionGroup move hooks,
  lazy lifecycle update jobs, HMR reload dedup, v-show move-hook suppression,
  shared-definition hook retention, interop-bridge immutability). The lib's
  wrappers are pass-through, so consumers inherit each beta's improvements without
  code changes - but the wrappers exist only because the API is not yet final. See [the whitepaper's Vue 3.6 alignment table](./docs/whitepaper.md)
  for the per-beta detail.
- **The lib's value during beta** is graceful degradation (`null` returns when
  Vue's API is absent or not yet present), version probing (`isVaporAvailable`),
  and a stable surface for consumers to code against while Vue itself iterates.

## Upstream's Vapor roadmap: what we depend on, and what we don't

Vue tracks Vapor's own progress in [vuejs/core#13687][vapor-roadmap]. Read it for
**stated design intent**, not just for checkboxes - it is where upstream says
things no commit diff shows, and two of those statements are load-bearing here.

**The rule this project applies, symmetrically:** an unchecked box does not mean
missing, and a checked box does not mean working. Both halves have bitten us, so
a fixture settles each item, not a reading of the list: provide/inject was
unchecked while measurably working, and KeepAlive was checked while our own
integration with it was inert.

**Design intent that is now settled upstream (not a gap awaiting a fix):**

- **`getCurrentInstance()` returns `null` inside Vapor components, intentionally**
  (maintainer, 2026-07-20; an internal `useInstanceOption` exists but is
  deliberately not public). This is why `tryKeepAliveHooks` gates on
  `hasInjectionContext()` - see the rc.4/rc.5 rows in whitepaper §9. The gate is
  **permanent**; do not reintroduce an instance-accessor probe expecting it to
  start answering. **And the gate is only half of it - v1.17.0 found that
  `vapor-chamber/vue` never passed `hasInjectionContext` to `configureVue()`, so
  in a production bundle (where the probe cannot resolve `vue`) the gate fell
  back to `getCurrentInstance()` and went inert exactly as it did before rc.4.**
  A correct guard fed by an incomplete registry is an absent guard; the wiring
  list in `src/vue.ts` is load-bearing and is now pinned by
  `tests/vue-subpath-wiring-fixture.test.ts`.
- **Vapor exposes no general-purpose component instance tree to userland, by
  design** (maintainer, 2026-08), so user code cannot depend on internal
  instances. Two consequences for this repo, both favourable and neither
  requiring work:
  - **Vue Test Utils** (unchecked): `findComponent`-style traversal is precisely
    what upstream ruled out, so `createTestBus` - which asserts at the bus
    boundary - is the aligned testing story regardless of how VTU lands.
  - **DevTools Integration** (unchecked): `src/devtools.ts` builds its inspector
    tree from buffered `bus.onAfter` entries, never from Vue's component tree, so
    the Commands timeline and inspector panel do not wait on Vapor
    component-tree bookkeeping.

**Unchecked items this project does not depend on:**

| Upstream item | Why it doesn't block us |
| --- | --- |
| VaporSuspense | `useVaporAsyncCommand` awaits a bus promise and creates no boundary of its own; VDOM `<Suspense>` <-> Vapor interop already works |
| Vue Router | this repo ships its own router (`vapor-chamber/router`), URL-addressed and vDOM-free by design |
| Pinia / Nuxt / VitePress | no dependency in either direction |
| Provide/Inject System | measured working at **both** levels on a real `createVaporApp` - `tests/router/vapor-fixture.test.ts` (primitive) and `tests/vapor/router-composables.test.ts` (composables inside a real `defineVaporComponent`) |

[vapor-roadmap]: https://github.com/vuejs/core/issues/13687

## What is stable, regardless of Vue's beta cycle

These layers are framework-agnostic and will not change shape across
Vue 3.6 stable:

- **Command bus** - `createCommandBus`, `createAsyncCommandBus`, plugins,
  hooks, before-hooks, wildcard listeners, request/response, batch, query,
  emit, meta, BusError, introspection.
- **Transports** - HTTP, WebSocket, SSE bridges. Independent of Vue.
- **Plugins** - logger, validator, history, debounce, throttle, authGuard,
  optimistic, retry, persist, sync, cache, circuitBreaker, rateLimit, metrics,
  serialize (per-key sequential processing, async),
  idempotent (collapse duplicate commands + stamp Idempotency-Key).
- **Schema / LLM layer** - bus -> tool-call adapters for Anthropic / OpenAI.
- **Form bus** - reactive form state with async validation.
- **HTTP client** - fetch wrapper with CSRF, interceptors, dedup.
- **Testing utilities** - createTestBus, snapshot, time-travel.
- **`defineVaporCommand`** - the zero-overhead command dispatch primitive
  has no Vue equivalent and stays.
- **IIFE distribution** - three sized variants (core / elements / full)
  matching Vue's tree-shake axes. Stable shape.

## What is transitional and will realign post-3.6-stable

Everything below exists primarily to bridge the 3.5->3.6 gap. None will be
removed silently - each gets a deprecation cycle with a working escape hatch.

### `useVaporCommand` and `useCommand` have converged: **DONE**

The split existed because pre-3.6, `getCurrentInstance()`-based cleanup fails
in Vapor components. `useCommand` now uses `onScopeDispose`-only cleanup and
no `getCurrentInstance()`, so it is Vapor-safe on its own.

**Done:** `useVaporCommand` was folded into `useCommand`. There is now a single
command composable - `register`/`on`/`emit`/`dispose` plus reactive
`loading`/`lastError`, Vapor-safe in `<script setup vapor>` and VDOM alike.
`useVaporCommand` was **removed entirely** - not left as a deprecated alias.
The project tracks pre-release Vue with a tiny userbase, so it chose the clean
removal over a deprecation cycle.

**Removed:** ~60 lines of duplicated logic, plus the "which one do I use?"
question from the docs.

### Thin Vapor wrappers will become opt-in via build flag

`defineVaporComponent`, `defineVaporCustomElement`, `defineVaporAsyncComponent`,
and `createVaporChamberApp` exist to provide a `null`-returning safety surface
when Vue's API is not present. After Vue 3.6 stable, that null path is dead
code for any consumer who has Vue ≥ 3.6 in their dependency tree.

**Decision (rc.3): the flavor apparatus is retired. `configureVue()` is the
plan.** The `__VAPOR_NATIVE__` define, the second build, and the `vue36`
export condition are all withdrawn as roadmap items - not deferred, withdrawn.
Three verified facts, each fatal on its own:

1. **The "identity wrappers" premise was a silent bug.** Checked in
   `node_modules/@vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js`:
   `defineVaporComponent` sets `comp.__vapor = true` before returning `comp`
   (and for a *function* `comp` builds a fresh `{name, setup, __vapor}`
   object); `defineVaporAsyncComponent` builds a `VaporAsyncComponentWrapper`;
   `defineVaporCustomElement` returns a `class ... extends VaporElement`.
   Compiling the wrappers to `return options` drops the `__vapor` marker -
   no error, no null, just wrong-mode rendering.

2. ~~**There is (almost) nothing to statically import from.**~~ **This fact was
   WRONG, and the rc.6 cycle corrected it. All four wrapped APIs are statically
   importable from `vue`, and have been since at least rc.5.** The rc.5 row
   recorded "exactly one of this lib's four wrapped APIs - `defineVaporAsyncComponent` -
   *is* statically importable... the other three and `vaporInteropPlugin` remain
   absent." That was wrong when it was written. `vue.runtime.esm-bundler.js` is
   23 lines long, and the row quoted two of them:

   ```js
   import { defineVaporAsyncComponent, withAsyncContext } from "@vue/runtime-vapor";
   export { compile, defineVaporAsyncComponent, withAsyncContext };
   ```

   while missing the line between them:

   ```js
   export * from "@vue/runtime-vapor";   // <- present at rc.5 AND rc.6
   ```

   Enumerated through bundler resolution (`Object.keys` of the module, the method
   this section already prescribes), that entry exports **18 Vapor names on both
   rc.5 and rc.6, in byte-identical lists** that include all four wrapped APIs
   and `vaporInteropPlugin`:

   > `VaporElement, VaporFragment, VaporKeepAlive, VaporTeleport, VaporTransition,
   > VaporTransitionGroup, createVaporApp, createVaporSSRApp,
   > defineVaporAsyncComponent, defineVaporComponent, defineVaporCustomElement,
   > defineVaporSSRCustomElement, isVaporComponent, useVaporCssVars,
   > vaporInteropPlugin, withVaporDirectives, withVaporKeys, withVaporModifiers`

   The count is as seen through the test's name filter; the entry's full surface
   changed at rc.8 (`withOnce` added, runtime-vapor `withAsyncContext` removed).

   **The lesson is the one this section was already trying to teach, applied to
   itself.** It says "verified by enumerating the module's real exports, not by
   grepping for the name: a substring hit in that file is not an export" - and
   then reached its conclusion from a hand-copied quote of the named-export line,
   which is the same error with the sign flipped: an *absence* in a quote is not
   an absence from the module. An `export *` re-export has no name to grep for.
   The enumeration is now a fixture rather than a paragraph
   (`tests/vue-bundler-vapor-exports.test.ts`), so the next cycle reads a number
   instead of re-deriving it.

   What remains true, each point checked rather than assumed: the exports map
   still has **no vapor condition or subpath** (enumerated at rc.6: `.`,
   `./server-renderer`, `./compiler-sfc`, `./jsx-runtime`, `./jsx-dev-runtime`,
   `./jsx`, `./dist/*`, `./package.json`), and the only with-vapor *browser*
   dist is still `esm-browser`. `@vue/runtime-vapor` is now a **declared
   dependency of `vue`** (not merely transitive-by-accident), which is what makes
   Vue's own re-export legitimate; it is still not a dependency of *ours*, so
   importing it directly from this package would remain a phantom import under
   strict pnpm. And deep-importing that dist in **raw Node ESM** still fails
   (`@vue/runtime-dom` does not provide `TransitionPropsValidators` under Node's
   resolved condition). That is an artifact of raw-ESM condition resolution, not
   a packaging bug for the audience that file targets: bundler consumers are
   fine, which this repo's own suite proves by importing bare `vue` unaliased
   under the default vitest config.

   **None of this revives the flavor.** The reason deserves precision, because
   the fact that changed is the one the flavor's case rested on most heavily.
   Fact 1 (compiling the wrappers to `return options` silently drops the
   `__vapor` marker: wrong-mode rendering, no error) and fact 3 (<0.9 KB brotli
   at stake) are each fatal on their own, and what `vue` re-exports affects
   neither. The flavor is no longer *impossible* for want of something to
   import; it is merely not worth building. That is a weaker reason than the one
   on file, so it is stated as the weaker reason rather than left to look
   unchanged.

3. **The prize is under a kilobyte.** The entire probe + registry +
   `configureVue` + detection-hint region of `chamber.ts` (lines ~60-412)
   measures **2,299 B minified / 885 B brotli** (esbuild `--minify`, brotli
   q=11) - an *upper bound* on what any flavor could ever delete, since it
   includes machinery every flavor keeps. Two dist flavors, a build flag, and
   a resolution condition are not a reasonable trade for <0.9 KB.

What replaces it costs nothing, because it already exists:
[`configureVue(vue)`](./src/chamber.ts) - the consumer hands over the Vue
namespace they actually use, the registry seeds synchronously, and the
wrappers' null path becomes unreachable. One channel, every consumer type
(bundler alias, import map, `esm-browser` dist, custom build), no probe race,
no new surface, no peer dep. It was documented as the no-bundler escape hatch;
it is in fact the deterministic Vapor wiring for everyone, and the docs should
say so.

**The runtime probe stays, permanently.** It is the zero-config path and the
only channel no-build pages have. `configureVue` bypasses it; nothing deletes
it. Both paths are maintained past 2.0.

**Reopen condition** (the one future in which a flavor becomes worth revisiting):
Vue ships a with-vapor *bundler* entry or a `vue`-scoped vapor subpath/condition
at 3.6 stable. Then a static-import fast path becomes possible - and it still
has to clear the ~885 B bar, re-measured.

**Status at rc.6: the first half is MET - and was already met at rc.5, which the
rc.5 row got wrong.** `vue`'s bundler entry re-exports the whole
`@vue/runtime-vapor` surface (18 names, all four wrapped APIs among them) via
`export *`, on both rc.5 and rc.6 - so "Vue ships a with-vapor *bundler* entry"
is satisfied. The second half is not: there is still no `vue`-scoped vapor
subpath or condition in the exports map. Since the condition is an **or**, it is
met, and the sentence that follows it now applies: a static-import fast path is
possible, *and it still has to clear the ~885 B bar, re-measured.*

**It has not been re-measured, and until it is, nothing changes.** The
~885 B figure is an upper bound on what a flavor could delete, and facts 1 and 3
still hold, so the standing decision (withdrawn, superseded by `configureVue()`)
stands on its own merits. What is gone is the argument that there was nothing to
import; that argument was never true. `tests/vue-bundler-vapor-exports.test.ts`
fails if the four wrapped APIs stop being statically importable or if a vapor
subpath/condition appears, so a test maintains this row rather than someone
remembering to look.

### Runtime feature-detection registry: kept, and measured

`chamber.ts` maintains a registry of probed Vue functions
(`_defineVaporCustomElementFn`, `_vueOnScopeDispose`, `_vueGetCurrentScope`,
`_vueHasInjectionContext`, `_vueOnActivated`, `_vueOnDeactivated`, etc.). Each
entry exists because a given Vue version may or may not have it.

This list previously named `_vueOnUnmounted`, which **no longer exists**: the
`onUnmounted` cleanup fallback became unreachable, and was removed, once
`getCurrentScope()` was established as always non-null inside a Vue 3.5+
`setup()`. Re-audited at rc.6: every remaining slot has live call sites, so
there is no dead probe to prune. The pruning rule is unchanged - an entry goes only
when the peer floor moves past the version that made it conditional, which
Vue 3.5 support still prevents for all of them.

This section used to plan a post-stable collapse to direct `vue` imports under
the `vue36` flavor. Withdrawn with the flavor (see above): the whole
registry-and-probe region is ≤900 B brotli, `configureVue()` already seeds it
synchronously for consumers who want determinism, and the entries stay because
the peer range keeps 3.5 (no Vapor, partial hooks) supported.

### `v-vc:command` in Vapor: shipped in v1.20.0 as `vcCommandVapor`

This file used to list "Directives in Vapor" under **what is not on the
roadmap**, on the stated grounds that "the Vue team has consistently signaled
directives remain a VDOM-only feature." That was wrong, and wrong for the whole
time it was written down. `withVaporDirectives` is a public export of the
with-vapor build and ships in **every** Vue version this project has tracked -
verified by unpacking the published `@vue/runtime-vapor` dist from
3.6.0-alpha.3 through rc.3. rc.3 did not add it; it hardened it (#15258,
#15167, #15158). Measured in `tests/vapor-directives-fixture.test.ts`.

What is real: the two renderers want different **shapes**, and one
`app.directive('vc', ...)` registration cannot serve both:

```
VDOM    { mounted(el, binding), updated(el, binding), beforeUnmount(el) }
Vapor   (el, value, argument, modifiers) => cleanup | void
```

The Vapor form runs once per root element in a detached `EffectScope`, returns
its own cleanup, and has **no `updated` hook** - the value arrives as a getter.
So the port is a second export, `vcCommandVapor` from
`vapor-chamber/directives`, built over the same `buildHandler`. It reads the
getter at dispatch time rather than tracking it: tracking needs `renderEffect`,
which only Vue's Vapor build exports, and a static import of it would break the
subpath for Vue 3.5 consumers of the vDOM plugin.

It was taken in the rc.8 cycle under the feature template: it was the one place
this library diverged from a Vue capability, while Vue kept investing in Vapor
directives (rc.8 wraps its own directive helpers in `withOnce`). Cost, what it
buys and the fixture are recorded in CHANGELOG v1.20.0 and docs/decisions.md;
`tests/directives-vapor-fixture.test.ts` mounts it on a real Vapor app. The
plugin's install-time "not ported to Vapor" warning is gone.

### `createVaporChamberApp` will become a soft-deprecated convenience

When Vue Vapor is absent it throws a clearer error than `createVaporApp` would,
which helps discoverability during beta. Post-stable, point users at
`import { createVaporApp } from 'vue'` directly.

**Plan, and its status:** JSDoc `@deprecated` was planned for v1.3 and has not
been applied: there is no `@deprecated` tag on it at v1.17.0. The plan
(soft-deprecate, working through v2) stands, and it is outstanding, not done.

## Variant contents are not under semver before v2.0

The IIFE variants (`core`, `elements`, `full`) are split along **audience /
deployment-shape** axes - sprinkled JS, embeddable widgets, kitchen-sink SPAs.
While Vue 3.6 is in RC, the lib reserves the right to move APIs between
variants. Concretely:

- An API that lives in `core` today may move to `full` in a later v1.x release
  if usage data or audience clarification suggests it doesn't fit the variant's
  identity. Example: WebSocket / SSE bridges moved out of `core` in v1.2.0
  because realtime is a different deployment shape than sprinkled-JS.
- A new API may appear in `core` that wasn't there before, if it's idiomatic
  for the audience. Example: `connect()` was added in v1.2.0 as a one-liner
  for the sprinkled-JS audience.
- ESM consumers (the `vapor-chamber` main entry) are unaffected - the main
  entry exposes the union of all variants and obeys strict semver.

This exemption ends at v2.0: once Vue 3.6 ships stable and consumer
deployment patterns are observable, variant boundaries become semver-stable.
Until then, treat IIFE variant *names* as stable but variant *contents* as
beta-era refinement.

If you pin to a specific variant's API surface, do so against `dist/` in your
own infrastructure, not the public CDN. The full surface is always in `full`.

## Two doorways: general bus and fast lane

The lib ships **two dispatch paths** under the same package, with deliberately
different shapes:

- **`createCommandBus()` - general purpose.** Command envelope, CommandResult,
  plugin chain, before/after hooks, listeners (exact + wildcard), schema,
  batch with rollback, request/response, AbortController, persist/sync/retry,
  HTTP/WS/SSE transports, Vapor wrappers. Ergonomics-first. Use for app-level
  commands.
- **`createFastLane()` (`vapor-chamber/fast-lane`) - real-real-hot path.**
  Strips everything: no envelope, no result, no plugins, no hooks, no
  wildcards, no abort. Just `compile(action, handler)` returning a
  callable, plus `on`/`emit` for fan-out. Use for per-frame game ticks,
  trading data feeds, audio buffer processing, scroll/mousemove sampling,
  physics steps. Roughly an order of magnitude faster than `bus.dispatch` on
  the 10k-dispatch bench: <!-- vc:benchCompileVsDispatch -->15.62<!-- /vc:benchCompileVsDispatch -->x its ops/sec on the latest `npm run bench`. This line once read "~36x (25,400 vs
  700)", a third copy of a number maintained in `docs/performance.md`, and both
  halves had drifted: dispatch has since gained the v1.16.0 clock caching.
  `docs/performance.md` maintains the bench table; read current figures there.

The two are not interchangeable. The fast lane is **not** a faster bus -
it's a different tool for a different workload. Don't reach for it because
it's faster; reach for it because you've measured the general bus as a
bottleneck on a hot loop.

See [docs/performance.md](./docs/performance.md) for the full positioning,
benchmark numbers, and decision tree.

## What is not on the roadmap

- **Forking Vue internals.** The lib intentionally wraps Vue's public API
  and detects features at runtime. Bundling polyfills or forking compiler
  output is out of scope.
- **A full SFC-aware HMR replacement.** `vite-hmr.ts` will keep tracking
  `@vitejs/plugin-vue` rather than re-implementing HMR.
- **Rebuilding the router on the command bus.** The two pipelines are
  isomorphic - `beforeEach` guards resemble cancelable `onBefore`, loaders
  resemble async handlers, commit resembles a result, `afterEach` resembles
  `onAfter` - which makes unification tempting. Rejected: the router's pipeline
  carries domain semantics generic dispatch has no slot for (two-phase commit
  with atomic data, URL revert on popstate abort, newer-navigation superseding
  via `AbortController`), and the Vapor outlet's whole premise is that the
  router core does not change. That isomorphism is why `revalidateRoutes` is a
  small plugin; it is not a reason to merge the engines.

## Version targets

Per-release detail lives in **one** place: whitepaper §9's per-release rows
(`docs/whitepaper.md`), with `CHANGELOG.md` as the narrative. This file used to
carry a third copy of that table, which drifted - it still ended at
*v1.7.0 (unreleased)* long after v1.11.0 shipped. v1.10.0 made the same call for
the README's size table (deleted rather than re-synced) and it holds here:
a third copy is a third thing to keep true.

What this file still owns, because §9 does not:

| Version | Trigger | What changes about the *contract* |
|---------|---------|-----------------------------------|
| current line | Each 3.6 RC | Tracking bumps: peer dep, alignment notes, perf re-measure. No contract change. |
| v1.13.0 | rc.3 alignment | Tracking bump + docs: `configureVue()` promoted from no-bundler escape hatch to the recommended deterministic Vapor wiring for all consumers. No API change. |
| v1.16.0 | rc.5 alignment | Tracking bump, plus one real contract change: the transition bridge's `phase` / `dispose` became **non-enumerable**, so `{ ...bridge }` no longer carries them. Direct access and destructuring are unaffected; the change exists because `v-bind="t"` - the documented binding - was spreading both into the DOM as attributes. |
| v1.17.0 | rc.6 alignment | Two measured perf wins (wildcard fan-out 1.14-1.32x, router active-link stamping 1.77-1.86x), both 0 B. **New subpath `vapor-chamber/vapor`** (no new capability - a build-time wiring channel replacing the probe; wired set measured, custom-element/interop opt-in). Plus one real fix: `vapor-chamber/vue` never passed `hasInjectionContext`, so in a **production bundle** (probe dead) the rc.4 KeepAlive guard fell back to `getCurrentInstance()` and went inert - `useCommandHistory`/`useCommandError` recorded commands dispatched into a deactivated view. Also: wildcard listeners match on a prefix computed at `on()` time (1.14-1.32x on wildcard fan-out, 0 B brotli, `'*'` unaffected); `configureVue()` documented as MERGING, so a Vapor app adds one name rather than re-enumerating eight; and one roadmap fact corrected - all four wrapped Vapor APIs are statically importable from `vue`, and were at rc.5. |
| v1.18.0 | rc.6 window | **New subpath `vapor-chamber/router/vapor`** - a Vapor-native `RouterOutlet`, experimental. A genuinely new render surface, so it overrides the "new capability parks until after 3.6 stable" posture deliberately and on evidence, per the maturation posture under "Posture" above: the RC window is the runway, and an outlet built over N alignment cycles arrives at stable already hardened. Gated on a measured number before any of it was built - **<!-- vc:outletSaving -->20.42<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->64.7<!-- /vc:outletSavingRaw --> KB raw** saved versus the same app rendering through the vDOM outlet plus interop, re-derived per run from a Vite production build by `tests/vapor/vapor-outlet-size.test.ts`. The guard holds two limits: the saving stays >= <!-- vc:outletFloor -->15.0<!-- /vc:outletFloor --> KB, and the Vapor outlet's own machinery over a router-without-outlet floor stays <= <!-- vc:outletOwnArmCeiling -->5.0<!-- /vc:outletOwnArmCeiling --> KB (**measured <!-- vc:outletOwnArm -->4.23<!-- /vc:outletOwnArm --> KB**); it is written to fail loudly if a later RC erodes either, and that failure is a decision trigger, not a threshold to raise. (Until the rc.8 cycle it was one esbuild-measured 19.5 KB bar on the difference, retired after firing twice on improvements - see the whitepaper's rc.8 row.) Contract changes: one additive `RouterErrorCode` (`mode_mismatch`), and route components on this outlet must be `defineVaporComponent` output. Blade rows still need the vDOM outlet. **Plus one BREAKING change to `vapor-chamber/router`**: it no longer builds an http client, so a `{ url }` route table now needs `http` and blade rows need `fetchBlade` - `routerHttp()` and `bladeFetcher()` ship as the new `vapor-chamber/router/remote` subpath. Two lines for the affected setups, nothing for a generated table with no blade rows, which is the primary setup and was paying 3.4 KB brotli for features it never called. Taken in the RC window on the same maturation logic as the outlet above: near-zero adoption now, and the cost of the break only rises. `./router` drops 12.4 -> 9.6 KB brotli. Three more additive codes: `redirect_loop`, `no_router`, `http_unconfigured`. **Plus a new subpath `vapor-chamber/store`** - `defineChamberStore`, experimental, <!-- vc:sizeStore -->0.7<!-- /vc:sizeStore --> KB brotli, importing `vue` and nothing else. Store actions are commands, so `persist`, `history`, `sync`, `optimistic`, `idempotent`, `serialize` and the devtools timeline apply to store state with no store-specific code, and URL-worthy fields delegate to the router rather than mirroring it. Lands with a deliberate reversal of whitepaper §6 recorded in that section - PACKAGE scope only: the bus still stores no state. No contract change for anyone not importing it. |
| v1.19.0 | rc.7 alignment | Tracking bump (peer `>=3.6.0-rc.7`); all 50 rc.7 commits read at source, every one pass-through. The cycle carried code anyway, because it also read every module in `src`: twenty-three defects, each reproduced before it was fixed. The largest class: five shipped plugins (`logger`, `history`, `circuitBreaker`, `metrics`, `persist`) read `next()`'s result as a `CommandResult`, which on the async bus is a Promise, so each took the wrong branch in silence - now one shared rule, `src/settled.ts`. Numeric options that failed open on a bad value (NaN) now fall back to their documented default. Contract changes, all small: a second form on one bus now throws instead of taking the first one over (forms take an `id` prefix, default `'form'`, so a single form dispatches the names it always did); one additive `RouterErrorCode`, `cyclic_parent`; `configureVue` added to the `full` and `elements` IIFE namespaces. And the ESM build's DEV flag now folds in a consumer's production build, so dev-only diagnostic strings stop shipping: 14,037 -> 12,764 B raw and 4,453 -> 3,999 B brotli on a real Vite app build, about 10%. That held for one-chunk apps; in a code-split app a chunk that imported DEV kept its strings until v1.20.0 derived DEV per module. |
| v1.20.0 | rc.8 alignment | Tracking bump (peer `>=3.6.0-rc.8`), plus one contract NARROWING, taken as a minor under the pre-stable policy below: `retry()`'s default no longer retries an error carrying an HTTP status unless it is 408, 429 or 5xx - so `retry()` stacked in front of the HTTP bridge stops re-sending a 422. A handler that throws a 4xx-status error and relied on `retry()` re-running it passes its own `isRetryable`. Additive: `classifyError` and `isRetryableStatus` exported from the root; `vaporChamberWire()` from `vapor-chamber/vite`, a build-only Vite plugin that wires Vue into an app importing the root, with no import changed; `vcCommandVapor` from `vapor-chamber/directives`, `v-vc:command` for Vapor components (the plugin's install-time Vapor warning is gone). Also in this release: `useSharedCommandState().isLoading(action, target?)`; a plugin's throw is a `VC_PLUGIN_THREW` result; a sealed bus refuses `clear()`; `dispose()` settles waiting `request()`s and the sync `request()` honours its signal; a before-hook's throw is a `VC_CORE_BEFORE_CANCEL` result; `history()` records an async redo once; the ESM build's DEV derived per module; sizes measured as they ship (Vite production builds, about 10% lower); `alien-signals` an optional peer; `dispose()` runs each plugin's `dispose()` and `retry()` has one; what an undo handler or a redo dispatches carries origin `undo` / `redo` and is never recorded; the TestBus's `request()`/`respond()` are real. |
| v2.0.0 | One minor cycle after 3.6 stable | Stable-landing realignment: finalize the identity decision (Vapor-first vs bus-first). The `vue36` flavor + registry collapse were withdrawn at rc.3 (superseded by `configureVue()`, <0.9 KB at stake - see "What is transitional"). `useVaporCommand`->`useCommand` shipped early in v1.7.0. See the checklist below. |

**Version policy before 3.6 stable.** Breaking changes ship as **minors**, not
majors. The original justification, "the peer dep is a moving beta", expired
when Vue left beta, and the policy no longer rests on it. It rests on two
things: the pre-stable peer dep is still a moving target
(<!-- vc:vueAligned -->3.6.0-rc.8<!-- /vc:vueAligned --> today), and the surfaces that have actually taken breaking changes are the
ones documented experimental. v1.11.0's `RouterOutlet` subpath move cited the
router's experimental status, not the beta window, and that is the standard
going forward. A breaking change to a surface documented as stable needs a
major, beta window or not. **2.0.0 remains reserved for the post-stable identity
decision** (Vapor-first vs bus-first), keeping the major bump meaningful. The
`vue36` flavor + registry collapse were withdrawn from that reservation at rc.3
(see "What is transitional").
Corollary - **we deliver first**: any v2.0-roadmapped item that does *not* depend on
the stable identity call ships early in a minor as soon as it's ready (the
`useVaporCommand`->`useCommand` merge landed this way in v1.7.0).

Note: the `vue36` build-flag wrapper elimination was once tentatively slated for
v1.5.0, then parked as "blocked on Vue 3.6 RC/stable". At rc.3 the blocker
resolved the other way: the item was **withdrawn, not unblocked** - the identity
premise was wrong at source, rc.3 ships no with-vapor bundler entry to import
from, and the measured prize is <0.9 KB brotli. `configureVue()` supersedes it;
full evidence in "What is transitional" above.

`createEchoBridge` (protocol-aware Reverb/Echo realtime - public / private /
presence channels -> bus) **shipped in v1.5.0**; it is a receive-only transport
adapter, fully decoupled from Vue, so nothing blocked it. See
[docs/integrations/laravel.md](./docs/integrations/laravel.md).

## Vue version-support matrix

Which Vue versions each released lib line supports. The peer dep is permissive
(`>=3.5.0 || >=3.6.0-rc.8`, matching `package.json`); this table is the *tested*
support statement.

| vapor-chamber | Vue 3.5 (composables only) | Vue 3.6 | Notes |
|---------------|----------------------------|---------|-------|
| v1.2.x - v1.5.x | ✅ | beta.11 -> beta.14 | the beta-aligned lines; v1.5.x feature-locked |
| v1.6.x - v1.7.0 | ✅ | beta.15 -> beta.17 | tracking-only bumps + the first post-lock delivery |
| **v1.8.0 ->** | ✅ | **rc.1 -> rc.8** | current; tested against rc.8 |
| v2.0.0 | ✅ (composables) | **3.6 stable** | peer range gains stable; wiring unchanged - probe by default, `configureVue()` for determinism |

On Vue 3.5 you get the framework-agnostic surface (bus, plugins, transports,
composables with `onScopeDispose` cleanup). The full Vapor surface
(`defineVapor*`, `createVaporChamberApp`, interop plugin) requires Vue 3.6 and
returns `null` / throws with a clear message when Vapor is absent.

## What flips at Vue 3.6 stable

A single checklist for the stable landing (v2.0.0). Each item is detailed in
"What is transitional" above; this is the operational summary so the bump is
mechanical, not archaeological.

**Read these as deadlines, not gates.** An item here is *owed* by v2.0.0; any
item ships earlier, in a minor, the moment it is ready and does not depend on
the stable identity call. That is the "we deliver first" corollary, and
`useCommand` already landed that way. Delivering early is over-delivery, not a
policy break. Items that ship early are marked ✅ with the release that carried them;
items that die are struck with the reason, not deleted:

- [ ] **Peer dep** - add `^3.6.0` (stable) to the supported range.
- ~~**`vue36` build flavor**~~ - **withdrawn at rc.3**, not deferred: the
      identity premise was a silent bug at source (`__vapor` marker), rc.3
      ships no with-vapor bundler entry to statically import, and the measured
      prize was <0.9 KB brotli. Superseded by `configureVue()`; evidence and
      reopen condition in "What is transitional".
- [x] **`useVaporCommand` -> `useCommand`** - **done** (shipped early in v1.7.0, ahead of v2.0). The
      two composables were folded into a single Vapor-safe `useCommand`
      (`onScopeDispose`-only cleanup, `register`/`on`/`emit`/`dispose`).
      `useVaporCommand` was removed clean - no deprecated re-export.
- [ ] **`createVaporChamberApp`** - soft-deprecate (`@deprecated` JSDoc), point at
      `import { createVaporApp } from 'vue'`.
- [~] **Typed Vapor surface** - **the subpath itself shipped early in v1.17.0**
      (see "v1.17.0 - `vapor-chamber/vapor`, and what it cost" above); the
      TYPES half is what remains. The entry carries the runtime wiring: it
      statically imports Vue's Vapor APIs, so the registry is seeded at build
      time rather than by a probe that cannot resolve in a production bundle.
      That half never depended on the stable identity call, so "we deliver
      first" applied. Still owed at v2.0, in the same entry: once Vue's Vapor
      types settle at stable, give the `defineVapor*` wrappers first-class
      inference using Vue's exported types (`DefineVaporComponent`,
      `VaporComponent`, `VaporPublicProps`) via that isolated
      `vapor-chamber/vapor` subpath export, so the `vue` type dependency never
      touches the Vue-less main barrel. Until then the wrappers keep the opt-in `<T = any>`
      generic added in v1.6.0 (no Vue-type dependency).
- [x] **plugin-vue 6.x** - in use (devDependency); `>=5.0.0` already admits it.
- [ ] **Re-measure** IIFE sizes (Rolldown/Vite 8 may shift them) and update README.
- [ ] **Variant contents** become semver-stable (the beta-era reshuffle freedom ends).

None of these is a behavior change for consumers who use the documented API -
they're internal collapses that the deprecation cycle (landing first in a v1.x
minor) makes safe.

## Vite + plugin-vue alignment

The library is currently aligned to **Vite ≥ 5.0.0** and **@vitejs/plugin-vue
≥ 5.0.0**. Both are declared as optional peerDependencies - they only matter
if a consumer uses the `vapor-chamber/vite` plugins (HMR, `vaporChamberWire()`) or compiles Vue SFCs
that target Vapor mode.

**Tracking forward:**

- **Vite 8 + Rolldown.** Landed: the repo builds on Vite 8 (devDependency),
  whose default bundler is Rolldown, through the same programmatic `build()`
  API in [scripts/build.mjs](./scripts/build.mjs); README sizes are stamped
  from each build.
- **plugin-vue 6.x.** In use: the repo builds and tests on it
  (devDependency); the optional peer range `>=5.0.0` already admits it.
- **Lightning CSS.** Vite's CSS pipeline doesn't affect vapor-chamber (the
  lib emits no CSS), so no action needed.

The v2 changes happen behind a major bump (see the version policy above).

## TypeScript 7: measured, and deliberately not taken yet

The library is pinned to **TypeScript ^6.0.3** by decision, not oversight. TypeScript 7 is the Go port: its `exports` map is
`lib/version.cjs` plus `unstable/*`, and the classic JS compiler API
(`createProgram`, `parseJsonConfigFileContent`, `transform`, `factory`) is
gone. Every tool that loads TypeScript as a *library* rather than shelling out
to the `tsc` binary breaks on it.

**The library itself is already TS 7 clean.** Measured on 7.0.2 in a clean
worktree, every gate but one passes, and the one failure is ours:

| gate | result on TS 7.0.2 |
| --- | --- |
| `typecheck` (all three projects) | passes |
| `build` (declaration emit + esbuild) | passes |
| `test:run` | 1981 passed, 1 skipped, same as TS 6 |
| `size:check` | byte-identical, all variants under budget |
| `docs` | **fails**: `ts.parseJsonConfigFileContent is not a function` |

**What actually blocks the move:**

- **`vue-tsc`**, which type-checks the example SFCs. Its latest release,
  3.3.11, fails on `--version`, before doing any work at all:
  `require.resolve('typescript/lib/tsc')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
  This is ecosystem-wide, not a Vue oversight - the same missing API stops
  Angular and typed ESLint rules, and TypeScript's own 7.0 notes tell Vue
  projects to stay on 6. Tracked upstream in vuejs/language-tools#5381, waiting
  on the TypeScript 7.1 programmatic API.
- **[scripts/generate-api-docs.mjs](./scripts/generate-api-docs.mjs)**, which
  reads the compiler directly.

The generator is deliberately NOT ported ahead of time: TS 6
publishes no `exports` map and no `unstable/*`, while TS 7 publishes only
`unstable/*`. The two APIs are mutually exclusive, so porting forward breaks
the build today, and supporting both means a dual code path in a build script
for a migration that cannot happen yet.

**When 7.1 ships and vue-tsc supports it**, the work is known and small: bump
`typescript` in the root and the three examples, and swap one function in the
generator (`parseJsonConfigFileContent` + `createProgram` for `API` +
`updateSnapshot` from `typescript/unstable/sync`). The TS 7 API was verified
capable of everything the generator needs - entry points, alias resolution,
signatures, doc comments and JSDoc tags - before this note was written.

## How to read this file

If you're a consumer choosing between APIs in this lib:

- **Stable today, stable in v2:** the "stable, regardless of Vue's beta cycle"
  list above. Use freely.
- **Working today, will be reshaped in v2:** the "transitional" list. Use, but
  expect a deprecation cycle. The escape hatch will always exist for one minor
  before removal.
- **Avoid:** anything not listed above is internal. The `_*` prefixed and
  `getXxxFn()` exports in `chamber.ts` are explicitly internal.

If you're contributing: there is no "biggest pending change" here any more. This
line used to name the build-flag wrapper-elimination work and call it blocked on
Vue 3.6 RC. Both halves are dead: that apparatus was **withdrawn at rc.3**, not
deferred, and `configureVue()` replaced it (see "Thin Vapor wrappers will become
opt-in via build flag" above); and the RC gate it waited on has since passed (we
align on rc.8). The two statements sat in the same file contradicting each
other for two cycles.

For performance characteristics, optimization philosophy, and tuning options
see [docs/performance.md](./docs/performance.md).

---

## Appendix: feature matrix

Per-module implementation status (moved here from the README - this file is the
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
| `once()` - one-shot listener | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `offAll(pattern?)` - mass unsubscribe | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `onBefore(hook)` - pre-dispatch hook, cancelable | `command-bus` | ✅ v0.6.0 | ✅ covered |
| Request / response pattern + timeout | `command-bus` | ✅ v0.3.0 | ✅ covered |
| Per-command throttle + undo at register | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `bus.hasHandler()` introspection | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `bus.clear()` | `command-bus` | ✅ v0.5.0 | ✅ covered |
| `BaseBus` structural interface | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `query()` - CQRS read-only dispatch (skips beforeHooks) | `command-bus` | ✅ v1.0 | ✅ covered |
| `emit()` - domain events (no handler, no result) | `command-bus` | ✅ v1.0 | ✅ covered |
| `Command.meta` - auto-stamped id, ts, correlationId, causationId | `command-bus` | ✅ v1.0 | ✅ covered |
| `registeredActions()` - introspection | `command-bus` | ✅ v1.0 | ✅ covered |
| `commandKey(action, target)` export | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `BusError` structured error class (code, severity, emitter) | `command-bus` | ✅ v1.0 | ✅ covered |
| A throwing or rejecting plugin becomes a `VC_PLUGIN_THREW` result at its boundary (not retried, not circuit-counted) | `command-bus` | ✅ v1.20.0 | ✅ covered |
| `inspectBus(bus)` - tree-shakeable topology introspection | `command-bus` | ✅ v1.0 | ✅ covered |
| `bus.seal()` / `unsealBus(bus)` - freeze configuration | `command-bus` | ✅ v1.0 | ✅ covered |
| `bus.dispose()` - clean teardown with timer cancellation | `command-bus` | ✅ v1.0 | ✅ covered |
| `createCommandPool(size)` - pre-allocated object pool | `command-bus` | ✅ v1.0 | ✅ covered |
| Transactional batch with undo rollback | `command-bus` | ✅ v1.0 | ✅ covered |
| Recursion depth guard (max 16) | `command-bus` | ✅ v1.0 | ✅ covered |
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
| `optimisticUndo` - auto-rollback via registered undo handlers | `plugins-core` | ✅ v1.0 | ✅ covered |
| `retry` with configurable backoff + glob filter | `plugins-io` | ✅ v0.4.2 | ✅ 100% lines |
| `persist` (localStorage / custom storage) | `plugins-io` | ✅ v0.4.2 | ✅ covered |
| `sync` (BroadcastChannel cross-tab) | `plugins-io` | ✅ v0.4.2 | ✅ covered |
| `cache` - LRU query result caching with TTL + glob filter | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `circuitBreaker` - per-action closed/open/half-open resilience | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `rateLimit` - per-action sliding window limiter | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `metrics` - lightweight telemetry (count, duration, errorRate) | `plugins-extra` | ✅ v1.0 | ✅ covered |
| `serialize` - per-key sequential processing (async; prevents same-key races; `scope:'cross-tab'` via Web Locks) | `plugins-extra` | ✅ v1.5 | ✅ covered |
| `idempotent` - collapse duplicate commands (double-submit/retry); stamps `Idempotency-Key` for the HTTP bridge | `plugins-extra` | ✅ v1.5 | ✅ covered |

### Utilities

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createChamber` - declarative namespace grouping | `utilities` | ✅ v1.0 | ✅ covered |
| `createWorkflow` - saga pattern with compensation | `utilities` | ✅ v1.0 | ✅ covered |
| `createReaction` - declarative cross-domain rules | `utilities` | ✅ v1.0 | ✅ covered |

### Transport layer

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `postCommand` - POST with retry, CSRF, timeout, session | `http` | ✅ v0.5.0 | ✅ 100% lines |
| `readCsrfToken` - meta / cookie / hidden input | `http` | ✅ v0.5.0 | ✅ covered |
| `HttpError.code` - machine-readable code from response body | `http` | ✅ v0.6.0 | ✅ covered |
| 419 vs 401 fix - CSRF expiry ≠ session expiry | `http` | ✅ v0.6.0 | ✅ covered |
| `createHttpBridge` - fetch plugin | `transports` | ✅ v0.4.2 | ✅ 100% lines |
| `HttpBridgeOptions.noRetry` - per-action retry disable | `transports` | ✅ v0.6.0 | ✅ covered |
| `HttpBridgeOptions.scopeController` - Vapor lifecycle abort | `transports` | ✅ v0.6.0 | ✅ covered |
| `createWsBridge` - WebSocket plugin + reconnect + bounded queue | `transports` | ✅ v0.6.0 | ✅ covered |
| `WsBridge.connected` - reactive signal for connection state | `transports` | ✅ v0.6.0 | ✅ covered |
| `createSseBridge` - server-push EventSource, accepts `BaseBus` | `transports` | ✅ v0.6.0 | ✅ covered |
| `createEchoBridge` - Laravel Echo/Reverb realtime (public/private/presence -> bus) | `transports` | ✅ v1.5.0 | ✅ covered |

### Vue composables (requires Vue ≥3.5)

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `useCommand` - Vapor-safe reactive composable (register/on/emit/dispose, loading/error) | `chamber` | ✅ v0.6.0 | ✅ covered |
| `useCommandState` | `chamber` | ✅ v0.2.0 | ✅ covered |
| `useCommandHistory` - reactive undo/redo | `chamber` | ✅ v0.2.0 | ✅ covered |
| `useCommandGroup` - namespace isolation | `chamber` | ✅ v0.4.1 | ✅ covered |
| `useCommandError` - error boundary | `chamber` | ✅ v0.4.1 | ✅ covered |
| `useSharedCommandState().isLoading(action, target?)` - per-key, bus-wide loading | `chamber` | ✅ v1.20.0 | ✅ covered |
| `getCommandBus` / `setCommandBus` / `resetCommandBus` | `chamber` | ✅ v0.1.0 | ✅ covered |
| Signal shim + `configureSignal` | `chamber` | ✅ v0.3.0 | ✅ covered |
| `onScopeDispose` lifecycle alignment | `chamber` | ✅ v0.4.0 | ✅ covered |
| `isVaporAvailable()` | `chamber` | ✅ v0.4.0 | ✅ covered |
| `createVaporChamberApp` / `getVaporInteropPlugin` / `defineVaporCommand` | `chamber-vapor` | ✅ v0.4.0 | ✅ covered |
| `tryAutoCleanup` dev warning (no scope/instance) | `chamber` | ✅ v0.6.0 | ✅ covered |
| `waitForVueDetection()` - async Vue probe | `chamber` | ✅ v0.6.0 | ✅ covered |

### Router (`vapor-chamber/router`, experimental)

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createRouter` - table + engine over a server catch-all | `router` | ✅ v1.9.0 | ✅ covered |
| Two-layer URL model - path navigates, query is state (no remount) | `router/engine` | ✅ v1.9.0 | ✅ covered |
| Two-phase commit - loaders resolve before one frozen snapshot lands | `router/engine` | ✅ v1.9.0 | ✅ covered |
| Guards + after-hooks, self-removal safe; bounded guard redirects (`redirect_loop`) | `router/engine` | ✅ v1.9.0 | ✅ covered |
| Loader SPI - `prefixes` / `url` / `affects`, abort-on-supersede, `ctx.revalidate` | `router/loaders` | ✅ v1.9.0 | ✅ covered |
| Typed query params - `useQueryParam`, `usePagination`, history conventions | `router/composables` | ✅ v1.9.0 | ✅ covered |
| Menu + breadcrumb projections, shared `data-active` semantics | `router/menu` | ✅ v1.9.0 | ✅ covered |
| DOM integration - link interception, active stamping, hover + idle preheat | `router/dom` | ✅ v1.9.0 | ✅ covered |
| `RouterOutlet` (vDOM) + blade rows, on its own subpath | `router/vdom` | ✅ v1.11.0 | ✅ covered |
| `RouterOutlet` (Vapor-native), no interop | `router/vapor` | ✅ v1.18.0 | ✅ covered |
| `routerHttp` / `bladeFetcher` - the http-backed features, opt-in | `router/remote` | ✅ v1.18.0 | ✅ covered |
| `fetchLoaders` - in-box plain-JSON loader preset | `router-fetch` | ✅ v1.9.0 | ✅ covered |

### Extras

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createFormBus` - reactive form + sync/async validation | `form` | ✅ v0.6.0 | ✅ covered |
| `FormBus` headless mode (`reactive: false`) | `form` | ✅ v0.6.0 | ✅ covered |
| Schema layer - `createSchemaCommandBus`, `toTools`, `synthesize` | `schema` | ✅ v0.5.0 | ✅ 100% lines |
| Schema auto-validation (`schemaValidator` auto-installed) | `schema` | ✅ v1.0 | ✅ covered |
| `SynthesizeOptions.adapter` - custom LLM adapter | `schema` | ✅ v0.6.0 | ✅ covered |
| `ERROR_CODE_REGISTRY` - structured error lookup table | `schema` | ✅ v1.0 | ✅ covered |
| `busApiSchema()` - JSON schema of bus API for LLM prompts | `schema` | ✅ v1.0 | ✅ covered |
| `describeErrorCodes()` - plain-text error table for LLM system prompts | `schema` | ✅ v1.0 | ✅ covered |
| `setupDevtools` - Vue DevTools panel | `devtools` | ✅ v0.4.0 | ✅ covered |
| `createDirectivePlugin` - `v-vc:command` directive (vDOM) | `directives` | ✅ v0.6.0 | ✅ covered |
| `vcCommandVapor` - `v-vc:command` for Vapor components | `directives` | ✅ v1.20.0 | ✅ covered |
| Vite HMR plugin (+ `.vapor.vue` support) | `vite-hmr` | ✅ v0.6.0 | ✅ covered |
| IIFE / CDN bundle | `iife` | ✅ v0.5.0 | 🔧 bundle entry |
