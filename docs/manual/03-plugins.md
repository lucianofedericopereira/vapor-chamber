# 3. Plugins

A plugin adds a cross-cutting concern to every command it selects: logging, validation, limits,
caching, undo. This chapter installs the built-in ones, configures the async bus's retry, and
writes a plugin of your own. Where a plugin runs in the dispatch, and why, is in the
[whitepaper](../whitepaper.md), section 5.

## Use the built-in plugins

| Plugin | What it does |
|--------|-------------|
| `logger(options?)` | Logs every settled command to the console, including a refusal or a cancel |
| `validator(rules)` | Refuses a command a rule rejects, before every plugin and the work |
| `history({ bus, ... })` | Undo/redo of the bus's commands. Not a bus plugin: it installs its own recorder |
| `authGuard(options)` | Refuses protected commands when unauthenticated, before the validators |
| `createChannel(options)` | Mirrors emitted facts to other tabs. Not a bus plugin: it takes a fast lane, not the bus |

Extras, from the same import: `cache`, `circuitBreaker`, `rateLimit`, `metrics`.

Pacing belongs to the sender, not to a plugin. `pace(send, { debounce: ms })` runs the latest
call of a burst, and `pace(send, { throttle: ms })` the first call per wait. Calls are keyed by
action and target, so search as you type passes the typed text as the payload.
`useCommand({ debounce })` and `defineVaporCommand(action, handler, { throttle })` take the same
options.

### Install and configure each one

```typescript
// logger / validator
bus.use(logger({ collapsed: true, actions: ['cart*'] }));
bus.use(logger({ level: 'error', badges: true }));   // failures only, with [ OK ] / [ FAIL ] badges
bus.use(validator({
  cartAdd: (cmd) => cmd.target?.id ? null : 'Product must have an ID',   // null = valid
}));

// history - records the bus's commands from the call on; undo() dispatches <action>$undo, which runs the registered inverse
const h = history({ bus, maxSize: 100 });
h.undo();
h.redo();
h.getState();   // { past, future, canUndo, canRedo }
// Undo is local: a command a transport sent reads canUndo false, so the server's
// write is never reversed on the client alone. Send a compensating command.
// What an undo handler dispatches is a rollback step (meta.origin 'undo', a redo's 'redo'),
// never recorded. Limit: an async undo handler's dispatch after an await is recorded.

// pacing at the sender: the typed text is the payload, so a burst shares one key
const search = pace(bus.dispatch, { debounce: 300 });
const r = await search('searchQuery', {}, input.value); // the latest call's real result
const mark = pace(bus.dispatch, { throttle: 100 });     // a repeat inside 100 ms: pace:limited:dispatch

// authGuard
bus.use(authGuard({
  isAuthenticated: () => !!user.value,
  protected: ['shopCart', 'admin*'],          // 'shopCart' that action, 'admin*' every admin action, '*' all
  onUnauthenticated: (cmd) => router.push('/login'),
}));

// extras
bus.use(cache({ ttl: 60_000, actions: ['getUser*'] }));
bus.use(circuitBreaker({ threshold: 5, resetTimeout: 30_000 }));
bus.use(rateLimit({ max: 10, window: 1000 }));

const m = metrics();
bus.use(m);
m.summary();   // { cartAdd: { count: 42, avgMs: 1.2, errorRate: 0.02 } }
```

A plugin that takes `actions` also takes `actionFilter`, a predicate on the action name.

- `actions` lists names or `prefix*` patterns. Absent or `[]` means every action.
- `createActionFilter` builds a filter from CloudEvents filter expressions: `exact`, `prefix`,
  `suffix`, `all`, `any`, `not`.[^cloudevents] It rejects what the spec rejects
  (`core:invalid:filter`).
- Given both, both must match. The bus asks once per action, never per dispatch.
- Only an app that calls `createActionFilter` carries its code. It is also `createMcpHandler`'s
  allowlist, its one selection.

[^cloudevents]: CloudEvents Subscriptions API, section 3.2.4.

```typescript
import { createActionFilter } from 'vapor-chamber';

const reads = createActionFilter([{ all: [{ suffix: { action: 'Get' } }, { not: { prefix: { action: 'admin' } } }] }]);
bus.use(cache({ ttl: 60_000, actionFilter: reads }));
```

## Make an action optimistic

**Optimistic actions:** `register(action, handler, { undo, optimistic: true })`, on either bus.

- The handler makes the local change and sends the write.
- The inverse reverses the local change only, and never does I/O. Undoing a write the server
  applied is the app's compensating command, not an inverse.
- On the async bus the dispatch answers an `Accepted` at once. A failure runs the undo before
  `done` settles with it. A plugin's refusal runs nothing, so nothing is undone.
- For an action a transport sends, the handler is the local change and the transport the write.

