# Changelog

All notable changes to this project will be documented in this file.

## v1.3.0 — Vue 3.6.0-beta.12 alignment

### Changed

- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.12"`.

### Vue 3.6.0-beta.12 alignment

- **Error recovery in Vapor setup**: Vue now restores component context,
  fallthrough prop state, and render effect state after `setup()` throws.
  Wrappers (`createVaporChamberApp`, `defineVaporComponent`,
  `useVaporAsyncCommand`) are pass-through — consumers receive the fix
  automatically on upgrade.

- **VDOM slots interop**: `runtime-vapor` normalizes and exposes VDOM slots
  during interop, and no longer retains interop state from emits.
  `getVaporInteropPlugin()` passes through unchanged — mixed Vapor/VDOM trees
  pick up these fixes with no code changes.

- **SSR unresolved tag fallback**: `server-renderer` now renders unresolved tags
  as elements rather than failing. The `rehydrate()` function's `ignoreUnhandled`
  option already handles the command-bus side — this Vue fix covers the
  server-render side symmetrically.

- **Deferred fragment hydration anchors**: anchor preservation for deferred
  fragment hydration is now correct. Applications using `rehydrate()` inside
  Vapor fragments benefit without any vapor-chamber changes.

- **v-for item scope detach** (perf): Vapor's runtime detaches v-for item scopes
  on removal, preventing scope retention. `useCommandState` arrays used in v-for
  benefit from reduced scope overhead on item removal.

- **Static class fast path** (perf): Vapor's compiler emits a fast path for
  static class strings, lowering DOM update cost per render cycle.

### New

- **`useCommandState` coalesce option** (`chamber.ts`): New `{ coalesce: true }`
  third argument accumulates state mutations from synchronous dispatches and
  flushes the signal once per microtask via `queueMicrotask`. Pairs with
  beta.12's v-for source coalescing — the signal write is deferred, Vue's runtime
  coalesces the resulting DOM update into one pass. 10 rapid `dispatchBatch` items
  → 1 signal write instead of 10. Default: `false` (immediate write, unchanged).

  ```ts
  const { state } = useCommandState(
    [] as Item[],
    { append: (s, cmd) => [...s, cmd.target] },
    { coalesce: true }, // flush once per microtask burst
  );
  ```

### Performance

- **`syncQuery` bare-bus fast path** (`command-bus.ts`): `bus.query()` now skips
  the plugin runner and hook walk when the bus has no plugins, after-hooks, or
  listeners — matching the existing optimization in `bus.dispatch()`. CQRS read
  calls on a bare bus hit the handler directly with no indirection. Bench
  confirms `syncQuery` bare (2,393 hz) now matches `syncDispatch` bare (2,259 hz).

### Internal

- **`stampMeta` signature simplified** (`command-bus.ts`): Changed from
  `stampMeta({ action, target, payload })` to `stampMeta(payload)` — `action`
  and `target` were never read inside the function. Eliminates a temporary
  object at all 9 call sites.

- **`_prefixCache` FIFO eviction** (`command-bus.ts`): On overflow, the wildcard
  prefix cache previously called `Map.clear()`, wiping all 256 entries. Now
  evicts only the oldest entry (`Map` insertion order), keeping the cache warm.

- **`getCurrentScope()` in `tryAutoCleanup`** (`chamber.ts`): Replaced the
  `try { onScopeDispose(fn) } catch {}` pattern with `if (getCurrentScope())`.
  The unreachable `onUnmounted` fallback (dead code under Vue ≥ 3.5) is removed.
  `tryKeepAliveHooks` simplified the same way using `getCurrentInstance()`.

- **`command-bus.ts` — 10 duplicate sync/async functions collapsed to shared
  implementations.** Both buses now call the same underlying functions:
  `register`, `on`, `once`, `offAll`, `addHook`, `clearState`, `inspect`.
  `syncRegister` and `asyncRegister` were byte-for-byte identical at runtime
  (type annotations only differed) — merged into a single `register`.
  `asyncClear` shared 8 of 10 lines with `syncClear` — common body extracted
  to `clearState`. Both bus factories shared the same 12-line inspection object
  — extracted to `inspect()`.

- **`plugins-extra.ts`** — Four identical `matchesActions` closures (one per
  plugin) replaced by a single module-level `makeActionFilter(patterns)` factory.

- **`plugins-io.ts`** — Local `matchesRetryActions` deleted; `matchesPattern`
  imported from `command-bus` instead (which additionally has prefix caching).

- **`plugins-core.ts`** — `debounce` and `throttle` were building throttle keys
  with `JSON.stringify(cmd.target)` (no key-sort, no circular-ref safety).
  Replaced with `commandKey(cmd.action, cmd.target)` which sorts keys for stable
  output and handles circular references.

- **`transports.ts`** — Local `matchesActions` wrapper and `abortResultForBridge`
  deleted. Both replaced by imports: `matchesPattern` (inline) and
  `abortedResult` (now exported `@internal` from `command-bus.ts`).

- **`chamber.ts` / `chamber-vapor.ts`** — `useCommand.dispatch`,
  `useVaporCommand.dispatch`, and `useCommandQuery.query` shared the same
  20-line loading/error wrapper. Extracted to `runDispatch(busCall, loading,
  lastError, onSuccess?)` in `chamber.ts`, imported by `chamber-vapor.ts`.

### Bundle sizes (min / brotli / gzip)

| variant | v1.2.0 | v1.3.0 |
|---|---|---|
| full    | 32 KB / 8.7 KB / 9.8 KB | 33.7 KB / 9.9 KB / 11.1 KB |
| core    | 23 KB / 6.1 KB / 6.8 KB  | 23.0 KB / 6.7 KB / 7.5 KB  |
| elements| 24 KB / 6.4 KB / 7.2 KB  | 24.4 KB / 7.1 KB / 7.9 KB  |

Net size increase over v1.2.0 is from new features (`useCommandState` coalesce,
`runDispatch`, `getCurrentScope` detection). The internal refactoring offset
~1.1 KB raw across all variants.

### Tests

- New `tests/plugins-extra.test.ts` — 30 cases covering `cache`,
  `circuitBreaker`, `rateLimit`, and `metrics` (previously 0% coverage).
- New `tests/utilities.test.ts` — 17 cases covering `createChamber`,
  `createWorkflow`, and `createReaction` (previously 0% coverage).
- Targeted additions to `tests/chamber.test.ts` — `useCommandState` coalesce
  mode, `useCommandHistory` undo handler invocation and error recovery.
- Targeted additions to `tests/command-bus.test.ts` — `configureUid`,
  `syncQuery` bare-bus fast path, `offAll` with wildcard pattern, async batch
  mid-flight abort.

## v1.2.0 — Vue 3.6.0-beta.11 alignment

### Changed

- **Build pipeline migrated to Vite** (`scripts/build.mjs`). Replaces the custom
  esbuild IIFE script and tsc JS emit with a single orchestrator using Vite's
  programmatic API. Rollup tree-shaking + multi-entry library mode in one pass.
  `tsc` now emits types only (`emitDeclarationOnly: true`).
- **IIFE bundle split into three audience-based variants.** Variants reflect
  *deployment shapes*, not Vue feature axes — split by who is consuming the
  bundle, not by which Vue API happens to be inside.
  - `core` — sprinkled JS on server-rendered pages (Blade / Rails / Django /
    .NET MVC / WordPress). Bus + HTTP transport + lightweight plugins
    (logger, validator, debounce, throttle, retry, authGuard) + `connect()`
    one-liner with auto-CSRF.
  - `elements` — embeddable widgets via custom elements. Everything in `core`
    plus `defineVaporCustomElement` and a `defineWidget(tag, options)` helper.
  - `full` — kitchen sink for SPAs. Everything in `elements` plus realtime
    transports (WebSocket / SSE), heavy plugins (persist, sync, history,
    optimistic), `mount()`, and the full Vapor composables surface.

  New audience-specific helpers `connect()` (CORE/ELEMENTS/FULL) and
  `defineWidget()` (ELEMENTS/FULL) are also exposed in larger variants so the
  same call site works regardless of which bundle is loaded.

  Sub-path exports: `vapor-chamber/iife`, `/iife-core`, `/iife-elements`.

  Measured sizes (v1.2.0, min / brotli q=11 / gzip -9):
  - core: 23 KB / 6.1 KB / 6.8 KB
  - elements: 24 KB / 6.4 KB / 7.2 KB
  - full: 32 KB / 8.7 KB / 9.8 KB

  **Variant contents are not under semver before v2.0** — see ROADMAP.md.
  ESM consumers (the main entry) get the full surface and obey strict semver.
- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.11"`.

### Documented

