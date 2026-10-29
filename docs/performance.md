# Performance & Tuning

What the library does for speed, and how to tune it. Most of this page describes what is
**already done by default**. The "Tuning knobs" section trades defaults for higher throughput on
specific hot paths.

- The rules below, one line each with where their evidence is: [V8-RULES.md](./V8-RULES.md).
- The steps of a measurement: [TESTING_PROCEDURE.md](./TESTING_PROCEDURE.md).

---

## Philosophy

The library targets two optimization regimes:

1. **Read-many hot paths:** places where plugins, hooks, listeners and consumer code touch the
   same object on every dispatch, such as `result.ok`, `cmd.meta.id`, `cmd.action`. These rely on
   **monomorphic hidden classes**, so V8's inline caches stay specialized. The library keeps one
   shape for `Command`, `CommandResult`, `CommandMeta` and the internal bus state.
2. **Algorithmic complexity:** places where the cost scales with the usage pattern. Examples:
   listener fan-out (an O(n) walk became an O(1) hash plus an O(w) wildcard walk), and a store's
   saves (one per write became one per microtask).

What the library does **not** chase:

- **Loop-syntax micro-optimizations** (cached `length`, index loops against `for...of`). V8's
  TurboFan handles these. The few index loops kept are documented where they are, and everywhere
  else idiomatic code is fine.
- **Property mangling, Closure ADVANCED, asm.js or Wasm.** For a library this size the friction
  far exceeds the gain.
- **Premature parallelism.** Hooks run in sequence, because order matters.[^parallel]

[^parallel]: Opt-in parallel was considered and not built (docs/decisions.md, the 2026-10-13 entry "What we measured but did not ship").

---

## What's optimized by default

All of this comes without changing any code. It is listed for diagnosis only.

### Hot-path shape consistency

- **One result shape.** `okResult` / `errResult` always allocate `{ ok, value, error }`, with
  the unused slot set to `undefined`. One hidden class serves both, with monomorphic property
  access at every consumer site. `tests/v8-shapes.test.ts` checks the map with V8's own
  `%HaveSameMap`, and fails on any new hand-built result literal in `src/`.[^s27]
- **One meta shape.** `stampMeta` always allocates
  `{ ts, id, correlationId, causationId, origin, idempotencyKey, response, request }`, in a
  stable field order. The last three are `undefined` until stamped (log s35.81, s35.136,
  s35.139). No late property additions, no shape transitions.
- **One command shape.** The `Command` literal is always `{ action, target, payload, meta, signal }`,
  in the same order, on both buses: dispatch, query, batch, request, a replay, a command another
  tab sent and the test bus. `signal` is `undefined` where nothing sets it. So a step's ticket
  fills a slot instead of adding a field, and a site that reads commands from both buses sees one
  map (`tests/v8-shapes.test.ts`, with `%HaveSameMap`).[^signal-slot] The sync `request`'s own
  `signal` option still never reaches the command.
- **`emit` builds `{ action, target }`, on purpose** (see its fast-path note below).[^emit-pad]
- **Bus state in one literal.** `AsyncState` and `SyncState` are initialized through single
  object literals at bus construction, with no incremental field writes that would branch the
  shape.

[^s27]: Until the perf audit (s27) this held only for results the bus built itself. About 30 sites outside it wrote their own `{ ok, error }` or `{ ok, value }` literal, a different map: `validator`, `authGuard`, the debounce plugin, async `optimisticUndo`, every HTTP and WebSocket transport result, and the `runDispatch` and `useSharedCommandState` error paths. They now call the same two factories, which also shrank every IIFE (the full IIFE by 32 B brotli).

[^signal-slot]: The slot was measured 2026-10-24 on an Intel i7-8650U: a bare sync dispatch 0.999x (0.1 ns, MDE 0.1%), nothing counted on the step, batch, query and app rows (log 36.F56).

[^emit-pad]: Padding emit to four fields was measured through the real bus and declined. A `'*'` listener reading both kinds gained nothing outside the harness's self-A/B band (0.967-1.012x), while the padded emit itself ran about 3% slower.

### Parts placed once

`bus.use(plugin)` places each part of a plugin once: its `started` and `settled` parts in the
facts slot, its rules and its work steps in maps resolved once per action.

- A dispatch reads them. It walks no chain and builds no closure per plugin, since no part holds
  `next`.
- An action that no rule or step covers pays one null read for each.
- A part's throw becomes its plugin's `plugin:failed:plugin` at the part's own boundary, an
  inline try in the bus.

### The async path awaits only what is async

An async dispatch builds a promise or awaits a step only where something can be pending.

- After-hooks run in a plain loop, and only a hook that returns a promise is awaited.
- A handler that returns a value, such as a store's reducer, answers with no async function
  around it.
- The retry reads a success directly, and builds its re-send only on a failure.
- A sent command's POST returns its request's own promise.
- `useCommand` adds no promise on a bus that cannot reject.

Each is pinned by a count of microtask turns. The rule and its measurements are V8-RULES rule 20
(log 36.F45 to 36.F49).

### Listener bucketing

- `bus.on('cartAdd', fn)` (an exact match) goes into a `Map<action, Listener[]>` for O(1) lookup
  at dispatch time.
