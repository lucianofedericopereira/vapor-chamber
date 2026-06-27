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

Real-world impact (listener fan-out, 50 exact + 5 wildcards, machine-sensitive absolutes):
- emit: ~750 ops/sec
- dispatch: ~600 ops/sec — emit ~1.25× dispatch (no plugin chain / `meta` stamp / depth tracking)

Scales with listener count: silent for <5 listeners, larger beyond ~50.

### Counter-based `meta.id`

The default unique-ID generator is a per-process random prefix + monotonic
counter (~30–50 ns per call). Was `crypto.randomUUID()` (~1–2 µs). Measured
~2.5× speedup on the 10k-dispatch hot path (counter ~1,850 vs `randomUUID` ~750 ops/sec).

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
| Raw (minified) | 16.7 KB |
| Brotli | **5.5 KB** |
| Vapor probing references | 0 |

Composables (`useCommand`, etc.) only land in your
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

Measured on 100 rapid dispatches × 50-item array state (machine-sensitive absolutes):
- Default: ~4,100 ops/sec
- `coalesce: true`: ~97,000 ops/sec (**~23×**)

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

The default `useCommand()` composable allocates two reactive
signals (`loading`, `lastError`) **per call**. On a page with 50 components
each calling it, that's 100 signal nodes in the reactivity graph.
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

**Performance note (v1.5.0 bench, beta.14):**

| Signal path (isolated scalar write loop) | ops/sec | Notes |
|---|---|---|
| Plain `{ value }` object (default fallback) | ~371,000 | Zero overhead, not reactive |
| **Vue `shallowRef()` via `signal()` auto-detected** | **~40,000–62,000** | The default since v1.5.0 — ~4–7× the old deep-`ref()` path |
| alien-signals via `configureAlienSignals` | ~10,400 | Opt-in reactive (non-Vue contexts) |
| Vue deep `ref()` (the old v1.4 `signal()` default) | ~9,000 | Replaced by shallowRef — see §"reactive runtime notes" finding #5 |
| Old closure getter/setter (v1.3, removed) | ~2,200 | 166× slower than plain object |

The plain `{ value }` fallback is fastest — zero getter/setter overhead. Since v1.5.0 `signal()`
auto-detects Vue and wires **`shallowRef()`**, which on this isolated scalar write loop runs
~40–62k ops/sec across runs (the absolute is machine-state sensitive; the **ratio is the robust
claim**: ~4–7× the deep `ref()` it replaced), and well ahead of the `configureAlienSignals`
adapter (~10k). (This isolated figure is the signal-write cost only; end-to-end through the command
bus the scalar gain is ~+12% because dispatch dominates — see the reactive-runtime-notes section.)
For push-pull reactivity *without* Vue, `configureAlienSignals` remains the correct choice.

**Implementation note:** the connector takes alien-signals' `signal`
function as an argument rather than importing it. vapor-chamber stays free
of an `alien-signals` runtime dep; consumers install it themselves
(~7.5 KB raw / ~2.5 KB brotli). 7 tests in
[tests/alien-signals.test.ts](../tests/alien-signals.test.ts) verify the
adapter against the real published package, not a stub.

### `useCommandState({ coalesce: true })` — correctness, not speed

`useCommandState` accepts a `{ coalesce: true }` option that collapses a burst
of dispatches into a single reactive signal write (≤1 write per microtask burst).
Bench result (v1.4.0, beta.13): throughput is **indistinguishable** from the
default — 1,902 ops/sec vs 1,897 ops/sec across two runs.

Use `coalesce: true` when correctness matters — e.g. a `v-for` that should
never see a partially-updated list mid-burst. Do not reach for it as a
performance knob; the measurements show no gain.

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
| `core`      | Sprinkled JS on server-rendered pages (Blade / Rails / Django)| 7.0 KB |
| `elements`  | Embeddable widgets via custom elements                        | 7.4 KB |
| `full`      | SPAs that grew big enough to want everything                  | 10.2 KB |

_(Always-current measured sizes for every export: [BUNDLE-SIZES.md](./BUNDLE-SIZES.md), generated by `npm run size:doc` and CI-verified fresh.)_

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
| direct function call (theoretical floor) | ~374,000 | 1.0×            |
| **vapor-chamber `fast-lane`**       | **~28,900**| 12.9×             |
| nanoevents emit                     | ~13,900    | 26.9×             |
| mitt emit                           | ~5,130     | 72.9×             |
| vapor-chamber `bus.dispatch` (general) | ~1,810  | 207×              |

Fast lane is **~2.1× faster than nanoevents** and **~5.6× faster than mitt** on
single-handler dispatch — beats every minimal event-emitter peer in this
class. ~12.9× behind the theoretical floor of a direct function call,
which is the cost of one Map lookup + one closure call (the closure is
necessary to support `remove()` + `clear()`).