- `defineVaporComponent` JSDoc now describes Vue 3.6.0-beta.11 alignment:
  generics + runtime props inference (Vue PR #14770), and the emits-vs-attrs
  split (declared `emits` listeners are excluded from `$attrs`). The wrapper
  forwards `options` unchanged so both behaviors flow through to Vue.

### Tests

- New regression test asserting `defineVaporComponent` passes options through
  unmodified — locks in the emits/attrs and generics flow-through.
- New IIFE bundle smoke test asserting the three variants ship the expected
  exports (and don't accidentally bloat with unwanted ones).
- New SSR rehydrate benchmarks (`tests/perf.bench.ts`) at 10 / 100 / 1000
  command scales, plus the ignoreUnhandled skip path. Locks the lib's replay
  cost so any regression is visible regardless of Vue version. (Vue's
  beta.11 hydration fast path is orthogonal — it speeds Vue's part of SSR,
  not command replay.)

### Performance

- **`signal` extracted into a side-effect-free `src/signal.ts` module.** The
  minimal signal API (lazy sync `globalThis.__VUE__` probe + plain fallback
  + `configureSignal()`) lives standalone with no module-load side effects.
  `chamber.ts` re-exports it for backward compat and pushes Vue's `ref()`
  into it via `configureSignal()` once its async probe completes.
  - `transports.ts` and `form.ts` now import `signal` from `./signal`,
    breaking their transitive dependency on `chamber.ts`'s Vapor-detection
    registry (the module-load `probeVue()` side effect, ~9 Vue API probes,
    `defineVaporCustomElement` / `defineVaporAsyncComponent` references,
    `waitForVueDetection` machinery).
  - **Result:** every ESM consumer using transports/form/plugins without
    Vue composables ships a smaller bundle. Measured against a typical
    Blade scenario (`createCommandBus` + `createHttpBridge` + `logger`):
    bundle dropped from ~6.2 KB brotli to **5.7 KB brotli (~9% reduction,
    535 bytes saved)**, with zero remaining references to `probeVue`,
    `_vueOnScopeDispose`, `defineVaporCustomElement`, `applyVueModule`, or
    `waitForVueDetection` in the consumer output. Public API unchanged.
- **Listener bucketing in core.** `on()` / `once()` listeners are now split
  between `exactListeners: Map<action, Listener[]>` (O(1) lookup on the
  dispatch hot path) and `wildcardListeners: Array<{pattern, listener}>`
  (walked with `matchesPattern` only when wildcards exist). The split is
  internal — no API change. Measured against the 5k-dispatch × 55-listener
  bench:
  - dispatch: 415 → 466 ops/sec (**+12%**)
  - emit: 403 → 507 ops/sec (**+26%**)
  Real-world wins scale with listener count: silent at 3 listeners, larger
  beyond ~50.
- **`persist` plugin gains opt-in `coalesce: true`.** Collapses back-to-back
  `getState()` + `JSON.stringify()` + `setItem()` cycles within one microtask
  burst into a single save. Use when many rapid commands touch the same
  state (form input, scroll tracking, batched cart updates). Trade-off: 1
  microtask of save latency. Measured against the 100-dispatch × 50-item
  array bench: 3,300 → 28,887 ops/sec (**8.75×**). Default behavior unchanged
  (per-dispatch save).
- **Default `meta.id` generator swapped from `crypto.randomUUID()` to a
  counter + per-process random prefix.** Command IDs are correlation tokens,
  not security tokens — uniqueness across one process is sufficient for tracing
  and observability. Measured 2.26× speedup on the 10k-dispatch hot path
  (default 1460 ops/sec vs randomUUID 645 ops/sec on the dev machine).
- **`configureUid(fn)` exported** — opt-in to `crypto.randomUUID` (or any
  custom generator) for distributed tracing or cross-process auditing use cases.
- Verified `okResult` / `errResult` / `stampMeta` / `AsyncState` already
  produce monomorphic hidden classes — the existing code is V8-aligned. No
  changes needed beyond the uid swap.

### Infrastructure

- **CI/CD pipeline** added at [.github/workflows/ci.yml](./.github/workflows/ci.yml).
  Test matrix runs typecheck, lint, full test suite (559 tests), build, and
  size budget guard on Node 20.19 + Node 22, on Linux + macOS. A separate
  `bench smoke` job runs `vitest bench` and uploads the result as an artifact
  for trend tracking.
- **Biome config** ([biome.json](./biome.json)) replaces the absence of a
  linter. Tuned to match the project's existing style (no auto-format
  pass — formatter disabled to avoid touching every file). Three new
  scripts: `npm run lint` (auto-fix), `npm run lint:check` (CI), and
  `npm run typecheck` (tsc --noEmit).
- **`scripts/check-size.mjs`** — bundle-size budget guard. Fails if any IIFE
  variant exceeds its raw or brotli budget. Locks v1.2.0 sizes so future
  changes can't silently regress the headline numbers. Bumping budgets
  requires an explicit edit + CHANGELOG note. Wired as `npm run size:check`
  and into `prepublishOnly`.
- **`tests/esm-treeshake.test.ts`** — bundles a synthetic Blade-style consumer
  (`createCommandBus` + `createHttpBridge` + `logger`) and asserts the bundle
  stays under 6.5 KB brotli with zero leaked references to `probeVue`,
  `applyVueModule`, `defineVaporCustomElement`, `defineVaporAsyncComponent`,
  `defineVaporComponent`, `waitForVueDetection`, or `_vueOnScopeDispose`.
  Locks the v1.2.0 signal-extraction win — if a future side-effect import
  drags chamber.ts back into transports/plugins consumers, this test fires.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — dev setup, project layout,
  workflow, performance-work expectations ("only ship perf changes that
  benches confirm"), release process.
- **[SECURITY.md](./SECURITY.md)** — supported version policy, vulnerability
  reporting via GitHub Security Advisories, response timeline (≤72h ack,
  ≤30d patch for high/critical), in-scope and out-of-scope items.
- **Issue + PR templates** — bug report, feature request, and PR templates
  under `.github/`. PR template includes the perf-bench requirement and a
  CHANGELOG-entry slot.
- **`prepublishOnly`** now runs the full quality pipeline: typecheck → lint
  → tests → build → size guard. No accidental publishes with broken builds
  or oversized bundles.

### AbortController integration (async bus + HTTP bridge)

Cancelable async dispatches landed in v1.2.x with a tight scope:

- **`asyncBus.dispatch(action, target, payload, { signal })`** — 4th arg is
  an optional `DispatchOptions`. Backward compatible (existing 3-arg call
  sites work unchanged).
- **`Command.signal: AbortSignal | undefined`** — handlers can read
  `cmd.signal.aborted` or attach `cmd.signal.addEventListener('abort', …)`
  to short-circuit work mid-flight.
- **Pre-flight abort:** if `signal.aborted` at dispatch time, the bus skips
  the handler entirely and resolves with `{ ok: false, error }`. The error
  is the explicit reason if the user passed one (`ac.abort(new MyError())`),
  otherwise a `BusError('VC_CORE_ABORTED', …)` so consumers can switch on
  `error.code`. Added `VC_CORE_ABORTED` to the `BusErrorCode` union.
- **HTTP bridge auto-propagation:** `createHttpBridge()` now merges
  `cmd.signal` with any bridge-level `signal` / `scopeController` via
  `AbortSignal.any()` (with a fallback for older runtimes). Consumers no
  longer need to thread the signal through the bridge config — pass it at
  the call site and the fetch picks it up.
- **After-hooks fire** for aborted dispatches so loggers / metrics see the
  aborted command. Observability stays intact regardless of cancellation.

### Sync bus accepts but ignores `{ signal }`

The sync `CommandBus.dispatch` signature accepts the 4th `DispatchOptions`
arg for type compatibility with `AsyncCommandBus`, but the signal is ignored
at runtime — sync dispatches are atomic and not cancelable. Pass a signal
here only if you also use the async bus and want a uniform call site.

### Test coverage gate

CI now enforces a coverage floor via [vitest.config.ts](./vitest.config.ts)
+ a `test:coverage` step in [.github/workflows/ci.yml](./.github/workflows/ci.yml).
Current floor:

| Metric     | Threshold |
|------------|-----------|
| lines      | 75%       |
| functions  | 80%       |
| branches   | 65%       |
| statements | 73%       |

Set ~1–2 points below current measured coverage — acts as a real floor
without tightening on trivial test additions. Tightens over time as
coverage improves; only loosened with an explicit CHANGELOG note.

**Excluded** (covered indirectly or not unit-testable):
- `index.ts`, `plugins.ts` — pure re-export aggregators
- `iife*.ts` — namespace builders; underlying surface tested elsewhere
- `vite-hmr.ts` — Vite plugin (real Vite server required)
- `testing.ts` — test-only utility (would test the test helper)
- `devtools.ts`, `directives.ts` — require real Vue runtime

**Known gaps for follow-up** (reflected in the floor, not hidden):
- `plugins-extra.ts` — 0% (cache, circuitBreaker, rateLimit, metrics)
- `utilities.ts` — 0% (createChamber, createWorkflow, createReaction)

### `emitDOMEvent` — bridge widget events to host pages

Vue's component `emit(...)` goes through Vue's event system; it does NOT
bubble out as a real DOM event. For embeddable widgets that need to
communicate with the surrounding page (e.g. a `<cart-bubble>` notifying
its container that a product was added), the new `emitDOMEvent(el, name,
detail, options?)` helper dispatches a real `CustomEvent` so host pages
can `addEventListener` on the widget tag.

```ts
// In a widget
VaporChamber.defineWidget('cart-bubble', {
  setup() {
    return () => h('button', {
      onClick: (e) =>
        VaporChamber.emitDOMEvent(e.target.getRootNode().host, 'cart-added', { sku: 'X' })
    }, 'Add');
  }
});

// On the host page
document.querySelector('cart-bubble').addEventListener('cart-added', (e) => {
  console.log(e.detail.sku);   // 'X'
});
```

Defaults: `bubbles: true`, `composed: true` (the latter escapes shadow DOM
so events reach light-DOM listeners on the host). Options override per
call.

Exposed in `elements` and `full` IIFE namespaces. 8 tests in
[tests/emit-dom-event.test.ts](./tests/emit-dom-event.test.ts) cover
every-type detail, preventDefault behavior, missing-CustomEvent fallback,
null-element defensive return, options overrides.

**Pattern adapted from
[vue-custom-element](https://github.com/karol-f/vue-custom-element)'s
`customEmit` helper** (Karol-F, MIT). vue-custom-element predates Vue 3.6
Vapor by years, but the underlying gap (Vue emit ≠ DOM event) still
exists today and the helper shape is timeless. The rest of
vue-custom-element's surface (string→typed-prop coercion, slot handling,
shadow-DOM strategy, async loading, disconnect cleanup) is now native to
Vue 3.6's `defineVaporCustomElement` — no other harvest needed.

**Particularly relevant for Laravel integration.** Laravel projects
typically have multiple coexisting reactive layers (Blade + Alpine +
Livewire + Filament). vapor-chamber widgets are none of those — they're
Vue Vapor — so they need an interop primitive that doesn't couple to any
specific layer. `emitDOMEvent` is that primitive: a widget dispatches a
`CustomEvent`, and any of Alpine's `@event.window`, Livewire 3's
`#[On('event')]`, or vanilla `addEventListener` can pick it up. New
section in [docs/integrations/laravel.md](./docs/integrations/laravel.md)
("Widget ↔ Livewire / Alpine / Blade event bridging") shows the four
patterns: Blade+Alpine, Livewire 3, Filament panel widget, vanilla DOM.

### `vapor-chamber/alien-signals` — connector for non-Vue contexts

[src/alien-signals.ts](./src/alien-signals.ts) — a tiny adapter that bridges
[alien-signals](https://github.com/stackblitz/alien-signals)' function-call
API (`s()` / `s(value)`) to vapor-chamber's `.value`-style `Signal`
interface.

```ts
import { signal as alienSignal } from 'alien-signals';
import { configureAlienSignals } from 'vapor-chamber/alien-signals';

configureAlienSignals(alienSignal);

// Every vapor-chamber signal() — including useCommand, useSharedCommandState,
// FormBus signals — is now backed by alien-signals' push-pull propagation.
```

**Why ship this:** Vue 3.6's `ref()` is itself a port of alien-signals
([vuejs/core#12349](https://github.com/vuejs/core/pull/12349)), so Vue
consumers already get alien-signals reactivity via the lib's
auto-detection. The connector serves **non-Vue contexts** — SSR / Node
services, Web Workers, embedded widgets, anywhere you want push-pull
reactivity without Vue's full runtime.

**No runtime dep added.** The connector takes alien-signals' `signal`
function as an argument rather than importing it; consumers install
alien-signals themselves (~7.5 KB raw / ~2.5 KB brotli). vapor-chamber
stays Vue-agnostic on the runtime side.

7 tests in [tests/alien-signals.test.ts](./tests/alien-signals.test.ts)
verify the adapter against the real published alien-signals package,
including: value reads/writes, multi-type coverage,
`configureAlienSignals` flipping the global signal factory, propagation
through alien-signals `computed`/`effect`, and a full integration test
running `useSharedCommandState` on top of the alien-signals-backed
factory.

### Migration guides

- [docs/migrating/from-mitt.md](./docs/migrating/from-mitt.md) — API mapping,
  listener-signature change, when not to migrate (and pointer to fast-lane
  if you only need pub/sub).
- [docs/migrating/from-event-emitter.md](./docs/migrating/from-event-emitter.md) —
  Node EventEmitter / eventemitter3 mapping, multi-arg-emit→single-payload,
  class-based vs functional, listener leak detection.

### Inertia 2 integration flags (Inertia + vapor-chamber coexistence)

[transports.ts](src/transports.ts) — `HttpBridgeOptions` gains two flags
that the whitepaper §11.3 documented but the code never shipped:

- **`csrf: 'inertia'`** — defer CSRF token management to Inertia's Axios
  instance. The bridge skips its own DOM-based CSRF reading and relies on
  the consumer's `@inertiajs/inertia` axios setup to inject the token.
- **`onRedirect: (url) => router.visit(url)`** — handle 3xx / `{ redirect }`
  body responses. When set, vapor-chamber resolves the dispatch as failed
  with a "Redirected to ..." message and calls the callback with the URL.
  Use this to hand 302s to Inertia's router for navigation.

### `vapor-chamber/observable` — Symbol.observable / RxJS interop

[src/observable.ts](src/observable.ts) — bridges `bus.on(pattern)` and
`bus.dispatch()` into the TC39 Observable protocol via `Symbol.observable`.
Zero RxJS dependency — RxJS reads the interop natively via `from()`.

```ts
import { from } from 'rxjs';
import { filter, debounceTime } from 'rxjs/operators';
import { observe } from 'vapor-chamber/observable';

from(observe(bus, 'cart*'))
  .pipe(filter(({ result }) => result.ok), debounceTime(200))
  .subscribe(({ cmd }) => console.log(cmd.action));
```

Inverse: `dispatchFrom(bus, action, observable)` pipes Observable values
into the bus as dispatches. 9 tests in
[tests/observable.test.ts](./tests/observable.test.ts).

### `vapor-chamber/standard-schema` — schema-lib-agnostic validation plugin

[src/plugins-schema.ts](src/plugins-schema.ts) — `validateSchemas` and
`validateSchemasAsync` plugins that work with any schema library
implementing [Standard Schema v1](https://standardschema.dev/): Zod,
Valibot, ArkType, Effect Schema. The plugin only depends on the
`'~standard'` interop shape — no schema lib is bundled or required.

```ts
import { z } from 'zod';
import { validateSchemas } from 'vapor-chamber/standard-schema';

bus.use(validateSchemas({
  cartAdd:     z.object({ id: z.number(), qty: z.number().min(1) }),
  orderCreate: z.object({ items: z.array(z.any()).min(1) }),
}));

// Failures resolve with { ok: false, error: BusError(VC_VALIDATION_FAILED) }.
```

Options: `field` (`'target' | 'payload' | 'both' | (cmd) => unknown`),
`onInvalid` (`'reject' | 'warn'`). New `VC_VALIDATION_FAILED` BusErrorCode.
7 tests in [tests/plugins-schema.test.ts](./tests/plugins-schema.test.ts).

Distinct from the existing `schemaValidator` in [schema.ts](src/schema.ts)
which serves the LLM tool-use layer with field-type strings — the two
have intentionally different shapes for different use cases.

### Comparative bench expansion (3 → 7 peer libraries)

[tests/perf.bench.ts](./tests/perf.bench.ts) now benches against:
mitt, nanoevents, eventemitter3, tiny-emitter, RxJS Subject, raw Map, plus
vapor-chamber's general bus and fast lane. Multi-listener emit (3 listeners,
10k events):

| Lib                                 | ops/sec |
|-------------------------------------|---------|
| eventemitter3                       | ~5,990  |
| nanoevents                          | ~5,830  |
| raw `Map<string, Set<fn>>`          | ~5,310  |
| **vapor-chamber `bus.emit`**        | **~4,660** |
| mitt                                | ~2,620  |
| tiny-emitter                        | ~2,240  |
| rxjs Subject                        | ~2,030  |

vapor-chamber's general `bus.emit` is now competitive with the fastest
event emitters (#4 of 7), beats mitt/tiny-emitter/RxJS by 1.8–2.3×, ~80%
of eventemitter3/nanoevents. The fast lane (separately) remains 1.9×
faster than nanoevents on single-handler dispatch.

### TypeDoc → GitHub Pages auto-deploy

[.github/workflows/docs.yml](./.github/workflows/docs.yml) — when `main`
gets pushes to `src/**.ts`, `typedoc.json`, or `README.md`, regenerates
the API site and deploys to GitHub Pages. The site is `.gitignore`d
locally; CI is the source of truth for the published version.

### `examples/sprinkled-blade/` — runnable demo

[examples/sprinkled-blade/](./examples/sprinkled-blade/) — minimal
end-to-end example of the sprinkled-JS pattern with a Node mock backend
that emulates what `VaporChamberController.php` does. Two-terminal
`node mock-server.mjs` + `npx serve .` and the demo is interactive.
Pairs with the runnable PHP companions in
[`examples/laravel-backend/`](./examples/laravel-backend/).

### Deferred to v1.3

- **`command-bus.ts` file split** (1388 → 5–7 focused modules). Pure
  maintainability, no API change. Best done alongside v1.3's wrapper
  elimination so the elimination diff stays clean.

### `createFastLane()` — new dispatch path for real-real-hot loops

Sub-path export `vapor-chamber/fast-lane` adds a deliberately-narrow
dispatcher for workloads where the general bus's per-call overhead
(Command envelope, CommandResult, plugin chain) is measurably the
bottleneck. **Not a faster bus** — a different tool for a different
audience. Game ticks, trading data feeds, audio buffer processing,
scroll/mousemove sampling, physics steps.

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
const onTick = lane.compile<TickData, void>('tick', (data) => {
  updateChart(data.symbol, data.price);
});

// Hot loop — pure function call, no envelope or result allocation
for (const tick of feed) onTick(tick);

// Multi-subscriber fan-out
lane.on('frame', dt => animate(dt));
lane.on('frame', dt => render(dt));
lane.emit('frame', deltaSeconds);
```

**Surface (intentionally minimal):**
- `compile(action, handler)` → returns a pre-bound dispatcher callable
- `on(action, listener)` / `emit(action, data)` → multi-subscriber fan-out
- `remove(action)` / unsubscribe closures
- `registeredActions()` / `clear()`

**Intentionally NOT in fast-lane:**
- Command/Result envelopes — handler receives `data` directly, returns whatever
- Plugins, hooks, listeners on `compile`'s dispatch path
- Wildcards
- Schema validation, batch, request/response, AbortController
- meta / id / correlation / causation tracing
- Auto-cleanup hooks (no Vue scope integration)
- Any of the bus's transports / persistence / retry

**Measured against the same 10k-dispatch bench used elsewhere:**

| Lib / Path                              | ops/sec     | vs fast-lane |
|-----------------------------------------|-------------|--------------|
| direct function call (theoretical floor)| ~348,000    | 13.7× faster |
| **vapor-chamber `fast-lane.compile`**   | **~25,400** | 1.0×         |
| nanoevents emit                         | ~13,300     | 1.9× slower  |
| mitt emit                               | ~4,750      | 5.3× slower  |
| vapor-chamber `bus.dispatch` (general)  | ~700        | 36× slower   |

Multi-listener emit (3 listeners): fast-lane ~5,980 ops/sec ties nanoevents
(~5,700) within 5%, beats mitt (~2,580) by 2.3×, beats `bus.emit` (~3,100)
by 1.9×.

**Implementation:** ~50 lines in `src/fast-lane.ts`. Two parallel `Map`s
(handlers + listeners). `compile` returns a closure that captures the
action key and reads from the handler map (one Map.get + one call per
dispatch). The Map.get indirection is the only thing keeping it from
matching direct-function-call throughput; that indirection enables
`remove()` and `clear()` without breaking previously-returned dispatchers.

**Tests:** 12 in [tests/fast-lane.test.ts](./tests/fast-lane.test.ts) —
correctness for compile/dispatch/on/emit/remove/clear, isolation between
instances, error propagation (no try/catch wrapping), late re-compile
re-routing the dispatcher.

**Doc positioning:** [docs/performance.md](./docs/performance.md) opens
with a "two doorways" section explaining when to pick each path. The
[ROADMAP.md](./ROADMAP.md) reflects this is a permanent two-path design,
not a v2 migration target.

Inspired by [splice](https://github.com/lucianofedericopereira/splice) but
keeps **string-keyed actions** (debuggable in stack traces, devtools, logs)
rather than splice's numeric IDs. The trade-off: ~13.7× behind theoretical
floor instead of ~3-5× — paying ~2-3× for debuggability vs splice. For a
tradeoff curve where the next bigger workload is "I'm building HFT", the
right tool is splice; for "I have a hot loop in my Vue app", the fast lane
is the right tool.

### Performance — splice-inspired optimization sweep (kept 2 of 5)

Inspired by the [splice](https://github.com/lucianofedericopereira/splice)
architecture (which trades ergonomics for raw speed at every junction). I
tested five candidate optimizations against vapor-chamber's hot path —
**only kept what bench-confirmed a clear win**, the rest reverted with the
finding documented so future contributors don't re-investigate.

| # | Candidate                                              | Outcome  | Δ on bare-bus dispatch (10k ops/sec) |
|---|--------------------------------------------------------|----------|--------------------------------------|
| 1 | Bare-bus fast path (sync) — bypass runner when no plugins/hooks/listeners | ✅ **KEPT**   | 595 → ~700 (**+18%**)                |
| 2 | Skip `validateNaming` when no naming option configured | ✅ **KEPT**   | ~700 → ~728 (**+4%**)                |
| 3 | Bare-bus fast path (async)                             | ✗ reverted | 3,586 → 3,360 (within noise, possible regression) |
| 4 | Cache `isBare` boolean (vs five inline property reads) | ✗ reverted | ~700 → ~536 (**-25%** — V8 already optimizes the inline reads; adding the field changed `SyncState`'s hidden class and slowed the dispatch site) |
| 5 | Inline `tryCatchHandler` in bare path                  | ✗ reverted | ~700 → ~651 (no measurable win — V8 was already inlining) |
| 6 | `stampMeta(payload)` instead of `stampMeta({action, target, payload})` (drop temporary wrapper) | ✗ reverted | ~728 → ~682 (slight regression — possibly V8 IC polymorphism on the `any` arg) |

**Net result for v1.2.x dispatch:** +22% on the bare-bus path (sync, no
plugins/hooks/listeners). Specifically:

```ts
// In _syncDispatchInner, before the normal path:
if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);  // skip if no naming option
const cmd: Command = { ... };

if (
  executeOverride === undefined &&
  s.pluginEntries.length === 0 &&
  s.beforeHooks.length === 0 &&
  s.afterHooks.length === 0 &&
  s.exactListeners.size === 0 &&
  s.wildcardListeners.length === 0
) {
  const handler = s.handlers.get(action);
  if (handler === undefined) return handleMissing(s.opts, cmd);
  return tryCatchHandler(handler, cmd);
}
```

**Lessons documented for future investigators:**
- **Don't add fields to hot-path state objects to "cache" simple inline
  checks.** V8's tight ICs on `Map.size` / `Array.length` already optimize
  those reads; introducing a new field shifts the hidden class and can
  regress the receiver-site IC. Inline reads won by 25%.
- **V8 inlines small functions like `tryCatchHandler` automatically.**
  Manual inlining didn't measure.
- **Async dispatch's `await` + Promise microtask machinery dominates** —
  skipping the runner indirection doesn't help because the runner cost is
  a small fraction of total async dispatch cost.
- **Removing temporary object allocation can regress IC behavior** when the
  argument type becomes more polymorphic (`any` payloads). The bench
  showed regression even though escape analysis "should" elide the wrapper.
  Keep the wrapper for stable IC.
- **Skipping a function call (validateNaming) when its body would early-
  return anyway IS a real win** because the call itself is the cost on the
  hot path, not the body.

### Performance — sync dispatch bare-bus fast path (+18%)

For sync `bus.dispatch` calls where the bus has no plugins, no
before/after hooks, and no listeners (a common configuration: register +
dispatch with nothing else), the implementation now bypasses the runner
indirection and fans out directly to the handler. Same correctness, fewer
function calls.

```ts
// In _syncDispatchInner, before the normal path:
if (
  executeOverride === undefined &&
  s.pluginEntries.length === 0 &&
  s.beforeHooks.length === 0 &&
  s.afterHooks.length === 0 &&
  s.exactListeners.size === 0 &&
  s.wildcardListeners.length === 0
) {
  const handler = s.handlers.get(action);
  if (handler === undefined) return handleMissing(s.opts, cmd);
  return tryCatchHandler(handler, cmd);
}
```

Measured 10k-dispatch bench, average across 3 runs:

| Path                                    | Before    | After     | Δ       |
|-----------------------------------------|-----------|-----------|---------|
| sync dispatch — bare bus (no plugins)   | ~595 ops/sec | **~705 ops/sec** | **+18%** |
| sync dispatch — with plugins/hooks/listeners | unchanged | unchanged | 0%      |

The fast path's five length/size checks (`pluginEntries.length`,
`beforeHooks.length`, `afterHooks.length`, `exactListeners.size`,
`wildcardListeners.length`) are all O(1) property reads — cheaper than
allocating the per-dispatch arrow + invoking the runner closure.

### Performance — async dispatch fast path: tested, NOT shipped

The same bare-bus fast path was tested for async dispatch and showed no
measurable win (3,586 → 3,360 ops/sec across 3 runs — within noise, possible
slight regression). The async path's `await` + Promise microtask machinery
dominates the per-call cost, so skipping the runner doesn't help. Reverted.

A comment in `_asyncDispatchInner` records this finding so future
contributors don't repeat the same investigation.

### Performance — pre-bound dispatcher Map: tested, NOT shipped

A second optimization was tested: pre-bind a `(cmd) => tryCatchHandler(h, cmd)`
closure per action at register time, store in a parallel `dispatchers: Map`,
and reference it in dispatch instead of building the arrow per call. **Failed
to win** because the runner's `execute` parameter is parameterless — the
pre-bound dispatcher takes `cmd`, so dispatch still has to allocate
`() => dispatcher(cmd)` to bridge into the runner. Same alloc cost as before.
Reverted; insight noted for any future runner-signature change.

### Performance — `emit` fast path (9.9× speedup)

The v1.2.x `bus.emit()` path now skips three per-call allocations that were
present before:

1. **No-listener short-circuit** — `if (!exactListeners.has(event) && wildcardListeners.length === 0) return;` before allocating anything. Real apps emit many events that nobody listens for; this turns them into a hash lookup + length check.
2. **Singleton `EMIT_RESULT`** — frozen `{ ok: true, value: undefined, error: undefined }` shared by every emit, replacing per-call `okResult(undefined)`.
3. **Skip `stampMeta` on emit** — emit is fire-and-forget; the typical listener doesn't read `cmd.meta.id` / `correlationId` / `causationId` / `ts`. `Command.meta` is left `undefined` for emit-fired commands. Listeners that need meta on a fire-and-forget event should use `dispatch`.

Measured on the same 10k-event × 3-listener bench used for v1.2.0:

| Path                              | Before    | After     | Speedup |
|-----------------------------------|-----------|-----------|---------|
| `bus.emit` — 3 listeners          | ~470 ops/sec | **~4,640 ops/sec** | **9.9×** |
| `bus.emit` — NO listeners         | (also ~470, allocated unconditionally) | **~24,500 ops/sec** | **52×** |

Comparative repositioning:

| Bench                             | vapor-chamber | mitt   | nanoevents |
|-----------------------------------|---------------|--------|------------|
| emit, 3 listeners                 | **4,640**     | 2,550  | 5,620      |
| emit, no listeners (fast path)    | **24,500**    | 9,820  | 81,800     |

vapor-chamber `emit` is now **1.8× faster than mitt** with subscribers and
**2.5× faster without**. Within 20% of nanoevents on the loaded path; about
3× behind on the empty path (nanoevents' single-property check vs the lib's
two-step Map+array check).

`bus.dispatch` is unchanged in this pass — it does meaningfully more per
call than `emit` (CommandResult, plugin chain, meta stamping for
correlation/causation tracing) and a fair comparison is to other bus /
middleware libraries, not to event emitters.

Comparative bench harness lives in
[tests/perf.bench.ts](./tests/perf.bench.ts) under `describe('emit fast
path — no listeners')`, `describe('comparative emit fan-out')`, and
`describe('comparative dispatch')`. `mitt` and `nanoevents` are devDeps
(bench-only).

Inspiration: [splice](https://github.com/lucianofedericopereira/splice)
ships similar tricks (frame pooling, no-listener fast path, minimal
envelopes). vapor-chamber didn't adopt splice's full architecture
(numeric action IDs, binary headers, frozen action tables) because it
would mean a v2 rewrite; the targeted fast paths capture most of the win
without breaking existing API.

### TypeDoc → API reference site (`npm run docs`)

Added [typedoc.json](./typedoc.json) and `npm run docs` / `npm run docs:watch`
scripts. Generates a navigable HTML API reference from existing JSDoc into
`docs/api/`, covering the main entry plus all sub-path entries
(`transports`, `directives`, `transitions`, `ssr`, `vite-hmr`).

The output is `.gitignore`d so it stays fresh per release. Public hosting
(GitHub Pages or Netlify) is queued for v1.3.

`typedoc` and `typedoc-plugin-markdown` added as devDeps.

### Vapor SFC end-to-end example

Added [examples/vapor-sfc/](./examples/vapor-sfc/) — a runnable Vapor SFC
demo (`npm install && npm run dev`) showing three composable patterns side
by side:

- `CartPanel.vue` uses `useVaporCommand()` for per-button reactive
  loading state
- `SearchPanel.vue` uses `defineVaporCommand()` for fire-and-forget
  search-as-you-type without reactive overhead
- `StatusBar.vue` uses `useSharedCommandState()` for cross-component
  aggregate state (loading + recent errors)

Pinned to `vue@^3.6.0-beta.11` and `@vitejs/plugin-vue@^5.2.0`. Uses the
local checkout (`"file:../.."`); swap to a published version when
testing v1.2.0 from npm.

### `useSharedCommandState()` composable

Aggregate loading / error signals **shared** across every subscriber on the
same bus, instead of allocating a private `loading` + `lastError` pair per
caller. Designed for component-heavy pages where many components only need
to react to "is *anything* in flight?" or "what was the last error?".

```ts
import { useSharedCommandState } from 'vapor-chamber';

const { dispatch, isAnyLoading, lastError, errors, errorCount, clear } =
  useSharedCommandState({ errorCap: 10 });

// Bind across components:
//   <Button :disabled="isAnyLoading.value">Save</Button>
//   <Toast v-if="lastError.value">{{ lastError.value.message }}</Toast>
```

Behavior:
- **Same signal instances** for every caller on the same bus (verified by
  identity).
- **Per-bus isolation** — separate buses get separate shared states (kept in
  a `WeakMap<CommandBus, SharedState>`).
- **Ref-counted disposal** — state is dropped when the last subscriber
  disposes, allowing the WeakMap entry to be GC'd.
- **`inFlight` counter** aggregates concurrent dispatches across all
  subscribers; never goes negative.
- **`errors` ring buffer** newest-last, capped at `errorCap` (default 10).
  Custom caps respected; if multiple subscribers request different caps the
  smallest wins (avoids surprise memory growth).
- **`{ signal }` option** forwards to the underlying bus dispatch — the
  AbortController integration shipped earlier in v1.2 works through this
  composable too.
- **Auto-cleanup** via `tryAutoCleanup` so Vue scope / component unmount
  drops the subscription without manual disposal.

12 tests in [tests/shared-state.test.ts](./tests/shared-state.test.ts)
covering identity, isolation, inFlight aggregation, error ring buffer,
clear semantics, async/sync paths, abort propagation, ref-counted disposal.

### AbortController extensions (v1.2.x continuation)

The AbortController story shipped in v1.2.0 was deliberately minimal (async
dispatch + HTTP bridge). These extensions complete the cancellation surface:

- **`bus.request(action, target, payload, { signal, timeout })`** — async
  request/response now accepts `signal`. Pre-aborted signal short-circuits
  with `VC_CORE_ABORTED` before the responder runs; mid-flight abort races
  against the responder + timeout so callers can cancel without waiting.
  After settlement, the listener is removed and the dedup key cleared.
- **`bus.dispatchBatch(commands, { signal })`** — batch-level cancellation.
  Pre-aborted signal returns immediately with empty results;
  mid-batch abort stops further dispatches (already-completed results are
  preserved). Per-command `cmd.signal` flows to handlers via the underlying
  `dispatch` so individual handlers can observe abort. With `transactional:
  true`, mid-batch abort triggers rollback of already-succeeded commands.
- **WebSocket bridge auto-propagation** — `createWsBridge` now honors
  `cmd.signal` per dispatch. Pre-aborted skips the send; mid-flight abort
  removes the request from the pending map and resolves the dispatch
  immediately (server may still process the command — WS protocol has no
  per-message cancellation, this only cancels the client-side wait).
- **Child signal pattern documented**, not auto-derived. True auto-derivation
  would require AsyncLocalStorage (Node-only) or a module-level dispatch
  stack (race-condition prone in browsers under concurrent dispatches). The
  reliable pattern is explicit threading:
  ```ts
  bus.register('parent', async (cmd) => {
    return await bus.dispatch('child', target, payload, { signal: cmd.signal });
  });
  ```
  Already works since v1.2.0 — no new code needed.

### SSE bridge — intentionally not wired

`createSseBridge` is receive-only (server-pushes to client; no per-command
request/response cycle), so `cmd.signal` doesn't apply at the bridge level.
Consumers wanting to cancel an SSE subscription call `sse.teardown()`.

### Bundle-size budget bumped

The new signal-handling code (WS/request/batch) plus `useSharedCommandState`
in chamber.ts added bytes. Budgets in `scripts/check-size.mjs` raised
accordingly:
- `vapor-chamber.iife.min.js`: 9.5 KB → **10.0 KB brotli max** (full variant
  picked up both AbortController extensions and useSharedCommandState)
- `vapor-chamber-core.iife.min.js`: 6.7 KB → 6.9 KB brotli max
  (AbortController extensions only — chamber.ts not bundled here)
- `vapor-chamber-elements.iife.min.js`: 7.0 KB → 7.2 KB brotli max (same)

Measured sizes after both changes:
- full: 35.2 KB raw / **9.8 KB brotli** / 11.0 KB gzip
- core: 24.6 KB raw / **6.6 KB brotli** / 7.4 KB gzip
- elements: 25.8 KB raw / **6.9 KB brotli** / 7.8 KB gzip

### Laravel integration documentation

- **[docs/integrations/laravel.md](./docs/integrations/laravel.md)** — single
  consolidated reference covering the backend deliverables: minimum-viable
  shape (one route + one controller + action classes), CSRF flows (Blade
  meta tag vs Sanctum SPA cookie), Inertia coexistence, Filament panel
  islands, Reverb / Echo realtime, queued / long-running commands,
  per-command authorization and validation patterns. Smoke-test snippet
  included.
- **[examples/laravel-backend/](./examples/laravel-backend/)** — drop-in PHP
  companion files: `VaporChamberController.php`, `config-vapor-chamber.php`,
  `routes-web.php`, plus three example action classes
  (`AddToCart.php`, `CancelOrder.php`, `ProcessCheckout.php`) covering
  inline validation, Gate authorization, and queued commands.
- **Comment cleanup pass** in `src/http.ts`, `src/transports.ts`,
  `src/chamber.ts`, `src/signal.ts` — JSDoc and inline comments now frame
  Laravel as one of several supported server-rendered frameworks (Rails,
  Django, .NET MVC, custom stacks) rather than the singular target.
  Behavior unchanged.
- **Whitepaper §11.5 trimmed.** The previous reference to
  `createEchoBridge` "v0.8.0" overstated shipped surface — the protocol-aware
  Echo bridge isn't shipped yet. §11.5 now describes the generic
  `createWsBridge` + Echo-event-to-`bus.emit()` pattern that works today,
  with the protocol-aware adapter on the v1.3 ROADMAP.

### Roadmap

- New [ROADMAP.md](./ROADMAP.md) makes the beta-tracking posture explicit:
  what is stable today regardless of Vue's beta cycle, what is transitional
  (Vapor wrappers, `useVaporCommand` / `useCommand` split, runtime feature
  registry), and the v1.3 / v2 cutover plan tied to Vue 3.6 RC and stable.
  Includes the build-flag wrapper-elimination strategy (Vite `define` +
  `package.json` conditional `vue36` export) so the wrappers can compile to
  identity calls and be DCE'd for consumers on Vue 3.6 stable.

### Audited, no change needed

- Defensive try/catch blocks around scope cleanup in `chamber.ts` were audited
  against beta.11's `runtime-core: cleanup stopped async setup scopes` fix.
  The lib's guards target a different condition (called outside any scope at
  all, not a stopped async scope), so nothing is now obsolete. All guards
  remain load-bearing.

### Removed

- `scripts/build-iife.mjs` (replaced by `scripts/build.mjs`).
- Stale hardcoded `version: '0.4.2'` in `src/iife.ts`.

## v1.1.0 — Vue 3.6.0-beta.10 alignment

### Added

- **`defineVaporCustomElement(options)`** (`chamber-vapor.ts`) — wrapper for Vue 3.6.0-beta.10's
  `defineVaporCustomElement()`. Creates custom elements backed by Vapor rendering with zero-overhead
  DOM updates inside shadow DOM. SSR runtime is automatically tree-shaken (beta.10 fix). Returns
  `null` when Vue 3.6.0-beta.10+ is not detected.

- **`defineVaporComponent(options)`** (`chamber-vapor.ts`) — wrapper for Vue 3.6.0-beta.10's
  `defineVaporComponent()`. Provides full TypeScript inference for props, emits, and slots in
  Vapor components. Returns `null` when not available.

- **`defineVaporAsyncComponent(loader)`** (`chamber-vapor.ts`) — wrapper for Vue 3.6.0-beta.10's
  `defineVaporAsyncComponent()`. Async Vapor components are properly cached by VaporKeepAlive and
  hydrate under VDOM Suspense boundaries. Returns `null` when not available.

- **`useVaporAsyncCommand(asyncBus?)`** (`chamber-vapor.ts`) — async-aware command dispatch
  composable for Vapor components under Suspense. Returns `Promise<CommandResult>` from dispatch,
  with reactive `loading` and `lastError` signals. Safe for `<script setup vapor>`.

### Changed

- **Vue detection** (`chamber.ts`) — now probes for `defineVaporCustomElement`,
  `defineVaporComponent`, and `defineVaporAsyncComponent` from Vue 3.6.0-beta.10+.

- **Directive warning** (`directives.ts`) — updated Vapor compatibility warning to mention
  `useVaporAsyncCommand()` and clarify that directives work in VDOM components within mixed
  Vapor/VDOM trees when the interop plugin is installed.

- **Vite HMR** (`vite-hmr.ts`) — tracks Vapor↔VDOM mode switching during HMR reloads. When a
  component switches rendering mode (e.g. template-only HMR between Vapor and VDOM), the bus state
  is preserved and the mode change is logged in verbose mode.

- **`createTransitionBridge(options)`** (`transitions.ts`) — framework-agnostic factory that
  wires Vue `<Transition>` / `<TransitionGroup>` lifecycle hooks to bus commands. All 8 hooks
  (`onBeforeEnter`, `onEnter`, `onAfterEnter`, `onEnterCancelled`, `onBeforeLeave`, `onLeave`,
  `onAfterLeave`, `onLeaveCancelled`) dispatch namespaced actions with the DOM element as target.
  The `done()` callback is called automatically after sync or async handler completion.

- **`useTransitionCommand(options?)`** (`transitions.ts`) — Vue composable version of the
  transition bridge. Uses the shared bus, reactive `phase` signal (`'idle' | 'entering' | 'leaving'`),
  and auto-cleanup via `tryAutoCleanup`. Bind directly to `<Transition v-bind="hooks">`.

- **Sub-path export** `vapor-chamber/transitions` — tree-shakeable, zero cost when not imported.

- **`useCommandQuery()`** (`chamber.ts`) — CQRS read-side composable with reactive `data`,
  `loading`, and `lastError` signals. Wraps `bus.query()` which skips `onBefore` hooks (no auth
  gates or loading spinners for reads). Supports both sync and async buses.

- **`createSSRPlugin(options?)`** (`ssr.ts`) — server-side plugin that records dispatched
  commands for dehydration. Options: `filter`, `maxCommands`. Methods: `dehydrate()`, `clear()`.

- **`rehydrate(bus, commands, options?)`** (`ssr.ts`) — client-side replay of dehydrated commands.
  Skips unhandled commands by default (`ignoreUnhandled: true`). Options: `filter` to suppress
  side-effectful commands during replay.

- **Sub-path export** `vapor-chamber/ssr` — tree-shakeable SSR hydration utilities.

- **`createHttpClient(defaults?)`** (`http.ts`) — multi-method HTTP client factory aligned with
  useFetch patterns. All HTTP methods (GET/POST/PUT/PATCH/DELETE), request deduplication for GETs,
  LRU response caching with TTL, request/response interceptors (Axios-style), safe mode
  (`client.safe.post()` returns `{ data, error, status }` instead of throwing), file download
  with Content-Disposition parsing, instance creation with `client.create({ baseURL })`, query
  params builder (arrays, nested objects). `postCommand` retained for backward compatibility.

- **Configurable XSRF cookie name** (`http.ts`) — reads `<meta name="xsrf-cookie">` to
  configure the cookie name for CSRF token detection. Defaults to `XSRF-TOKEN` (backward compat).

- **`createHttpBridge` httpClient option** (`transports.ts`) — inject a custom `HttpClient`
  instance for advanced use cases (interceptors, custom baseURL). Falls back to `postCommand`.

- **`persist` validate option** (`plugins-io.ts`) — `persist({ validate: (state) => bool })`
  rejects stale or structurally invalid persisted state on `load()`. Returns `null` with a
  console warning when validation fails. Prevents silent shape drift after deploys.

### Fixed

- **`useCommand()` / `useVaporCommand()` async loading** — `loading` signal now stays `true`
  until async handler results resolve. Previously it flashed `true→false` in the same tick,
  making it invisible in templates when using async transports (HTTP bridge, WS bridge).

### Changed

- **`useVaporCommand()` now exposes `emit()`** — fire domain events directly from the composable
  without dropping to `useCommandBus()`.

- **KeepAlive-aware composables** — `useCommandHistory` and `useCommandError` now pause their
  bus subscriptions when the host component is deactivated by `<KeepAlive>`, and resume when
  reactivated. Prevents silent subscription loss in cached components.

- **Transition bridge `onMove` hook** — `TransitionBridge` now includes `onMove(el)` for
  `<TransitionGroup>` reorder animations. Dispatches `{namespace}Move` action.

- **`useCommandGroup()` now exposes `query()` and `emit()`** — namespaced CQRS reads and domain
  events. `cart.query('getTotal', {})` dispatches `cartGetTotal` via `bus.query()` (skips onBefore).
  `cart.emit('updated', data)` dispatches `cartUpdated` via `bus.emit()`.

- **`useCommandHistory` redo re-dispatches** — `redo()` now re-dispatches the command through
  the bus (matching the plugin version's behavior). Previously it only moved the command between
  stacks without executing the handler.

- **`createFormBus` bus injection** — `createFormBus({ bus: sharedBus })` injects an external
  command bus instead of creating an isolated one. Form commands (`formSet`, `formTouch`, etc.)
  become visible to DevTools, metrics, logger, and global listeners.

- **Peer dependency** — `vue` peer dep updated to `>=3.5.0 || >=3.6.0-beta.10` to align with
  the APIs used by the new wrappers.

---

### Added — v1.0 e-commerce hardening

- **Transactional batch dispatch** (`command-bus.ts`) — `dispatchBatch(commands, { transactional: true })`
  rolls back all successful commands on first failure using registered undo handlers. Returns
  `BatchResult.rollbacks?: CommandResult[]` with compensation results in reverse order. Essential
  for e-commerce checkout flows where partial execution is worse than total failure:
  ```ts
  const result = bus.dispatchBatch([
    { action: 'inventoryReserve', target: item },
    { action: 'paymentCharge',    target: payment },
    { action: 'orderCreate',      target: order },
  ], { transactional: true });
  // If paymentCharge fails → inventoryReserve's undo handler runs automatically
  // result.rollbacks contains the compensation results
  ```

- **`optimisticUndo(bus, actions, options?)` plugin** (`plugins-core.ts`) — automatic rollback
  using registered undo handlers. On async failure, executes `bus.getUndoHandler(action)` to
  revert. On sync failure, rolls back immediately. Options: `predict` (return optimistic value),
  `onRollback` (notification callback), `onRollbackError` (undo itself failed). Pairs with
  `register(action, handler, { undo })` for zero-config rollback:
  ```ts
  bus.register('cartAdd', addHandler, { undo: (cmd) => removeFromCart(cmd.target) });
  bus.use(optimisticUndo(bus, ['cartAdd'], {
    predict: (cmd) => ({ ...cart, items: [...cart.items, cmd.target] }),
    onRollback: (cmd, err) => toast.error(`Failed: ${err.message}`),
  }));
  ```

- **Auto-validation in `createSchemaCommandBus`** (`schema.ts`) — `schemaValidator` plugin is
  now installed automatically when creating a schema bus. Validates field types against the schema
  before the handler runs. Opt out with `{ validate: false }`:
  ```ts
  const bus = createSchemaCommandBus(schema);           // validates by default
  const bus = createSchemaCommandBus(schema, { validate: false }); // skip
  ```
  `SchemaCommandBusOptions` type exported: `CommandBusOptions & { validate?: boolean }`.

- **`inspectBus(bus)` introspection** (`command-bus.ts`) — tree-shakeable standalone function
  that returns a full `BusInspection` snapshot of bus topology: registered actions, undo actions,
  responder actions, plugin count/priorities, hook counts, listener patterns, sealed state,
  dispatch depth, and active timers. Uses Symbol key pattern (same as `unsealBus`):
  ```ts
  import { inspectBus } from 'vapor-chamber';
  const info = inspectBus(bus);
  // { actions: ['cartAdd', ...], pluginCount: 3, sealed: false, ... }
  ```
  `TestBus.inspect()` also available for test assertions.

- **`createCommandPool(size)`** (`command-bus.ts`) — pre-allocated object pool for `Command`
  instances in hot paths. Eliminates GC pressure in high-frequency dispatch scenarios (10k+/sec).

- **`bus.seal()` / `unsealBus(bus)`** (`command-bus.ts`) — freeze bus configuration after setup.
  Sealed buses reject `register()`, `use()`, and `clear()` calls with `BusError`. `unsealBus()`
  is a tree-shakeable escape hatch using Symbol key.

- **`bus.dispose()`** (`command-bus.ts`) — clean teardown: clears all state, cancels active
  timers, and marks the bus as disposed. Subsequent dispatch/register calls throw. Safe for
  component-scoped buses and SSR per-request teardown.

- **Recursion depth guard** (`command-bus.ts`) — dispatch depth is tracked and capped at 10.
  Prevents infinite dispatch loops (e.g. handler A dispatches B which dispatches A). Throws
  `BusError` with code `VC_CORE_MAX_DEPTH` and the current depth in context.

### Added — v1.0 performance, LLM-friendliness, structured errors

- **V8 engine optimizations** (`command-bus.ts`) — monomorphic `okResult()`/`errResult()` factories
  ensure stable hidden classes; extracted `tryCatchHandler()` so V8 TurboFan can optimize callers;
  replaced all `.slice()` + `for...of` in hot paths with index-based `for` loops and length snapshots.
  10k dispatches: ~15ms.

- **`BusError` class** (`command-bus.ts`) — structured errors with machine-readable `code`,
  `severity` (error/warn/info), `emitter` (core/plugin/hook/listener/transport/workflow), `action`,
  and optional `context` bag. All core error paths now produce `BusError` instances. Extends `Error`.
  ```ts
  if (result.error instanceof BusError) {
    switch (result.error.code) {
      case 'VC_CORE_NO_HANDLER': /* register handler */ break;
      case 'VC_PLUGIN_CIRCUIT_OPEN': /* wait for reset */ break;
    }
  }
  ```

- **`BusErrorCode` type** — union of all error codes: `VC_CORE_NO_HANDLER`, `VC_CORE_THROTTLED`,
  `VC_CORE_REQUEST_TIMEOUT`, `VC_PLUGIN_CIRCUIT_OPEN`, `VC_PLUGIN_RATE_LIMITED`, etc.

- **`ERROR_CODE_REGISTRY`** (`schema.ts`) — frozen lookup table of all error codes with severity,
  emitter, message, and fix suggestion. Single source of truth for docs, i18n, and LLM prompts.

- **`getErrorEntry(code)`** — lookup function for error code metadata.

- **`describeErrorCodes()`** — plain-text table of all error codes for LLM system prompts.

- **`busApiSchema()`** (`schema.ts`) — JSON schema of every bus method (dispatch, query, emit,
  register, use, on, etc.) with param types and return types. Prevents LLM hallucination of
  non-existent methods.

- **LLM-friendly naming** (`command-bus.ts`) — renamed internal type helpers `_T`/`_P`/`_R` to
  `TargetOf`/`PayloadOf`/`ResultOf` with JSDoc. Added `@example` blocks to `createCommandBus`
  and `createAsyncCommandBus`.

- **Self-correcting error messages** — all errors now include actionable fix text (e.g.
  `"No handler registered for 'X'. Call bus.register('X', handler) first."`).

- **`createChamber(namespace, handlers)`** (`utilities.ts`) — declarative namespace grouping with
  camelCase prefixing. Returns `{ install, actionName, namespace }`.

- **`createWorkflow(steps)`** (`utilities.ts`) — sequential command execution with automatic saga
  compensation on failure. Returns `{ run, steps }`.

- **`createReaction(pattern, action, opts)`** (`utilities.ts`) — declarative cross-domain dispatch
  rules via `bus.on()`. Returns `{ install }`.

- **`cache(opts)`** (`plugins-extra.ts`) — LRU query result caching with TTL, maxSize, glob action
  filter. Methods: `invalidate()`, `clear()`, `size()`.

- **`circuitBreaker(opts)`** (`plugins-extra.ts`) — per-action circuit with closed/open/half-open
  states. Threshold, resetTimeout, onOpen/onClose callbacks.

- **`rateLimit(opts)`** (`plugins-extra.ts`) — per-action sliding window rate limiter.

- **`metrics(opts)`** (`plugins-extra.ts`) — lightweight telemetry: dispatch count, duration,
  success rate per action. Methods: `entries()`, `summary()`, `clear()`.

### Added — core 1.0 readiness

- **`Command.meta?: CommandMeta`** (`command-bus.ts`) — auto-stamped metadata on every dispatched
  command: `{ ts, id, correlationId?, causationId? }`. `ts` is `Date.now()`, `id` is
  `crypto.randomUUID()` with Math.random fallback. Propagate tracing IDs via
  `payload.__correlationId` and `payload.__causationId`. Optional on the type level — userland
  code that constructs `Command` objects manually does not need to provide it.

- **`bus.query(action, target, payload?)`** (`command-bus.ts`) — read-only dispatch that skips
  `onBefore` hooks (no mutation gating). Runs handler through the plugin pipeline and fires
  `onAfter` hooks and `on()` listeners. CQRS separation: use `dispatch()` for writes,
  `query()` for reads.

- **`bus.emit(event, data?)`** (`command-bus.ts`) — fire a domain event that notifies `on()`
  listeners without requiring a registered handler and without returning a result. Clean path
  for domain events (e.g., `orderCreated`, `cartCleared`) that are observations, not commands.

- **`bus.registeredActions(): string[]`** (`command-bus.ts`) — returns all registered action
  names. Essential for introspection, DevTools panels, and debugging.

- **`TestBus.onBefore` now fires for real** (`testing.ts`) — was previously a no-op stub.
  Hooks can now cancel dispatch on TestBus, matching real bus behavior.

- **`TestBus.query()`, `TestBus.emit()`, `TestBus.registeredActions()`** (`testing.ts`) — full
  parity with the real buses.

### Added — core quality & gap fixes (v0.6.0 candidate)

- **`bus.onBefore(hook)`** (`command-bus.ts`) — pre-dispatch hook on both sync and async buses.
  Throw (or reject, on async bus) to cancel the dispatch — returns `{ ok: false, error }`.
  After hooks still fire on cancellation. Use for auth gates, loading spinners, pre-validation:
  ```ts
  bus.onBefore((cmd) => {
    if (!isAuth()) throw new Error('Unauthenticated');
  });
  ```

- **`bus.offAll(pattern?)`** — remove all `on()` listeners matching an exact pattern, or all
  listeners if called with no argument. Useful for component teardown without tracking individual
  unsub functions:
  ```ts
  bus.on('cart*', listenerA);
  bus.on('cart*', listenerB);
  bus.offAll('cart*');  // removes both
  bus.offAll();         // removes everything
  ```

- **`bus.once(pattern, listener)`** — one-shot subscription on both sync and async buses.
  Auto-unsubscribes after first matching command. The returned unsub cancels before it fires.
  `TestBus` now also has a real `once()` implementation.

- **`BatchResult.successCount` and `BatchResult.failCount`** — always present on batch results
  regardless of `continueOnError`. Allows precise "3 of 5 succeeded" reporting:
  ```ts
  const { results, successCount, failCount } = bus.dispatchBatch(cmds, { continueOnError: true });
  console.log(`${successCount}/${results.length} succeeded`);
  ```

- **`HttpError.code`** — machine-readable error code extracted from response body `{ code: '...' }`.
  Enables pattern-matching on application errors without string comparison on `.message`:
  ```ts
  } catch (e) {
    if ((e as HttpError).code === 'CART_ITEM_LIMIT_EXCEEDED') showLimitWarning();
  }
  ```

- **`HttpBridgeOptions.noRetry: string[]`** — list of action names that must never be retried,
  regardless of the `retry` setting. Prevents double-execution of payment and checkout commands:
  ```ts
  createHttpBridge({ endpoint: '/api/vc', retry: 2, noRetry: ['paymentCharge', 'orderPlace'] })
  ```

- **`WsBridgeOptions.maxQueueSize?: number`** (default: `100`) — caps the in-memory queue that
  accumulates messages during a WebSocket disconnect. When exceeded, the oldest queued message
  is resolved with `{ ok: false, error }` before the new message is enqueued. Prevents unbounded
  memory growth during long disconnects or reconnect storms.

- **`SynthesizeOptions.adapter?: LlmAdapter`** (`schema.ts`) — custom LLM adapter for `synthesize()`.
  When provided, bypasses the built-in Anthropic API call entirely. Receives Anthropic-format tool
  definitions, user text, and options; returns a `ToolCallInput`. Use for proxied APIs, OpenAI, or
  any other provider:
  ```ts
  const adapter: LlmAdapter = async (tools, text) => {
    const res = await myOpenAiProxy.complete({ tools, prompt: text });
    return { name: res.toolName, input: res.args };
  };
  await bus.synthesize('add 2 of item 5', { adapter });
  ```
  `LlmAdapter` type exported from main entry point.

- **`BaseBus` interface** — structural escape hatch for utilities that work with both sync and async
  buses. Exported from main entry point. Use as parameter type in `createChamber`, `createWorkflow`,
  and any cross-bus utilities to avoid `as any` casts.

- **`commandKey(action, target)`** — stable `action:target` string key, exported from core.
  Handles circular references safely. Useful for cache invalidation (TanStack Query integration).

- **`buildRunner` and `matchesPattern`** — exported from `command-bus.ts` for use in utilities
  and custom test doubles without internal duplication.

- **`BeforeHook`, `AsyncBeforeHook`, `LlmAdapter`** types exported from main entry point.

- **`WHITEPAPER.md`** — comprehensive architectural document covering: design decisions from
  nine comparative analysis rounds (RTK, VueUse, XState, TanStack Query, DDD, Svelte Stores,
  RxJS, GraphQL, ArangoDB), CQRS positioning, DDD application service layer pattern,
  integration guide for Pinia / TanStack Query / Inertia 3 / XState / Laravel Reverb,
  utility layer design (`createChamber`, `createWorkflow`, `createReaction`), and v1.0 roadmap.

### Fixed — v1.0 review rounds (3 full audits)

- **Per-instance throttle timers** (`command-bus.ts`) — throttle `setTimeout` handles were stored
  per action but not per bus instance. Two buses with the same throttled action shared timers.
  Fixed: timers are now stored in per-instance `SyncState.activeTimers` / `AsyncState.activeTimers`.

- **`BusError` native `cause` propagation** (`command-bus.ts`) — `BusError` constructor now passes
  `{ cause: originalError }` to `Error` super constructor when wrapping an existing error. Enables
  `error.cause` chaining for debugging.

- **`commandKey` fast-path for primitives** (`command-bus.ts`) — `commandKey()` now returns
  `action:target` directly when target is a string/number/boolean, skipping `JSON.stringify`.
  ~3× faster for the common case of ID-based targets.

- **History plugin `_replaying` flag** (`plugins-core.ts`) — `history.undo()` and `history.redo()`
  now set a `_replaying` flag that prevents re-recording the replayed command into history. Previously,
  undo/redo could create infinite history loops.

- **Cache plugin async compatibility** (`plugins-extra.ts`) — `cache()` now correctly awaits
  async handler results before caching. Previously, cache stored the Promise object instead of
  the resolved value on async buses.

- **Metrics plugin O(1) entry access** (`plugins-extra.ts`) — `metrics.entries()` now returns
  a frozen snapshot instead of rebuilding from internal maps on every call.

- **`TestBus.on()` fires listeners on `query()` and `emit()`** (`testing.ts`) — previously only
  fired on `dispatch()`. Now consistent with real bus behavior.

### Fixed

- **419 CSRF expiry incorrectly triggered session-expired callbacks** (`http.ts`) — 419 was
  included in `SESSION_EXPIRED_STATUS`. It is now correctly excluded: 419 is CSRF expiry,
  not a session expiry. Only 401 fires `onSessionExpired` and dispatches the `session-expired`
  `CustomEvent`.

- **CSRF refresh was a no-op** (`http.ts`) — `refreshCsrfOnce` re-read the stale DOM token
  instead of fetching a fresh one. Now fetches `csrfCookieUrl` (default `/sanctum/csrf-cookie`)
  to let Laravel issue a fresh `XSRF-TOKEN` cookie before re-reading. Concurrent 419s still
  coalesce — no duplicate refresh requests.

- **`ReferenceError: installedBus is not defined`** (`transports.ts`) — leftover assignment
  after removing the `installedBus` variable from the SSE bridge `install()` function.

- **SSE bridge `install(bus)` accepted `CommandBus` (sync only)** (`transports.ts`) — the `bus`
  parameter in `SseBridgeOptions.onEvent` and `install()` was typed as `CommandBus`. Changed to
  `BaseBus` so both sync and async buses can be passed without `as any`.

- **WS timeout was hardcoded** (`transports.ts`) — the per-message response timeout in
  `createWsBridge` was hardcoded to 10_000ms. Now reads `WsBridgeOptions.timeout` (default
  still 10_000).

- **HTTP bridge swallowed error response bodies** (`transports.ts`) — error messages from the
  bridge were `HTTP {status}`. Now includes `data.message ?? data.error` from the response JSON
  when the server returns an error object.

- **HTTP bridge always retried even non-idempotent actions** — mitigated by `noRetry` option
  (see above).

- **Error response bodies were never parsed** (`http.ts`) — `doFetch` only parsed JSON when
  `raw.ok`. Now always attempts `raw.json()` so error body fields (`code`, `message`, `error`)
  are available in `HttpError.response.data` and `HttpError.code`.

- **`once()` mutation-during-iteration bug** (`command-bus.ts`) — when a `once()` listener fired
  and called its own `unsub()` inside the loop, subsequent listeners in the same array were
  skipped. Fixed by iterating `.slice()` of `patternListeners` and `afterHooks` in both
  `syncRunHooks` and `asyncRunHooks`.

- **`isAsyncFn` fragile in minified builds** (`command-bus.ts`) — used `fn.constructor?.name`
  which minifiers rename to single characters. Fixed to `fn[Symbol.toStringTag]`.

- **`TestBus.on()` was a no-op stub** (`testing.ts`) — stored listeners but never called them.
  Now fires matching listeners after every dispatch, consistent with the real buses.

### Added — Vue 3.6 Vapor alignment (v0.6.0 candidate)

- **`useVaporCommand()` composable** (`chamber-vapor.ts`) — full-featured Vapor-safe composable
  with `dispatch()`, `register()`, `on()`, reactive `loading`/`lastError` signals, and `dispose()`.
  Does not use `getCurrentInstance()` — safe in Vapor's scope-based lifecycle. Auto-cleans up
  via `onScopeDispose` when available.

- **`tryAutoCleanup` dev warning** (`chamber.ts`) — in development mode, logs a console warning
  when no Vue scope or component instance is found. Helps catch accidental usage outside
  `setup()` or `effectScope()` in Vapor components where `getCurrentInstance()` returns null.

- **Vapor directive compatibility warning** (`directives.ts`) — `createDirectivePlugin.install()`
  now emits a console warning when Vapor mode is detected, explaining that `v-vc:command`
  directives are VDOM-only and suggesting `useVaporCommand()` or `defineVaporCommand()` instead.

- **Vite HMR `.vapor.vue` file support** (`vite-hmr.ts`) — the `transform()` hook now matches
  `.vapor.vue` files (Vue 3.6+ Vapor SFCs) in addition to `.ts`, `.js`, `.vue`, `.tsx`, `.jsx`.

- **`FormBusOptions.reactive?: boolean`** (`form.ts`) — set to `false` to skip Vue signal
  allocations (saves 7 signal allocations per form). All APIs work identically via plain
  get/set wrappers. Useful for headless, server-side, or batch form processing.

- **`HttpBridgeOptions.scopeController?: AbortController`** (`transports.ts`) — pass an
  AbortController tied to a Vapor component's lifecycle. When the component is disposed and
  the controller is aborted, all in-flight HTTP requests are cancelled automatically. Merges
  with the existing `signal` option via `AbortSignal.any()` when available.

- **`WsBridge.connected: Signal<boolean>`** (`transports.ts`) — reactive signal for WebSocket
  connection state. Bindable directly in Vapor/VDOM templates without polling. Updates on
  `ws.onopen`, `ws.onclose`, and `disconnect()`.

### Changed

- **`FormRules` now supports async validators** (`form.ts`) — rule functions may return
  `string | null | Promise<string | null>`. `set()` uses sync-only rules for live per-field
  feedback (no UI jank). `submit()` awaits all rules including async ones before gating
  `onSubmit`. Fully backward-compatible — existing sync rules unchanged.

---

### Added

- **`createAsyncSchemaCommandBus<S>(schema, options?)`** (`src/schema.ts`) — async variant of
  `createSchemaCommandBus`. Use when handlers perform async work (API calls, LLM, DB).
  Same interface: `toTools()`, `synthesize()`, `getSchema()`, `fromToolCall()`, `describe()`.

- **`schemaValidator(schema)`** (`src/schema.ts`) — plugin that blocks dispatch when field types
  don't match the schema. Returns `{ ok: false, error }` before the handler runs. Uses the same
  `validateFields` helper as `schemaLogger`.

- **`describeSchema(schema)`** (`src/schema.ts`) — returns a plain-text summary of all commands
  for use in LLM system prompts: `"Available commands:\n- cartAdd: Add item to cart (target: id:number, ...)"`.
  Also available as `bus.describe()` on schema buses.

- **`bus.fromToolCall(toolUse)`** on `SchemaCommandBus` / `AsyncSchemaCommandBus` — dispatch
  directly from a pre-existing LLM `tool_use` block without a full `synthesize()` round-trip.
  Accepts `{ name, input: { target?, payload? } }` — the same shape the LLM returns.

- **Schema layer** (`src/schema.ts`) — flat runtime schema as single source of truth:
  - `BusSchema` / `ActionSchema` / `FieldMap` — flat type definitions (`{ id: 'number' }`)
  - `InferMap<S>` — derives TypeScript `CommandMap` types from the runtime schema automatically;
    no separate type definition needed
  - `createSchemaCommandBus<S>(schema)` — sync bus typed from schema
  - `createAsyncSchemaCommandBus<S>(schema)` — async bus typed from schema
  - `toTools(schema, provider?)` / `toAnthropicTools` / `toOpenAITools` — LLM tool definitions;
    `target` and `payload` kept as separate nested objects (no field merging/splitting)
  - `schemaLogger(schema, options?)` — schema-aware plugin: logs description, validates field types
    with `✓` / `⚠` indicators
  - `synthesize(schema, bus, text, options?)` — natural language → LLM tool use → dispatch;
    injectable `fetch` for testing; supports both sync and async buses
  - Schema keys are normalized to camelCase on creation (`cart_add` → `cartAdd` with a warn)

- **8 core bus fixes** (`src/command-bus.ts`):
  - `request()` now routes through the plugin chain when a responder exists (was bypassing it)
  - `request()` signature: `(action, target, payload?, options?)` — payload added as 3rd arg
  - `onMissing` custom function wrapped in try/catch — throws return `{ ok: false, error }`
  - `bus.hasHandler(action)` — introspection method on both `CommandBus` and `AsyncCommandBus`
  - `register()` warns on silent handler overwrite
  - `CommandBus<M extends CommandMap>` and `AsyncCommandBus<M>` are now generic — typed dispatch
    and register via `createCommandBus<MyMap>()`
  - `wrapThrottle` key: `JSON.stringify` wrapped in try/catch for circular ref safety
  - `dispatchBatch(commands, options?)` — new `BatchOptions = { continueOnError?: boolean }`;
    when true, collects all results and returns the first error instead of stopping

- **`CommandMap`** and **`BatchOptions`** exported from main entry point.

---

## [0.5.0] - 2026-03-22

### Breaking Changes

- **camelCase action names enforced throughout** — all built-in examples, wildcard patterns, and
  `useCommandGroup` now use camelCase (`cartAdd`, `ordersCancel`). The naming convention regex
  changed from snake_case `/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/` to camelCase
  `/^[a-z][a-zA-Z0-9]+$/`. Rationale: Pereira (2026) proved camelCase produces 1.12–1.20× fewer
  BPE tokens than dot-notation (p<0.001, Spearman ρ=1.000 across all tested tokenizer pairs),
  saving ~$54,499/year at enterprise-scale LLM usage.
  See `docs/whitepaper.md` §2.5.

- **Wildcard patterns now use `*` suffix** (was `.*` / `_*`) — `cart*` matches `cartAdd`,
  `cartRemove`, etc. Affects `bus.on()`, `useCommandGroup`, `createHttpBridge`, `retry`.

- **`wrapThrottle` now throws on throttled calls** (was returning an invalid `CommandResult`).
  Throttled dispatches return `{ ok: false, error }` with `error.message === 'throttled'` and
  `error.retryIn` (ms until retry is safe). Callers should check `result.ok` before using
  `result.value`.

### Added

- **`useCommandGroup(namespace)`** (`src/chamber.ts`) — namespace isolation for large apps:
  - All `dispatch`/`register`/`on` calls are automatically prefixed in camelCase
  - `cart.dispatch('add', product)` → dispatches `'cartAdd'`
  - `cart.register('add', handler)` → registers `'cartAdd'`
  - `cart.on('*', listener)` → listens to `'cart*'`
  - Auto-cleanup on Vue scope disposal
  - `group.namespace` exposes the namespace string

- **`useCommandError(options?)`** (`src/chamber.ts`) — reactive error boundary:
  - `errors` — signal containing all failed dispatches
  - `latestError` — signal with the most recent error
  - `clearErrors()` — reset state
  - Optional `filter` narrows which actions are tracked

- **Transport layer** (`src/transports.ts`):
  - `createHttpBridge(options)` — async plugin that forwards commands to a backend endpoint via POST
  - `createWsBridge(options)` — WebSocket transport with auto-reconnect
  - `createSseBridge(options)` — Server-sent events bridge (server-push commands)
  - All transports accept an `actions` filter: `['cart*']` sends only matching commands over the wire
  - `createHttpBridge` uses `postCommand` from `http.ts` for retry, CSRF, and timeout support

- **`retry` plugin** (`src/plugins-io.ts`) — async plugin with configurable backoff:
  - `maxAttempts`, `baseDelay`, `strategy` (`'fixed'` | `'linear'` | `'exponential'`)
  - `actions` glob filter — only retry matching action patterns
  - `isRetryable(error, attempt)` — stop retrying on non-recoverable errors early

- **`persist` plugin** (`src/plugins-io.ts`) — auto-save state to localStorage after each command:
  - Custom `storage` backend (sessionStorage, IndexedDB adapter, etc.)
  - `plugin.load()`, `plugin.save()`, `plugin.clear()` methods
  - SSR-safe: resolves localStorage at call time, no-ops when unavailable

- **`sync` plugin** (`src/plugins-io.ts`) — broadcast commands across browser tabs via `BroadcastChannel`:
  - `filter` option to select which actions to broadcast
  - `onReceive` callback to intercept or suppress incoming commands
  - `plugin.close()`, `plugin.isOpen()` methods
  - Echo prevention: re-dispatched commands from other tabs are not re-broadcast

- **`createTestBus` snapshot & time-travel** (`src/testing.ts`):
  - `bus.snapshot()` — returns a deep copy of the recorded dispatch list (mutations don't affect `recorded`)
  - `bus.travelTo(index)` — returns commands from 0 to index inclusive
  - `bus.travelToAction(action)` — returns all commands up to the last occurrence of `action`
  - All time-travel methods return the `Command` array (not `RecordedDispatch`) for easy assertion

- **`src/http.ts`** — TypeScript HTTP client, adapted from `fetch/useFetch.js`:
  - `postCommand<T>(url, body, config)` — POST with retry, CSRF, timeout, session detection
  - `readCsrfToken()` — multi-source CSRF: meta tag → `XSRF-TOKEN` cookie → hidden `_token` input; 5-min TTL cache
  - `invalidateCsrfCache()` — force cache clear (e.g. after logout)
  - `AbortSignal.any` with manual fallback for older environments
  - Jittered exponential backoff (avoids thundering herd)
  - `X-RateLimit-Reset` as `Retry-After` fallback
  - 419 CSRF refresh coalesces concurrent requests (no duplicate refreshes)
  - `session-expired` CustomEvent + `onSessionExpired` callback
  - `TimeoutError` distinct from `AbortError`

- **`src/chamber-vapor.ts`** — Vapor-specific API extracted from `chamber.ts` for CDCC compliance:
  - `createVaporChamberApp()`, `getVaporInteropPlugin()`, `defineVaporCommand()`

- **`src/plugins-core.ts`** / **`src/plugins-io.ts`** — `plugins.ts` split for CDCC compliance:
  - `plugins-core.ts`: logger, validator, history, debounce, throttle, authGuard, optimistic
  - `plugins-io.ts`: retry, persist, sync
  - `plugins.ts` now a barrel re-export

- **SSR concurrency tests** — 4 new tests in `tests/new-features.test.ts` verifying that
  independent buses don't share handlers, plugins, or state across simulated SSR requests.

- **`useCommandGroup` camelCase tests** — 2 new tests verifying that
  `cart.register('add')` registers `'cartAdd'` and `cart.dispatch('remove')` dispatches `'cartRemove'`.

- **`createFormBus<T>(options)`** (`src/form.ts`) — reactive form state manager built on the command bus:
  - `values`, `errors`, `touched`, `isDirty`, `isValid`, `isSubmitting` — reactive signals
  - `set(field, value)` — update a field and re-run all validation rules
  - `touch(field)` — mark a field as interacted with (triggers error display)
  - `submit()` — validate all fields, call `onSubmit`, return `boolean`
  - `reset()` — restore initial field values and clear all state
  - `use(plugin)` — attach any command bus plugin (logger, throttle, authGuard, etc.)
  - `bus` — exposes the underlying `CommandBus` for DevTools, testing, and advanced use
  - 13 new tests in `tests/form.test.ts`

- **`@types/node`** added as dev dependency (required by `vite-hmr.ts`).

### Changed

- **`command-bus.ts` refactored** to CDCC-compliant module-level functions with explicit state
  threading (`SyncState` / `AsyncState`). Factory functions dropped from ~179 lines to ~20 lines
  each. All inner functions promoted to module scope.

- **Async-on-sync guard** — `syncUse()` now warns when an async plugin is installed on a sync bus:
  ```
  [vapor-chamber] Async plugin installed on sync bus — use createAsyncCommandBus() instead.
  ```

- **`chamber.ts`** exports `tryAutoCleanup` (previously private) and internal Vapor state getters
  (`getVaporAppFn`, `getVaporInteropRef`) for use by `chamber-vapor.ts`.

---

## [0.4.0] - 2026-03-20

### Vue 3.6 + Vite 7/8 Alignment

This release aligns vapor-chamber with the Vue 3.6 beta (Vapor mode feature-complete)
and the Vite 7/8 toolchain (Rolldown bundler).

### Added

- **`isVaporAvailable()`** — runtime detection of Vue 3.6+ Vapor mode support
- **`createVaporChamberApp()`** — helper to create a Vapor app instance (requires Vue 3.6+)
- **`getVaporInteropPlugin()`** — returns `vaporInteropPlugin` for mixed VDOM/Vapor trees
- **`defineVaporCommand()`** — zero-overhead composable for hot-path dispatches in Vapor mode.
  Skips reactive `loading`/`lastError` signal creation that `useCommand()` provides.
  Ideal for telemetry events, scroll-position sampling, debounced search, autosave,
  and any fire-and-forget pattern where reactive loading state would be wasted overhead.

### Changed

- **`tryAutoCleanup()` now prefers `onScopeDispose`** (Vue 3.5+) over `onUnmounted`.
  `onScopeDispose` works in component setup, `effectScope()`, Vapor components, and SSR —
  making it the correct lifecycle hook for library composables.
- **Node.js requirement bumped to `>=20.19.0`** to align with Vite 7/8 minimum.
- **`tsconfig.json` module target changed from `ESNext` to `ES2022`** for deterministic output
  that matches Vite 7's baseline-widely-available target.
- **Dynamic imports in `devtools.ts` now use `@vite-ignore`** comment for Rolldown compatibility.
  Prevents Vite 8 (Rolldown) from statically analyzing the optional `@vue/devtools-api` import.
- **Package keywords updated** with `alien-signals`, `vue-3.6`, `vapor-mode`.

### Notes on Vue 3.6 Vapor + alien-signals

- Vue 3.6 rewrites `@vue/reactivity` atop alien-signals (by Johnson Chu / StackBlitz).
  `ref()` is now backed by fine-grained signals internally — **no separate signal API needed**.
- vapor-chamber's `configureSignal()` remains available as an escape hatch but is no longer
  required in Vue 3.6+; the auto-detected `ref()` is already alien-signals powered.
- The command bus core (`command-bus.ts`) remains framework-agnostic — zero Vue dependency.
- All composables work identically in VDOM, Vapor, and mixed trees.

---

## [0.3.0] - 2026-03-20

### Fixed

- **Debounce plugin stale closure** (`src/plugins.ts`): The previous implementation called `next()` inside a `setTimeout`, invoking the middleware chain continuation from a stale closure context. After the debounce timer fired, the `next` function still referenced the original dispatch's middleware state — not the latest one. Fixed by storing the latest `next` closure per debounce key and executing the most recent one when the timer fires.

- **History undo was data-only** (`src/plugins.ts`): `history.undo()` popped the command from the stack but never executed an inverse handler, so the UI state didn't actually revert. Now accepts an optional `{ bus }` reference. When provided, `undo()` calls `bus.getUndoHandler(action)` and executes the inverse handler. `redo()` re-dispatches through the bus. Fully backward-compatible — without `{ bus }`, behavior is unchanged.

- **Signal shim had no reactivity in standard Vue 3** (`src/chamber.ts`): The fallback signal was a plain getter/setter object. When Vue Vapor was not available (i.e., standard Vue 3), changing `signal.value` did not trigger Vue's reactivity system, so `useCommandState` would not update the UI. Fixed by detecting Vue's `ref()` at module load and using it as the signal implementation when available.

- **Shared bus leaked between tests** (`src/chamber.ts`): The module-level `sharedBus` singleton persisted across test files. If a test forgot to call `setCommandBus(createCommandBus())` in `beforeEach`, handlers and hooks from previous tests would leak. Added `resetCommandBus()` export that sets the singleton to `null`, ensuring a clean slate in `afterEach`.

### Added

- **Naming convention enforcement** (`src/command-bus.ts`): New `naming` option on `createCommandBus()` validates action names at both registration and dispatch time. Supports any regex pattern with configurable violation mode (`'warn'`, `'throw'`, or `'ignore'`).

- **Wildcard / pattern listeners** (`src/command-bus.ts`): New `bus.on(pattern, listener)` method. Supports `'*'` (all events), `'prefix*'` (namespace glob), or exact match.

- **Request/response pattern** (`src/command-bus.ts`): New `bus.request()` and `bus.respond()`. Supports timeout (default 5s). Falls back to normal `dispatch()` if no responder is registered.

- **Per-command throttle/undo at register time** (`src/command-bus.ts`): `register()` now accepts `{ throttle, undo }` options.

- **Auto-cleanup on Vue component unmount** (`src/chamber.ts`): All composables now detect Vue lifecycle context and register cleanup automatically.

- **`resetCommandBus()` export** (`src/chamber.ts`).

- **`authGuard` plugin** and **`optimistic` plugin** (`src/plugins.ts`).

### Tests

- Added tests for: naming convention, wildcard listeners, request/response, undo handler, per-command throttle, `resetCommandBus`, `authGuard`, `optimistic`, history with bus-backed undo/redo.

---

## [0.2.0] - 2026-03-18

### Added

- **Async command bus** (`createAsyncCommandBus`): Full async support for handlers, plugins, and hooks.
- **Command batching** (`dispatchBatch`): Execute multiple commands sequentially, stops on first failure.
- **Plugin priority** (`use(plugin, { priority })`): Higher priority runs first (outermost).
- **Dead letter handling** (`onMissing`): Configurable behavior for unhandled commands.
- **Testing utilities** (`createTestBus`): Record and assert dispatched commands.
- **DevTools integration** (`setupDevtools`): Timeline + inspector panel for Vue DevTools.

---

## [0.1.0] - 2026-03-16

### Fixed

- **`newTodoText` reactivity bug** (`examples/vue-vapor-component.vue`): Form input was declared as a plain `let` variable. Changed to `const newTodoText = signal('')`.

- **Redundant stats recomputation** (`examples/vue-vapor-component.vue`): `getStats()` was called four times in the template. Replaced with a `stats` signal updated once via `bus.onAfter()`.

- **Debounce plugin memory leak** (`src/plugins.ts`): The `results` map was never cleared.

- **Throttle plugin memory leak** (`src/plugins.ts`): The `lastRun` map was never pruned.

- **`useCommand` lifecycle leak** (`src/chamber.ts`): `register` and `use` were forwarded with no shared cleanup path.

- **Proxy trap breakage via private global access** (`src/chamber.ts`): Replaced `window.__VUE_VAPOR__` probe with explicit `configureSignal(fn)` API.

- **Reactivity loss from destructuring** (`examples/vue-vapor-component.vue`).

- **`v-model` on a signal object** (`examples/vue-vapor-component.vue`).

- **`.trim()` called on signal object** (`examples/vue-vapor-component.vue`).

- **`bus.onAfter()` return value discarded** (`examples/vue-vapor-component.vue`).

- **`AsyncHandler` type collapsed to `any`** (`src/command-bus.ts`).

- **Dead `listeners` array in fallback signal** (`src/chamber.ts`).

- **Stale `~1KB` size claim** (`src/index.ts`, `src/command-bus.ts`).

- **Wrong import path in JSDoc** (`src/devtools.ts`).

### Performance

- **Plugin chain no longer rebuilt on every dispatch** (`src/command-bus.ts`): Replaced per-dispatch `reduceRight` with a cached `runner` function rebuilt only on `use()`.

### Added

- **`signal` and `configureSignal` exports**.
- **DevTools integration** (`src/devtools.ts`).
- **Roadmap in README**.
