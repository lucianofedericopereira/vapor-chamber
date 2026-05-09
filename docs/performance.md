# Performance & Tuning

Practical reference for getting the most out of vapor-chamber. Most of what
this document describes is **already done by default** — the lib is V8-aligned
out of the box. The "Tuning" section below is for cases where you want to
trade defaults for higher throughput on specific hot paths.

---

## Philosophy

The lib targets two different optimization regimes:

1. **Read-many hot paths** — places where the same object is touched by
   plugins, hooks, listeners, and consumer code on every dispatch. Examples:
   `result.ok`, `cmd.meta.id`, `cmd.action`. These rely on **monomorphic
   hidden classes** so V8's inline caches stay specialized. The lib enforces
   shape consistency on `Command`, `CommandResult`, `CommandMeta`, and the
   internal bus state.
2. **Algorithmic complexity** — places where the cost scales with usage
   pattern. Examples: listener fan-out (O(n) walk → O(1) hash + O(w) wildcard
   walk), persist plugin saves (one per dispatch → one per microtask).

What the lib does **not** chase:
- Loop-syntax micro-opts (cached `length`, index-vs-`for...of`). V8's
  TurboFan handles these. The few places where index loops are kept are
  documented; everywhere else, idiomatic code is fine.
- Property mangling, Closure ADVANCED, asm.js / Wasm. Friction far exceeds
  gain for a library at this size.
- Premature parallelism. Hooks run sequentially because order matters; opt-in
  parallel is on the roadmap, not the default.

---

## What's optimized by default

You get all of this without changing any code. Listed for diagnostic
transparency only.

### Hot-path shape consistency

- `okResult` / `errResult` always allocate `{ ok, value, error }` with the
  unused slot set to `undefined`. One hidden class for both, monomorphic
  property access at every consumer site.
- `stampMeta` always allocates `{ ts, id, correlationId, causationId }` with
  stable field order. No late property additions, no shape transitions.
- `Command` literal always `{ action, target, payload, meta }` in the same
  order across `dispatch` / `query` / `emit` / `request` paths.
- `AsyncState` and `SyncState` initialized via single object literals at bus
  construction — no incremental field writes that would create shape
  branches.

### Pre-composed plugin chain

`bus.use(plugin)` rebuilds a single composed `runner` function once per
plugin add/remove. Dispatch calls `runner(cmd, execute)` directly — no
per-dispatch chain walk, no per-dispatch closure allocation.

### Listener bucketing

`bus.on('cartAdd', fn)` (exact match) goes into a `Map<action, Listener[]>`
for O(1) lookup at dispatch time. `bus.on('cart*', fn)` (wildcard) goes into
a separate array walked with `matchesPattern` only when wildcards exist.

Real-world impact (5k dispatches × 55 listeners):
- dispatch: +12% (415 → 466 ops/sec)
- emit: +26% (403 → 507 ops/sec)

Scales with listener count: silent for <5 listeners, larger beyond ~50.

### Counter-based `meta.id`

The default unique-ID generator is a per-process random prefix + monotonic
counter (~30–50 ns per call). Was `crypto.randomUUID()` (~1–2 µs). Measured
2.26× speedup on the 10k-dispatch hot path.

If you need cryptographically unique IDs (distributed tracing, cross-process
auditing), opt in:

```ts
import { configureUid } from 'vapor-chamber';
configureUid(() => crypto.randomUUID());
```

Call once at app setup. Affects all subsequent dispatches.

### Wildcard pattern prefix cache

`matchesPattern('foo*', 'fooBar')` caches the prefix (`'foo'`) per pattern
in a 256-entry LRU. Avoids `String.prototype.slice()` on every match.

### Tree-shake-friendly imports

The signal API lives in a side-effect-free `src/signal.ts` module. Importing
`createHttpBridge` or `createFormBus` does not pull in the Vue
feature-detection registry from `chamber.ts`. Typical Blade-style consumer
bundle (`createCommandBus` + `createHttpBridge` + `logger`):