For multi-listener fan-out (3 listeners):

| Lib / Path                          | ops/sec |
|-------------------------------------|---------|
| **vapor-chamber `fast-lane.emit`**  | **~7,390** |
| nanoevents                          | ~6,650  |
| vapor-chamber `bus.emit` (general)  | ~4,570  |
| mitt                                | ~3,400  |

Edges out nanoevents (~1.1×); ~2.2× faster than mitt.

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

The honest picture, measured on a current Apple Silicon dev machine (June 2026, Vue
3.6.0-beta.16), 10k iterations per bench. **Updated after the v1.2.x emit fast-path landed** —
the earlier measurement (where vapor-chamber `emit` was 6–16× slower than
`mitt`/`nanoevents`) was wasted-work in the lib's emit path, not an inherent
cost of the bus pattern.

### Emit with NO listeners (the "I emit, nobody cares" case)

This is the most common emit shape in real apps — many lifecycle / debug /
conditional events have zero subscribers. Should be effectively free.

| Lib                                | ops/sec    | Relative |
|------------------------------------|------------|----------|
| nanoevents                         | ~176,600   | 1.0×     |
| **vapor-chamber `bus.emit`**       | **~21,600**| 8.2×     |
| mitt                               | ~14,960    | 11.8×    |

vapor-chamber's no-listener fast path is **~1.4× faster than mitt**. nanoevents
is far ahead on this specific path — its `if (!this.events[event]) return;` is a
single property check, vs vapor-chamber's `Map.has() + Array.length === 0`
two-check guard — but vapor-chamber stays comfortably ahead of mitt.

### Emit fan-out (3 listeners)

| Lib                                | ops/sec    | Relative |
|------------------------------------|------------|----------|
| nanoevents                         | ~6,600     | 1.0×     |
| raw `Map<string, Set<fn>>`         | ~5,590     | 1.2×     |
| **vapor-chamber `bus.emit`**       | **~4,730** | 1.4×     |
| mitt                               | ~3,380     | 2.0×     |

vapor-chamber `emit` is **~1.4× faster than mitt** and ~28% behind nanoevents —
competitive with the lightest event emitters in the ecosystem.

### Dispatch with single handler (10k)

`dispatch` is a different shape than `emit`. It returns a `CommandResult`,
walks the plugin chain (even when empty), stamps `Command.meta` for
correlation/causation tracing, and tracks dispatch depth. Minimal event
emitters (`mitt`, `nanoevents`) don't compute results — comparing
`bus.dispatch` to `m.emit` is apples-to-oranges. Real peers are Pinia's
action dispatch, Redux's dispatch, or any middleware-chained bus.

| Lib                                | ops/sec    | What it does                       |
|------------------------------------|------------|------------------------------------|
| nanoevents emit                    | ~13,800    | call subscribed fns, no return     |
| mitt emit                          | ~5,140     | call subscribed fns, no return     |
| **vapor-chamber `bus.dispatch`**   | **~1,800** | resolve handler → run plugin chain → stamp meta → return CommandResult |

The ~3–8× gap reflects the work `dispatch` does per call: meta object
allocation (`{ ts, id, correlationId, causationId }`), result object
allocation (`{ ok, value, error }`), plugin runner invocation, dispatch
depth tracking. None of those are free, all are unavoidable for the bus
pattern's semantics. Real-world impact at ~1,800 iterations × 10k dispatches:
**~18M dispatches per second on a single thread**, well above any normal
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

## Reactive runtime notes (Vue 3.6)

Findings from the v1.5.0 bench run (June 2026, Vue beta.14, confirmed numbers — see the
bench comment block in `tests/perf.bench.ts`). This is the single, current reactive-perf
section; where a number shifted across betas the prior-beta baseline is cited inline (so the
superseded per-beta notes don't need their own section).

> **beta.15 (v1.6.0):** no perf-affecting change on these paths. The beta.15 alignment was
> documentation plus one guard on the (non-hot) `v-vc:command` click path; nothing in a measured
> hot loop changed. A 3-run beta.15 set was recorded on a dev host (see the baseline blocks in
> `tests/perf.bench.ts`): the stable rows (command bus, transition bridge, `useCommandState`,
> `effectScope` lifecycle) land ~3–8% under the beta.14 *reference-host* numbers **uniformly —
> including the Vue-independent raw `bus.dispatch` path**, which Vue's version cannot touch, so that
> shift is host/load variance, not a regression. The Vue-reactive rows (`shallowRef`, `watchEffect`)
> swing 20–30% run-to-run by machine state and are recorded as ranges; the same-process
> `signal-shallow-ab` A/B remains the trustworthy regression guard and still shows `shallowRef`
> faster. The beta.14 numbers below remain the cross-beta reference (an apples-to-apples cross-beta
> delta needs beta.14 re-run on the same host). Bench labels now read the running Vue version
> dynamically (`VUE_VERSION`), so they self-track.

> **beta.16 (unreleased):** no lib code change, so no path moved on our side. The full bench was
> re-run against beta.16 on a dev host and is **green** — the Vue-independent rows (plain
> `{ value }` ~368k ops/s, fast-lane ~28.6k, `bus.dispatch` ~1.83k) land on the recorded
> baselines, confirming no regression; the Vue-reactive rows stay inside their recorded ranges. No
> controlled cross-beta delta is claimed (that needs beta.15 re-measured on the *same* host —
> single-host numbers swing 20–30% by machine state, so a same-process A/B is the only honest
> comparison). **Opportunity logged, not acted on:** Vue's #14969 (skip `SlotFragment` for stable
> slot fallback) demonstrates a compile-time-proof → one-bit-flag → lighter-runtime-object pattern.
> It is a candidate for our own allocation-on-the-uncertain-branch hot paths, but only lands with a
> measured same-host A/B and after the Vapor-first/bus-first decision at 3.6 stable — not on a guess.