- `bus.on('cart*', fn)` (a wildcard) goes into a separate array. Each entry carries its prefix,
  computed once in `on()`, so dispatch tests it with one `startsWith` and no `matchesPattern`
  call.

With 50 exact and 5 wildcard listeners, emit runs
<!-- vc:benchEmitVsDispatchFanout -->1.50<!-- /vc:benchEmitVsDispatchFanout -->x
the dispatch rate, because it keeps no per-action record, stamps no `meta` and tracks no depth.
That is the median of the latest `npm run bench:bands`.

### Counter-based `meta.id`

The default unique-ID generator is a per-process random prefix plus a monotonic counter. About
12 ns per call against about 104 ns for `crypto.randomUUID()`, about 8x.[^uid-measured]

**Always quote the runtime with the number.** Modern V8 and Node batch UUID entropy, so
`randomUUID`'s cost moves between runtimes while the counter's does not.

**The ratio at the dispatch level is bench-backed:** <!-- vc:benchUidCounterVsUuid -->2.89<!-- /vc:benchUidCounterVsUuid -->x on the 10k-dispatch
hot path.[^uid-bench] The gap between about 8x per call and <!-- vc:benchUidCounterVsUuid -->2.89<!-- /vc:benchUidCounterVsUuid -->x per dispatch is the
rest of the dispatch diluting it. So never quote a per-call absolute as if it were an end-to-end
win.

If you need cryptographically unique IDs (distributed tracing, cross-process auditing), opt in
with `configureUid(fn)` under "Tuning knobs" below.

[^uid-measured]: Re-measured on Node 24, 2026-08-17: `hrtime` medians over 21 x 200k reps.

[^uid-bench]: The median of the latest `npm run bench:bands`, from the `meta overhead - uid generator comparison` bench in `tests/perf.bench.ts`.

### Wildcard pattern prefix cache

`matchesPattern('foo*', 'fooBar')` caches the prefix (`'foo'`) per pattern, in a 256-entry
cache, so no match calls `String.prototype.slice()`. When the cache is full, the oldest pattern
leaves first (first in, first out). A hit does not refresh it.

### Tree-shake-friendly imports

The signal API lives in a side-effect-free `src/signal.ts` module. Importing `httpTransport` or
`createFormBus` does not pull in the Vue feature-detection registry from `chamber.ts`. A typical
Blade-style consumer bundle (`createAsyncCommandBus` + `httpTransport` + `logger`):

| | Bundle |
|--|--|
| Brotli | **<!-- vc:sizeConsumer -->13.3<!-- /vc:sizeConsumer --> KB** |
| Vapor probing references | 0 |

That number is measured, not retyped.

- `scripts/measure-size.mjs` builds this exact consumer entry from `dist/` and publishes it as a
  row in [BUNDLE-SIZES.md](./BUNDLE-SIZES.md).
- `npm run docs:stamp` republishes it here, and `lint:check` fails on a stale one, since a
  hand-copied measurement drifts.
- `tests/esm-treeshake.test.ts` builds the same consumer entry and checks that the Vapor
  registry drops out. It gates its size against a ceiling measured on a Vite production build
  (`NODE_ENV` defined, as a consumer ships it). The row above is that same Vite build of the same
  entry, so the two numbers agree. The test logs every move with what bought the bytes.

Composables (`useCommand` and the rest) land in your bundle only if you import them.

---

## Tuning knobs (consumer-facing)

### A store's `persist`: one save per microtask

A store with `persist` saves after its writes, once per microtask. A burst of writes in one task
does one `JSON.stringify()` and one `setItem()`, with the last state.

```ts
const useCart = defineChamberStore('cart', {
  state, reducers,
  persist: saveTo({ key: 'vc:cart' }),
});
```

Storage holds a write one microtask after it. A microtask runs before the next task, so a page
unload cannot fall between a write and its save.[^microtask] A storage read inside the same task
sees the state before the burst. The store has no per-write mode.[^persist-plugin]

[^microtask]: HTML Standard, perform a microtask checkpoint: https://html.spec.whatwg.org/multipage/webappapis.html#perform-a-microtask-checkpoint

[^persist-plugin]: The `persist()` plugin saved on every dispatch by default, and coalesced only when asked. In v1.31, `coalesce: true` measured 18.27x the default on 100 dispatches over a 50-item state.

### `configureUid(fn)`: swap the unique-ID generator

Default: a counter plus a per-process random prefix. Fast, and unique in the process.

Opt in to `crypto.randomUUID()` if you ship command IDs to a distributed tracing backend, or use
them as cross-process correlation keys:

```ts
import { configureUid } from 'vapor-chamber';
configureUid(() => crypto.randomUUID());
```

Call it once at app setup, before any dispatch. It affects every dispatch after it.

### `meta.ts` is cached per microtask turn (default behaviour, no option)

`stampMeta` reads the clock **once per microtask turn**, and every command dispatched inside that
turn shares the value. The first command of each turn carries an exact stamp, and the second to
the last of the same synchronous run repeat it. `Date.now()` has millisecond resolution and a
typical burst is under a millisecond, so those commands would almost always have received the
same number anyway.

