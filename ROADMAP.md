# Roadmap

This project tracks Vue 3.6 through its **release-candidate** phase. That phase decides what is
stable, what is transitional, and what will change once Vue 3.6 ships stable. This file is the
source of truth for that distinction.

- **RC dates:** rc.1 2026-07-18, rc.2 2026-07-22, rc.3 2026-08-11, rc.4 2026-08-14, rc.5
  2026-08-21, rc.6 2026-08-28, rc.7 2026-09-04, rc.8 2026-09-11, rc.9 2026-09-18, rc.10
  2026-09-30, rc.11 2026-10-10, rc.12 2026-10-16, rc.13 2026-10-23.
- **Aligned to Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->:** the `vue` devDependency pin, stamped rather than
  typed, so it cannot fall behind the package.
- **Where each cycle is recorded:** the alignment table in the whitepaper's appendix B says what
  each cycle reviewed, with commit counts and what it found. `docs/rc-alignment.md` says how a
  cycle is run, and `docs/rc-alignment-log.md` is the per-cycle record.

---

## Posture: feature-complete, tracking Vue to stable

**The feature set is complete as of v1.5.0, and locked.** The command bus, plugins, transports,
composables, schema and LLM layer, form bus, HTTP client, testing utilities and the Vapor surface
are done.[^v150] Until Vue 3.6 ships stable, the only forward motion is:

1. **Tracking each new Vue 3.6 RC:** verify the pass-through wrappers still hold, fold any
   behavioural notes into the alignment table, bump the peer dependency.
2. **The stable-landing realignment** (see "What flips at Vue 3.6 stable" below): wrapper
   elimination, registry collapse.

[^v150]: v1.5.0 closed the last planned capabilities: `serialize`, `idempotent`, `onMissing:'buffer'` deferred dispatch, `createEchoBridge`, and the `vapor-chamber/reactive` companion.

Maintenance continues: correctness hardening, coverage, doc currency, performance
re-measurement. New feature work does not. A request for a new capability waits until after 3.6
stable, when the deployment patterns that would justify it are observable.

**For composition work, the decision owner superseded the wait: the RC window is the runway, not
the waiting room.** The freeze still governs ordinary feature requests, and its real job is
unchanged: standing pressure to justify every byte with evidence. Waiting for stable buys safety
at the cost of arriving unproven. Building now means v2.0 at stable promotes and stabilizes a
system that has already survived N alignment cycles.[^runway]

[^runway]: What changed is the conclusion drawn from a tiny userbase and a pre-release peer dependency. This repo's own history is the argument: the bus hardened over the betas, and the router was built and realigned from rc.1 onward, through every RC since.

A piece may therefore land experimental in a 1.x minor once it clears the v1.17.0 template:
measured cost, what it buys, fixtures to the house standard. "Improves the architecture" clears
that bar, and "change for its own sake" does not.

- Six pieces have landed under it: `revalidateRoutes`, `vapor-chamber/router/vapor`,
  `vapor-chamber/store`, `vcCommandVapor`, `vcPayloadVapor` and `vcOptimisticVapor`. Each
  shipped on its own, each with a dated row in `docs/decisions.md`.
- That log is the test this rule states, so it alone decides whether a later piece belongs in
  this count.
- **At stable the remaining work is arrival, not construction:** re-measure every number, run the
  v2.0 identity decision over a proven surface, stabilize semver.

Changes that touched the freeze without breaking it are recorded in appendix A: the v1.14.0
`{ signal }` and `Symbol.dispose` exception, the v1.16.0 clock change, the v1.17.0
`vapor-chamber/vapor` subpath and its cost, and the v1.17.0 wildcard prefix.

## Pre-stable specifics

- **Peer dependency:** `vue: ">=3.5.0 || >=<!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->"`. The library supports Vue 3.5
  (composables only) and Vue 3.6 RCs (full Vapor surface).