> **beta.17 (unreleased):** no lib code change again — every beta.17 fix is compiler-vapor
> (compile-time, below us), runtime slot/hydration/interop (below the command-replay or inherited
> through the `getVaporInteropPlugin()` pass-through), or a reactivity/scheduler fix the lib never
> touches. The full bench was re-run against beta.17 on a dev host and is **green**: the
> Vue-independent rows land on the recorded baselines (plain `{ value }` floor ~368k ops/s, fast-lane
> ~28.7k, `bus.dispatch` ~1.78k, `emit` with no listeners ~25.4k), confirming no regression; the
> Vue-reactive rows stay inside their recorded ranges. No controlled cross-beta delta is claimed.
> **Pattern worth noting:** Vue's #14984 (*preserve render-effect creation order when updating*) had
> to add creation-order as a scheduler tiebreaker behind component id — the same insertion-order
> invariant the bus already gets **for free** from JS's stable `Array.prototype.sort` on
> equal-priority plugins (`byPriority`), and already pins with the `equal priority preserves
> registration order` regression test. Nothing to act on; the lib's ordering was already correct by
> construction, but the parallel is a good reminder of why that test stays.

**1. The plain `{ value }` fallback remains the fastest write path at ~372,000 ops/sec.**
Essentially unchanged from beta.13 (~368k) — within normal run-to-run variance.
The fallback is not reactive; for push-pull reactivity without Vue, use
`configureAlienSignals(alienSignal)` (~10,400 ops/sec).