| | Bundle |
|--|--|
| Raw | 17 KB |
| Brotli | **5.7 KB** |
| Vapor probing references | 0 |

Composables (`useCommand`, `useVaporCommand`, etc.) only land in your
bundle if you explicitly import them.

---

## Tuning knobs (consumer-facing)

### `persist({ ..., coalesce: true })` — collapse rapid saves

By default, every successful dispatch with the persist plugin does one
`getState()` + `JSON.stringify()` + `setItem()` cycle. For workloads where
many rapid commands touch the same state (form input, scroll tracking,
batched cart updates), enable coalescing:

```ts
import { persist } from 'vapor-chamber';

bus.use(persist({
  key: 'vc:cart',
  getState: () => cart.value,
  coalesce: true,   // <— save once per microtask burst, not per dispatch
}));
```

Trade-off: 1 microtask of latency before the save lands. Storage reads
immediately after a burst of dispatches will see the pre-burst state until
the next tick.

Measured on 100 rapid dispatches × 50-item array state:
- Default: 3,300 ops/sec
- `coalesce: true`: 28,887 ops/sec (**8.75×**)

Use when you're measurably bottlenecked on persist; leave default otherwise
to keep storage in lockstep with bus state.

### `configureUid(fn)` — swap the unique-ID generator

Default: counter + per-process random prefix. Fast, in-process unique.

Opt in to `crypto.randomUUID()` if you ship command IDs to a distributed
tracing backend or use them as cross-process correlation keys:

```ts
import { configureUid } from 'vapor-chamber';
configureUid(() => crypto.randomUUID());
```

Call once at app setup, before any dispatches.

### `useSharedCommandState()` — one set of signals shared across many components

Default composables (`useCommand` / `useVaporCommand`) allocate two reactive
signals (`loading`, `lastError`) **per call**. On a page with 50 components
each calling one of them, that's 100 signal nodes in the reactivity graph.
Most of those components only need to know "is *anything* in flight?" — they
don't need their own private loading state.

`useSharedCommandState()` returns the **same** signal instances to every
caller subscribed to the same bus. State is per-bus (multiple buses → multiple
shared states), ref-counted (auto-dropped when the last subscriber disposes),
and exposes a ring-buffered errors list capped at `errorCap` (default 10).

```ts
import { useSharedCommandState } from 'vapor-chamber';

// In any number of components — all see the same isAnyLoading / errors / lastError.
const { dispatch, isAnyLoading, lastError, errors, errorCount, clear } = useSharedCommandState();

// Bind to button disabled across the whole UI:
//   <button :disabled="isAnyLoading.value">Save</button>
//
// Show a top-of-page error toast:
//   <Toast v-if="lastError.value">{{ lastError.value.message }}</Toast>

await dispatch('cartAdd', product);
```

Behavior:
- **`inFlight`** counts concurrent dispatches across all subscribers; auto-decrements when each completes (sync throw, async reject, async ok=false, all paths).
- **`isAnyLoading`** is `true` when `inFlight > 0`.
- **`errors`** is a ring buffer (newest last); older entries drop when length
  exceeds `errorCap`.
- **`lastError`** is the most recent error.
- **`clear()`** wipes errors / lastError; does not affect `inFlight`.
- **`{ signal }`** option forwards to the underlying bus dispatch (the v1.2.x
  AbortController integration), so cancellation works the same as
  `useCommand`.
- **Auto-cleanup** via `tryAutoCleanup` — Vue scope/component disposal calls
  `dispose()` automatically.

When to use:
- **Use `useSharedCommandState`** when many components only need aggregate
  state ("any loading?", "any errors?"). Toolbars, status bars, global
  spinners, error toast lists.
- **Use `useCommand`** when a component needs its own private loading/error
  scoped to its own button or form. Component-local UI state.

Both can coexist on the same bus.

### `dispatch(..., { signal })` — cancelable async dispatch

Pass an `AbortSignal` as the 4th argument to cancel an in-flight async
dispatch:

```ts
import { createAsyncCommandBus } from 'vapor-chamber';

const bus = createAsyncCommandBus();
bus.register('searchProducts', async (cmd) => {
  // Handler can observe cmd.signal mid-flight
  return await fetch('/api/search?q=' + cmd.target, { signal: cmd.signal });
});

const ac = new AbortController();
const result = bus.dispatch('searchProducts', 'denim', undefined, { signal: ac.signal });

// Later — user types a new query, abort the in-flight search
ac.abort();
```

Behavior:
- **Pre-aborted signal** → resolves immediately with `{ ok: false, error }`,
  handler is **not** called. The error is the explicit reason
  (`ac.abort(myError)`) if provided, otherwise a `BusError` with
  `code === 'VC_CORE_ABORTED'`.
- **Mid-flight abort** → handler observes `cmd.signal.aborted === true`. The
  handler is responsible for stopping its own work — the bus does not
  forcibly terminate it.
- **HTTP bridge** auto-forwards `cmd.signal` to `fetch`. No need to thread
  the signal through `createHttpBridge` options at construction.
- **After-hooks fire** for aborted dispatches so loggers and metrics see the
  cancellation.
- **Sync bus** accepts `{ signal }` for type uniformity but ignores it at
  runtime — sync dispatches are atomic.

**Not yet supported** (deferred to v1.3): `bus.request()` / `respond()`,
`bus.dispatchBatch()`, auto-derived child signals from parent dispatches,
WebSocket / SSE bridges. Use `cmd.signal` directly in custom handlers /
plugins as a workaround.

### `vapor-chamber/alien-signals` — push-pull reactivity for non-Vue consumers

