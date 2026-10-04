# Performance & Tuning

Practical reference for getting the most out of vapor-chamber. Most of what
this page describes is **already done by default**: the lib is V8-aligned
out of the box. The "Tuning knobs" section below trades defaults for higher
throughput on specific hot paths.

The rules below, condensed to one line each with where their evidence is, are
in [V8-RULES.md](./V8-RULES.md).

---

## Philosophy

The lib targets two different optimization regimes:

1. **Read-many hot paths** - places where the same object is touched by
   plugins, hooks, listeners, and consumer code on every dispatch. Examples:
   `result.ok`, `cmd.meta.id`, `cmd.action`. These rely on **monomorphic
   hidden classes** so V8's inline caches stay specialized. The lib enforces
   shape consistency on `Command`, `CommandResult`, `CommandMeta`, and the
   internal bus state.
2. **Algorithmic complexity** - places where the cost scales with usage
   pattern. Examples: listener fan-out (O(n) walk -> O(1) hash + O(w) wildcard
   walk), persist plugin saves (one per dispatch -> one per microtask).

What the lib does **not** chase:
- Loop-syntax micro-opts (cached `length`, index-vs-`for...of`). V8's
  TurboFan handles these. The few places where index loops are kept are
  documented; everywhere else, idiomatic code is fine.
- Property mangling, Closure ADVANCED, asm.js / Wasm. Friction far exceeds
  gain for a library at this size.
