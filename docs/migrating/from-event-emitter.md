# Migrating from Node EventEmitter / eventemitter3

[Node's `EventEmitter`](https://nodejs.org/api/events.html) and
[`eventemitter3`](https://github.com/primus/eventemitter3) are the canonical
class-based event emitters. vapor-chamber is a command bus - a different
shape. This guide is for users who reached for an EventEmitter for app-wide
state coordination and outgrew it.

If you only need pub/sub event broadcast (no return values, no plugins,
no transports), **stay on EventEmitter** or use vapor-chamber's
[fast lane](../performance.md) - both are smaller and faster than the
general-purpose bus.

---

## API mapping

| EventEmitter / eventemitter3                    | vapor-chamber                                              |
|-------------------------------------------------|------------------------------------------------------------|
| `new EventEmitter()`                            | `createCommandBus()`                                       |
| `emitter.on('foo', fn)` / `addListener`         | `bus.on('foo', fn)`                                        |
| `emitter.once('foo', fn)`                       | `bus.once('foo', fn)`                                      |
| `emitter.off('foo', fn)` / `removeListener`     | unsubscribe via closure returned from `bus.on('foo', fn)`  |
| `emitter.removeAllListeners('foo')`             | `bus.offAll('foo')`                                        |
| `emitter.removeAllListeners()`                  | `bus.offAll()` (no arg removes everything)                 |
| `emitter.emit('foo', a, b, c)`                  | `bus.emit('foo', { a, b, c })` *(single-arg payload)*      |
| `emitter.listeners('foo')`                      | Inspect via `inspectBus(bus).listenerPatterns`             |
| `emitter.listenerCount('foo')`                  | No per-pattern count - `listenerPatterns` lists patterns   |
| `setMaxListeners(n)`                            | No equivalent - vapor-chamber doesn't cap listener count   |

## Multi-argument emit -> single-payload emit

EventEmitter accepts varargs:
```ts
emitter.emit('userUpdate', userId, oldName, newName, timestamp);
emitter.on('userUpdate', (userId, oldName, newName, timestamp) => {});
```

vapor-chamber takes a single payload (more typeable, easier to extend):
```ts
bus.emit('userUpdate', { userId, oldName, newName, timestamp });
bus.on('userUpdate', (cmd) => {
  const { userId, oldName, newName, timestamp } = cmd.target;
});
```

If you have many EventEmitter-style call sites, write a thin shim:
```ts
const emitArgs = (action: string, ...args: any[]) => bus.emit(action, args);
const onArgs = (action: string, fn: (...args: any[]) => void) =>
  bus.on(action, (cmd) => fn(...(cmd.target as any[])));

emitArgs('userUpdate', userId, oldName, newName);
onArgs('userUpdate', (userId, oldName, newName) => {});
```

## Listener signature change

EventEmitter listeners receive the emitted args directly. vapor-chamber
listeners receive `(cmd, result)` - `cmd.target` is the payload, `result`
is `{ ok, value, error }`. For pure pub/sub the second argument doesn't
matter: emit always uses a singleton ok-result.

## Class-based vs functional

EventEmitter is class-based and intended for inheritance:
```ts
class MyService extends EventEmitter {
  constructor() { super(); }
  doThing() { this.emit('didThing'); }
}
```

vapor-chamber is functional. The bus is created, not extended:
```ts
const bus = createCommandBus();
class MyService {
  doThing() { bus.emit('didThing'); }
}
```

If your codebase has many `extends EventEmitter` services, consider
keeping them and using vapor-chamber as the *cross-service* bus that
those services emit/listen on. They're complementary.

## Beyond what EventEmitter does

You probably reached for vapor-chamber because you needed something
EventEmitter lacks. Here is the surface:

```ts
// Handlers with results - emit doesn't have a return path
bus.register('cartAdd', (cmd) => addToCart(cmd.target));
const result = bus.dispatch('cartAdd', { id: 42 });
if (result.ok) console.log('added', result.value);

// Plugins (logger, debounce, throttle, persist, ...); the async bus retries on its own
bus.use(logger());

// Async + AbortController
const asyncBus = createAsyncCommandBus();
const ac = new AbortController();
const result = await asyncBus.dispatch('orderCreate', cart, undefined, { signal: ac.signal });

// HTTP transport - dispatches forward to a backend
asyncBus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));

// Schema introspection (LLM tool-use)
import { toAnthropicTools } from 'vapor-chamber';
const tools = toAnthropicTools(busSchema);
```

## Memory leaks: listener cleanup

EventEmitter's `setMaxListeners(n)` is a leak detector: it warns if you
accumulate too many listeners. vapor-chamber has no equivalent because the
lib's composables (`useCommand`, `useSharedCommandState`) clean up
automatically via `tryAutoCleanup`, on Vue scope or component disposal.

For non-Vue code, capture the unsubscribe closure:
```ts
const off = bus.on('cartAdd', handler);
// later: off();
```

`inspectBus(bus).listenerPatterns` lists patterns, not subscriptions, so a
leak of repeated `on('cartAdd')` does not grow it. Check instead that each
`on()` has its unsubscribe called.

## When NOT to migrate

- Your codebase is built around `extends EventEmitter` - vapor-chamber's
  functional shape doesn't fit. Keep EventEmitter for the per-class event
  surface and use vapor-chamber as the cross-cutting bus.
- You only need EventEmitter's pub/sub semantics and don't need results,
  plugins, transports, or schema. Use the fast lane:

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';
const lane = createFastLane();
lane.on('userUpdate', (data) => updateUI(data));
lane.emit('userUpdate', { userId, name });
```

On three-listener fan-out the fast lane's `on`/`emit` runs
**<!-- vc:benchFastLaneVsEventEmitter3 -->0.94-1.04<!-- /vc:benchFastLaneVsEventEmitter3 -->x eventemitter3**
and **<!-- vc:benchFastLaneVsMitt -->1.84-1.95<!-- /vc:benchFastLaneVsMitt -->x mitt**.
Against eventemitter3 that is level: the band falls on both sides of 1. The
general bus's `emit` is behind eventemitter3 on the same fan-out, at
**<!-- vc:benchEmitVsEventEmitter3Fanout -->0.78-0.82<!-- /vc:benchEmitVsEventEmitter3Fanout -->x**.
So moving EventEmitter pub/sub onto the bus costs some speed on this path;
onto the fast lane, about none.
The fast lane figure is the default removal mode (`'live'`, which matches the
main bus - a listener removed mid-emit does not run, and one added mid-emit
runs from the next emit).
`createFastLane({ removal: 'snapshot' })` skips the per-listener `off` check
and runs somewhat faster; the check is the price of that correctness
(the measured gap is in [performance.md](../performance.md)).

Single-handler `compile()` dispatch runs
**<!-- vc:benchCompileVsDispatch -->10.57<!-- /vc:benchCompileVsDispatch -->x** the general bus's `dispatch`,
and nothing above affects it. For the mode trade-off, see
[performance.md](../performance.md).

> These ratios are **generated**, not typed: `npm run bench:bands` runs the
> bench several times through `scripts/bench-ratios-reporter.mjs`, and
> `npm run docs:stamp` publishes them, so none is typed by hand. Ratios rather
> than hz on purpose: an absolute hz figure is host state (rows here swing
> 20-30% run to run) and a same-run ratio is not. Even a ratio moves. A ratio
> between two libraries is a fact about one host (docs/V8-RULES.md rule 15),
> so it is printed as the range over the runs; a ratio between two of this
> library's own paths is the median. These: <!-- vc:benchProvenance -->Node 24.21.0, vitest 5.0.1, mitt 3.0.1, eventemitter3 5.0.4, 5 runs<!-- /vc:benchProvenance -->,
> one Apple Silicon Mac. A
> micro-loop emitting one name over and over flatters emitters keyed by a
> plain object; with varying names they fall behind (docs/performance.md).