There is **no runtime option** for this. An option earns its place only when both settings are
right for different people, and this one is right for nearly everyone. The rare consumer who
needs an exact per-command wall clock has an escape that costs nobody else a byte:

```ts
// 1. stamp your own, in a plugin's started part - works with the published package
bus.use({ started: (cmd) => { if (cmd.meta) cmd.meta.exactTs = Date.now(); } });
```

An exact clock would *not* buy **ordering**. Two commands dispatched in the same millisecond
share a `Date.now()` value whether the clock is cached or not. Order comes from `meta.id`, whose
default generator is a monotonic counter.

The cache saves a fixed amount per command, so its share shrinks as the dispatch does more, and
it vanishes once listener fan-out dominates.[^clock-saving] `tests/clock-source-ab.test.ts`
measures it on the real dispatch path, with `emit` as the control, and prints its table.

**The trade.** The wall-clock field goes coarse by up to the burst's duration, so a
thousand-command burst reads as instantaneous. Commands after the first in a turn also stop
tracking `vi.setSystemTime`.

`meta.ts` (the `ts` field of a command's meta, read in `src/command-bus.ts`) was never a duration
instrument. `Date.now()` has millisecond resolution and is **not monotonic**, so an NTP
correction or a clock change can move it backwards. For real timing, read `performance.now()` in
a plugin. On a hot loop, use `createFastLane()`, which stamps no meta at all.

**Nothing internal is affected.** No code in this library reads `meta.ts`. Every TTL or expiry
decision calls `Date.now()` directly: `cache`, `idempotent`, `circuitBreaker`, `rateLimit`,
`pace`, transport queues, the CSRF cache. `tests/clock-source-contained.test.ts` pins it for
`cache` and `idempotent`: it drives a frozen clock and asserts both still expire on real time.

The numbers are host-specific: the gain *is* the price of `Date.now()` on your platform. The
test is self-contained and prints its table, so re-run it there.

[^clock-saving]: Roughly 15-25 ns per command when it landed (v1.6.0, macOS, Node 24).

### `commandState(bus)`: one set of signals shared across many components

A component needs to know "is THIS in flight?" or "is *anything* in flight?". Neither is the
component's own fact: a command's busy state is the bus's. So no composable keeps a count of its
own, and 50 components on a page cost one state, plus one signal per key a reader asks about.

`commandState(bus)` returns the **same** signal instances to every caller on the same bus, with
or without Vue. `useSharedCommandState()` is the same handle, released with the component's
scope. The state is per bus (several buses, several shared states) and ref-counted (dropped when
the last handle disposes). It keeps a ring-buffered errors list capped at `maxSize` (default 10).

```ts
import { useSharedCommandState } from 'vapor-chamber/vue';

// In any number of components - all see the same anyPending / errors / lastError.
const { pending, anyPending, lastError, errors, clear } = useSharedCommandState();

// Bind to button disabled across the whole UI:
//   <button :disabled="anyPending">Save</button>
//
// Show a top-of-page error toast:
//   <Toast v-if="lastError">{{ lastError.message }}</Toast>
```

Behaviour:

- **It is the bus's internal facts observer**, never one of the app's hooks or listeners. The bus
  tells it `started` before the rules, and `settled` after its after-hooks and before its
  listeners. So a listener reads its command as settled, a sealed bus stays sealed, and
  `inspectBus` counts no hook or listener for it (`tests/command-state-lane.test.ts`). It catches
  its own writes: a subscriber's throw is logged and the dispatch runs.[^facts-lane]
- **`anyPending`** is any command in flight on the bus, from any caller.
- **`errors`** is a ring buffer, newest last. Older entries drop when its length exceeds
  `maxSize`. A failed query lands here too.
- **`lastError`** is the most recent error.
- **`clear()`** wipes `errors` and `lastError`. Pending keys are untouched.
- **`pending(action, target?)`** is per key and bus-wide: true while any dispatch of that
  `commandKey(action, target)` is in flight, from any caller.
  - Each key is its own signal, written only when its count crosses 0 <-> 1. So
    `pending('svcRestart', 'nginx')` does not re-run when `httpd` restarts.
  - `pending(action)` is the exact key `(action, undefined)`, not "any target".
  - Counting starts at the first `pending()` call or `anyPending` read, so a bus nobody asks
    per-key questions of pays nothing. It stops when the last handle leaves with nothing in
    flight, and the bus is bare again.
  - Every start settles. A plugin that throws or rejects becomes a `plugin:failed:plugin` result,
    and `onMissing: 'throw'` is settled before it is re-thrown.[^settles]
  - When the last handle leaves while a key is in flight, the state outlives it until that
    command settles. So the next holder (the page a route change mounts) reads the key
    lit.[^handover]
- **`subscribe(fn)`** runs after a fact moved a value the state holds, for a page whose signals
  are plain values.
- **Automatic cleanup** (`useSharedCommandState`) through `tryAutoCleanup`: Vue scope or
  component disposal calls `dispose()`.

[^facts-lane]: A fast lane in its place cost a tracked dispatch +16.8 ns (log 36.84).

[^settles]: Pinned by `tests/command-loading-fixture.test.ts`. Those are the two exits that once left a key true.

[^handover]: `tests/shared-state-handover.test.ts`.

When to use which:

- **`useSharedCommandState`** when many components need only aggregate state ("any loading?",
  "any errors?"): toolbars, status bars, global spinners, error toast lists.
- **`useCommand().pending(action, target)`** for a button's own busy state: the key it
  dispatches, so two buttons on one composable go busy apart. A dispatch's own failure is its
  result.

Both can coexist on the same bus.

### `dispatch(..., { signal })`: cancelable async dispatch

Pass an `AbortSignal` as the fourth argument to cancel an in-flight async dispatch:

```ts
import { createAsyncCommandBus } from 'vapor-chamber';

const bus = createAsyncCommandBus();
bus.register('searchProducts', async (cmd) => {
  // Handler can observe cmd.signal mid-flight
  return await fetch('/api/search?q=' + cmd.target, { signal: cmd.signal });
});

const ac = new AbortController();
const result = bus.dispatch('searchProducts', 'denim', undefined, { signal: ac.signal });

// Later - user types a new query, abort the in-flight search
ac.abort();
```

Behaviour:

- **A pre-aborted signal** resolves at once with `{ ok: false, error }`, and the handler is
  **not** called. The error is the explicit reason (`ac.abort(myError)`) if given, otherwise a
  `BusError` with `code === 'core:aborted:dispatch'`.
- **A mid-flight abort:** the handler observes `cmd.signal.aborted === true`. The handler stops
  its own work, because the bus does not terminate it. A handler or plugin that rethrows the
  signal's reason (`cmd.signal.throwIfAborted()`, a `fetch` with `cmd.signal`) gets the same
  error as a pre-aborted signal: an `Error` reason as itself, otherwise `core:aborted:dispatch`.
- **One shape for every abort the bus builds:** a `BusError` named `AbortError`, with the
  signal's reason as `cause`.
  - An `Error` reason is not wrapped: it comes back as itself, and `failureCondition(e, signal)`
    reads it as `aborted`, as the retry and `circuitBreaker` do.
  - For the bus's own shape, `e.name === 'AbortError'`, `e instanceof BusError` and
    `failureCondition(e) === 'aborted'` all read it.
  - The client's `transport:aborted:request` and the router's `router:aborted:navigation` have
    the same name.
- **The HTTP transport** forwards `cmd.signal` to `fetch`. There is no need to thread the signal
  through `httpTransport` options at construction.
- **After-hooks fire** for aborted dispatches, so loggers and metrics see the cancellation.
- **The sync bus** accepts `{ signal }` for type uniformity but ignores it at runtime, because
  sync dispatches are atomic.

**Also cancelable:**

- `bus.request()` accepts `{ signal, timeout }` on both buses. On the sync bus the command
  carries no `signal`, so the signal settles the request and the responder is not told.
- `bus.dispatchBatch()` accepts `{ signal }`. With `transactional: true`, it rolls back the
  commands that already succeeded on a mid-batch abort.
- The **WebSocket transport** honours `cmd.signal` per dispatch.
- The **SSE bridge** is receive-only by design, so `cmd.signal` does not apply at the bridge
  level. Call `sse.dispose()` to stop a subscription.

The one thing that stays manual is **child signals**: a nested dispatch does not inherit its
parent's signal. Thread it explicitly:[^thread-signal]

```ts
bus.register('parent', async (cmd) =>
  await bus.dispatch('child', target, payload, { signal: cmd.signal }));
```

Automatic derivation would need `AsyncLocalStorage` (Node-only) or a module-level dispatch stack,
which races in browsers under concurrent dispatches. So it stays explicit.

[^thread-signal]: Threading the signal by hand has worked since v1.2.0.

### `vapor-chamber/alien-signals`: push-pull reactivity for non-Vue consumers

Vue 3.6's `ref()` is itself a port of [alien-signals](https://github.com/stackblitz/alien-signals)
([vuejs/core#12349](https://github.com/vuejs/core/pull/12349)). So when vapor-chamber wires Vue's
`shallowRef()`, it already runs alien-signals' algorithm.

For **non-Vue contexts** (SSR and Node services, Web Workers, embedded widgets, anywhere you want
push-pull reactivity without Vue's full runtime), the `vapor-chamber/alien-signals` connector
swaps vapor-chamber's signal factory in one call:

```ts
import { signal as alienSignal } from 'alien-signals';
import { configureAlienSignals } from 'vapor-chamber/alien-signals';

configureAlienSignals(alienSignal);

// From here on, every vapor-chamber signal() - including useCommand,
// useSharedCommandState, FormBus signals - is backed by alien-signals'
// push-pull propagation algorithm. computed() / effect() from alien-signals
// observe the same underlying instances.
```

In a Vue app, keep the auto-detected `shallowRef()`: Vue's reactivity already runs alien-signals'
algorithm. For push-pull reactivity *without* Vue, `configureAlienSignals` is the right choice.
The plain `{ value }` fallback is not reactive.

**How it is wired:** the connector takes alien-signals' `signal` function as an argument, so
vapor-chamber never imports it. `alien-signals` is an optional peer, bundled only if you install
and import it yourself (about 7.5 KB raw, 2.5 KB brotli). Seven tests in
[tests/alien-signals.test.ts](../tests/alien-signals.test.ts) check the adapter against the real
published package, not a stub.

### A store's `coalesce: true`: correctness, not speed

A store with `coalesce: true` collapses a burst of dispatches into a single state write, at most
one write per microtask burst. Its throughput is **indistinguishable** from the
default.[^coalesce-bench]

Use `coalesce: true` when correctness matters, for example a `v-for` that should never see a
partly updated list mid-burst. Do not reach for it as a performance knob: the measurements show
no gain.

[^coalesce-bench]: Bench result (v1.4.0, beta.13, on `useCommandState`, the composable the option came from): 1,902 ops/sec against 1,897 ops/sec across two runs.

### `configureSignal(fn)`: bring your own signal

The library wires Vue's `shallowRef()` (not `ref()`) for reactivity: at build time when you
import from `vapor-chamber/vue`, otherwise through the runtime probe. For a custom signal library,
or to wire alien-signals directly:

```ts
import { configureSignal } from 'vapor-chamber';
import { signal as alienSignal } from 'alien-signals';
configureSignal((initial) => {
  const s = alienSignal(initial);
  return { get value() { return s(); }, set value(v) { s(v); } };
});
```

It is useful for SSR and non-Vue environments where you still want reactive bus state.

---

## Choosing an IIFE variant

For `<script>`-tag deployments the library ships three sized bundles. Pick by audience, not by
feature checklist.

| Variant     | Audience                                                      | Brotli |
|-------------|---------------------------------------------------------------|--------|
| `core`      | Sprinkled JS on server-rendered pages (Blade / Rails / Django)| <!-- vc:sizeIifeCore -->21.6<!-- /vc:sizeIifeCore --> KB |
| `elements`  | Embeddable widgets through custom elements                    | <!-- vc:sizeIifeElements -->22.4<!-- /vc:sizeIifeElements --> KB |
| `full`      | SPAs that grew big enough to want everything                  | <!-- vc:sizeIifeFull -->29.7<!-- /vc:sizeIifeFull --> KB |

_(Always-current measured sizes for every export: [BUNDLE-SIZES.md](./BUNDLE-SIZES.md), generated by `npm run size:doc` and CI-verified fresh.)_

**Decision tree:**

```
Does your page use WebSocket/SSE, persistence, or undo/redo?
|- Yes -> full (elements and core carry none of them)
`- No  -> Does your page register custom elements via defineWidget()?
         |- Yes -> elements
         `- No  -> core
```

Most server-rendered apps land on **core**, and most third-party widget distributions on
**elements**. Most SPAs that ship a `<script>` build land on **full**, and should probably use ESM
through a bundler instead.

Variant contents are not stable across minor versions before v2.0 (see
[ROADMAP.md](../ROADMAP.md)). ESM consumers always get the full surface and strict semver.

---
## Two doorways: general bus vs fast lane

vapor-chamber ships **two dispatch paths** for different audiences. Pick by what your hot path
is.

| Path                                  | When to use                                                 | Trades                                                                  |
|---------------------------------------|-------------------------------------------------------------|-------------------------------------------------------------------------|
| `createCommandBus()` (general)        | App-level commands: cart, form, navigation, analytics       | Pays per call for envelope + result + the parts placed on the action. Gives you results, plugins, hooks, listeners, schema, batch, request/response, AbortController |
| `createFastLane()` (the real hot path) | Game tick, trading data, audio buffer, scroll/mousemove, physics step | Strips everything but the function call. No envelope, no result, no plugins, no hooks, no abort. Just `(data) => handler(data)` |

The fast lane lives at `vapor-chamber/fast-lane`:

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
const onPriceTick = lane.compile('priceTick', (tick) => updateChart(tick));
onPriceTick(tick);   // pure function call, no allocations on hot path
```

**Measured cost per call** (10k calls, single handler):

| Path                                   | Time per call | Calls in one 60 fps frame |
|----------------------------------------|---------------|---------------------------|
| **vapor-chamber `fast-lane`**          | <!-- vc:benchCompileNs -->6.2<!-- /vc:benchCompileNs --> ns | about <!-- vc:benchCompilePerFrame -->2,700,000<!-- /vc:benchCompilePerFrame --> |
| mitt emit                              | <!-- vc:benchMittNs -->46.8<!-- /vc:benchMittNs --> ns | about <!-- vc:benchMittPerFrame -->360,000<!-- /vc:benchMittPerFrame --> |
| vapor-chamber `bus.dispatch` (general) | <!-- vc:benchDispatchNs -->83.9<!-- /vc:benchDispatchNs --> ns | about <!-- vc:benchDispatchPerFrame -->200,000<!-- /vc:benchDispatchPerFrame --> |

Stamped from the latest `npm run bench:bands` (`scripts/bench-bands.mjs`), the median over its
runs, on <!-- vc:benchProvenance -->Intel Core i7-8650U, Linux, Node 24.22.1, vitest 5.0.5, Vue 3.6.0-rc.13, mitt 3.0.1, eventemitter3 5.0.4, 5 runs<!-- /vc:benchProvenance -->. The
times belong to that machine, so read them as an order of magnitude. A ratio between two of this
library's rows moved 2-9% between the two machines measured, and one against another library is
a band for one host (docs/V8-RULES.md rule 15).[^direct-call]

[^direct-call]: This table once gave each row as a multiple of a direct function call. That multiple doubled between two machines (the fast lane 13.96x on an Apple M3, 30.63x on an Intel i7-8650U), because V8 reduces the bare call to almost nothing. So it was retired (docs/decisions.md, 2026-10-13).

The fast lane runs **<!-- vc:benchCompileVsDispatch -->14.44<!-- /vc:benchCompileVsDispatch -->x the ops/sec of `bus.dispatch`** and
**<!-- vc:benchCompileVsMitt -->7.37-8.24<!-- /vc:benchCompileVsMitt -->x that of mitt's emit** on single-handler dispatch. What it costs over
a direct function call is one Map lookup and one closure call. The closure is what supports
`remove()` and `clear()`.

**Multi-listener fan-out (3 listeners).** The latest `npm run bench:bands` reads the default
`'live'` fast lane at
**<!-- vc:benchFastLaneVsMitt -->2.13-2.52<!-- /vc:benchFastLaneVsMitt -->x mitt** and
**<!-- vc:benchFastLaneVsEventEmitter3 -->1.01-1.16<!-- /vc:benchFastLaneVsEventEmitter3 -->x eventemitter3**
(level with it where the range spans 1).

- `'live'`, the default, matches the main bus: an emit calls the listeners that existed when it
  started, and skips any removed during it. Any added during it wait for the next emit. A
  listener removed mid-emit, by itself or a peer, never skips or double-invokes a neighbour. Each
  listener carries an `off` mark.[^live-guard]
- `createFastLane({ removal: 'snapshot' })` opts into copy-on-write unsubscription instead. The
  emit loop returns to one call per slot, and a listener removed mid-emit still runs once in that
  emit. It skips the guard the default pays for its correctness. Pick it only for a measured
  fan-out bottleneck.
- Each mode's contract is pinned by its own test in `tests/fast-lane.test.ts`. Neither touches
  single-handler `compile()` dispatch, and both share a single-listener fast path on `emit`.

[^live-guard]: In v1.12.0 the emit loop gained the unsub-during-emit identity guard, at about 10-15% of this row's throughput against the pre-guard loop. v1.26.0 (log section 35.67) corrected the guard: it corrected the cursor by length, and still skipped or re-ran a listener when one removed peers on both sides of itself. On a three-listener emit, the `off` mark measured 0.964x the old guard's time.

`createFastLane({ onError })` calls each listener in a `try`. A throw goes to
`onError(error, action)` and the emit goes on, the rule a bus listener follows. The emit is
chosen at creation, so a lane without `onError` carries no `try`. A store's field events ride
such a lane (`tests/store-one-watcher.test.ts`).

### When to pick which

```
Are you in a per-frame / per-tick / per-sample hot loop?
|-- Yes -> fast-lane. Use compile(action, handler) + dispatcher(data).
|          Or on(action, fn) + emit(action, data) for fan-out.
`-- No  -> general bus. createCommandBus() with the rich API.
```

If the answer is "I don't know", use the general bus. The fast lane is for workloads where you
have already identified the bus as a measurable bottleneck.

---

## Comparative benchmarks vs other small libs

10k iterations per bench.

A micro-loop that emits one constant event name over and over measures how well V8 specializes
that one name, not what an app pays. An emitter keyed by a plain object reads ahead there and
falls behind once the names vary (log s35.57).

The rows below compare against mitt and eventemitter3, the peers with a migration guide here.
Each ratio against them is the range over the latest `npm run bench:bands`
(<!-- vc:benchProvenance -->Intel Core i7-8650U, Linux, Node 24.22.1, vitest 5.0.5, Vue 3.6.0-rc.13, mitt 3.0.1, eventemitter3 5.0.4, 5 runs<!-- /vc:benchProvenance -->). That range is a fact about that host
(docs/V8-RULES.md rule 15). The numbers this library stands on are its own paths, measured
against each other.

### Emit with NO listeners (the "I emit, nobody cares" case)

This is the most common emit shape in real apps: many lifecycle, debug and conditional events
have no subscribers. It should be effectively free.

vapor-chamber's no-listener fast path runs **<!-- vc:benchEmitNoListenersVsMitt -->2.12-2.24<!-- /vc:benchEmitNoListenersVsMitt -->x the ops/sec of mitt** (the range
over the latest `npm run bench:bands`). The cost is a `Map.has()` and an `Array.length === 0`
check, whatever the name, including names on `Object.prototype` such as
`constructor`.[^no-listener]

[^no-listener]: Per emit, with pre-built buses and a sink, it costs 3.2 ns for one repeated event name and 3.8 ns over four varying names. It was the same in v1.25.0 (log s35.57).

### Emit fan-out (3 listeners)

vapor-chamber `emit` runs **<!-- vc:benchEmitVsMittFanout -->1.57-1.94<!-- /vc:benchEmitVsMittFanout -->x mitt** and
**<!-- vc:benchEmitVsEventEmitter3Fanout -->0.62-0.99<!-- /vc:benchEmitVsEventEmitter3Fanout -->x eventemitter3** (the range over the latest `npm run bench:bands`):
ahead of mitt, behind eventemitter3. Where fan-out speed against eventemitter3 matters, the fast
lane is level with it (above).[^notify-guard]

[^notify-guard]: In v1.12.0 `notifyListeners`' unsub-during-emit guard was corrected to compare by identity. The old length-only heuristic could re-invoke a listener that removed a *later* peer. Its cost on this row was within run-to-run variance.

### Dispatch with single handler (10k)

`dispatch` is a different shape than `emit`. mitt's `emit` calls the subscribed functions and
returns nothing. `bus.dispatch` does more, all of it the bus pattern's semantics, none of it
free:

- it reads the action's record (its handler, rules and steps).
- it allocates the meta object (`{ ts, id, correlationId, causationId, origin, idempotencyKey, response, request }`)
  and the result object (`{ ok, value, error }`).
- it tracks dispatch depth.

Real peers are Pinia's action dispatch, Redux's dispatch, or any middleware-chained bus. mitt's
emit runs **<!-- vc:benchMittEmitVsDispatch -->1.81-2.47<!-- /vc:benchMittEmitVsDispatch -->x** the ops/sec of `bus.dispatch` (the range over the
latest `npm run bench:bands`).

### What this means

- **For pub/sub event emit and listen:** vapor-chamber `emit` is faster than mitt, and behind
  eventemitter3 on fan-out. It costs a few ns per emit with no listeners, whatever the event
  name, so use it freely. For a fan-out hot loop, the fast lane is level with eventemitter3.
- **For commands with results, plugins, hooks, batch or request/response:** that is the bus
  pattern, and `dispatch` does meaningfully more per call than `emit`. "Measuring your own usage"
  below shows how to time the bus in your own app, which tells you whether that cost matters.

The comparative benches live in [`tests/perf.bench.ts`](../tests/perf.bench.ts) under
`describe('emit fast path - no listeners')`, `describe('comparative emit fan-out')`,
`describe('comparative dispatch')` and the two fast lane groups. Reproduce the stamped ratios
with `npm run bench:bands` (several runs), or one run with
`npx vitest bench --run tests/perf.bench.ts`.

### How the emit fast path works

The `emit` fast path makes three changes:[^v12]

1. **No-listener short-circuit**: `if (!s.exactListeners.has(event) && s.wildcardListeners.length === 0) return;` before any allocation.
2. **Singleton `EMIT_RESULT`**: `Object.freeze({ ok: true, value: undefined, error: undefined })`, reused by every emit. `okResult(undefined)` would allocate a fresh object each time.
3. **No `stampMeta` on emit**: `Command.meta` is left undefined for emit-fired commands. Emit is fire-and-forget, and typical listeners do not use correlation IDs or timestamps. The `Command` type already has `meta?` as optional. Listeners that need meta on a fire-and-forget event should use `dispatch` instead.

[^v12]: Added in v1.2.x. Similar tricks ship in [splice](https://github.com/lucianofedericopereira/splice): frame pooling, a no-listener fast path, minimal envelopes. vapor-chamber did not adopt the full splice architecture (numeric action IDs, binary headers, frozen action tables), because that would mean a v2 rewrite. The targeted fast paths capture most of the win without breaking the existing API.

## Reactive runtime notes (Vue 3.6)

The guards that catch a regression are same-process: `tests/signal-shallow-ab.test.ts`,
`tests/clock-source-ab.test.ts`, and the wildcard and router-stamp A/Bs. Their equivalence checks
run in every suite, and their timing tables print on `npm run test:timing` (log s35.55).

**One cross-version guard is NOT in that list.** `tests/vue-version-ab.test.ts` (driven by
`npm run ab:vue`) compares two Vue dists in one process. It reports shallowRef writes and
effectScope only, and runs a self-comparison control. Two workloads that built a persistent
dependency graph (watcher notify, computed read-after-write) were removed, because it could not
resolve a version difference on them at all.[^rc7-harness]

[^rc7-harness]: Found in the rc.7 cycle. Two byte-identical copies of the SAME dist differed by up to 1.425x through it, in opposite directions per workload, because each module instance carries its own reactivity state. The two removed workloads' control spread was 68% and 35%.

### `signal()` wires `shallowRef`, not `ref`

The alien-signals rewrite changed dependency *tracking*. But `ref(anObjectOrArray)` still wraps
the value in a deep reactive Proxy through `toReactive()`. The library replaces signal values
whole and never mutates nested fields. So `shallowRef` means the same for every internal signal,
and it skips that proxy cost.

`tests/signal-shallow-ab.test.ts` measures it as an **interleaved same-process A/B** on the real
dispatch path: a handler writing a `signal()`, the median of 5 interleaved reps,
`process.hrtime`.[^bench-floor] The same-process test swings up to 2x between runs, so it is a
lead. Its table prints on `npm run test:timing`.

[^bench-floor]: The coarse vitest-bench harness cannot resolve this: its per-iteration setup floor compresses the array and scalar cases to one rate.

The figure comes from `npm run ab` (docs/V8-RULES.md rule 16), workload
`scripts/ab/workloads/signal-backend.mjs`. Arm A is the shipped build, and arm B the same source
built with `signal()` wired to `ref`. A state that appends to an array, rebuilt every 100
dispatches, cost 1.94-1.98 us per dispatch on `shallowRef` and 5.72-6.34 us on `ref`:
2.95-3.13x, counted at both call lengths.[^signal-ab]

[^signal-ab]: Measured 2026-10-13 on an Intel Core i7-8650U, Linux, Node 24.21.0, Vue 3.6.0-rc.11, 10 processes. With 10 appends per state (3.8-4.2x) and on a number (1.42-1.44x), `ref` read slower too, but both rows failed the tool's interference gates, so they are leads, not results. The control, a dispatch with no state, read 1.001 and 0.997.

The test asserts no timing *threshold*. Ratios are unstable under parallel load and coverage
instrumentation, and the test compares Vue's `ref` and `shallowRef` directly, so it could not
catch a library regression anyway. The regression guard is `chamber.test.ts` > "signal() factory
- shallow reactivity", which asserts `signal()` stays a `shallowRef`.

There is no isolated `ref`-against-`shallowRef` micro-bench in `perf.bench.ts`, because pure
deterministic signal loops are constant-foldable. V8 removes the shallowRef path as dead code,
since it has no observable effect, while keeping `ref`'s Proxy-trap side effects. The ratios
that yields are garbage. The real dispatch path defeats constant-folding, since the command bus
is opaque indirection.

If you need deep reactivity (nested-mutation tracking for a `v-model`-bound state object), opt
back in per state: a store's `deep: true`, or `deepSignal` from `vapor-chamber/reactive`. It pays
the `ref` cost only where you ask for it, and every other signal stays on the fast shallow path.

---

## Reading an A/B: what a change can and cannot move

Three things settle how to read a process-replicated A/B.[^ab-history]

[^ab-history]: The perf-1.26 audit (log s35.44) first measured each change as two production bundles of the built `dist/` in one process, with interleaved rounds, a same-bundle control and both load orders. After an outside review it measured again with the process as the unit of replication ([V8-RULES.md](./V8-RULES.md) rules 16 to 18): 10 processes per comparison, a timing loop per arm, a fixed young generation, 20th-percentile summaries and a per-function control gate. The figures below were measured once more with the committed tool, `npm run ab`, at two call lengths (log s35.53).

**A change moves only the paths that run it.** V8 optimizes each copy of a function on its own.
An edit in one function reaches others in three ways:

- It changes when its call chain tiers up. The interrupt budget counts executed bytecode.
- It changes which callees still fit the inlining budget, counted in bytecode bytes.
- It changes the type feedback that shared callees collect during warm-up, Vue's internals
  included.

Allocation changes move the GC schedule too. Machine-code placement matters less than in an
ahead-of-time compiler, since V8 lays code out in compilation order. So a loop the change never
executes can read a few percent faster or slower, and the control cannot show it, because it
compares a bundle with a byte-identical copy of itself. Which of these moved a given loop is a
hypothesis until `--trace-opt` and `--trace-turbo-inlining` show it.[^warnunwired]

So diff the two arms first, and attribute a movement only to a path that executes the changed
code. A real cost shows on every workload that runs the code, in the same direction.

[^warnunwired]: Measured on this library. The change that brought composable creation back to v1.25.0's speed touched only `warnUnwired`, which runs at creation. On the same run, a dispatch loop that never calls it read 0.93-0.98x on one workload and 1.05x on another, in one process per comparison. The same untouched code moved in opposite directions, the signature of a layout and JIT-state artifact, not a cost. Replicated over 10 processes, that path read 1.000.

**An isolated win is a lead, not a verdict.** A workload with one call site and one shape keeps
that site monomorphic, and an application does not. Every candidate is confirmed on a mixed
workload, then on `npm run bench` against the previous version, before it lands.[^filter-loop]
The comments on `stampMeta` and `handleMissing` in `src/command-bus.ts` record the same lesson
from earlier changes.

[^filter-loop]: The scoped plugin's action filter, a loop instead of a per-call arrow, read no effect with one one-pattern plugin. It read 0.979-0.986x (4.6-6.6 ns per dispatch) on a chain of four different scoped plugins with mixed pattern lists and a listener.

**One process is one draw.** Both arms in a process share its heap, GC schedule and tier-up
timeline. More rounds do not average those away, but more processes do.[^withdrawn]

[^withdrawn]: The single-process harness had reported the composable dispatch change at 0.87-0.90x, on a workload interleaving both composables over Vue's reactive graph. Across processes, that workload's own A/A control spread up to 1.36x, so it measures nothing, and the figure is withdrawn. The change stands at 0.915-0.934x (2.7-3.9 ns) on the workload whose control holds within 1%.

---

## Measuring your own usage

To find out whether vapor-chamber is a bottleneck in your app:

1. **Hot-path dispatch cost.** Time your highest-frequency dispatch sites with
   `performance.now()` over a sample window, in a DevTools profile or around the call. If the
   bus's own share is small next to the handlers', look at the work the handlers do.
2. **HTTP envelope cost.** Profile the `JSON.stringify(envelope)` site only if your endpoint is
   hot. The library's envelope is already minimal.

For a full bench run against your own dispatch shapes, copy `tests/perf.bench.ts` into your
project and adapt the workloads.