- Premature parallelism. Hooks run sequentially because order matters; opt-in
  parallel was considered and not built (see "What we measured but did not
  ship").

---

## What's optimized by default

You get all of this without changing any code; it is listed for diagnosis
only.

### Hot-path shape consistency

- `okResult` / `errResult` always allocate `{ ok, value, error }` with the
  unused slot set to `undefined`. One hidden class for both, monomorphic
  property access at every consumer site.
  Until the perf audit (s27) this held only for results the bus built itself:
  ~30 sites outside it - `validator`, `authGuard`, `debounce`, async
  `optimisticUndo`, every HTTP and WebSocket bridge result, the `runDispatch`
  and `useSharedCommandState` error paths - wrote their own `{ ok, error }`
  or `{ ok, value }` literal, a different map. They now call the same two
  factories, which also shrank every IIFE (the full IIFE by 32 B brotli).
  `tests/v8-shapes.test.ts` checks the map with V8's own `%HaveSameMap`, and
  fails on any new hand-built result literal in `src/`.
- `stampMeta` always allocates `{ ts, id, correlationId, causationId, origin,
  idempotencyKey }` with stable field order (`idempotencyKey` `undefined` until
  stamped, log s35.81). No late property additions, no shape transitions.
- `Command` literal always `{ action, target, payload, meta }` in the same
  order across `dispatch` / `query` / `emit` / `request` paths.
  Corrected by the perf audit (s27), measured with `%HaveSameMap`: that holds
  for `dispatch`, `query` and `request` on one bus type (pinned in
  `tests/v8-shapes.test.ts`: the sync `request`'s `signal` option must not
  reach the command). `emit` builds
  `{ action, target }` - deliberately, see its fast-path note below - and the
  async bus adds `signal`, so an async command is its own map. Padding emit to
  four fields was measured through the real bus and declined: a `'*'`
  listener reading both kinds gained nothing outside the harness's self-A/B
  band (0.967-1.012x), while the padded emit itself ran ~3% slower. Unifying sync and
  async would put a `signal` store on the sync hot path, the class of change
  `_syncDispatchInner` records as 25% worse.
- `AsyncState` and `SyncState` initialized via single object literals at bus
  construction - no incremental field writes that would create shape
  branches.

### Pre-composed plugin chain

`bus.use(plugin)` rebuilds a single composed `runner` function once per
plugin add/remove. Dispatch calls `runner(cmd, execute)` directly - no
per-dispatch chain walk. Each plugin level does allocate one `next` closure
per dispatch: the runners are re-entrant, so the bus's retry calling a
transport level once per attempt and deferred continuations (`debounce` calling it from a timer)
re-enter the chain at the right level. `buildRunner`'s PERF NOTE in
`src/command-bus.ts` records what that costs on "3 plugins + 1 listener" and
why correctness took it.

Each plugin call is also the boundary that turns a plugin's throw or rejected
promise into a `plugin:failed:plugin` result: an inline try in each runner, and on
the async runner a `.then` only when a plugin did not simply return its
`next()` value. On "3 plugins + 1 listener" that boundary sits inside the
self-control band (within noise) on both buses, measured by
`tests/plugin-throw-ab.test.ts` with three DISTINCT plugin functions per level
and per bus type: a real chain's shape. One function at every level keeps the
call site near-monomorphic and understates the cost.

### Listener bucketing

`bus.on('cartAdd', fn)` (exact match) goes into a `Map<action, Listener[]>`
for O(1) lookup at dispatch time. `bus.on('cart*', fn)` (wildcard) goes into
a separate array; each entry carries its prefix, computed once in `on()`, so
dispatch tests it with one `startsWith`, with no `matchesPattern` call on the
dispatch path.

Real-world impact (listener fan-out, 50 exact + 5 wildcards; the ops/sec are one earlier run on
one host, the ratio is the median of the latest `npm run bench:bands`):
- emit: ~750 ops/sec
- dispatch: ~600 ops/sec - emit runs <!-- vc:benchEmitVsDispatchFanout -->1.33<!-- /vc:benchEmitVsDispatchFanout -->x the dispatch rate (no plugin chain / `meta` stamp / depth tracking)

The bucketing gain scales with listener count: silent for <5 listeners,
larger beyond ~50.

### Counter-based `meta.id`

The default unique-ID generator is a per-process random prefix + monotonic
counter. **Re-measured on Node 24 (2026-08-17, `hrtime` medians over 21x200k
reps): ~12 ns per call vs ~104 ns for `crypto.randomUUID()` - ~8x.**

**Always quote the runtime with the number**: modern V8/Node batch UUID
entropy, so `randomUUID`'s cost moves between runtimes while the counter's
does not.

The **ratio at the dispatch level is bench-backed and unaffected**: <!-- vc:benchUidCounterVsUuid -->3.14<!-- /vc:benchUidCounterVsUuid -->x on the
10k-dispatch hot path (the median of the latest `npm run bench:bands`; one earlier run on one host read
counter ~1,850 vs `randomUUID` ~750 ops/sec), which is the
`meta overhead - uid generator comparison` bench in `tests/perf.bench.ts`. Note
the gap between ~8x per call and <!-- vc:benchUidCounterVsUuid -->3.14<!-- /vc:benchUidCounterVsUuid -->x per dispatch - the rest of the dispatch
dilutes it, which is why per-call absolutes should never be quoted as if they
were end-to-end wins.

If you need cryptographically unique IDs (distributed tracing, cross-process
auditing), opt in with `configureUid(fn)` under "Tuning knobs" below.

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
| Brotli | **<!-- vc:sizeConsumer -->7.6<!-- /vc:sizeConsumer --> KB** |
| Vapor probing references | 0 |

That number is measured, not retyped: `scripts/measure-size.mjs` builds this
exact consumer entry from `dist/` and publishes it as a row in
[BUNDLE-SIZES.md](./BUNDLE-SIZES.md), and `npm run docs:stamp` republishes it
here, with `lint:check` failing on a stale one. A hand-copied measurement drifts.
`tests/esm-treeshake.test.ts` builds the same consumer entry, checks that the
Vapor registry drops out, and gates its size against a ceiling measured on a
Vite production build (`NODE_ENV` defined, as a consumer ships it), and the
row above is that same Vite build of the same entry, so the two numbers agree.
The test logs every move with what bought the bytes.

Composables (`useCommand`, etc.) land in your bundle only if you import them.

---

## Tuning knobs (consumer-facing)

### `persist({ ..., coalesce: true })`: collapse rapid saves

By default, every successful dispatch with the persist plugin does one
`getState()` + `JSON.stringify()` + `setItem()` cycle. For workloads where
many rapid commands touch the same state (form input, scroll tracking,
batched cart updates), enable coalescing:

```ts
import { persist } from 'vapor-chamber';

bus.use(persist({
  key: 'vc:cart',
  getState: () => cart.value,
  coalesce: true,   // <- save once per microtask burst, not per dispatch
}));
```

Trade-off: 1 microtask of latency before the save lands. Storage reads
immediately after a burst of dispatches will see the pre-burst state until
the next tick.

Measured on 100 rapid dispatches x 50-item array state (the ops/sec are one earlier run on one
host; the ratio is the median of the latest `npm run bench:bands`):
- Default: ~4,100 ops/sec
- `coalesce: true`: ~97,000 ops/sec (**<!-- vc:benchPersistCoalesce -->17.89<!-- /vc:benchPersistCoalesce -->x**)

Use when you're measurably bottlenecked on persist; leave default otherwise
to keep storage in lockstep with bus state.

### `configureUid(fn)`: swap the unique-ID generator

Default: counter + per-process random prefix. Fast, in-process unique.

Opt in to `crypto.randomUUID()` if you ship command IDs to a distributed
tracing backend or use them as cross-process correlation keys:

```ts
import { configureUid } from 'vapor-chamber';
configureUid(() => crypto.randomUUID());
```

Call once at app setup, before any dispatches; it affects every dispatch
after it.

### `meta.ts` is cached per microtask turn (default behaviour, no option)

`stampMeta` reads the clock **once per microtask turn** and every command
dispatched inside that turn shares the value. The first command of each turn
carries an exact stamp; the 2nd..nth of the same synchronous run repeat it.
`Date.now()` is millisecond-resolution and a typical burst is sub-millisecond,
so those commands would almost always have received the same number anyway.

There is deliberately **no runtime option** for this - an option only earns its
place when both settings are right for different people, and this one is right
for essentially everyone. The rare consumer who needs exact per-command wall
clock has two escapes, neither of which costs anyone else a byte:

```ts
// 1. stamp your own, in a plugin - works with the published package
bus.use((cmd, next) => { if (cmd.meta) cmd.meta.exactTs = Date.now(); return next(); },
        { priority: 100 });
```

Note what an exact clock would *not* buy: two commands dispatched in the same
millisecond share a `Date.now()` value whether the clock is cached or not, so it
never provides **ordering**. Order comes from `meta.id`, whose default generator
is a monotonic counter.

**Measured** (`tests/clock-source-ab.test.ts`, real dispatch path, interleaved
A/B, median of 5 reps, macOS / Node 24.19 where `Date.now()` is ~33 ns isolated):

| Path | cached vs default |
|---|---|
| `bus.dispatch` / `bus.query` - bare bus | 1.42-1.67x |
| `dispatchBatch` | 1.42-1.57x |
| dispatch with an ordinary handler | 1.38-1.50x |
| dispatch - 3 plugins + 1 listener | 1.18-1.24x |
| dispatch - 50 listeners + 5 wildcards | 1.04-1.07x - **no gain** |
| `emit` (control: never stamps) | 1.02-1.06x - the noise floor |

The cache saves roughly **15-25 ns per command**, a fixed amount, so its share
shrinks as the dispatch does more and vanishes once listener fan-out dominates.
The `emit` control row sets the noise floor, which is why the fan-out row reads
"no gain" rather than a small one.

Confirmed end to end on the bench: `bus.dispatch` moved from **197.7x** slower
than a direct function call to **140.0x**. `bus.emit` is unchanged, which is the
control - it never stamped meta.

Both figures are hand-written and frozen: one interleaved run, where the claim
is the DIRECTION of the change rather than either absolute. Do not read them
against the `vc:benchFloorVsDispatch` marker further down, which measures the
same two rows from a different run.

**The trade, stated plainly.** Every command in one synchronous burst shares a
`ts`. Ordering is unaffected - `meta.id` is monotonic and unique, and it is what
you should sequence by - but the wall-clock field goes coarse by up to the
burst's duration, so a thousand-command `rehydrate` reads as instantaneous.
Commands after the first in a turn also stop tracking `vi.setSystemTime`.

`meta.ts` was never a duration instrument: `Date.now()` is millisecond-resolution
and **not monotonic**, so an NTP correction or a clock change can move it
backwards. For real timing read `performance.now()` in a plugin; on a hot loop
use `createFastLane()`, which stamps no meta at all.

**Nothing internal is affected.** No code in this library reads `meta.ts`, and
every TTL/expiry decision (`cache`, `idempotent`, `circuitBreaker`, `rateLimit`,
`throttle`, transport queues, CSRF cache, outbox) calls `Date.now()` directly -
pinned by `tests/clock-source-contained.test.ts`, which drives a deliberately
frozen clock and asserts those still expire on real time.

Numbers are host-specific: the gain *is* the price of `Date.now()` on your
platform - the test is self-contained and prints its table, so re-run it there.

### `useSharedCommandState()`: one set of signals shared across many components

The default `useCommand()` composable allocates two reactive
signals (`loading`, `lastError`) **per call**. On a page with 50 components
each calling it, that's 100 signal nodes in the reactivity graph.
Most of those components only need to know "is *anything* in flight?" - they
don't need their own private loading state.

`useSharedCommandState()` returns the **same** signal instances to every
caller subscribed to the same bus. State is per-bus (multiple buses -> multiple
shared states), ref-counted (auto-dropped when the last subscriber disposes),
and exposes a ring-buffered errors list capped at `errorCap` (default 10).

```ts
import { useSharedCommandState } from 'vapor-chamber';

// In any number of components - all see the same isAnyLoading / errors / lastError.
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
- **`isLoading(action, target?)`** is per-key and bus-wide: true while any
  dispatch of that `commandKey(action, target)` is in flight, from any caller.
  Each key is its own signal, written only when its count crosses 0 <-> 1, so
  `isLoading('svcRestart', 'nginx')` does not re-run when `httpd` restarts.
  `isLoading(action)` is the exact key `(action, undefined)`, not "any target".
  Tracking starts at the first `isLoading()` call on the bus (a before-hook is
  installed then), so a bus nobody asks per-key questions of pays nothing.
  Every start settles, pinned by `tests/command-loading-fixture.test.ts`: a
  plugin that throws or rejects becomes a `plugin:failed:plugin` result, and
  `onMissing: 'throw'` is settled before it is re-thrown - the two exits that
  once left a key true. A sealed bus works too: the library installs its own
  hook past the seal and seals it again. When the last holder leaves while a
  key is in flight, the state outlives it until that command settles, so the
  next holder (the page a route change mounts) reads the key lit
  (`tests/shared-state-handover.test.ts`).
- **`{ signal }`** option forwards to the underlying bus dispatch (the v1.2.x
  AbortController integration), so cancellation works the same as
  `useCommand`.
- **Auto-cleanup** via `tryAutoCleanup` - Vue scope/component disposal calls
  `dispose()` automatically.

When to use:
- **Use `useSharedCommandState`** when many components only need aggregate
  state ("any loading?", "any errors?"). Toolbars, status bars, global
  spinners, error toast lists.
- **Use `useCommand`** when a component needs its own private loading/error
  scoped to its own button or form. Component-local UI state.

Both can coexist on the same bus.

### `dispatch(..., { signal })`: cancelable async dispatch

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

// Later - user types a new query, abort the in-flight search
ac.abort();
```

Behavior:
- **Pre-aborted signal** -> resolves immediately with `{ ok: false, error }`,
  handler is **not** called. The error is the explicit reason
  (`ac.abort(myError)`) if provided, otherwise a `BusError` with
  `code === 'core:aborted:dispatch'`.
- **Mid-flight abort** -> handler observes `cmd.signal.aborted === true`. The
  handler is responsible for stopping its own work - the bus does not
  forcibly terminate it.
- **HTTP bridge** auto-forwards `cmd.signal` to `fetch`. No need to thread
  the signal through `createHttpBridge` options at construction.
- **After-hooks fire** for aborted dispatches so loggers and metrics see the
  cancellation.
- **Sync bus** accepts `{ signal }` for type uniformity but ignores it at
  runtime - sync dispatches are atomic.

**Also cancelable**: `bus.request()` accepts `{ signal, timeout }` on both
buses (on the sync bus the command carries no `signal`, so the signal settles
the request and the responder is not told); `bus.dispatchBatch()`
accepts `{ signal }` and, with `transactional: true`, rolls back
already-succeeded commands on a mid-batch abort; the **WebSocket bridge**
honours `cmd.signal` per dispatch. The **SSE bridge** is receive-only by design,
so `cmd.signal` does not apply at the bridge level - call `sse.teardown()` to
stop a subscription.

The one item that remains manual is **auto-derived child signals**:
a nested dispatch does not inherit its parent's signal automatically. Thread it
explicitly, which has worked since v1.2.0:

```ts
bus.register('parent', async (cmd) =>
  await bus.dispatch('child', target, payload, { signal: cmd.signal }));
```

True auto-derivation would need `AsyncLocalStorage` (Node-only) or a
module-level dispatch stack (race-prone in browsers under concurrent
dispatches), which is why it stays explicit rather than magic.

### `vapor-chamber/alien-signals`: push-pull reactivity for non-Vue consumers

Vue 3.6's `ref()` is itself a port of [alien-signals](https://github.com/stackblitz/alien-signals)
([vuejs/core#12349](https://github.com/vuejs/core/pull/12349)) - so when
vapor-chamber wires Vue's `shallowRef()` you're already on alien-signals'
algorithm under the hood.

For **non-Vue contexts** - SSR/Node services, Web Workers, embedded
widgets, anywhere you want push-pull reactivity without Vue's full runtime -
the `vapor-chamber/alien-signals` connector flips vapor-chamber's
underlying signal factory in one call:

```ts
import { signal as alienSignal } from 'alien-signals';
import { configureAlienSignals } from 'vapor-chamber/alien-signals';

configureAlienSignals(alienSignal);

// From here on, every vapor-chamber signal() - including useCommand,
// useSharedCommandState, FormBus signals - is backed by alien-signals'
// push-pull propagation algorithm. computed() / effect() from alien-signals
// observe the same underlying instances.
```

**Performance note (v1.5.0 bench, beta.14):**

| Signal path (isolated scalar write loop) | ops/sec | Notes |
|---|---|---|
| Plain `{ value }` object (default fallback) | ~371,000 | Zero overhead, not reactive |
| **Vue `shallowRef()` via `signal()` auto-detected** | **~40,000-62,000** | The default since v1.5.0 - ~4-7x the old deep-`ref()` path |
| alien-signals via `configureAlienSignals` | ~10,400 | Opt-in reactive (non-Vue contexts) |
| Vue deep `ref()` (the old v1.4 `signal()` default) | ~9,000 | Replaced by shallowRef - see §"reactive runtime notes" finding #5 |

The `shallowRef()` range spans runs: the absolute is machine-state sensitive, and the **ratio
to the deep `ref()` it replaced is the robust claim**. It is also the signal-write cost only; end
to end through the command bus the scalar gain is ~+12%, because dispatch dominates (see the
reactive-runtime-notes section). For push-pull reactivity *without* Vue,
`configureAlienSignals` remains the correct choice.

**Implementation note:** the connector takes alien-signals' `signal`
function as an argument, so vapor-chamber never imports it: it is bundled
only if you import it yourself (npm installs it as a declared dependency;
~7.5 KB raw / ~2.5 KB brotli). 7 tests in
[tests/alien-signals.test.ts](../tests/alien-signals.test.ts) verify the
adapter against the real published package, not a stub.

### `useCommandState({ coalesce: true })`: correctness, not speed

`useCommandState` accepts a `{ coalesce: true }` option that collapses a burst
of dispatches into a single reactive signal write (≤1 write per microtask burst).
Bench result (v1.4.0, beta.13): throughput is **indistinguishable** from the
default - 1,902 ops/sec vs 1,897 ops/sec across two runs.

Use `coalesce: true` when correctness matters - e.g. a `v-for` that should
never see a partially-updated list mid-burst. Do not reach for it as a
performance knob; the measurements show no gain.

### `configureSignal(fn)`: provide your own signal implementation

The lib wires Vue's `shallowRef()` (not `ref()`) for reactivity - at build time when you
import from `vapor-chamber/vue`, otherwise through the runtime probe. If you're using a custom
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
| `core`      | Sprinkled JS on server-rendered pages (Blade / Rails / Django)| <!-- vc:sizeIifeCore -->9.2<!-- /vc:sizeIifeCore --> KB |
| `elements`  | Embeddable widgets via custom elements                        | <!-- vc:sizeIifeElements -->9.7<!-- /vc:sizeIifeElements --> KB |
| `full`      | SPAs that grew big enough to want everything                  | <!-- vc:sizeIifeFull -->13.5<!-- /vc:sizeIifeFull --> KB |

_(Always-current measured sizes for every export: [BUNDLE-SIZES.md](./BUNDLE-SIZES.md), generated by `npm run size:doc` and CI-verified fresh.)_

**Decision tree:**

```
Does your page register custom elements via defineWidget()?
├─ Yes -> elements
└─ No  -> Does your page use WebSocket/SSE, persistence, or undo/redo?
        ├─ Yes -> full
        └─ No  -> core
```

Most server-rendered apps land on **core**. Most third-party widget
distributions land on **elements**. Most SPAs that ship a `<script>` build
land on **full** (and probably should use ESM via a bundler instead).

Variant contents are not stable across minor versions before v2.0 - see
[ROADMAP.md](../ROADMAP.md). ESM consumers always get the full surface and
obey strict semver.

---

## Two doorways: general bus vs fast lane

vapor-chamber ships **two distinct dispatch paths** that serve different
audiences. Pick by what your hot path actually is.

| Path                                  | When to use                                                 | Trades                                                                  |
|---------------------------------------|-------------------------------------------------------------|-------------------------------------------------------------------------|
| `createCommandBus()` (general)        | App-level commands: cart, form, navigation, analytics       | Pays per-call for envelope + result + plugin chain - gives you results, plugins, hooks, listeners, schema, batch, request/response, AbortController |
| `createFastLane()` (real-real-hot)    | Game tick, trading data, audio buffer, scroll/mousemove, physics step | Strips everything but the function call. No envelope, no result, no plugins, no hooks, no abort. Just `(data) => handler(data)` |

The fast lane lives at `vapor-chamber/fast-lane`:

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
const onPriceTick = lane.compile('priceTick', (tick) => updateChart(tick));
onPriceTick(tick);   // pure function call, no allocations on hot path
```

**Measured throughput** (10k iterations, single handler):

| Lib / Path                               | Relative to floor |
|------------------------------------------|-------------------|
| direct function call (theoretical floor) | 1.0x              |
| **vapor-chamber `fast-lane`**            | <!-- vc:benchFloorVsCompile -->13.96<!-- /vc:benchFloorVsCompile -->x |
| mitt emit                                | <!-- vc:benchFloorVsMitt -->69.14-80.07<!-- /vc:benchFloorVsMitt -->x |
| vapor-chamber `bus.dispatch` (general)   | <!-- vc:benchFloorVsDispatch -->151.80<!-- /vc:benchFloorVsDispatch -->x |

The "Relative to floor" column is stamped from the latest `npm run bench:bands`
(`scripts/bench-bands.mjs`): the median for this library's rows, the range over
the runs for mitt's, because a ratio against another library is a fact about
one host (docs/V8-RULES.md rule 15; <!-- vc:benchProvenance -->Node 24.21.0, vitest 5.0.1, mitt 3.0.1, eventemitter3 5.0.4, 5 runs<!-- /vc:benchProvenance -->).

Fast lane runs **<!-- vc:benchCompileVsDispatch -->10.57<!-- /vc:benchCompileVsDispatch -->x the ops/sec of `bus.dispatch`** and
**<!-- vc:benchCompileVsMitt -->5.34-5.76<!-- /vc:benchCompileVsMitt -->x that of mitt's emit** on single-handler dispatch. Its <!-- vc:benchFloorVsCompile -->13.96<!-- /vc:benchFloorVsCompile -->x gap to the theoretical floor of a direct function call is
the cost of one Map lookup + one closure call (the closure is what supports
`remove()` + `clear()`).

For multi-listener fan-out (3 listeners), the latest `npm run bench:bands`
reads the default `'live'` fast lane at
**<!-- vc:benchFastLaneVsMitt -->1.84-1.95<!-- /vc:benchFastLaneVsMitt -->x mitt** and
**<!-- vc:benchFastLaneVsEventEmitter3 -->0.94-1.04<!-- /vc:benchFastLaneVsEventEmitter3 -->x eventemitter3**
(level with it where the range spans 1). In v1.12.0 the emit loop gained the
unsub-during-emit identity guard: a listener removed mid-emit (by itself or
a peer) no longer skips or double-invokes a neighbor. That guard is the
default (`'live'`, matching the main bus) and costs this row ~10-15% of its
throughput vs the pre-guard loop. Unreleased (log section 35.67): the guard
corrected the cursor by length, and still skipped or re-ran a listener when one
removed peers on both sides of itself. It is now an `off` mark per listener:
an emit calls the listeners that existed when it started, skips any removed
during it, and leaves any added during it for the next. On a three-listener
emit that loop measured 0.964x the old guard's time.

`createFastLane({ removal: 'snapshot' })` opts into
copy-on-write unsubscription instead: the emit loop returns to one call per
slot, and a listener removed mid-emit still runs once in that emit (each
mode's contract is pinned by its own test in `tests/fast-lane.test.ts`). It skips
the guard the default pays for its correctness (the ~10-15% above). Pick
`'snapshot'` only off a measured fan-out bottleneck. Single-handler `compile()` dispatch is untouched by all of this,
and both modes share a single-listener fast path on `emit`.

### When to pick which

```
Are you in a per-frame / per-tick / per-sample hot loop?
├── Yes -> fast-lane. Use compile(action, handler) + dispatcher(data).
│         Or on(action, fn) + emit(action, data) for fan-out.
└── No  -> general bus. createCommandBus() with the rich API.
```

If the answer is "I don't know," use the general bus. The fast lane is for
workloads where you have already identified the bus as a measurable
bottleneck.

---

## Comparative benchmarks vs other small libs

10k iterations per bench.

A micro-loop that emits one constant event name over and over measures how
well V8 specialises that one name, not what an app pays: an emitter keyed by a
plain object reads ahead there and falls behind once the names vary (log
s35.57). The rows below compare against mitt and eventemitter3, the peers with
a migration guide here. Each ratio against them is the range over the latest
`npm run bench:bands` (<!-- vc:benchProvenance -->Node 24.21.0, vitest 5.0.1, mitt 3.0.1, eventemitter3 5.0.4, 5 runs<!-- /vc:benchProvenance -->),
a fact about that host (docs/V8-RULES.md rule 15); the numbers this library
stands on are its own paths, measured against each other.

### Emit with NO listeners (the "I emit, nobody cares" case)

This is the most common emit shape in real apps - many lifecycle / debug /
conditional events have zero subscribers. Should be effectively free.

vapor-chamber's no-listener fast path runs **<!-- vc:benchEmitNoListenersVsMitt -->1.81-1.92<!-- /vc:benchEmitNoListenersVsMitt -->x the ops/sec of mitt** (the range over the
latest `npm run bench:bands`). Per emit, with pre-built buses and a sink, it costs 3.2 ns
for one repeated event name and 3.8 ns over four varying names, and it was the
same in v1.25.0 (log s35.57): a `Map.has()` and an `Array.length === 0` check,
whatever the name, including names on `Object.prototype` such as
`constructor`.

### Emit fan-out (3 listeners)

vapor-chamber `emit` runs
**<!-- vc:benchEmitVsMittFanout -->1.44-1.54<!-- /vc:benchEmitVsMittFanout -->x mitt**
and **<!-- vc:benchEmitVsEventEmitter3Fanout -->0.78-0.82<!-- /vc:benchEmitVsEventEmitter3Fanout -->x eventemitter3**
(the range over the latest `npm run bench:bands`): ahead of mitt, behind
eventemitter3. Where fan-out speed against eventemitter3 matters, the
fast lane is level with it (above). (v1.12.0:
`notifyListeners`' unsub-during-emit guard was corrected to compare by
identity - the old length-only heuristic could re-invoke a listener that
removed a *later* peer. Cost within run-to-run variance on this row.)

### Dispatch with single handler (10k)

`dispatch` is a different shape than `emit`. It returns a `CommandResult`,
walks the plugin chain (even when empty), stamps `Command.meta` for
correlation/causation tracing, and tracks dispatch depth. Minimal event
emitters (`mitt`) don't compute results - comparing
`bus.dispatch` to `m.emit` is apples-to-oranges. Real peers are Pinia's
action dispatch, Redux's dispatch, or any middleware-chained bus.

mitt's `emit` calls the subscribed functions and returns nothing;
`bus.dispatch` resolves the handler, runs the plugin chain, stamps the meta and
returns a `CommandResult`. mitt's emit runs
**<!-- vc:benchMittEmitVsDispatch -->1.64-2.04<!-- /vc:benchMittEmitVsDispatch -->x**
the ops/sec of `bus.dispatch` (the range over the latest `npm run bench:bands`).
The gap reflects the work `dispatch` does per call: meta object
allocation (`{ ts, id, correlationId, causationId }`), result object
allocation (`{ ok, value, error }`), plugin runner invocation, dispatch
depth tracking. None of those are free, all are unavoidable for the bus
pattern's semantics.

### What this means

- **For pub/sub event emit/listen** - vapor-chamber `emit` is faster than
  mitt, behind eventemitter3 on fan-out, and costs a few ns per emit with no
  listeners, whatever the event name. Use it freely; for a fan-out hot loop,
  the fast lane is level with eventemitter3.
- **For commands with results / plugins / hooks / batch / request/response** -
  that's the bus pattern; `dispatch` does meaningfully more per call than
  `emit`. The throughput is still high enough for any normal workload.

The comparative benches live in [`tests/perf.bench.ts`](../tests/perf.bench.ts)
under `describe('emit fast path - no listeners')`,
`describe('comparative emit fan-out')`, `describe('comparative dispatch')` and
the two fast lane groups. Reproduce the stamped ratios with
`npm run bench:bands` (several runs), or one run with
`npx vitest bench --run tests/perf.bench.ts`.

### Implementation notes for the curious

The v1.2.x `emit` fast path makes three changes:

1. **No-listener short-circuit** - `if (!exactListeners.has(event) && wildcardListeners.length === 0) return;` before any allocation.
2. **Singleton `EMIT_RESULT`** - `Object.freeze({ ok: true, value: undefined, error: undefined })` reused by every emit, instead of `okResult(undefined)` allocating a fresh object.
3. **No `stampMeta` on emit** - `Command.meta` is left undefined for emit-fired commands. emit is fire-and-forget; correlation IDs / timestamps are unused by typical listeners. The `Command` type already has `meta?` as optional. Listeners that need meta on a fire-and-forget event should use `dispatch` instead.

Inspiration: similar tricks ship in [splice](https://github.com/lucianofedericopereira/splice) - frame pooling, no-listener fast path, minimal envelopes. vapor-chamber didn't adopt the full splice architecture (numeric action IDs, binary headers, frozen action tables) because it would mean a v2 rewrite; the targeted fast paths capture most of the win without breaking existing API.

## Reactive runtime notes (Vue 3.6)

> **Where this record stops.** The per-release notes below run to beta.17. The
> library has since aligned through rc.3 to <!-- vc:vueAligned -->3.6.0-rc.10<!-- /vc:vueAligned --> (v1.14.0 onward) without a full
> bench re-run recorded here, so read every absolute below as a beta-era
> snapshot. The per-release alignment findings for the RC window live in
> CHANGELOG.md; the guards that actually catch a regression -
> `tests/signal-shallow-ab.test.ts`, `tests/clock-source-ab.test.ts`, the
> wildcard and router-stamp A/Bs - are same-process; their equivalence checks
> run in every suite, which is why nothing here silently rotted, and their
> timing tables print on `npm run test:timing` (log s35.55).
>
> **One cross-version guard is NOT in that list, and the rc.7 cycle found out
> why.** `tests/vue-version-ab.test.ts` (driven by `npm run ab:vue`) compares two
> Vue dists in one process, and on the two workloads that build a persistent
> dependency graph - watcher notify, computed read-after-write - it cannot
> resolve a version difference at all: two byte-identical copies of the SAME dist
> differ by up to 1.425x through it, in opposite directions per workload, because
> each module instance carries its own reactivity state. Its printed
> `0.87-1.15` band holds for the two workloads that build no graph. Treat a
> "faster" or "slower" verdict on the other two as unmeasured until that harness
> grows a self-A/B control pass.

Findings from the v1.5.0 bench run (June 2026, Vue beta.14, confirmed numbers - see the
bench comment block in `tests/perf.bench.ts`). This is the single, current reactive-perf
section; where a number shifted across betas the prior-beta baseline is cited inline (so the
superseded per-beta notes don't need their own section).

> **beta.15 (v1.6.0):** no perf-affecting change on these paths. The beta.15 alignment was
> documentation plus one guard on the (non-hot) `v-vc-command` click path; nothing in a measured
> hot loop changed. A 3-run beta.15 set was recorded on a dev host (see the baseline blocks in
> `tests/perf.bench.ts`): the stable rows (command bus, transition bridge, `useCommandState`,
> `effectScope` lifecycle) land ~3-8% under the beta.14 *reference-host* numbers **uniformly -
> including the Vue-independent raw `bus.dispatch` path**, which Vue's version cannot touch, so that
> shift is host/load variance, not a regression. The Vue-reactive rows (`shallowRef`, `watchEffect`)
> swing 20-30% run-to-run by machine state and are recorded as ranges; the same-process
> `signal-shallow-ab` A/B remains the trustworthy regression guard and still shows `shallowRef`
> faster. The beta.14 numbers below remain the cross-beta reference (an apples-to-apples cross-beta
> delta needs beta.14 re-run on the same host). Bench labels now read the running Vue version
> dynamically (`VUE_VERSION`), so they self-track.

> **beta.16:** no lib code change, so no path moved on our side. The full bench was
> re-run against beta.16 on a dev host and is **green** - the Vue-independent rows (plain
> `{ value }` ~368k ops/s, fast-lane ~28.6k, `bus.dispatch` ~1.83k) land on the recorded
> baselines, confirming no regression; the Vue-reactive rows stay inside their recorded ranges. No
> controlled cross-beta delta is claimed (that needs beta.15 re-measured on the *same* host -
> single-host numbers swing 20-30% by machine state, so a same-process A/B is the only honest
> comparison). **Opportunity logged, not acted on:** Vue's #14969 (skip `SlotFragment` for stable
> slot fallback) demonstrates a compile-time-proof -> one-bit-flag -> lighter-runtime-object pattern.
> It is a candidate for our own allocation-on-the-uncertain-branch hot paths, but only lands with a
> measured same-host A/B and after the Vapor-first/bus-first decision at 3.6 stable - not on a guess.

> **beta.17 (unreleased):** no lib code change again - every beta.17 fix is compiler-vapor
> (compile-time, below us), runtime slot/hydration/interop (below the command-replay or inherited
> through the `getVaporInteropPlugin()` pass-through), or a reactivity/scheduler fix the lib never
> touches. The full bench was re-run against beta.17 on a dev host and is **green**: the
> Vue-independent rows land on the recorded baselines (plain `{ value }` floor ~368k ops/s, fast-lane
> ~28.7k, `bus.dispatch` ~1.78k, `emit` with no listeners ~25.4k), confirming no regression; the
> Vue-reactive rows stay inside their recorded ranges. No controlled cross-beta delta is claimed.
> **Pattern worth noting:** Vue's #14984 (*preserve render-effect creation order when updating*) had
> to add creation-order as a scheduler tiebreaker behind component id - the same insertion-order
> invariant the bus already gets **for free** from JS's stable `Array.prototype.sort` on
> equal-priority plugins (`byPriority`), and already pins with the `equal priority preserves
> registration order` regression test. Nothing to act on; the lib's ordering was already correct by
> construction, but the parallel is a good reminder of why that test stays.

**1. The plain `{ value }` fallback remains the fastest write path at ~372,000 ops/sec.**
Essentially unchanged from beta.13 (~368k) - within normal run-to-run variance.
The fallback is not reactive; for push-pull reactivity without Vue, use
`configureAlienSignals(alienSignal)` (~10,400 ops/sec).

**2. With `signal()` now wired to `shallowRef`, the Vue path is several times the alien-signals adapter - not equivalent to it.**
The beta.13 docs reported `signal()` (then deep `ref()`) at ~9k, *converging* with the
`alienSignalAdapter` (~10k). That comparison is obsolete: since v1.5.0 `signal()` wires
**`shallowRef`**, and on an isolated scalar write loop it measures **~40,000-62,000 ops/sec**
across runs - roughly **4-7x the deep `ref()` it replaced** and ~4-6x the alien adapter (~10,400).
The absolute is machine-state sensitive (observed 37k on a busy machine, 62k on an idle one); the
ratio is the robust claim. So for Vue apps the auto-detected `signal()` is now clearly the fastest
reactive path; `configureAlienSignals` is for non-Vue contexts, not a throughput upgrade. (Isolated
figure - end-to-end through the bus the scalar gain is ~+12%; see finding #5 for the real-path numbers.)

**3. beta.14 scheduler improvements lift `effectScope` lifecycle throughput ~9% above beta.13.**
`effectScope.run(() => onScopeDispose(fn))` with no tracked reactive state now runs at
~173,000 ops/sec (vs ~165k in beta.13) - the "reset job queue length after flush" fix reduces
teardown overhead. Every vapor-chamber composable that calls `tryAutoCleanup` benefits
automatically.

**4. `useCommandState` throughput improves ~24% in beta.14 and `{ coalesce: true }` remains neutral.**
Measured at ~2,093 ops/sec (immediate) and ~2,105 ops/sec (coalesced) with 100 dispatches -
both are +24% above the beta.13 ~1,700 ops/sec baseline. The scheduler flush improvement accounts
for the lift. Rule unchanged: use `coalesce: true` for correctness (≤1 reactive write per
burst), not throughput - the two paths are within noise of each other.

**5. `signal()` wires `shallowRef`, not `ref` - and the difference is large for object/array state.**
The alien-signals rewrite changed dependency *tracking*, but `ref(anObjectOrArray)` still wraps the
value in a deep reactive Proxy via `toReactive()`. The library replaces signal values wholesale and
never mutates nested fields, so `shallowRef` is semantically equivalent for every internal signal
and skips that proxy cost. Measured **interleaved same-process A/B** on the real `useCommandState`
dispatch path (the coarse vitest-bench harness, with its ~480µs/iteration setup floor, cannot
resolve this - it compresses array and scalar cases to the same ~2,100 ops/sec):

| `useCommandState` dispatch path | `ref` | `shallowRef` | delta |
|---|---|---|---|
| 100 array appends (v-for source) | ~3,300 | ~11,300 | **+245%** |
| 10 array appends | ~122,000 | ~285,000 | **+134%** |
| 100 scalar increments | ~123,000 | ~146,000 | **+12%** |

These are not hand-measured one-offs: `tests/signal-shallow-ab.test.ts` runs this exact A/B
(median of 7 interleaved reps, `process.hrtime`) and **prints the table** on `npm run test:timing`
(opt-in since log s35.55: a timing loop sets the suite's floor and asserts nothing) - that printed
output is the evidence. It deliberately does not assert a timing *threshold* (ratios are unstable
under parallel load / coverage instrumentation, and the test compares Vue's `ref`/`shallowRef`
directly, so it couldn't catch a library regression anyway). The actual regression guard is
`chamber.test.ts` › "signal() factory - shallow reactivity", which asserts `signal()` stays a
`shallowRef`. The array/10 and scalar deltas are the noisier cases (run-to-run ±10-20%); the
array/100 case is consistently ~3.4x.

Why not an isolated `ref`-vs-`shallowRef` micro-bench in `perf.bench.ts`? Because pure deterministic
signal loops are constant-foldable: V8 dead-code-eliminates the shallowRef path (no observable effect)
while keeping `ref`'s Proxy-trap side effects, yielding inflated 800x+ ratios with ±100% rme - garbage.
The real dispatch path defeats constant-folding (the command bus is opaque indirection), which is why
the interleaved real-path test above is the only trustworthy source for these ratios.

Methodology note: these absolute numbers are far higher than the `perf.bench.ts` `useCommandState`
table because the manual harness strips vitest-bench's per-iteration setup floor. Use them for the
**ref-vs-shallowRef ratio only**, not as standalone throughput figures. The takeaway: deep-proxy
creation on every object/array signal write was real, avoidable overhead - now avoided by default.

If you genuinely need deep reactivity (nested-mutation tracking for a `v-model`-bound state object),
opt back in per-state with `useDeepCommandState` / `deepSignal` from `vapor-chamber/reactive` - it
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
| `syncDispatch` - bare handler, no plugins                          | ~2,316      |
| `syncDispatch` - 3 plugins + 1 listener                            | ~1,267      |
| `asyncDispatch` - bare handler                                     | ~3,391      |
| `dispatch` - default uid                                           | ~1,874      |
| `dispatch` - `crypto.randomUUID` via `configureUid`                | ~747        |
| `dispatch` - 50 exact + 5 wildcard listeners                       | ~602        |
| `emit` - 50 exact + 5 wildcard listeners                           | ~756        |
| `persist` - default mode (100 dispatches x 50-item state)          | ~3,894      |
| `persist` - `coalesce: true` (100 dispatches x 50-item state)      | ~98,292     |
| `rehydrate` - 1000 commands, single handler                        | ~16,192     |
| `rehydrate` - 1000 commands, ignoreUnhandled skip path             | ~107,016    |
| **Vue reactive integration (beta.14, requires vue devDep)**        |             |
| `signal()` fallback - plain `{ value }` object (no Vue, no alien-signals) | ~372,198 |
| alien-signals via `configureAlienSignals` (opt-in reactive)        | ~10,400     |
| `signal()` write - Vue **shallowRef** auto-detected (v1.5.0 default)| ~40,000-62,000 |
| `signal()` write - Vue deep `ref()` (old v1.4 default, for reference)| ~9,000     |
| `effectScope` + `onScopeDispose` x 1k - no reactive state (lazy job) | ~173,462 |
| `effectScope` + reactive signal + `onScopeDispose` x 1k (full path)| ~21,287    |
| `useCommandState` 100 dispatches - Vue ref signal writes (beta.14) | ~2,100      |
| `useCommandState coalesced` 100 dispatches - 1 reactive write      | ~2,115      |

---

## What we measured but did not ship

Documented here so future contributors don't repeat the investigation.

### HTTP envelope shape

We considered making the HTTP envelope `{ command, target, payload }` always
include all fields (vs omitting `payload` when undefined) for hidden-class
consistency. **Already done in production code.** Bench showed no meaningful
difference (~5%, within noise) - JSON.stringify pays a tiny cost to skip
undefined slots, which cancels the IC consistency win for write-once ->
serialize-once -> discard workloads. Not actionable.

**Lesson:** monomorphic shape advice applies to read-many paths (result,
meta, command). For serialize-once paths, write idiomatic code; V8's
JSON.stringify has its own fast paths that don't benefit from shape
preservation tricks.

### Copy-on-write listener buckets (fast-lane emit): shipped as an opt-in

Considered in v1.12.0 to recover the fan-out throughput the
unsub-during-emit identity guard cost, and initially rejected because it
changes removal semantics (a listener removed mid-emit still runs once -
snapshot semantics), and silently swapping semantics for a bench row is not
a trade this lib makes.

**Resolution: shipped as `createFastLane({ removal: 'snapshot' })`** - off
by default (`'live'` keeps bus parity), chosen at factory time so the hot
path carries zero mode-branching, each mode's mid-emit-unsubscribe contract
pinned by its own test. The consumer who opts in has read the trade at the
option's doc comment; nobody gets snapshot semantics by accident. See the
fan-out table above for the gap between the two modes.

### Parallel after-hooks

Considered `Promise.all`-style parallel execution of registered after-hooks.
Skipped because most real hook pipelines have hidden order dependencies
(logger before metrics, audit before publish). An opt-in `{ parallel: true }`
registration option was floated for v1.3 and never built; it is not in
ROADMAP.md and nothing is scheduled. Default stays sequential, and this entry
records the reasoning rather than a plan.

### Property mangling

Considered Terser's `mangle.properties` for internal `_*` prefixed names.
Skipped - breaks debugging without measurable real-world gain on bundles
of this size. Reconsidered if a measured profile shows it's worth it.

### Closure Compiler ADVANCED

Considered. Would save another 10-15% on top of current Vite output, but
requires annotating every API with `@export`, writing externs files, and
removing all dynamic property access (`obj[runtimeKey]`, `Symbol.toStringTag`,
runtime `vue.defineVaporCustomElement` probes). The library's runtime
feature-detection patterns are fundamentally incompatible with Closure's
static-world assumptions. Friction far exceeds gain.

---

## Reading an A/B: what a change can and cannot move

The perf-1.26 audit (log s35.44) first measured each change as two production
bundles of the built `dist/` in one process, rounds interleaved, a same-bundle
control, both load orders; then, after an outside review, again with the
process as the unit of replication (10 processes per comparison, a timing loop
per arm, fixed young generation, 20th-percentile summaries, a per-function
control gate; [V8-RULES.md](./V8-RULES.md) rules 16 to 18), and the figures
below once more with the committed tool, `npm run ab`, at two call lengths
(log s35.53). Three things it
settled about reading such a result.

**A change moves only the paths that run it.** V8 optimizes each copy of a
function on its own, and an edit in one function reaches others: it changes
when its call chain tiers up (the interrupt budget counts executed bytecode),
which callees still fit the inlining budget (counted in bytecode bytes), and
what type feedback shared callees, Vue's internals included, collect during
warm-up; allocation changes move the GC schedule too. Machine-code placement
matters less than in an ahead-of-time compiler, since V8 lays code out in
compilation order. So a loop the change never executes can read a few percent
faster or slower, and the control cannot show it: it compares a bundle with a
byte-identical copy of itself. Which of these moved a given loop is a
hypothesis until `--trace-opt` and `--trace-turbo-inlining` show it.
Measured on this library: the change that brought composable creation back to
v1.25.0's speed touched only `warnUnwired`, which runs at creation; on the same
run, a dispatch loop that never calls it read 0.93-0.98x on one workload and
1.05x on another, in one process per comparison. The same untouched code moved
in opposite directions, which is the signature of a layout and JIT-state
artifact, not a cost; replicated over 10 processes, that path read 1.000. So:
diff the two arms first, and attribute a movement only to a path that executes
the changed code. A real cost shows on every workload that runs the code, in
the same direction.

**An isolated win is a lead, not a verdict.** A workload with one call site and
one shape keeps that site monomorphic; an application does not. The scoped
plugin's action filter, a loop instead of a per-call arrow, read no effect with
one one-pattern plugin and 0.979-0.986x (4.6-6.6 ns per dispatch) on a chain
of four different scoped plugins with mixed pattern lists and a listener. Every candidate is
confirmed on a mixed workload, then on `npm run bench` against the previous
version, before it lands. The comments on `stampMeta` and `handleMissing` in
`src/command-bus.ts` record the same lesson from earlier changes.

**One process is one draw.** Both arms in a process share its heap, GC
schedule and tier-up timeline, so more rounds do not average those away;
processes do. The single-process harness had reported the composable dispatch
change at 0.87-0.90x on a workload interleaving both composables over Vue's
reactive graph. Across processes, that workload's own A/A control spread up to
1.36x, so it measures nothing and the figure is withdrawn; the change stands at
0.915-0.934x (2.7-3.9 ns) on the workload whose control holds within 1%.

---

## Measuring your own usage

If you want to know whether vapor-chamber is a bottleneck in your app:

1. **Hot-path dispatch count.** Wrap a sample window around your highest-
   frequency dispatch sites and count. If you're under ~10k dispatches/sec
   per page, the bus is not your bottleneck - look at the work the handlers
   themselves do.
2. **Persist save frequency.** Count `setItem` calls in DevTools'
   Storage panel. If you see >100/sec, enable `coalesce: true`.
3. **Listener fan-out.** `inspectBus(bus)` returns the registered listener
   pattern count. If `listenerPatterns.length > 50`, you're getting the
   bucketing benefit; if it's 1-5, the bucketing is silent. (This line used
   to reach for the symbol directly, as
   `bus[Symbol.for('vapor-chamber.inspect')]?.()`, which could never have
   worked: the real key is a module-private `Symbol()`, not a registered
   `Symbol.for()`, and it is spelled with a colon. Both halves wrong, and
   `inspectBus` is the public door anyway.)
4. **HTTP envelope cost.** Profile the `JSON.stringify(envelope)` site only
   if your endpoint is hot. The lib's envelope is already minimal.

For a full bench run against your own dispatch shapes, copy
`tests/perf.bench.ts` into your project and adapt the workloads.
