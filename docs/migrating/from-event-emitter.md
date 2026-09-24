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

// Plugins (logger, retry, debounce, throttle, persist, ...)
bus.use(retry({ maxAttempts: 3 }));

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

On multi-listener fan-out the fast lane's `on`/`emit` is
**<!-- vc:benchFastLaneVsMitt -->2.33<!-- /vc:benchFastLaneVsMitt -->x mitt**.
Against nanoevents it depends on the removal mode: the default (`'live'`, which
matches the main bus - a listener removed mid-emit does not run) sits at
**<!-- vc:benchFastLaneVsNano -->1.22<!-- /vc:benchFastLaneVsNano -->x**, while
`createFastLane({ removal: 'snapshot' })` reaches
**<!-- vc:benchFastLaneSnapshotVsNano -->1.32<!-- /vc:benchFastLaneSnapshotVsNano -->x**.
The gap between those two modes is the price of the v1.12.0 unsub-during-emit
identity guard, and the guard bought correctness.

Single-handler `compile()` dispatch holds a different and much wider lead,
**<!-- vc:benchCompileVsNano -->2.89<!-- /vc:benchCompileVsNano -->x nanoevents**,
and nothing above affects it. For the mode trade-off, see
[performance.md](../performance.md).

> These four ratios are **generated**, not typed: `npm run bench` writes them
> through `scripts/bench-ratios-reporter.mjs`, and `npm run docs:stamp` publishes
> them. This paragraph used to carry them by hand, with a warning that they had
> no generator, and by the time anyone checked two had drifted: it described the
> snapshot mode as "at parity (~0.9-1.0x)" while that mode measured consistently
> ahead of nanoevents. Ratios rather than hz on purpose: an absolute hz figure is
> host state (rows here swing 20-30% run to run) and a same-run ratio is not.
> Even a ratio moves a little, so read the second decimal as noise.
