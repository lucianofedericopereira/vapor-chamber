# Migrating from Node EventEmitter / eventemitter3

[Node's `EventEmitter`](https://nodejs.org/api/events.html) and
[`eventemitter3`](https://github.com/primus/eventemitter3) are the canonical
class-based event emitters. vapor-chamber is a command bus — a different
shape. This guide is for users who reached for an EventEmitter for app-wide
state coordination and outgrew it.

If you only need pub/sub event broadcast (no return values, no plugins,
no transports), **stay on EventEmitter** or use vapor-chamber's
[fast lane](../performance.md) — both are smaller and faster than the
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
| `emitter.listenerCount('foo')`                  | Same                                                       |
| `setMaxListeners(n)`                            | No equivalent — vapor-chamber doesn't cap listener count   |

## Multi-argument emit → single-payload emit

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
listeners receive `(cmd, result)` — `cmd.target` is the payload, `result`
is `{ ok, value, error }`. For pure pub/sub use cases the second arg
doesn't matter (emit always uses a singleton ok-result).

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
EventEmitter doesn't have. Here's the surface:

```ts
// Handlers with results — emit doesn't have a return path
bus.register('cartAdd', (cmd) => addToCart(cmd.target));
const result = bus.dispatch('cartAdd', { id: 42 });
if (result.ok) console.log('added', result.value);

// Plugins (logger, retry, debounce, throttle, persist, sync, …)
bus.use(retry({ maxAttempts: 3 }));

// Async + AbortController
const asyncBus = createAsyncCommandBus();
const ac = new AbortController();
const result = await asyncBus.dispatch('orderCreate', cart, undefined, { signal: ac.signal });

// HTTP transport — dispatches forward to a backend
asyncBus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));

// Schema introspection (LLM tool-use)
import { toAnthropicTools } from 'vapor-chamber';
const tools = toAnthropicTools(busSchema);
```

## Memory leaks — listener cleanup

EventEmitter's `setMaxListeners(n)` warns if you accumulate too many
listeners; this is a leak detector. vapor-chamber doesn't have an
equivalent because the lib's composables (`useCommand`,
`useSharedCommandState`) auto-cleanup via `tryAutoCleanup` (Vue scope /
component disposal).

For non-Vue code, capture the unsubscribe closure:
```ts
const off = bus.on('cartAdd', handler);
// later: off();
```

If you're seeing listener leaks, run `inspectBus(bus).listenerPatterns`
and check whether the count grows without bound.

## When NOT to migrate

- Your codebase is built around `extends EventEmitter` — vapor-chamber's
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

The fast lane's `on/emit` is **2.3× faster than mitt** and ties nanoevents
within 5%. It has the right shape if you're EventEmitter-shaped today.