- **Vapor APIs are still moving.** `defineVaporCustomElement`, `defineVaporComponent` and
  `defineVaporAsyncComponent` are stable in shape, but their behaviour keeps shifting.[^vapor-apis]
  The library's wrappers are pass-through, so consumers inherit each release's improvements with
  no code change. But the wrappers exist only because the API is not yet final. See
  [the whitepaper's Vue 3.6 alignment table](./docs/whitepaper.md) for the per-release detail.
- **The library's value during the RC phase** is graceful degradation (`null` returns when
  Vue's API is absent or not yet present), version probing (`isVaporAvailable`), and a stable
  surface for consumers to code against while Vue itself iterates.

[^vapor-apis]: Vue introduced them across 3.6.0-alpha.3 to alpha.7 (#13059 alpha.3, #14017 alpha.4, #13831's typing alpha.7), not beta.10. Their behaviour has moved with nearly every release since: generics inference, the emits and attrs split, VDOM slots interop normalization, error recovery, TransitionGroup move animation (Vue has no move hook, log 36.8), lazy lifecycle update jobs, HMR reload dedup, v-show move suppression, shared-definition hook retention, interop-bridge immutability.

## Upstream's Vapor roadmap: what we depend on, and what we don't

Vue tracks Vapor's own progress in [vuejs/core#13687][vapor-roadmap]. Read it for **stated design
intent**, not only for checkboxes. It is where upstream says things no commit diff shows, and two
of those statements carry weight here.

**The rule this project applies, both ways:** an unchecked box does not mean missing, and a
checked box does not mean working. So a fixture settles each item, not a reading of the
list.[^both-ways]

[^both-ways]: Both halves have bitten this project. Provide/inject was unchecked while measurably working, and KeepAlive was checked while this library's own integration with it was inert.

**Design intent that is now settled upstream (not a gap awaiting a fix):**

- **`getCurrentInstance()` returns `null` inside Vapor components, intentionally** (maintainer,
  2026-07-20). An internal `useInstanceOption` exists but is deliberately not public. That is why
  `tryKeepAliveHooks` gates on `hasInjectionContext()` (see the rc.4 and rc.5 rows in the
  whitepaper's appendix B). The gate is **permanent**: do not reintroduce an instance-accessor
  probe expecting it to start answering.
- **The gate is only half of it.** The wiring list in `src/vue.ts` carries weight, and is pinned by
  `tests/vue-subpath-wiring-fixture.test.ts`. A correct guard fed by an incomplete registry is an
  absent guard.[^wiring]
- **Vapor exposes no general-purpose component instance tree to userland, by design**
  (maintainer, 2026-08), so user code cannot depend on internal instances. Two consequences for
  this repo, both favourable and neither needing work:
  - **Vue Test Utils** (unchecked): upstream ruled out `findComponent`-style traversal. So
    `createTestBus`, which asserts at the bus boundary, is the aligned testing story however VTU
    lands.
  - **DevTools Integration** (unchecked): `src/devtools.ts` builds its inspector tree from
    buffered `bus.onAfter` entries, never from Vue's component tree. So the Commands timeline and
    inspector panel do not wait on Vapor component-tree bookkeeping.

[^wiring]: v1.17.0 found that `vapor-chamber/vue` never passed `hasInjectionContext` to `configureVue()`. So in a production bundle, where the probe cannot resolve `vue`, the gate fell back to `getCurrentInstance()` and went inert exactly as it did before rc.4.

**Unchecked items this project does not depend on:**

| Upstream item | Why it doesn't block us |
| --- | --- |
| VaporSuspense | `useVaporAsyncCommand` awaits a bus promise and creates no boundary of its own. VDOM `<Suspense>` <-> Vapor interop already works |
| Vue Router | this repo ships its own router (`vapor-chamber/router`), URL-addressed and vDOM-free by design |
| Pinia / Nuxt / VitePress | no dependency in either direction |
| Provide/Inject System | measured working at **both** levels on a real `createVaporApp` - `tests/router/vapor-fixture.test.ts` (primitive) and `tests/vapor/router-composables.test.ts` (composables inside a real `defineVaporComponent`) |

[vapor-roadmap]: https://github.com/vuejs/core/issues/13687

## What is stable before Vue 3.6 stable

No shape is promised until Vue 3.6 ships stable.[^beta-start] Until then the shape stays free to
change, and a breaking change ships as a minor with the CHANGELOG naming it (see "Version policy
before 3.6 stable" under [Version targets](#version-targets)). The bus, plugins, transports and
the other layers that do not import Vue never wait on Vue's API, but they are not frozen either.
What a release exports is in its CHANGELOG entry and [docs/api/](./docs/api/README.md), not in a
list here.[^stable-list]

[^beta-start]: The project started in a beta expecting a near release. Vue has been in release candidates since 2026-07-18 (dates above).

[^stable-list]: A list of stable names here went stale with each RC.

## What is transitional and will realign post-3.6-stable

Everything below exists mainly to bridge the 3.5 -> 3.6 gap. A removal or rename lands in one
release with every consumer and example moved, and the CHANGELOG says "Changed X to Y" or
"Removed X". There is no deprecation cycle, alias or warning (owner, 2026-10-05 and
2026-10-06).

### `useVaporCommand` and `useCommand` have converged: **DONE**

There is a single command composable, `useCommand`: `dispatch`, `register`, `on`, `emit` and
`dispose`, plus `pending(action, target?)`, the bus's command state for that key. It is
Vapor-safe in `<script setup vapor>` and VDOM alike, because it cleans up with `onScopeDispose`
only and uses no `getCurrentInstance()`. `useVaporCommand` was **removed entirely**, not left as
a deprecated alias.[^converged]

[^converged]: The split existed because, before 3.6, cleanup based on `getCurrentInstance()` fails in Vapor components. `pending` replaced `loading` and `lastError` in v1.32.0. The merge removed about 60 lines of duplicated logic, and the "which one do I use?" question from the docs.

### Thin Vapor wrappers will become opt-in through a build flag

`defineVaporComponent`, `defineVaporCustomElement`, `defineVaporAsyncComponent` and
`createVaporChamberApp` exist to give a `null`-returning safety surface when Vue's API is not
present. After Vue 3.6 stable, that null path is dead code for any consumer with Vue 3.6 or later
in their dependency tree.

**Decision (rc.3): the flavor apparatus is withdrawn, and `configureVue()` is the plan.** The
`__VAPOR_NATIVE__` define, the second build and the `vue36` export condition are withdrawn as
roadmap items, not deferred. Two verified facts each decide it alone:

1. **Compiling the wrappers to `return options` silently drops the `__vapor` marker:** no error,
   no null, just wrong-mode rendering.[^fact1]
2. **The prize is under a kilobyte.** The whole probe, registry, `configureVue` and
   detection-hint region of `chamber.ts` measures **2,299 B minified / 885 B brotli**. That is an
   upper bound on what any flavor could delete, since it includes machinery every flavor keeps.
   Two dist flavors, a build flag and a resolution condition are not a reasonable trade for under
   0.9 KB.[^fact3]

A third argument, that nothing could be statically imported from `vue`, was wrong, and was
corrected in the rc.6 cycle. All four wrapped APIs are statically importable from `vue`, and were
at rc.5 too. That correction does not revive the flavor: the two facts above still hold. The
flavor is no longer *impossible*. It is merely not worth building. Appendix B keeps the full
record.

[^fact1]: Checked in `node_modules/@vue/runtime-vapor/dist/runtime-vapor.esm-bundler.js`. `defineVaporComponent` sets `comp.__vapor = true` before returning `comp`, and for a *function* `comp` it builds a fresh `{name, setup, __vapor}` object. `defineVaporAsyncComponent` builds a `VaporAsyncComponentWrapper`, and `defineVaporCustomElement` returns a `class ... extends VaporElement`. So the "identity wrappers" premise was a silent bug.

[^fact3]: Measured with esbuild `--minify` and brotli q=11, over lines ~60-412 of `chamber.ts` at the time.

**What replaces it costs nothing, because it already exists:**
[`configureVue(vue)`](./src/chamber.ts). The consumer hands over the Vue namespace they actually
use, the registry seeds synchronously, and the wrappers' null path becomes unreachable. One
channel serves every consumer type (bundler alias, import map, `esm-browser` dist, custom build),
with no probe race, no new surface and no peer dependency. It was documented as the no-bundler
escape hatch. It is in fact the deterministic Vapor wiring for everyone, and the docs say so.

**The runtime probe stays, permanently.** It is the zero-config path and the only channel
no-build pages have. `configureVue` bypasses it, and nothing deletes it. Both paths are maintained
past 2.0.

**Reopen condition** (the one future in which a flavor becomes worth revisiting): Vue ships a
with-vapor *bundler* entry, or a `vue`-scoped vapor subpath or condition, at 3.6 stable. Then a
static-import fast path becomes possible, and it still has to clear the ~885 B bar,
re-measured.

**Status:** the condition is an **or**, and its first half is met. `vue`'s bundler entry
re-exports the whole `@vue/runtime-vapor` surface through `export *`. The second half is not:
there is still no `vue`-scoped vapor subpath or condition in the exports map. So a static-import
fast path is possible, and it still has to clear the ~885 B bar. **It has not been re-measured,
and until it is, nothing changes.** `tests/vue-bundler-vapor-exports.test.ts` fails if the four
wrapped APIs stop being statically importable, or if a vapor subpath or condition appears. So a
test maintains this row, rather than someone remembering to look.

### Runtime feature-detection registry: kept, and measured

`chamber.ts` keeps a registry of probed Vue functions (`_defineVaporCustomElementFn`,
`_vueOnScopeDispose`, `_vueGetCurrentScope`, `_vueHasInjectionContext`, `_vueOnActivated`,
`_vueOnDeactivated` and others). Each entry exists because a given Vue version may or may not
have it.

- Every remaining slot has live call sites, so there is no dead probe to prune.[^registry-audit]
- The pruning rule: an entry goes only when the peer floor moves past the version that made it
  conditional, which Vue 3.5 support still prevents for all of them.
- The whole registry-and-probe region is 900 B brotli or less, and `configureVue()` already seeds
  it synchronously for consumers who want determinism. The entries stay because the peer range
  keeps 3.5 (no Vapor, partial hooks) supported.[^registry-plan]

[^registry-audit]: Re-audited at rc.6. The list once named `_vueOnUnmounted`, which no longer exists. The `onUnmounted` cleanup fallback became unreachable, and was removed, once `getCurrentScope()` was established as always non-null inside a Vue 3.5+ `setup()`.

[^registry-plan]: This section once planned a post-stable collapse to direct `vue` imports under the `vue36` flavor. It was withdrawn with the flavor (see above).

### `v-vc-command` in Vapor: shipped in v1.20.0 as `vcCommandVapor`

`withVaporDirectives` is a public export of the with-vapor build, and ships in **every** Vue
version this project has tracked.[^directives-wrong] What is real is that the two renderers want
different **shapes**, so one `app.directive('vc', ...)` registration cannot serve both:

```
VDOM    { mounted(el, binding), updated(el, binding), beforeUnmount(el) }
Vapor   (el, value, argument, modifiers) => cleanup | void
```

[^directives-wrong]: This file once listed "Directives in Vapor" under **what is not on the roadmap**, on the grounds that "the Vue team has consistently signaled directives remain a VDOM-only feature". That was wrong for the whole time it was written down. Verified by unpacking the published `@vue/runtime-vapor` dist from 3.6.0-alpha.3 through rc.3. rc.3 did not add it: it hardened it (#15258, #15167, #15158). Measured in `tests/vapor-directives-fixture.test.ts`.

- The Vapor form runs once per element. On an element it runs in the current scope, and only a
  component or fragment root gets a detached `EffectScope`. It returns its own cleanup, and has
  **no `updated` hook**: the value arrives as a getter.
- So the port is a second export, `vcCommandVapor` from `vapor-chamber/directives`, built over
  the same `buildHandler`. It reads the getter at dispatch time rather than tracking it. Tracking
  is possible with the public `watchEffect`, which Vue's own Vapor directive tests use, but it
  costs one effect per mounted control. Reading at dispatch time picks up an action set after
  mount, and a press with no action does nothing.
- `tests/directives-vapor-fixture.test.ts` mounts it on a real Vapor app.
- The plugin no longer warns "not ported to Vapor". Installed on a Vapor app, it registers
  nothing that works there, and warns in DEV: "On a Vapor app use vcCommandVapor."

It was taken in the rc.8 cycle under the feature template. It was the one place this library
diverged from a Vue capability, while Vue kept investing in Vapor directives (rc.8 wraps its own
directive helpers in `withOnce`). Its cost, what it buys and the fixture are recorded in CHANGELOG
v1.20.0 and docs/decisions.md.

### `createVaporChamberApp`: decided at v2.0, never marked deprecated

When Vue Vapor is absent, it throws a clearer error than `createVaporApp` would. In Node and on a
no-build page, Vapor ships only in a separate dist file, and there the clear throw is the feature:
`createVaporChamberApp` names which of "Vue absent", "Vue without Vapor" and "Vue unreachable"
happened, and `createVaporApp` names none of them.

**Status: not due.** Vue is at <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->, so the stable trigger has not fired.
At v2.0 it is either kept or removed cleanly, with every consumer moved to
`import { createVaporApp } from 'vue'`. It gets no `@deprecated` tag on the way (owner,
2026-10-05: no deprecations). Nothing changes before v2.0.

## Variant contents are not under semver before v2.0

The IIFE variants (`core`, `elements`, `full`) are split by **audience and deployment shape**:
sprinkled JS, embeddable widgets, kitchen-sink SPAs. While Vue 3.6 is in RC, the library may move
APIs between variants:

- An API in `core` today may move to `full` in a later v1.x release, if usage data or audience
  clarification suggests it does not fit the variant's identity.[^ws-moved]
- A new API may appear in `core`, if it is idiomatic for the audience.[^connect-added]
- ESM consumers (the `vapor-chamber` main entry) are unaffected. The main entry exposes the union
  of all variants and follows strict semver.

[^ws-moved]: The WebSocket and SSE bridges took this step in v1.2.0: realtime is a different deployment shape than sprinkled JS, so they moved from `core` to `full`.

[^connect-added]: `connect()` took this step in v1.2.0, as a one-liner for the sprinkled-JS audience.

This exemption ends at v2.0. Once Vue 3.6 ships stable and consumer deployment patterns are
observable, variant boundaries become semver-stable. Until then, treat IIFE variant *names* as
stable, and variant *contents* as still being refined.

If you pin to a specific variant's API surface, do so against `dist/` in your own infrastructure,
not the public CDN. The full surface is always in `full`.

## Two doorways: general bus and fast lane

The library ships **two dispatch paths** in the same package, with deliberately different shapes:

- **`createCommandBus()`: general purpose.** Command envelope, CommandResult, plugins
  (`PluginParts`), after-hooks, listeners (exact and wildcard), schema, batch with rollback,
  request/response, AbortController, the cross-tab channel, the async bus's retry, HTTP, WS and
  SSE transports, Vapor wrappers. Ergonomics first. Use it for app-level commands.
- **`createFastLane()` (`vapor-chamber/fast-lane`): the real hot path.** It strips everything: no
  envelope, no result, no plugins, no hooks, no wildcards, no abort. Just
  `compile(action, handler)` returning a callable, plus `on`/`emit` for fan-out. Use it for
  per-frame game ticks, trading data feeds, audio buffer processing, scroll and mousemove
  sampling, physics steps. It is about an order of magnitude faster than `bus.dispatch` on the
  10k-dispatch bench: <!-- vc:benchCompileVsDispatch -->14.44<!-- /vc:benchCompileVsDispatch -->x its ops/sec, the median of the latest
  `npm run bench:bands`. `docs/performance.md` keeps the bench table, so read current figures
  there.

The two are not interchangeable. The fast lane is **not** a faster bus: it is a different tool
for a different workload. Reach for it because you measured the general bus as a bottleneck on a
hot loop, not because it is faster.

See [docs/performance.md](./docs/performance.md) for the full positioning, benchmark numbers and
decision tree.

## Open work, to discuss

Candidates the owner has not decided. Each carries its current position, and the posture above
governs when any of them is built.[^open-work]

[^open-work]: Moved here on 2026-10-12 from the retired failures plan, whose live contract is now [docs/contract.md](docs/contract.md).

**Failures and the wire**

- **Shared tables and a handshake.** Three tiers of codes: the core's, the app's contract
  (`fails` in the schema, known to both sides) and a plugin's (not guaranteed on the other side).
  - Each table is identified by the hash of its content, and is immutable.
  - The hashes cross at a WebSocket's open, or in a request header of this library's own (RFC
    9842's header is scoped to content encoding).
  - An unknown table crosses once and is cached by hash. Codes are append-only.
  - A code's meaning never needs a table: the tables are for compression and documentation.
  - Position: to measure (bytes per connection and per failure).
- **CBOR on byte wires.** Measured: minimal RFC 9457 JSON is the biggest win over HTTP, with no
  encoder. CBOR (RFC 9290's model) only where nothing compresses (WebSocket frames, storage).
  Open: an existing encoder's size against a subset of this library's own.
- **`fails` in `BusSchema`:** code, status, and the field it can point at.
- ~~**Server push of store states.**~~ Built. A push is a name and data on every wire: an SSE
  event, an Echo broadcast, a WebSocket frame `{ event, data }` with no `id`. Each store state
  under `data.stores` is written to that store, then the event is emitted on the bus, never
  dispatched, so no plugin runs and nothing is sent back. The write is a step of `<event>$push`,
  a `$` name no reducer has, so a store's rollback keeps the state it set (`_pushed`,
  `src/applied-remotely.ts`, [docs/contract.md](docs/contract.md#4-the-wire)).
- **One type vocabulary** for the schema's `FieldType` and the router's `ParamType`, which name
  the same primitives differently, with a codec per boundary. Open: the names and the split.
- **A generated error registry.** `ERROR_CODE_REGISTRY` is still written by hand. The rule "an
  integrated list is an outcome" says it should be derived from the sites that raise each code,
  with a build check that every code is raised, documented and tested (rustc's tidy does this).
- **A plugin descriptor** declared by the plugin's author (name, codes, table hash), a bus-level
  diagnostics event, hooks per condition, inspection by name. Position: take the descriptor.
- **A DEV warning that names the install site** of a plugin with no `id`.

**Modes**

- **The fuse.** Nothing failure-related is built on success, and a command's key is computed once
  and shared: kept as a rule. A runtime switch that turns on expensive observation (devtools
  timeline, traces) after the first failure for a key earns its place only once that observation
  is measured.
- **A debug mode:** production code paths with observation on, a build flag beside `__VC_DEV__`
  (`__VC_DEBUG__`, as Vue's `__VUE_PROD_DEVTOOLS__`), folded away when off. Condition: it changes
  what is observed, never what happens, enforced by running the suite in production and debug and
  asserting identical results.
- **Standard Schema as the one validation path:** measure `BusSchema` through `~standard` against
  `schemaValidator`, for speed and size.
- **A contract test** that the build-time and runtime resolution of a plugin's `fail` give
  identical objects.
- **Re-measure the failure-path figures** (refusal cost, readers by shape) under the house A/B
  (`npm run ab`), stamped instead of typed.

**Components**

- **`KeepAlive` listeners:** pause, as `useCommandHistory` does, or stay live. Position: pause,
  since a cached page is refreshed by the router's re-read.
- ~~**`persist` applies what it loads**~~: settled by removing the plugin. A store's
  `persist: saveTo({ key })` reads its saved state when the store is created, and saves after any
  of its writes (`src/store-persist.ts`).

**Accessibility** (the guarantees are in [docs/accessibility.md](docs/accessibility.md))

- A reaction plugin that announces by `meta.origin` (what the user did: `user`, `undo`, `redo`,
  and silent for `remote`, `sync`, `replay`, `agent`), with urgency from the condition, focus after
  render, and a per-command opt-out.
- Focusing the first invalid field after a failed submit.
- Pausing auto-updating content (WCAG 2.2.2): revalidation, polling, SSE.
- Transitions and `prefers-reduced-motion`.
- Form participation for custom elements on Vue's `VaporElement`.
- Biome's `a11y` lint rules on the examples' HTML and Vue files, so a button with no `type`
  (submit, in a form) cannot come back.[^a11y-49]
- RFC 9111 revalidation through `fetch` against `http-cache`'s time windows, in a real browser.

[^a11y-49]: The 49 buttons there had one added on 2026-10-13.

**PHP**

- The Composer package `lucianofedericopereira/vapor-chamber` holds the wire contract's
  development routes. Open: the controller itself in the package, attributes that author the same
  `BusSchema` shape, a `Problem` helper, `generate-laravel` runnable by users.

## What is not on the roadmap

- **Forking Vue internals.** The library wraps Vue's public API and detects features at runtime.
  Bundling polyfills or forking compiler output is out of scope.
- **A full SFC-aware HMR replacement.** `vite-hmr.ts` keeps tracking `@vitejs/plugin-vue` rather
  than rebuilding HMR.
- **Rebuilding the router on the command bus.** The two pipelines look alike: `beforeEach` guards
  resemble a cancelable `onBefore`, loaders resemble async handlers, commit resembles a result,
  and `afterEach` resembles `onAfter`. Rejected: the router's pipeline carries domain semantics
  generic dispatch has no slot for (two-phase commit with atomic data, URL revert on a popstate
  abort, newer-navigation superseding through `AbortController`). And the Vapor outlet's whole
  premise is that the router core does not change. The likeness is why `revalidateRoutes` is a
  small plugin, not a reason to merge the engines.

## Version targets

Per-release detail lives in **one** place: the whitepaper's appendix B, its per-release rows
(`docs/whitepaper.md`), with `CHANGELOG.md` as the narrative.[^third-copy] What this file still
owns is the change to the *contract* each release made. The released rows, v1.13.0 to v1.20.0,
are in appendix C. The one still ahead:

| Version | Trigger | What changes about the *contract* |
|---------|---------|-----------------------------------|
| current line | Each 3.6 RC | Tracking bumps: peer dependency, alignment notes, perf re-measure. No contract change. |
| v2.0.0 | One minor cycle after 3.6 stable | Stable-landing realignment: finalize the identity decision (Vapor-first or bus-first). The `vue36` flavor and registry collapse were withdrawn at rc.3 (superseded by `configureVue()`, with under 0.9 KB at stake: see "What is transitional"). `useVaporCommand` -> `useCommand` shipped early in v1.7.0. See the checklist below. |

[^third-copy]: This file once carried a third copy of that table, which drifted: it still ended at *v1.7.0 (unreleased)* long after v1.11.0 shipped. v1.10.0 made the same call for the README's size table (deleted rather than re-synced), and it holds here: a third copy is a third thing to keep true.

**Version policy before 3.6 stable.** Breaking changes ship as **minors**, not majors.

- The policy rests on two things. The pre-stable peer dependency is still a moving target
  (<!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> today). And the surfaces that have taken breaking changes are the ones
  documented experimental.[^policy-basis]
- A breaking change to a surface documented as stable needs a major, in the RC phase or not.
- **2.0.0 remains reserved for the post-stable identity decision** (Vapor-first or bus-first),
  which keeps the major bump meaningful. The `vue36` flavor and registry collapse were withdrawn
  from that reservation at rc.3 (see "What is transitional").
- Corollary, **we deliver first:** any v2.0-roadmapped item that does *not* depend on the stable
  identity call ships early in a minor as soon as it is ready. The `useVaporCommand` ->
  `useCommand` merge landed this way in v1.7.0.

[^policy-basis]: The original justification, "the peer dependency is a moving beta", expired when Vue left beta. v1.11.0's `RouterOutlet` subpath move cited the router's experimental status, not the beta window, and that is the standard going forward.

The `vue36` build-flag wrapper elimination is **withdrawn, not blocked**. `configureVue()`
supersedes it, and the evidence is in "What is transitional" above.[^vue36-path]

[^vue36-path]: The item was first slated for v1.5.0, then parked as "blocked on Vue 3.6 RC or stable". At rc.3 the blocker resolved the other way, and the item was withdrawn.

`createEchoBridge` (protocol-aware Reverb and Echo realtime: public, private and presence
channels -> bus) **shipped in v1.5.0**. It is a receive-only transport adapter, fully decoupled
from Vue, so nothing blocked it. See [docs/integrations/laravel.md](./docs/integrations/laravel.md).

## Vue version-support matrix

Which Vue versions each released line supports. The peer dependency is permissive
(`>=3.5.0 || >=<!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->`, matching `package.json`). This table is the *tested* support
statement.

| vapor-chamber | Vue 3.5 (composables only) | Vue 3.6 | Notes |
|---------------|----------------------------|---------|-------|
| v1.2.x - v1.5.x | yes | beta.11 -> beta.14 | the beta-aligned lines, v1.5.x feature-locked |
| v1.6.x - v1.7.0 | yes | beta.15 -> beta.17 | tracking-only bumps + the first post-lock delivery |
| **v1.8.0 ->** | yes | **rc.1 -> current** | tested against <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> |
| v2.0.0 | yes (composables) | **3.6 stable** | peer range gains stable, wiring unchanged: probe by default, `configureVue()` for determinism |

On Vue 3.5 you get the framework-agnostic surface: bus, plugins, transports, and composables with
`onScopeDispose` cleanup. The full Vapor surface (`defineVapor*`, `createVaporChamberApp`, the
interop plugin) needs Vue 3.6. It returns `null` or throws with a clear message when Vapor is
absent.

## What flips at Vue 3.6 stable

A single checklist for the stable landing (v2.0.0). "What is transitional" above details each
item. This is the operational summary, so the bump is mechanical, not archaeological.

**Read these as deadlines, not gates.** An item here is *owed* by v2.0.0. Any item ships earlier,
in a minor, the moment it is ready and does not depend on the stable identity call: the "we
deliver first" corollary. Items that ship early are checked with the release that carried them.
Items that die are struck with the reason, not deleted.

- [ ] **Peer dependency:** add `^3.6.0` (stable) to the supported range.
- ~~**`vue36` build flavor**~~: **withdrawn at rc.3**, not deferred. The identity premise was a
      silent bug at source (the `__vapor` marker), and the measured prize was under 0.9 KB
      brotli. Superseded by `configureVue()`. Evidence and the reopen condition are in "What is
      transitional".
- [x] **`useVaporCommand` -> `useCommand`**: **done**, shipped early in v1.7.0. The two
      composables were folded into a single Vapor-safe `useCommand` (`onScopeDispose`-only
      cleanup, `register`/`on`/`emit`/`dispose`). `useVaporCommand` was removed clean, with no
      deprecated re-export.
- [ ] **`createVaporChamberApp`**: keep it, or remove it cleanly with every consumer moved to
      `import { createVaporApp } from 'vue'`. No `@deprecated` tag.
- [~] **Typed Vapor surface**: **the subpath itself shipped early in v1.17.0** (appendix A). The
      TYPES half remains.
      - The entry carries the runtime wiring: it statically imports Vue's Vapor APIs, so the
        registry is seeded at build time rather than by a probe that cannot resolve in a
        production bundle. That half never depended on the stable identity call, so "we deliver
        first" applied.
      - Still owed at v2.0, in the same entry: once Vue's Vapor types settle at stable, give the
        `defineVapor*` wrappers first-class inference with Vue's exported types
        (`DefineVaporComponent`, `VaporComponent`, `VaporPublicProps`). That goes through the
        isolated `vapor-chamber/vapor` subpath export, so the `vue` type dependency never touches
        the Vue-less main barrel.
      - Until then the wrappers keep an opt-in `<T = any>` generic, with no Vue-type
        dependency.[^generic-v16]
- [x] **plugin-vue 6.x**: in use (devDependency). `>=5.0.0` already admits it.
- [ ] **Re-measure** IIFE sizes and their budgets (`scripts/check-size.mjs`). The docs' figures
      are stamped.
- [ ] **Variant contents** become semver-stable, and the reshuffle freedom of the RC phase ends.

[^generic-v16]: The generic was added in v1.6.0.

None of these changes behaviour for consumers who use the documented API. Each lands in one
release with every consumer and example moved, and the CHANGELOG names it.

## Vite + plugin-vue alignment

The library is aligned to **Vite 5.0.0 or later** and **@vitejs/plugin-vue 5.0.0 or later**. Both
are declared as optional peerDependencies. They matter only if a consumer uses the
`vapor-chamber/vite` plugins (HMR, `vaporChamberWire()`) or compiles Vue SFCs that target Vapor
mode.

**Tracking forward:**

- **Vite 8 + Rolldown.** Landed: the repo builds on Vite 8 (devDependency), whose default bundler
  is Rolldown, through the same programmatic `build()` API in
  [scripts/build.mjs](./scripts/build.mjs). README sizes are stamped from each build.
- **plugin-vue 6.x.** In use: the repo builds and tests on it (devDependency). The optional peer
  range `>=5.0.0` already admits it.
- **Lightning CSS.** Vite's CSS pipeline does not affect vapor-chamber, which emits no CSS, so no
  action is needed.

The v2 changes happen behind a major bump (see the version policy above).

## TypeScript 7: measured, and deliberately not taken yet

The library is pinned to **TypeScript ^6.0.3** by decision, not oversight. TypeScript 7 is the Go
port. Its `exports` map is `lib/version.cjs` plus `unstable/*`, and the classic JS compiler API
(`createProgram`, `parseJsonConfigFileContent`, `transform`, `factory`) is gone. Every tool that
loads TypeScript as a *library*, rather than shelling out to the `tsc` binary, breaks on it.

**The library itself is already TS 7 clean.** Measured on 7.0.2 in a clean worktree, every gate
but one passes, and the one failure is the library's own:

| gate | result on TS 7.0.2 |
| --- | --- |
| `typecheck` (all three projects) | passes |
| `build` (declaration emit + esbuild) | passes |
| `test:run` | 1981 passed, 1 skipped, same as TS 6 |
| `size:check` | byte-identical, all variants under budget |
| `docs` | **fails**: `ts.parseJsonConfigFileContent is not a function` |

**What blocks the move:**

- **`vue-tsc`**, which type-checks the example SFCs. Its latest release, 3.3.11, fails on
  `--version`, before doing any work: `require.resolve('typescript/lib/tsc')` throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. This is ecosystem-wide, not a Vue oversight. The same missing
  API stops Angular and typed ESLint rules, and TypeScript's own 7.0 notes tell Vue projects to
  stay on 6. It is tracked upstream in vuejs/language-tools#5381, waiting on the TypeScript 7.1
  programmatic API.
- **[scripts/generate-api-docs.mjs](./scripts/generate-api-docs.mjs)**, which reads the compiler
  directly.

The generator is deliberately NOT ported ahead of time. TS 6 publishes no `exports` map and no
`unstable/*`, while TS 7 publishes only `unstable/*`, so the two APIs exclude each other. Porting
forward breaks the build today, and supporting both means a dual code path in a build script, for
a migration that cannot happen yet.

**When 7.1 ships and vue-tsc supports it**, the work is known and small. Bump `typescript` in the
root and the three examples, and swap one function in the generator
(`parseJsonConfigFileContent` + `createProgram` for `API` + `updateSnapshot` from
`typescript/unstable/sync`). The TS 7 API was checked for everything the generator needs before
this note was written: entry points, alias resolution, signatures, doc comments and JSDoc tags.

## How to read this file

If you are a consumer choosing between APIs in this library:

- **Every export, until Vue 3.6 stable:** free to change shape, as "What is stable before Vue 3.6
  stable" above says. A change ships as a minor, named in the CHANGELOG.
- **Working today, reshaped in v2:** the "transitional" list. Use it, and expect a rename or
  removal to land in one release, with the CHANGELOG naming it. There is no deprecation window.
- **Avoid:** the `_*`-prefixed and `getXxxFn()` exports in `chamber.ts`, which are internal.

If you are contributing: no large change is pending. The build-flag wrapper elimination is
**withdrawn**, not deferred, and `configureVue()` replaced it (see "Thin Vapor wrappers will become
opt-in through a build flag" above). The library aligns on <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->.

For performance characteristics, optimization philosophy and tuning options, see
[docs/performance.md](./docs/performance.md).

---

## Appendix A: changes that touched the freeze

Kept as history. The posture above states what holds now.

**Exception, v1.14.0:** `on()`/`once()` gained `{ signal }` (AbortSignal auto-unsubscribe) and
`Symbol.dispose` on every returned unsubscribe function (`using` support). Both are plain
JS-platform ergonomics. Nothing here depends on or waits for Vue's own API surface, so they do not
touch the question the freeze exists to wait out. They were kept small on purpose: about 100 B
brotli or less on each IIFE variant (see CHANGELOG). The freeze on genuinely new *capability*,
state or behaviour tied to Vue's still-moving API, stands.

**Not an exception, v1.16.0: no API was added.** `meta.ts` now reads the clock once per microtask
turn instead of once per command. That is a behaviour change inside an existing field, not new
capability, so the freeze is untouched: no export, no option, no config.

- It is worth a **1.18-1.67x speedup on dispatch-shaped work**: a fixed 15-25 ns saved per
  command, and nothing once listener fan-out dominates. The bench confirms it: `bus.dispatch`
  went from 197.7x to 140.0x slower than a direct call.
- A runtime knob was built, measured and then **deleted**. An option earns its place only when
  each setting is right for different people, and one setting is right for nearly everyone. A
  user plugin covers the rare need for an exact per-command wall clock.
- `ts` is a wall clock, not an ordering key: order comes from `meta.id`'s monotonic counter either
  way.
- Evidence: `tests/clock-source-ab.test.ts` (the gain, with a control row that never stamps) and
  `tests/clock-source-contained.test.ts` (no TTL or expiry path can be affected).

**v1.17.0: `vapor-chamber/vapor`, and what it cost.** A new public subpath. The entry does not ask
whether an exception is permitted. The freeze is not a rule to waive but the standing pressure to
justify bytes and nanoseconds, and that pressure is where most of this project's bugs have come
from. So the entry records what matters: what it costs, measured, and what it buys.

- **Cost**, on the `examples/vapor-sfc` app bundle: `+1.84 KB raw / +0.74 KB gzip` over wiring
  `createVaporApp` by hand.
- **Buys:** a whole failure class removed. The runtime probe resolves under a dev server but
  cannot resolve in a production bundle. That gap produced two shipped prod-only bugs:
  `createVaporChamberApp()` throwing on a page with Vapor bundled into it, and v1.17.0's own inert
  KeepAlive guard. A static import has no such failure mode.
- **No new capability:** every function it exposes already existed elsewhere. What changes is
  *how Vue reaches the registry*.

**The squeeze shaped it.** The first version wired all five Vapor names, and took the example
bundle from 80 KB to **158 KB** raw. The consumer's bundler keeps a static import whether the app
calls it or not, so "wire everything" is billed to everyone, including those who use none of it.
Measuring each name separately produced the shipped design:

| wired | raw KB | delta |
| --- | --- | --- |
| `createVaporApp` | 80.23 | - |
| `+ defineVaporComponent` | 80.26 | +0.03 |
| `+ defineVaporAsyncComponent` | 82.07 | +1.84 |
| `+ defineVaporCustomElement` | 89.44 | +9.21 |
| `+ vaporInteropPlugin` | 158.50 | **+78.27** |

The entry wires the first three. Custom elements and the VDOM interop renderer stay opt-in behind
one `configureVue()` line, which composes because `configureVue` merges. Had the size not been
measured, the shipped default would have roughly doubled every pure-Vapor consumer's bundle, with
a renderer that audience does not use.

It is **over-delivery, not a policy break.** The v2.0 checklist reserves this exact subpath name
for the typed Vapor surface. The "we deliver first" corollary says a v2.0-roadmapped item that
does not depend on the stable identity call ships as soon as it is ready. The runtime wiring does
not depend on it, so it landed then, and the types follow at v2.0 in the same entry. It is the same
shape as `useVaporCommand` -> `useCommand`, which landed early in v1.7.0.

**Not an exception, v1.17.0: no API was added.** Wildcard listeners now carry a `prefix` computed
once in `on()`, so the dispatch-time match is a single `startsWith` instead of a re-derivation
through `matchesPattern`'s prefix cache. The same freeze reasoning as v1.16.0 applies: a
behaviour change inside existing machinery, with no export, option or config.

- The public `matchesPattern` is untouched. It keeps its cache, since it takes arbitrary
  caller-supplied patterns that nothing has classified in advance.
- It is worth a **1.14-1.32x speedup on wildcard fan-out** (10-31 ns saved per dispatch, growing
  with listener count), at **0 B brotli**.
- Two rows deliberately do *not* move. A bus with no wildcard listeners is about 1.00x, the
  control: that shape already short-circuits. A lone `'*'` listener is about 1.02x, because
  `matchesPattern` already returned on its first comparison.
- The idea comes from Vue rc.6's commit `29ed4b0`, which does the same hoist for template
  adoption.
- Evidence: `tests/wildcard-prefix-ab.test.ts`. It builds its baseline arm by reverting the
  shipped source, so both arms are the real dispatch path.

## Appendix B: the static-import argument, and how it was corrected

Kept as history for "Thin Vapor wrappers will become opt-in through a build flag".

The rc.3 decision rested on three facts. Fact 2 said there was (almost) nothing to statically
import from `vue`. **That fact was WRONG, and the rc.6 cycle corrected it. All four wrapped APIs
are statically importable from `vue`, and have been since at least rc.5.**

The rc.5 row had recorded that "exactly one of this lib's four wrapped APIs -
`defineVaporAsyncComponent` - *is* statically importable... the other three and
`vaporInteropPlugin` remain absent". That was wrong when it was written.
`vue.runtime.esm-bundler.js` is 23 lines long, and the row quoted two of them:

```js
import { defineVaporAsyncComponent, withAsyncContext } from "@vue/runtime-vapor";
export { compile, defineVaporAsyncComponent, withAsyncContext };
```

while missing the line between them:

```js
export * from "@vue/runtime-vapor";   // <- present at rc.5 AND rc.6
```

Enumerated through bundler resolution (`Object.keys` of the module), that entry exports **18
Vapor names on both rc.5 and rc.6, in byte-identical lists**. They include all four wrapped APIs
and `vaporInteropPlugin`:

> `VaporElement, VaporFragment, VaporKeepAlive, VaporTeleport, VaporTransition,
> VaporTransitionGroup, createVaporApp, createVaporSSRApp,
> defineVaporAsyncComponent, defineVaporComponent, defineVaporCustomElement,
> defineVaporSSRCustomElement, isVaporComponent, useVaporCssVars,
> vaporInteropPlugin, withVaporDirectives, withVaporKeys, withVaporModifiers`

The count is as seen through the test's name filter. The entry's full surface changed at rc.8
(`withOnce` added, runtime-vapor `withAsyncContext` removed).

**The lesson is the one the section was already teaching, applied to itself.** It said "verified
by enumerating the module's real exports, not by grepping for the name: a substring hit in that
file is not an export". Then it reached its conclusion from a hand-copied quote of the
named-export line. That is the same error with the sign flipped: an *absence* in a quote is not an
absence from the module, and an `export *` re-export has no name to grep for. The enumeration is
now a fixture rather than a paragraph (`tests/vue-bundler-vapor-exports.test.ts`), so the next
cycle reads a number instead of re-deriving it.

What remained true, each point checked rather than assumed:

- The exports map still has **no vapor condition or subpath** (enumerated at rc.6: `.`,
  `./server-renderer`, `./compiler-sfc`, `./jsx-runtime`, `./jsx-dev-runtime`, `./jsx`,
  `./dist/*`, `./package.json`). The only with-vapor *browser* dist is still `esm-browser`.
- `@vue/runtime-vapor` is now a **declared dependency of `vue`**, not merely transitive by
  accident, which is what makes Vue's own re-export legitimate. It is still not a dependency of
  this package, so importing it directly from here would remain a phantom import under strict
  pnpm.
- Deep-importing that dist in **raw Node ESM** still fails (`@vue/runtime-dom` does not give
  `TransitionPropsValidators` under Node's resolved condition). That is an artifact of raw-ESM
  condition resolution, not a packaging bug for the audience that file targets. Bundler consumers
  are fine, which this repo's own suite proves by importing bare `vue` unaliased under the default
  vitest config.

**None of this revived the flavor.** The fact that changed is the one the flavor's case rested on
most heavily. Fact 1 (compiling the wrappers to `return options` silently drops the `__vapor`
marker) and fact 3 (under 0.9 KB brotli at stake) are each fatal on their own, and what `vue`
re-exports affects neither. The flavor is no longer *impossible* for want of something to import.
It is merely not worth building. That is a weaker reason than the one first on file, so it is
stated as the weaker reason rather than left to look unchanged.

**The reopen condition's first half was met at rc.5 already,** which the rc.5 row got wrong. Since
the condition is an **or**, it is met, and its sentence applies: a static-import fast path is
possible, and it still has to clear the ~885 B bar, re-measured. What is gone is the argument that
there was nothing to import, an argument that was never true.

## Appendix C: released contract changes

The released rows of "Version targets", v1.13.0 to v1.20.0.

| Version | Trigger | What changes about the *contract* |
|---------|---------|-----------------------------------|
| v1.13.0 | rc.3 alignment | Tracking bump + docs: `configureVue()` promoted from no-bundler escape hatch to the recommended deterministic Vapor wiring for all consumers. No API change. |
| v1.16.0 | rc.5 alignment | Tracking bump, plus one real contract change: the transition bridge's `phase` / `dispose` became **non-enumerable**, so `{ ...bridge }` no longer carries them. Direct access and destructuring are unaffected. The change exists because `v-bind="t"`, the documented binding, was spreading both into the DOM as attributes. |
| v1.17.0 | rc.6 alignment | Two measured perf wins (wildcard fan-out 1.14-1.32x, router active-link stamping 1.77-1.86x), both 0 B. **New subpath `vapor-chamber/vapor`** (no new capability: a build-time wiring channel replacing the probe, wired set measured, custom-element/interop opt-in). Plus one real fix: `vapor-chamber/vue` never passed `hasInjectionContext`. So in a **production bundle** (probe dead) the rc.4 KeepAlive guard fell back to `getCurrentInstance()` and went inert, and `useCommandHistory`/`useCommandError` recorded commands dispatched into a deactivated view. Also: wildcard listeners match on a prefix computed at `on()` time (1.14-1.32x on wildcard fan-out, 0 B brotli, `'*'` unaffected). `configureVue()` documented as MERGING, so a Vapor app adds one name rather than re-enumerating eight. And one roadmap fact corrected: all four wrapped Vapor APIs are statically importable from `vue`, and were at rc.5. |
| v1.18.0 | rc.6 window | **New subpath `vapor-chamber/router/vapor`**: a Vapor-native `RouterOutlet`, experimental. A genuinely new render surface, so it overrides the "new capability parks until after 3.6 stable" posture deliberately and on evidence, per the maturation posture under "Posture" above. The RC window is the runway, and an outlet built over N alignment cycles arrives at stable already hardened. Gated on a measured number before any of it was built: **<!-- vc:outletSaving -->17.97<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->57.0<!-- /vc:outletSavingRaw --> KB raw** saved versus the same app rendering through the vDOM outlet plus interop, re-derived per run from a Vite production build by `tests/vapor/vapor-outlet-size.test.ts`. The guard holds two limits: the saving stays >= <!-- vc:outletFloor -->15.0<!-- /vc:outletFloor --> KB, and the Vapor outlet's own machinery over a router-without-outlet floor stays <= <!-- vc:outletOwnArmCeiling -->5.0<!-- /vc:outletOwnArmCeiling --> KB (**measured <!-- vc:outletOwnArm -->4.14<!-- /vc:outletOwnArm --> KB**). It is written to fail loudly if a later RC erodes either, and that failure is a decision trigger, not a threshold to raise. (Until the rc.8 cycle it was one esbuild-measured 19.5 KB bar on the difference, retired after firing twice on improvements: see the whitepaper's rc.8 row.) Contract changes: one additive `RouterErrorCode` (`mode_mismatch`), and route components on this outlet must be `defineVaporComponent` output. Blade rows still need the vDOM outlet. **Plus one BREAKING change to `vapor-chamber/router`**: it no longer builds an http client. So a `{ url }` route table now needs `http` and blade rows need `fetchBlade`, and `routerHttp()` and `bladeFetcher()` ship as the new `vapor-chamber/router/remote` subpath. Two lines for the affected setups, nothing for a generated table with no blade rows. That is the primary setup, and it was paying 3.4 KB brotli for features it never called. Taken in the RC window on the same maturation logic as the outlet above: near-zero adoption now, and the cost of the break only rises. `./router` drops 12.4 -> 9.6 KB brotli. Three more additive codes: `redirect_loop`, `no_router`, `http_unconfigured`. **Plus a new subpath `vapor-chamber/store`**: `defineChamberStore`, experimental, <!-- vc:sizeStore -->5.8<!-- /vc:sizeStore --> KB brotli, importing `vue` and nothing else. Store actions are commands, so `persist`, `history`, `sync`, `optimistic`, `idempotent`, `serialize` and the devtools timeline apply to store state with no store-specific code. URL-worthy fields delegate to the router rather than mirroring it. Lands with a deliberate reversal of whitepaper section 6 recorded in that section, for PACKAGE scope only: the bus still stores no state. No contract change for anyone not importing it. |
| v1.19.0 | rc.7 alignment | Tracking bump (peer `>=3.6.0-rc.7`). All 50 rc.7 commits read at source, every one pass-through. The cycle carried code anyway, because it also read every module in `src`: twenty-three defects, each reproduced before it was fixed. The largest class: five shipped plugins (`logger`, `history`, `circuitBreaker`, `metrics`, `persist`) read `next()`'s result as a `CommandResult`. On the async bus that is a Promise, so each took the wrong branch in silence. Now one shared rule, `src/settled.ts`. Numeric options that failed open on a bad value (NaN) now fall back to their documented default. Contract changes, all small: a second form on one bus now throws instead of taking the first one over (forms take an `id` prefix, default `'form'`, so a single form dispatches the names it always did). One additive `RouterErrorCode`, `cyclic_parent`. `configureVue` added to the `full` and `elements` IIFE namespaces. And the ESM build's DEV flag now folds in a consumer's production build, so dev-only diagnostic strings stop shipping: 14,037 -> 12,764 B raw and 4,453 -> 3,999 B brotli on a real Vite app build, about 10%. That held for one-chunk apps. In a code-split app, a chunk that imported DEV kept its strings until v1.20.0 derived DEV per module. |
| v1.20.0 | rc.8 alignment | Tracking bump (peer `>=3.6.0-rc.8`), plus one contract NARROWING, taken as a minor under the pre-stable policy in "Version targets". `retry()`'s default no longer retries an error carrying an HTTP status unless it is 408, 429 or 5xx. So `retry()` stacked in front of the HTTP bridge stops re-sending a 422. A handler that throws a 4xx-status error and relied on `retry()` re-running it passes its own `isRetryable`. Additive: `classifyError` and `isRetryableStatus` exported from the root. `vaporChamberWire()` from `vapor-chamber/vite`, a build-only Vite plugin that wires Vue into an app importing the root, with no import changed. `vcCommandVapor` from `vapor-chamber/directives`, `v-vc:command` for Vapor components (the plugin's install-time Vapor warning is gone). Also in this release: `useSharedCommandState().isLoading(action, target?)`. A plugin's throw is a `plugin:failed:plugin` result, and a sealed bus refuses `clear()`. `dispose()` settles waiting `request()`s, and the sync `request()` honours its signal. A before-hook's throw is a `core:refused:hook` result, and `history()` records an async redo once. The ESM build's DEV is derived per module. Sizes measured as they ship (Vite production builds, about 10% lower). `alien-signals` is an optional peer. `dispose()` runs each plugin's `dispose()`, and `retry()` has one. What an undo handler or a redo dispatches carries origin `undo` / `redo` and is never recorded. The TestBus's `request()`/`respond()` are real. |

## Appendix D: feature matrix

Per-module status, moved here from the README. This file is the single source of truth for feature
status.

### Core

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| Dispatch / register / unregister | `command-bus` | v0.1.0 | 100% (line/branch/func) |
| Plugin pipeline (sync + async) | `command-bus` | v0.1.0 | 100% (line/branch/func) |
| ~~Plugin priority ordering~~: removed in v1.32.0, no part has a position and plugins run in install order | `command-bus` | v0.2.0 | - |
| `onAfter` hooks | `command-bus` | v0.2.0 | covered |
| Dead letter handling (`onMissing`) | `command-bus` | v0.2.0 | covered |
| Command batching + `continueOnError` + `successCount`/`failCount` | `command-bus` | v0.6.0 | covered |
| Naming convention enforcement | `command-bus` | v0.3.0 | covered |
| Wildcard listeners (`on`, `prefix*`) | `command-bus` | v0.3.0 | covered |
| `once()` - one-shot listener | `command-bus` | v0.6.0 | covered |
| `offAll(pattern?)` - mass unsubscribe | `command-bus` | v0.6.0 | covered |
| ~~`onBefore(hook)` - pre-dispatch hook, cancelable~~: removed in v1.32.0, a gate is a plugin's `authorize` or `validate` rule and an observer its `started` part | `command-bus` | v0.6.0 | - |
| Request / response pattern + timeout | `command-bus` | v0.3.0 | covered |
| Per-command undo at register (its `throttle` removed in v1.32.0, pacing is the sender's: `pace()`) | `command-bus` | v0.3.0 | covered |
| `bus.hasHandler()` introspection | `command-bus` | v0.3.0 | covered |
| `bus.clear()` | `command-bus` | v0.5.0 | covered |
| `BaseBus` structural interface | `command-bus` | v0.6.0 | covered |
| `query()` - CQRS read-only dispatch (the rules, the steps and the handler, then afterHooks) | `command-bus` | v1.0 | covered |
| `emit()` - domain events (no handler, no result) | `command-bus` | v1.0 | covered |
| `Command.meta` - auto-stamped id, ts, correlationId, causationId | `command-bus` | v1.0 | covered |
| `registeredActions()` - introspection | `command-bus` | v1.0 | covered |
| `commandKey(action, target)` export | `command-bus` | v0.6.0 | covered |
| `BusError` structured error class (`owner:condition:subject` code, `toJSON` problem document) | `command-bus` | v1.0 | covered |
| A throwing or rejecting plugin becomes a `plugin:failed:plugin` result at its boundary (not retried, not circuit-counted) | `command-bus` | v1.20.0 | covered |
| `inspectBus(bus)` - tree-shakeable topology introspection | `command-bus` | v1.0 | covered |
| `bus.seal()` / `unsealBus(bus)` - freeze configuration | `command-bus` | v1.0 | covered |
| `bus.dispose()` - clean teardown with timer cancellation | `command-bus` | v1.0 | covered |
| `createCommandPool(size)` - pre-allocated object pool | `command-bus` | v1.0 | covered |
| Transactional batch with undo rollback | `command-bus` | v1.0 | covered |
| Recursion depth guard (max 16) | `command-bus` | v1.0 | covered |
| V8 optimizations (monomorphic shapes, index loops, extracted try/catch) | `command-bus` | v1.0 | bench |
| SSR isolation (independent bus instances) | `command-bus` | v0.5.0 | covered |
| `createTestBus` record + assert | `testing` | v0.2.0 | harness (excluded) |
| `createTestBus` snapshot & time-travel | `testing` | v0.4.3 | covered |
| `TestBus.on()` / `once()` / `offAll()` real, not stubs | `testing` | v0.6.0 | covered |

### Plugins

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `logger` | `plugins-core` | v0.1.0 | 100% lines |
| `validator` | `plugins-core` | v0.1.0 | covered |
| `history` + bus-backed undo/redo | `plugins-core` | v0.3.0 | covered |
| ~~`debounce` (stale-closure fix)~~: removed in v1.32.0, pacing is the sender's (`pace(bus.dispatch, { debounce })`) | `plugins-core` | v0.3.0 | - |
| ~~`throttle`~~: removed in v1.32.0, pacing is the sender's (`pace(bus.dispatch, { throttle })`) | `plugins-core` | v0.3.0 | - |
| `authGuard` | `plugins-core` | v0.3.0 | covered |
| ~~`optimistic`~~: removed in v1.32.0, the handler makes the change (`register(action, handler, { undo, optimistic: true })`) | `plugins-core` | v0.3.0 | - |
| ~~`optimisticUndo` - auto-rollback through registered undo handlers~~: removed in v1.32.0, the same register option | `plugins-core` | v1.0 | - |
| ~~`retry` with configurable backoff + glob filter~~: removed in v1.25.0, the async bus retries on its own (its `retry` option) | `plugins-io` | v0.4.2 | - |
| ~~`persist` (localStorage / custom storage)~~: removed in v1.32.0, a store saves its own state (`persist: saveTo({ key })`, `store-persist`) | `plugins-io` | v0.4.2 | - |
| `createChannel` (BroadcastChannel, same-origin contexts) | `plugins-io` | v0.4.2 | covered |
| `cache` - LRU query result caching with TTL + glob filter | `plugins-extra` | v1.0 | covered |
| `circuitBreaker` - per-action closed/open/half-open resilience | `plugins-extra` | v1.0 | covered |
| `rateLimit` - per-action sliding window limiter | `plugins-extra` | v1.0 | covered |
| `metrics` - lightweight telemetry (count, duration, errorRate) | `plugins-extra` | v1.0 | covered |
| ~~`serialize` - per-key sequential processing (async, prevents same-key races, `scope:'cross-tab'` through Web Locks)~~: removed in v1.32.0, an action takes `register(action, handler, { exclusive })` and a store `exclusive: true` | `plugins-extra` | v1.5 | - |
| `idempotent` - collapse duplicate commands (double-submit/retry), stamps `Idempotency-Key` for the HTTP bridge | `plugins-extra` | v1.5 | covered |
| `supersede` - aborts the previous in-flight dispatch for the same key (async bus, the stale request is cancelled, not ignored) | `plugins-extra` | v1.9.0 | covered |

### Utilities

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createChamber` - declarative namespace grouping | `utilities` | v1.0 | covered |
| `createWorkflow` - saga pattern with compensation | `utilities` | v1.0 | covered |
| `createReaction` - declarative cross-domain rules | `utilities` | v1.0 | covered |

### Transport layer

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `postCommand` - POST with retry, CSRF, timeout, session | `http` | v0.5.0 | 100% lines |
| `readCsrfToken` - meta / cookie / hidden input | `http` | v0.5.0 | covered |
| ~~`HttpError.code`~~: removed in v1.26.0, every client failure is the core's `BusError` and a backend's code reads `remote:<condition>:<code>` | `http` | v0.6.0 | - |
| 419 vs 401 fix: CSRF expiry is not session expiry | `http` | v0.6.0 | covered |
| `httpTransport` (`createHttpBridge` until v1.32.0) - the fetch transport, declared at `createAsyncCommandBus({ transport })` | `transports` | v0.4.2 | 100% lines |
| ~~`HttpBridgeOptions.noRetry`~~: removed in v1.25.0, the bridges declare `transport` and the async bus's class rule decides | `transports` | v0.6.0 | - |
| `HttpTransportOptions.scopeController` - Vapor lifecycle abort | `transports` | v0.6.0 | covered |
| `wsTransport` (`createWsBridge` until v1.32.0) - WebSocket transport + reconnect + bounded queue | `transports` | v0.6.0 | covered |
| `wsTransport().connected` - reactive signal for connection state | `transports` | v0.6.0 | covered |
| `createSseBridge` - server-push EventSource, accepts `BaseBus` | `transports` | v0.6.0 | covered |
| `createEchoBridge` - Laravel Echo/Reverb realtime (public/private/presence -> bus) | `transports` | v1.5.0 | covered |

### Vue composables (needs Vue >= 3.5)

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `useCommand` - Vapor-safe composable (dispatch/register/on/emit/dispose, `pending(action, target?)`) | `chamber` | v0.6.0 | covered |
| ~~`useCommandState`~~: removed in v1.32.0, state reduced by commands is a store (`defineChamberStore`, `vapor-chamber/store`) | `chamber` | v0.2.0 | - |
| `useCommandHistory` - reactive undo/redo | `chamber` | v0.2.0 | covered |
| `useCommandGroup` - namespace isolation | `chamber` | v0.4.1 | covered |
| `useCommandError` - error boundary | `chamber` | v0.4.1 | covered |
| `useSharedCommandState().pending(action, target?)` (`isLoading`, renamed in v1.32.0) - per-key, bus-wide in flight | `chamber` | v1.20.0 | covered |
| `getCommandBus` / `setCommandBus` / `resetCommandBus` | `chamber` | v0.1.0 | covered |
| Signal shim + `configureSignal` | `chamber` | v0.3.0 | covered |
| `onScopeDispose` lifecycle alignment | `chamber` | v0.4.0 | covered |
| `isVaporAvailable()` | `chamber` | v0.4.0 | covered |
| `createVaporChamberApp` / `getVaporInteropPlugin` / `defineVaporCommand` | `chamber-vapor` | v0.4.0 | covered |
| `tryAutoCleanup` dev warning (no scope/instance) | `chamber` | v0.6.0 | covered |
| `waitForVueDetection()` - async Vue probe | `chamber` | v0.6.0 | covered |

### Router (`vapor-chamber/router`, experimental)

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createRouter` - table + engine over a server catch-all | `router` | v1.9.0 | covered |
| Two-layer URL model - path navigates, query is state (no remount) | `router/engine` | v1.9.0 | covered |
| Two-phase commit - loaders resolve before one frozen snapshot lands | `router/engine` | v1.9.0 | covered |
| Guards + after-hooks, self-removal safe, bounded guard redirects (`redirect_loop`) | `router/engine` | v1.9.0 | covered |
| Loader SPI - `prefixes` / `url` / `affects`, abort-on-supersede, `ctx.revalidate` | `router/loaders` | v1.9.0 | covered |
| Typed query params - `useQueryParam`, `usePagination`, history conventions | `router/composables` | v1.9.0 | covered |
| Menu + breadcrumb projections, shared `data-active` semantics | `router/menu` | v1.9.0 | covered |
| DOM integration - link interception, active stamping, hover, focus + idle preheat | `router/dom` | v1.9.0 | covered |
| `RouterOutlet` (vDOM) + blade rows, on its own subpath | `router/vdom` | v1.11.0 | covered |
| `RouterOutlet` (Vapor-native), no interop | `router/vapor` | v1.18.0 | covered |
| `routerHttp` / `bladeFetcher` - the http-backed features, opt-in | `router/remote` | v1.18.0 | covered |
| `fetchLoaders` - in-box plain-JSON loader preset | `router-fetch` | v1.9.0 | covered |

### Extras

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createFormBus` - reactive form + sync/async validation | `form` | v0.6.0 | covered |
| `FormBus` headless mode (`reactive: false`) | `form` | v0.6.0 | covered |
| Schema layer - `createSchemaCommandBus`, `toTools`, `synthesize` | `schema` | v0.5.0 | 100% lines |
| Schema auto-validation (`schemaValidator` auto-installed) | `schema` | v1.0 | covered |
| `SynthesizeOptions.adapter` - custom LLM adapter | `schema` | v0.6.0 | covered |
| `ERROR_CODE_REGISTRY` - structured error lookup table | `error-registry` | v1.0 | covered |
| `busApiSchema()` - JSON schema of bus API for LLM prompts | `schema` | v1.0 | covered |
| `describeErrorCodes()` - plain-text error table for LLM system prompts | `error-registry` | v1.0 | covered |
| `setupDevtools` - Vue DevTools panel | `devtools` | v0.4.0 | covered |
| `createDirectivePlugin` - `v-vc-command` directive (vDOM) | `directives` | v0.6.0 | covered |
| `vcCommandVapor` - `v-vc-command` for Vapor components | `directives` | v1.20.0 | covered |
| `vcPayloadVapor` - `v-vc-payload` for Vapor components | `directives` | v1.22.0 | covered |
| `vcOptimisticVapor` - `v-vc-optimistic` for Vapor components | `directives` | v1.22.0 | covered |
| Vite HMR plugin (injects into scripts, never a `.vue` file) | `vite-hmr` | v0.6.0 | covered |
| IIFE / CDN bundle | `iife` | v0.5.0 | bundle entry |