**2. With `signal()` now wired to `shallowRef`, the Vue path is several× the alien-signals adapter — not equivalent to it.**
The beta.13 docs reported `signal()` (then deep `ref()`) at ~9k, *converging* with the
`alienSignalAdapter` (~10k). That comparison is obsolete: since v1.5.0 `signal()` wires
**`shallowRef`**, and on an isolated scalar write loop it measures **~40,000–62,000 ops/sec**
across runs — roughly **4–7× the deep `ref()` it replaced** and ~4–6× the alien adapter (~10,400).
The absolute is machine-state sensitive (observed 37k on a busy machine, 62k on an idle one); the
ratio is the robust claim. So for Vue apps the auto-detected `signal()` is now clearly the fastest
reactive path; `configureAlienSignals` is for non-Vue contexts, not a throughput upgrade. (Isolated
figure — end-to-end through the bus the scalar gain is ~+12%; see finding #5 for the real-path numbers.)

**3. beta.14 scheduler improvements lift `effectScope` lifecycle cost ~9% above beta.13.**
`effectScope.run(() => onScopeDispose(fn))` with no tracked reactive state now costs
~173,000 hz (vs ~165k in beta.13) — the "reset job queue length after flush" fix reduces
teardown overhead. Every vapor-chamber composable that calls `tryAutoCleanup` benefits
automatically.

**4. `useCommandState` throughput improves ~24% in beta.14 and `{ coalesce: true }` remains neutral.**
Measured at ~2,093 ops/sec (immediate) and ~2,105 ops/sec (coalesced) with 100 dispatches —
both are +24% above the beta.13 ~1,700 hz baseline. The scheduler flush improvement accounts
for the lift. Rule unchanged: use `coalesce: true` for correctness (≤1 reactive write per
burst), not throughput — the two paths are within noise of each other.

**5. `signal()` wires `shallowRef`, not `ref` — and the difference is large for object/array state.**
The alien-signals rewrite changed dependency *tracking*, but `ref(anObjectOrArray)` still wraps the
value in a deep reactive Proxy via `toReactive()`. The library replaces signal values wholesale and
never mutates nested fields, so `shallowRef` is semantically equivalent for every internal signal
and skips that proxy cost. Measured **interleaved same-process A/B** on the real `useCommandState`
dispatch path (the coarse vitest-bench harness, with its ~480µs/iteration setup floor, cannot
resolve this — it compresses array and scalar cases to the same ~2,100 ops/sec):

| `useCommandState` dispatch path | `ref` | `shallowRef` | delta |
|---|---|---|---|
| 100 array appends (v-for source) | ~3,300 | ~11,300 | **+245%** |
| 10 array appends | ~122,000 | ~285,000 | **+134%** |
| 100 scalar increments | ~123,000 | ~146,000 | **+12%** |

These are not hand-measured one-offs: `tests/signal-shallow-ab.test.ts` runs this exact A/B in CI
(median of 7 interleaved reps, `process.hrtime`) and **prints the table on every run** — that printed
output is the live evidence. It deliberately does not assert a timing *threshold* (ratios are unstable
under parallel load / coverage instrumentation, and the test compares Vue's `ref`/`shallowRef`
directly, so it couldn't catch a library regression anyway). The actual regression guard is
`chamber.test.ts` › "signal() factory — shallow reactivity", which asserts `signal()` stays a
`shallowRef`. The array/10 and scalar deltas are the noisier cases (run-to-run ±10–20%); the
array/100 case is consistently ~3.4×.

Why not an isolated `ref`-vs-`shallowRef` micro-bench in `perf.bench.ts`? Because pure deterministic
signal loops are constant-foldable: V8 dead-code-eliminates the shallowRef path (no observable effect)
while keeping `ref`'s Proxy-trap side effects, yielding inflated 800×+ ratios with ±100% rme — garbage.
The real dispatch path defeats constant-folding (the command bus is opaque indirection), which is why
the interleaved real-path test above is the only trustworthy source for these ratios.

Methodology note: these absolute numbers are far higher than the `perf.bench.ts` `useCommandState`
table because the manual harness strips vitest-bench's ~480µs/iteration setup floor. Use them for the
**ref-vs-shallowRef ratio only**, not as standalone throughput figures. The takeaway: deep-proxy
creation on every object/array signal write was real, avoidable overhead — now avoided by default.

If you genuinely need deep reactivity (nested-mutation tracking for a `v-model`-bound state object),
opt back in per-state with `useDeepCommandState` / `deepSignal` from `vapor-chamber/reactive` — it
pays the `ref` cost only where you ask for it, leaving every other signal on the fast shallow path.

---

## Benchmark snapshot

Run on a current Apple Silicon dev machine, June 2026 (v1.5.0, Vue beta.14).
Your numbers will differ; what matters is the **ratios** and how they shift after
your changes.

Reproduce with:

```bash
npx vitest bench --run tests/perf.bench.ts
```

| Bench                                                              | ops/sec     |
|--------------------------------------------------------------------|-------------|
| `syncDispatch` — bare handler, no plugins                          | ~2,316      |
| `syncDispatch` — 3 plugins + 1 listener                            | ~1,267      |
| `asyncDispatch` — bare handler                                     | ~3,391      |
| `dispatch` — default uid                                           | ~1,874      |
| `dispatch` — `crypto.randomUUID` via `configureUid`                | ~747        |
| `dispatch` — 50 exact + 5 wildcard listeners                       | ~602        |
| `emit` — 50 exact + 5 wildcard listeners                           | ~756        |
| `persist` — default mode (100 dispatches × 50-item state)          | ~3,894      |
| `persist` — `coalesce: true` (100 dispatches × 50-item state)      | ~98,292     |
| `rehydrate` — 1000 commands, single handler                        | ~16,192     |
| `rehydrate` — 1000 commands, ignoreUnhandled skip path             | ~107,016    |
| **Vue reactive integration (beta.14, requires vue devDep)**        |             |
| `signal()` fallback — plain `{ value }` object (no Vue, no alien-signals) | ~372,198 |
| `signal()` fallback — old closure getter/setter (v1.3, removed)   | ~2,208      |
| alien-signals via `configureAlienSignals` (opt-in reactive)        | ~10,400     |
| `signal()` write — Vue **shallowRef** auto-detected (v1.5.0 default)| ~40,000–62,000 |
| `signal()` write — Vue deep `ref()` (old v1.4 default, for reference)| ~9,000     |
| `effectScope` + `onScopeDispose` × 1k — no reactive state (lazy job) | ~173,462 |
| `effectScope` + reactive signal + `onScopeDispose` × 1k (full path)| ~21,287    |
| `useCommandState` 100 dispatches — Vue ref signal writes (beta.14) | ~2,100      |
| `useCommandState coalesced` 100 dispatches — 1 reactive write      | ~2,115      |

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