Vue 3.6's `ref()` is itself a port of [alien-signals](https://github.com/stackblitz/alien-signals)
([vuejs/core#12349](https://github.com/vuejs/core/pull/12349)) — so when
vapor-chamber auto-detects `vue.ref` you're already on alien-signals'
algorithm under the hood.

For **non-Vue contexts** — SSR/Node services, Web Workers, embedded
widgets, anywhere you want push-pull reactivity without Vue's full runtime
— the `vapor-chamber/alien-signals` connector flips vapor-chamber's
underlying signal factory in one call:

```ts
import { signal as alienSignal } from 'alien-signals';
import { configureAlienSignals } from 'vapor-chamber/alien-signals';

configureAlienSignals(alienSignal);

// From here on, every vapor-chamber signal() — including useCommand,
// useSharedCommandState, FormBus signals — is backed by alien-signals'
// push-pull propagation algorithm. computed() / effect() from alien-signals
// observe the same underlying instances.
```

**Implementation note:** the connector takes alien-signals' `signal`
function as an argument rather than importing it. vapor-chamber stays free
of an `alien-signals` runtime dep; consumers install it themselves
(~7.5 KB raw / ~2.5 KB brotli). 7 tests in
[tests/alien-signals.test.ts](../tests/alien-signals.test.ts) verify the
adapter against the real published package, not a stub.

### `configureSignal(fn)` — provide your own signal implementation

The lib auto-detects Vue's `ref()` for reactivity. If you're using a custom
signal library or want to wire alien-signals directly:

```ts
import { configureSignal } from 'vapor-chamber';
import { signal as alienSignal } from 'alien-signals';
configureSignal((initial) => {
  const s = alienSignal(initial);
  return { get value() { return s(); }, set value(v) { s(v); } };
});
```

Useful for SSR / non-Vue environments where you still want reactive bus
state.

---

## Choosing an IIFE variant

For `<script>`-tag deployments, the lib ships three sized bundles. Pick by
audience, not by feature checklist.

| Variant     | Audience                                                      | Brotli |
|-------------|---------------------------------------------------------------|--------|
| `core`      | Sprinkled JS on server-rendered pages (Blade / Rails / Django)| 6.2 KB |
| `elements`  | Embeddable widgets via custom elements                        | 6.5 KB |
| `full`      | SPAs that grew big enough to want everything                  | 8.9 KB |

**Decision tree:**

```
Does your page register custom elements via defineWidget()?
├─ Yes → elements
└─ No  → Does your page use WebSocket/SSE, persistence, or undo/redo?
        ├─ Yes → full
        └─ No  → core
```

Most server-rendered apps land on **core**. Most third-party widget
distributions land on **elements**. Most SPAs that ship a `<script>` build
land on **full** (and probably should use ESM via a bundler instead).

Variant contents are not stable across major versions before v2.0 — see
[ROADMAP.md](../ROADMAP.md). ESM consumers always get the full surface and
obey strict semver.

---

## Two doorways: general bus vs fast lane

vapor-chamber ships **two distinct dispatch paths** that serve different
audiences. Pick by what your hot path actually is.

| Path                                  | When to use                                                 | Trades                                                                  |
|---------------------------------------|-------------------------------------------------------------|-------------------------------------------------------------------------|
| `createCommandBus()` (general)        | App-level commands: cart, form, navigation, analytics       | Pays per-call for envelope + result + plugin chain — gives you results, plugins, hooks, listeners, schema, batch, request/response, AbortController |
| `createFastLane()` (real-real-hot)    | Game tick, trading data, audio buffer, scroll/mousemove, physics step | Strips everything but the function call. No envelope, no result, no plugins, no hooks, no abort. Just `(data) => handler(data)` |

The fast lane lives at `vapor-chamber/fast-lane`:

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
const onPriceTick = lane.compile('priceTick', (tick) => updateChart(tick));
onPriceTick(tick);   // pure function call, no allocations on hot path
```

**Measured throughput** (10k iterations, single handler):

| Lib / Path                          | ops/sec    | Relative to floor |
|-------------------------------------|------------|-------------------|
| direct function call (theoretical floor) | ~348,000 | 1.0×              |
| **vapor-chamber `fast-lane`**       | **~25,400**| 13.7×             |
| nanoevents emit                     | ~13,300    | 26.2×             |
| mitt emit                           | ~4,750     | 73×               |
| vapor-chamber `bus.dispatch` (general) | ~700    | 498×              |

Fast lane is **1.9× faster than nanoevents** and **5.3× faster than mitt** on
single-handler dispatch — beats every minimal event-emitter peer in this
class. ~13.7× behind the theoretical floor of a direct function call,
which is the cost of one Map lookup + one closure call (the closure is
necessary to support `remove()` + `clear()`).

For multi-listener fan-out (3 listeners):

| Lib / Path                          | ops/sec |
|-------------------------------------|---------|
| **vapor-chamber `fast-lane.emit`**  | **~5,980** |
| nanoevents                          | ~5,700  |
| vapor-chamber `bus.emit` (general)  | ~3,100  |
| mitt                                | ~2,580  |

Ties nanoevents (within 5%); 2.3× faster than mitt.

### When to pick which

```
Are you in a per-frame / per-tick / per-sample hot loop?
├── Yes → fast-lane. Use compile(action, handler) + dispatcher(data).
│         Or on(action, fn) + emit(action, data) for fan-out.
└── No  → general bus. createCommandBus() with the rich API.
```

If the answer is "I don't know," use the general bus. The fast lane is for
workloads where you have already identified the bus as a measurable
bottleneck.

---

## Comparative benchmarks vs other small libs

The honest picture, measured on a current Apple Silicon dev machine (May 2026),
10k iterations per bench. **Updated after the v1.2.x emit fast-path landed** —
the earlier measurement (where vapor-chamber `emit` was 6–16× slower than
`mitt`/`nanoevents`) was wasted-work in the lib's emit path, not an inherent
cost of the bus pattern.

### Emit with NO listeners (the "I emit, nobody cares" case)

This is the most common emit shape in real apps — many lifecycle / debug /
conditional events have zero subscribers. Should be effectively free.

| Lib                                | ops/sec    | Relative |
|------------------------------------|------------|----------|
| nanoevents                         | ~81,800    | 1.0×     |
| **vapor-chamber `bus.emit`**       | **~24,500**| 3.3×     |
| mitt                               | ~9,800     | 8.3×     |

vapor-chamber's no-listener fast path is **2.5× faster than mitt**. nanoevents
is fastest because its `if (!this.events[event]) return;` is one property
check; vapor-chamber's `Map.has() + Array.length === 0` is two checks but
still well above the floor.

### Emit fan-out (3 listeners)

| Lib                                | ops/sec    | Relative |
|------------------------------------|------------|----------|
| nanoevents                         | ~5,600     | 1.0×     |
| raw `Map<string, Set<fn>>`         | ~5,200     | 1.1×     |
| **vapor-chamber `bus.emit`**       | **~4,600** | 1.2×     |
| mitt                               | ~2,500     | 2.2×     |

vapor-chamber `emit` is now **1.8× faster than mitt** and within 20% of
nanoevents — competitive with the lightest event emitters in the ecosystem.

### Dispatch with single handler (10k)

`dispatch` is a different shape than `emit`. It returns a `CommandResult`,
walks the plugin chain (even when empty), stamps `Command.meta` for
correlation/causation tracing, and tracks dispatch depth. Minimal event
emitters (`mitt`, `nanoevents`) don't compute results — comparing
`bus.dispatch` to `m.emit` is apples-to-oranges. Real peers are Pinia's
action dispatch, Redux's dispatch, or any middleware-chained bus.

| Lib                                | ops/sec    | What it does                       |
|------------------------------------|------------|------------------------------------|
| nanoevents emit                    | ~13,700    | call subscribed fns, no return     |
| mitt emit                          | ~4,400     | call subscribed fns, no return     |
| **vapor-chamber `bus.dispatch`**   | **~630**   | resolve handler → run plugin chain → stamp meta → return CommandResult |

The 5–10× gap reflects the work `dispatch` does per call: meta object
allocation (`{ ts, id, correlationId, causationId }`), result object
allocation (`{ ok, value, error }`), plugin runner invocation, dispatch
depth tracking. None of those are free, all are unavoidable for the bus
pattern's semantics. Real-world impact at ~630 dispatches × 10k iterations:
**6.3M dispatches per second on a single thread**, well above any normal
app's dispatch budget.

### What this means

- **For pub/sub event emit/listen** — vapor-chamber `emit` is competitive
  with the fastest event emitters. Use it freely.
- **For commands with results / plugins / hooks / batch / request/response**
  — that's the bus pattern; `dispatch` does meaningfully more per call than
  `emit`. The throughput is still high enough for any normal workload.

The comparative benches live in [`tests/perf.bench.ts`](../tests/perf.bench.ts)
under `describe('emit fast path — no listeners')`,
`describe('comparative emit fan-out')`, and `describe('comparative dispatch')`.
Reproduce with `npx vitest bench --run tests/perf.bench.ts`.

### Implementation notes for the curious

The v1.2.x `emit` fast path makes three changes:

1. **No-listener short-circuit** — `if (!exactListeners.has(event) && wildcardListeners.length === 0) return;` before any allocation.
2. **Singleton `EMIT_RESULT`** — `Object.freeze({ ok: true, value: undefined, error: undefined })` reused by every emit, instead of `okResult(undefined)` allocating a fresh object.
3. **No `stampMeta` on emit** — `Command.meta` is left undefined for emit-fired commands. emit is fire-and-forget; correlation IDs / timestamps are unused by typical listeners. The `Command` type already has `meta?` as optional. Listeners that need meta on a fire-and-forget event should use `dispatch` instead.

Inspiration: similar tricks ship in [splice](https://github.com/lucianofedericopereira/splice) — frame pooling, no-listener fast path, minimal envelopes. vapor-chamber didn't adopt the full splice architecture (numeric action IDs, binary headers, frozen action tables) because it would mean a v2 rewrite; the targeted fast paths capture most of the win without breaking existing API.

## Benchmark snapshot

Run on a current Apple Silicon dev machine, May 2026. Your numbers will
differ; what matters is the **ratios** and how they shift after your changes.

Reproduce with:

```bash
npx vitest bench --run tests/perf.bench.ts
```

| Bench                                                              | ops/sec     |
|--------------------------------------------------------------------|-------------|
| `syncDispatch` — bare handler, no plugins (10k dispatches)         | ~1,900      |
| `syncDispatch` — 3 plugins + 1 listener (10k dispatches)           | ~1,250      |
| `asyncDispatch` — bare handler (1k dispatches)                     | ~3,500      |
| `dispatch` — default uid                                           | ~1,460      |
| `dispatch` — `crypto.randomUUID` via `configureUid`                | ~645        |
| `dispatch` — 50 exact + 5 wildcard listeners (5k dispatches)       | ~466        |
| `emit` — 50 exact + 5 wildcard listeners (5k dispatches)           | ~507        |
| `persist` — default mode (100 dispatches × 50-item state)          | ~3,300      |
| `persist` — `coalesce: true` (100 dispatches × 50-item state)      | ~28,887     |
| `rehydrate` — 1000 commands, single handler                        | ~1,300      |
| `rehydrate` — 1000 commands, ignoreUnhandled skip path             | ~96,000     |

---

## What we measured but did not ship

Documented here so future contributors don't repeat the investigation.

### HTTP envelope shape

We considered making the HTTP envelope `{ command, target, payload }` always
include all fields (vs omitting `payload` when undefined) for hidden-class
consistency. **Already done in production code.** Bench showed no meaningful
difference (~5%, within noise) — JSON.stringify pays a tiny cost to skip
undefined slots, which cancels the IC consistency win for write-once →
serialize-once → discard workloads. Not actionable.

**Lesson:** monomorphic shape advice applies to read-many paths (result,
meta, command). For serialize-once paths, write idiomatic code; V8's
JSON.stringify has its own fast paths that don't benefit from shape
preservation tricks.

### Parallel after-hooks

Considered `Promise.all`-style parallel execution of registered after-hooks.
Skipped because most real hook pipelines have hidden order dependencies
(logger before metrics, audit before publish). An opt-in `{ parallel: true }`
registration option is on the v1.3 roadmap; default stays sequential.

### Property mangling

Considered Terser's `mangle.properties` for internal `_*` prefixed names.
Skipped — breaks debugging without measurable real-world gain on bundles
of this size. Reconsidered if a measured profile shows it's worth it.

### Closure Compiler ADVANCED

Considered. Would save another 10–15% on top of current Vite output, but
requires annotating every API with `@export`, writing externs files, and
removing all dynamic property access (`obj[runtimeKey]`, `Symbol.toStringTag`,
runtime `vue.defineVaporCustomElement` probes). The library's runtime
feature-detection patterns are fundamentally incompatible with Closure's
static-world assumptions. Friction far exceeds gain.

---

## Measuring your own usage

If you want to know whether vapor-chamber is a bottleneck in your app:

1. **Hot-path dispatch count.** Wrap a sample window around your highest-
   frequency dispatch sites and count. If you're under ~10k dispatches/sec
   per page, the bus is not your bottleneck — look at the work the handlers
   themselves do.
2. **Persist save frequency.** Count `setItem` calls in DevTools'
   Storage panel. If you see >100/sec, enable `coalesce: true`.
3. **Listener fan-out.** `bus[Symbol.for('vapor-chamber.inspect')]?.()` (via
   `inspectBus`) returns the registered listener pattern count. If
   `listenerPatterns.length > 50`, you're getting the bucketing benefit; if
   it's 1–5, the bucketing is silent.
4. **HTTP envelope cost.** Profile the `JSON.stringify(envelope)` site only
   if your endpoint is hot. The lib's envelope is already minimal.

For a full bench run against your own dispatch shapes, copy
`tests/perf.bench.ts` into your project and adapt the workloads.