```typescript
bus.register('cartAdd', async (cmd) => {
  cart.items.push(cmd.target);              // local, at once
  return api.addToCart(cmd.target);         // the write
}, {
  // local only: the write failed, so there is nothing on the server to remove
  undo: (cmd) => { cart.items = cart.items.filter((item) => item.id !== cmd.target.id); },
  optimistic: true,
});

const r = await bus.dispatch('cartAdd', item);       // an Accepted, at once
const end = await r.value.done;                       // the write's result
if (!end.ok) toast.error(`Rolled back: ${end.error.message}`);
```

A failure marked `context.outcome: 'unknown'` (no reply, and nothing identifies the command)
still rolls back, so the screen shows the last confirmed state. `done` settles with that error.
Re-read the server, since the write may have landed.

## Configure the async bus's retry

**retry** is the async bus's own, on by default. It re-sends the call that produced the outcome
(a handler, or the transport), so the plugins outside see one dispatch. It makes 3 attempts
with a jittered backoff, and a per-bus budget stops retries from piling onto a backend that is
down:

```typescript
const bus = createAsyncCommandBus({
  retry: {
    // Transient failures are re-sent for any action. An uncertain one (no
    // reply, a 500, a handler's throw) only where running twice is safe:
    actionPolicies: { 'cart*': 'idempotent', orderPay: false, searchRun: 2 }, // most specific wins
  },
});
createAsyncCommandBus({ retry: false });                        // off
createAsyncSchemaCommandBus({ cartSet: { retry: 'idempotent' } }); // on the schema
```

An action declared idempotent gets one `Idempotency-Key` for all its attempts.

## Save a store's state

A store saves itself, so this is an option on the store, not a plugin. [Chapter 7](./07-state.md)
covers stores.

**A store's `persist`** saves after its writes and is read back when the store is created:

```typescript
const useCart = defineChamberStore('cart', { state, reducers, persist: saveTo({ key: 'vc:cart' }) });

const cart = useCart(bus);   // the saved state is its first state
cart.add(1);                 // saved once per microtask, whatever wrote it
cart.$reset();               // back to state(), and saved as that

defineChamberStore('tab', { state, reducers, persist: saveTo({ key: 'vc:tab', storage: sessionStorage }) });          // custom backend
defineChamberStore('prefs', { state, reducers, persist: saveTo({ key: 'vc:prefs', validate }) });                       // a check of the saved shape
defineChamberStore('rows', { state, reducers, persist: saveTo({ key: 'vc:rows', storage: indexedDbStorage() }) });   // IndexedDB: read when it answers
```

`saveTo` comes from `vapor-chamber` or the store entries, and throws without `key`. A store
without `persist` carries none of it. Details: [docs/store.md](../store.md) (Saved state).

## Mirror facts to other tabs

**createChannel** mirrors emitted facts to other tabs through `BroadcastChannel`. What crosses
is what a handler computed, not the command that caused it, so the receiving tab applies values
rather than re-deriving them. The bridge is not a bus plugin and costs the dispatch path
nothing:

```typescript
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
lane.on('cartChanged', (fact) => applyToCart(fact));   // local AND remote land here

bus.register('cartAdd', (cmd) => {
  lane.emit('cartChanged', computeCart(cmd.target));   // this is what crosses tabs
});

const tabSync = createChannel({ channel: 'vapor-chamber:app', lane, events: ['cartChanged'] });
tabSync.dispose();
```

Tabs mirror when the facts are absolute ("the count is 2"), not relative ("add one"). A tab
opened later then converges instead of drifting. A payload crosses through structured clone, so
it cannot carry functions.

## Write your own plugin

A plugin is an object of parts. The bus places each part where it belongs, and no part holds
`next`, so two plugins give the same outcome in either install order:

```typescript
import { type Command, type PluginParts } from 'vapor-chamber';

function timing(): PluginParts {
  const starts = new Map<Command, number>();
  return {
    id: 'timing',
    started: (cmd) => { starts.set(cmd, performance.now()); },
    settled: (cmd) => {
      console.log(`${cmd.action} took ${performance.now() - (starts.get(cmd) ?? 0)}ms`);
      starts.delete(cmd);
    },
  };
}
bus.use(timing());
```

| Part | When the bus calls it | What it may do |
|---|---|---|
| `started(cmd)` | a dispatch or a query starts, before its rules | observe |
| `settled(cmd, result)` | every outcome, after the `onAfter` hooks | observe |
| `authorize(action)`, `validate(action)` | asked once per action. Its rule runs before the work | refuse |
| `reuse(cmd)` | before the work | answer with a stored result |
| `admit(cmd, fail)` | after every `reuse` | refuse (a limit), taking nothing |
| `begin(cmd)` | the command goes to the work | hand a `WorkTicket`: the work's `signal`, `landed(result)`, an `answer` |
| `attach(bus)` | at `use()` | subscribe, and return the detach |

