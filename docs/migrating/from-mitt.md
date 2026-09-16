# Migrating from mitt

[mitt](https://github.com/developit/mitt) is a tiny event emitter (<!-- vc:sizeMitt -->0.2<!-- /vc:sizeMitt --> KB brotli, measured beside our own rows in [BUNDLE-SIZES.md](../BUNDLE-SIZES.md)).
vapor-chamber is a command bus with results, plugins, hooks, transports, and
more. They solve different problems. If you're outgrowing mitt because you've
started building a command bus on top of it, this guide is the path.

If your mitt usage is purely pub/sub event broadcast (no return values, no
plugins, no async dispatching), **stay on mitt** or use vapor-chamber's
[fast lane](../performance.md) - both are smaller and faster than the
general-purpose bus.

---

## API mapping

| mitt                                | vapor-chamber                                                            |
|-------------------------------------|--------------------------------------------------------------------------|
| `mitt()`                            | `createCommandBus()` (with results) or `createFastLane()` (no results)   |
| `emitter.on('foo', fn)`             | `bus.on('foo', fn)`                                                      |
| `emitter.off('foo', fn)`            | unsubscribe via the closure returned from `bus.on('foo', fn)`            |
| `emitter.off('foo')`                | `bus.offAll('foo')`                                                      |
| `emitter.emit('foo', payload)`      | `bus.emit('foo', payload)` *(see envelope note below)*                   |
| `emitter.all` (Map of all listeners)| `inspectBus(bus).listenerPatterns`                                       |
| `mitt({ foo: [fn] })` (preset)      | Loop your presets through `bus.on(...)` after construction               |

## Listener signature change

mitt listeners receive the payload directly:
```ts
emitter.on('cartAdd', (item) => console.log(item.id));
```

vapor-chamber listeners receive `(cmd, result)`:
```ts
bus.on('cartAdd', (cmd, result) => console.log(cmd.target.id));
```

The data your mitt code passed as `payload` lands on `cmd.target`. The
second argument, `result`, is `{ ok, value, error }`, for listeners that
need to know whether the dispatch succeeded.

For a drop-in mitt-shaped wrapper:
```ts
const onMitt = (action: string, fn: (data: any) => void) =>
  bus.on(action, (cmd) => fn(cmd.target));
onMitt('cartAdd', (item) => console.log(item.id));   // identical to mitt
```

## Wildcards

mitt:
```ts
emitter.on('*', (type, payload) => {});
```

vapor-chamber:
```ts
bus.on('*', (cmd) => {});           // matches everything
bus.on('cart*', (cmd) => {});       // prefix wildcard - mitt doesn't have this
```

## Beyond what mitt does

You probably reached for vapor-chamber because you needed something mitt
lacks. Here is the extra surface:

```ts
// Results - handlers return values; consumers know if dispatch succeeded
bus.register('cartAdd', (cmd) => addToCart(cmd.target));
const result = bus.dispatch('cartAdd', { id: 42 });
if (result.ok) console.log('added', result.value);
else console.error(result.error);

// Plugins - logger, retry, debounce, throttle, persist, sync, ...
bus.use(logger());
bus.use(retry({ maxAttempts: 3 }));

// before/after hooks
bus.onBefore((cmd) => { if (!authorized(cmd)) throw new Error('forbidden'); });
bus.onAfter((cmd, result) => metrics.record(cmd.action, result.ok));

// Async with results
const asyncBus = createAsyncCommandBus();
asyncBus.use(createHttpBridge({ endpoint: '/api/vc' }));
const result = await asyncBus.dispatch('orderCreate', cart);

// AbortController
const ac = new AbortController();
asyncBus.dispatch('searchExecute', q, undefined, { signal: ac.signal });
ac.abort();   // resolves with VC_CORE_ABORTED, handler observes cmd.signal

// Batch with rollback
bus.dispatchBatch([
  { action: 'reserveSlot', target: slot },
  { action: 'chargeCard', target: payment },
  { action: 'sendConfirmation', target: order },
], { transactional: true });   // any failure -> reverse-order undo handlers
```

## Bundle size

mitt is <!-- vc:sizeMitt -->0.2<!-- /vc:sizeMitt --> KB brotli. vapor-chamber's `core` IIFE variant is
**<!-- vc:sizeIifeCore -->8.0<!-- /vc:sizeIifeCore --> KB brotli**, a couple
of orders of magnitude more; that difference pays for the extras above. For
always-current per-export numbers, see [BUNDLE-SIZES.md](../BUNDLE-SIZES.md)
(generated, CI-verified fresh) and prefer it over any figure quoted in prose.

If you only need pub/sub and don't want to pay for those features,
**don't migrate**: stay on mitt or use vapor-chamber's fast lane:

```ts
// vapor-chamber/fast-lane - mitt's shape, and faster than mitt on fan-out,
// but with vapor-chamber's surface available for everything else.
import { createFastLane } from 'vapor-chamber/fast-lane';
const lane = createFastLane();
lane.on('cartAdd', (item) => addToCart(item));
lane.emit('cartAdd', { id: 42 });
```

On the three-listener fan-out both libraries are built for, the fast lane
measures **<!-- vc:benchFastLaneVsMitt -->2.33<!-- /vc:benchFastLaneVsMitt -->x
mitt**. `npm run bench` generates that ratio and `npm run docs:stamp` publishes
it; nobody types it here. See [from-event-emitter.md](./from-event-emitter.md)
for the nanoevents comparison and the removal-mode trade-off.

## When NOT to migrate

- You're using mitt as a tiny global event bus and have no plans to grow it.
- Bundle size is the dominant constraint.
- You don't need results, plugins, hooks, transports, or any of the
  bus-shaped features.

mitt is excellent at what it does. vapor-chamber is for when you need more
than that.