- `id`, `actions` and `actionFilter` scope every part.
- `dispose` runs at the bus's `dispose()`, and `forget` after an undo lands.
- A command's own values are the sender's. The bus never rewrites a command, so the caller adds
  them.

Build a refusal's result with `err(error)`, the bus's own factory, and an answer with
`ok(value)`. Every result then keeps one hidden class. `fail(code, message)`, handed to a rule
and to an `admit` step, mints the failure's owner from the plugin's `id`.
`countOption(value, fallback)` is the library's rule for a numeric option: NaN falls back to the
default, negatives clamp, fractions truncate.

```typescript
import { err, type PluginParts } from 'vapor-chamber';

const qtyGuard: PluginParts = {
  id: 'qtyGuard', // the code reads qtyGuard:invalid:payload
  validate: (action) => action === 'cartAdd'
    ? (cmd, fail) => (cmd.payload?.qty > 0 ? undefined : err(fail('invalid:payload', 'qty must be positive')))
    : undefined,
};
```

A gate is a rule: it refuses before the work, and it may be async. A rule runs for a dispatch
and a query alike, so a gate names the actions it gates. After-hooks run once a command settles:

```typescript
// a client-wide read-only mode over every write
bus.use({
  id: 'readOnly',
  authorize: (action) => (isWrite(action)
    ? (cmd, fail) => (maintenance.value ? err(fail('refused:action', 'Read-only mode')) : undefined)
    : undefined),
});
bus.onAfter((cmd, result) => { if (!result.ok) report(result.error); });
```

`commandState(bus).pending(action)` (from `vapor-chamber`) says what is in flight.

## Cancel the previous in-flight dispatch

`supersede` aborts the stale request through `AbortController`, rather than ignoring its answer
on arrival. Use it for type-ahead search, autosave, or any command fired again and again where
only the latest matters.

```typescript
import { createAsyncCommandBus, supersede } from 'vapor-chamber';

const bus = createAsyncCommandBus();
bus.use(supersede());   // default key = commandKey(action, target)

bus.use(supersede({
  actions: ['searchQuery', 'draftSave'],                   // globs; default: all
  key: (cmd) => `${cmd.action}:${cmd.target?.id ?? ''}`,   // null/undefined to skip
}));
```

The HTTP transport forwards `cmd.signal` into its `fetch`, so a superseded HTTP request is
cancelled at the network layer. With `batch`, a superseded command settles at once and leaves a
batch not yet sent. A sent batch is cancelled once every command in it has aborted.

## Validate with Zod, Valibot or ArkType

`validateSchemas` from `vapor-chamber/standard-schema` takes a schema per action from any library
that follows Standard Schema v1. No schema library is bundled:

```typescript
import { z } from 'zod';
import { validateSchemas } from 'vapor-chamber/standard-schema';

bus.use(validateSchemas({
  cartAdd:     z.object({ id: z.number(), qty: z.number().min(1) }),
  orderCreate: z.object({ items: z.array(z.any()).min(1) }),
}, { field: 'target' }));   // 'target' (default), 'payload', 'both', or (cmd) => value
```

- A failure returns `validateSchemas:invalid:payload` before the handler runs.
- `onInvalid: 'warn'` reports the failure and runs the handler anyway.
- `validateSchemasAsync` takes a schema whose validation returns a promise.

## Group handlers, run sagas, react across domains

```typescript
import { createChamber, createWorkflow, createReaction } from 'vapor-chamber';

// Group handlers under a namespace
const cart = createChamber('cart', { add: handleAdd, remove: handleRemove });
cart.install(bus);   // registers cartAdd, cartRemove

// Saga: sequential steps with automatic compensation
const checkout = createWorkflow([
  { action: 'cartValidate' },
  { action: 'paymentReserve', compensate: 'paymentRelease' },
  { action: 'orderCreate',    compensate: 'orderCancel' },
]);
await checkout.run(bus, { cartId });   // compensates on failure

// Declarative cross-domain reaction
createReaction('cartAdd', 'inventoryCheck', {
  when: (cmd, result) => result.ok,
  map:  (cmd) => ({ itemId: cmd.payload.itemId }),
}).install(bus);
// It does not run on an undo, a redo or a mirrored command (origin 'sync'):
// history replays the follow-up it recorded.
```

- `map` builds the target, and `mapPayload` the payload.
- A reaction whose source matches its own target action is refused at install. It would fire on
  its own dispatch. `allowSelfMatch: true` permits it, with a `when` that ends the loop.
- `maxHops` (8 by default) caps how many reaction hops one command may start, counted across
  every reaction on the bus. So an indirect cycle (A to B to A) stops too.
Next: [4. Talking to a backend](./04-backend.md).
