# `vapor-chamber/store`

**Experimental.** State whose every mutation is a command.

<!-- vc:sizeStore -->2.2<!-- /vc:sizeStore --> KB brotli. Imports `vue`, the failure module and one chunk holding the library's `$` names and the commands a transport carried out: no bus, no probe.

```ts
import { createCommandBus } from 'vapor-chamber';
import { defineChamberStore } from 'vapor-chamber/store';

const bus = createCommandBus();

const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  reducers: {
    add:   (s, id: number) => ({ items: [...s.items, id] }),
    clear: () => ({ items: [] }),
  },
});

const cart = useCart(bus);
cart.add(42);            // dispatches `cartAdd`
cart.state.value.items;  // [42]
```

`reducers` maps each action key to a reducer, `(state, target, payload) =>
nextState`: `add` on store `cart` becomes the method `cart.add` and the action
`cartAdd`. The name is `reducers`, not `actions`: elsewhere in the library
`actions` names a set of actions (`ActionScope`), not a map of functions.
`tests/store-reducers-name.test.ts`.

## Why this is not another store

`cart.add(42)` is a command. That one fact is the whole design, and it is why
this module is small. Everything the bus already does applies to store state
with no store-specific code. Undo is the exception, and it takes one option
(below).

| you want | you add | the store contributes |
| --- | --- | --- |
| persistence | `persist` plugin | nothing |
| undo / redo | `history` plugin, and `undo: true` on the store | the inverse: the state each action replaced |
| optimistic rollback | `optimistic` plugin | nothing |
| double-submit collapse | `idempotent` plugin | nothing |
| ordered same-key writes | `serialize` plugin | nothing |
| a devtools timeline | `vapor-chamber/devtools` | nothing |
| the same state in every tab | `createChannel`, and `share` on the store | the state it reached, with a version (below) |

Across tabs the store shares the STATE it reached, never the command. The old
plugin re-dispatched each command in every tab, so each tab re-derived its own
outcome. Two tabs then disagreed for ever whenever the handler was not
deterministic. A state cannot disagree with itself.

```ts
const bus = createCommandBus();
bus.use(history());
bus.use(persist({ key: 'vc:cart', getState: () => cart.state.value }));

const cart = useCart(bus);
cart.add(1);
// saved and recorded - the store did not participate
```

### Undo

`history` reverses a command only through an inverse registered with it
(`register(action, handler, { undo })`). A store registers its actions with no
inverse unless it is defined with `undo: true`. Without it, history records a
store action and `undo()` leaves the state as it is. With it, each action and
`$reset` is registered with an inverse that puts back the state the action
replaced.

```ts
const useCart = defineChamberStore('cart', { state, reducers, undo: true });
const bus = createCommandBus();
const h = history({ bus });
bus.use(h);
const cart = useCart(bus);
cart.add(1);
cart.add(2);
h.undo();   // items [1]
h.redo();   // items [1, 2]
```

The undo runs as a command, `cartAdd$undo`, as every undo does (see the bus's
`register` options). So persist stores the undone state, and listeners and
devtools see it with `cmd.meta.origin` `'undo'`. A redo re-dispatches the
action with `'redo'`. A reload does not bring the undone state back. History
does not record the undo.

A redo is the same action again, so plugins and listeners hear it as before.
The store does not run the reducer again. It writes the state the action
produced, the same object, so an id the reducer minted comes back unchanged.
If the state moved after the undo, through a change history did not record,
the reducer runs instead. `tests/store-redo-recorded.test.ts`.

An undo can reach an older step. `optimisticUndo` and a transactional batch
dispatch `<action>$undo` for the action that failed, which need not be the
newest. The store then rebases. It starts from that step's state before, and
re-applies every later step it holds by calling the reducer directly. Plugins
and bridges do not see those steps again. Every later write survives,
including a tab's write (`$sync`), which is a step too. A later `$reset`, a
tab's write or a server's answer (below) keeps the state it set. An undo for
a step the store does not hold, or for one already undone, changes nothing. A
reducer that throws during the replay leaves the state as it was, and the
`$undo` command fails. A reducer that computes only from its arguments rebases
exactly. A reducer that mints a value, such as an id or a time, mints it again
for each later step it replays. `tests/store-rollback-rebase.test.ts`.

In development a store with `undo: true` runs each reducer twice, as React's
StrictMode does, and warns once per action when the two results differ. Mint
ids and times in the call, `cart.add({ id: crypto.randomUUID(), name })`, and
let the reducer only apply them. Production runs each reducer once.
`tests/store-reducer-twice.test.ts`.

Undo is local. A store's undo restores its own state and sends nothing. A
command a bridge carried out reads `canUndo` false in history, because only
the server can reverse what the server applied: send a compensating command.
`tests/undo-remote-step.test.ts`. A bridged action that got no reply fails
with `context.outcome: 'unknown'` when nothing identifies it. `optimisticUndo`
still rolls it back to the last confirmed state, and its `onRollback` reads
the outcome: re-read the server, since the write may have landed.
`tests/retry-unidentified.test.ts`.

The store keeps its last 256 steps. An older one reads `canUndo` false
(`history` keeps 50 by default). A store's id and action keys cannot carry a
`$`: names with `$` are the library's (`store:invalid:name`).

`canUndo` is true only while the store holds the state that action produced.
A change the history did not record (its `filter` left it out) moves it, and
`undo()` then does nothing rather than undo that change too. `canUndo` is
history's check. A rollback (`optimisticUndo`, a transactional batch)
reverses the step that failed and does not consult it. So the rebase above
runs for an older step whose `canUndo` is false. `tests/undo-check.test.ts`.
Without `undo: true`, a store's actions run exactly as they would with no
history. `tests/store-undo.test.ts`.

Pinia reaches a fraction of that by growing a small bus inside itself, because
no bus exists underneath it. In Pinia 4.0.3 (read 2026-10-06) that bus is
about 60 lines: `action()` 44 and its `$onAction` subscriptions 15. Here one
does, so the store is the thin part. `docs/whitepaper.md` section 3.6 and its
appendix A.3 say why this package now ships a state layer at all. They also
say which parts of that decision did not change.

## A store behind a bridge

A bridge (`createHttpBridge`, `createBatchingHttpBridge`, `createWsBridge`)
forwards the actions it matches to the server and answers them itself. The
reducer does not run. The dispatch is `ok`, its value the answer's `state`.
Whether that value is a store's state is known by the side that declares it,
never guessed:

- **The server declares it**, per reply: a `stores` member beside `state`,
  store states by store id. Each store with that id on the bus takes its
  state, whatever the command was. So a `checkout` can update the cart and
  the stock (docs/integrations/laravel.md shows the action's return).
- **The app declares it**, per store: `answer(state, value, cmd)` returns the
  next state from the command's own `state`. TanStack Query's `setQueryData`
  in `onSuccess` and Apollo's `update` do the same.
- **Neither**: the store keeps its state, as in 1.26.

```ts
// the server replies { state: { order: 7 }, stores: { cart: { items: [] } } }
const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  reducers: { add: (s, id: number) => ({ items: [...s.items, id] }) },
  answer: (_state, value) => value as { items: number[] }, // when cartAdd answers the cart
});
```

Both write as a step of the command that got the reply, inside the dispatch,
so `persist` saves it and a listener reads it. The command's own `answer`
runs first and the states the server named last, so what the server named
wins. History records the command once and cannot undo it, since only the
server can reverse what it applied. A failed command writes nothing.
`optimisticUndo`'s `predict` still answers the caller at once, and the store
changes when the reply lands. A store id is an external string: only the
reply's own keys are read (src/dict.ts), and an id with no store is ignored.
`tests/store-bridged-answer.test.ts`, `tests/store-declared-by-server.test.ts`.

Two writes in flight can be answered in any order. The server may apply them
in either order, and the replies may arrive in either order. Only the server
knows which state is newer, so let it say so with a number that grows with
each write it applies:

```ts
defineChamberStore('cart', {
  state: () => ({ rev: 0, items: [] as number[] }),
  reducers,
  answer: (_state, value) => value as { rev: number; items: number[] },
  version: (state) => state.rev, // an older answer never replaces a newer one
});
```

The store writes an answer only when its version is higher than the one it
holds, the rule `share` uses between tabs. An ETag cannot do this: RFC 9110
defines it for equality, not order. A version that is not a number is written
in arrival order, and development warns once. Without `version` the last
answer to arrive wins. The `serialize` plugin on the store's actions makes
that safe too. It sends one write at a time, so the server applies and
answers them in the order they were sent. An answer with no `state` (the
server's handler returned nothing) writes nothing.
`tests/store-answer-version.test.ts`.

The store's `answer` is `register`'s `answer` option, which any handler can
take: the bus calls it when a transport answered in place of the handler.

## The bus is always an argument

`useStore(bus)`, never `useStore()`. There is no fallback to the shared bus,
for two deliberate reasons:

- **The probe.** Reaching for `getCommandBus()` imports `chamber.ts`, whose
  top-level `probeVue()` then runs on any `vapor-chamber/store` import. That
  probe cannot resolve in a production bundle and is behind both of this
  package's shipped prod-only bugs. This module imports `vue` statically
  instead, which turns an upstream rename into a build error rather than a
  runtime null. That is also why it is a subpath: the root barrel is Vue-less
  by construction.
- **SSR.** Stores are cached per bus, so a per-request bus gets a per-request
  set of stores. A module global is the one thing that cannot give that, so
  defaulting to it would hand every request the same state.

The first draft defaulted the argument and paid both costs while claiming not
to. It measured 16.7 KB raw against a design estimate of 1-2 KB. With the bus
a mandatory argument, it is <!-- vc:sizeStoreRaw -->5.1<!-- /vc:sizeStoreRaw --> KB minified
(<!-- vc:sizeStore -->2.2<!-- /vc:sizeStore --> KB brotli), the `./store` row of
[BUNDLE-SIZES.md](./BUNDLE-SIZES.md). `tests/chamber-store.test.ts` asserts the
built entry imports only `vue` and the store's base, and the base only
`./failure.js` and `./applied-remotely.js`. The failure module mints the store's
coded refusals (`store:missing:bus`, `store:missing:router`,
`store:already:member`, `store:invalid:name`). The other chunk holds the
library's `$` names and the commands a transport carried out.

## State is shallow and replaced wholesale

Every reducer returns a **new** state object:

```ts
reducers: {
  add: (s, id: number) => ({ items: [...s.items, id] }),   // yes
  bad: (s, id: number) => { s.items.push(id); return s; }, // no-op to the signal
}
```

State is a `shallowRef`. The number behind that choice is a dispatch rate, not
a property of the ref. On the real dispatch path, 100 array appends run at
about 3.4x a deep `ref`. A `ref` wraps an array in a deep reactive proxy that
wholesale replacement never needs. The A/B is
`tests/signal-shallow-ab.test.ts`, and the absolute figures live in finding 5
of [performance.md](./performance.md#reactive-runtime-notes-vue-36). A reducer
that mutates and returns the same object does not notify, which is why
`$reset` and every action build fresh objects. `state` is exposed with a
getter and no setter, so `cart.state.value = x` throws in strict mode: the bus
is the only mutation channel.

## Reading one field

A component that reads `cart.state.value.count` re-renders on every write of
the store, because `state` is one ref. To react to one field:

```ts
import { fieldRef } from 'vapor-chamber/store';

const count = fieldRef(cart, 'count');      // a read-only ref: count.value
cart.$onField('count', (n) => announce(n)); // or a plain callback; returns the unsubscribe
```

Each fires only when a write changes that field (compared by identity). A
store nobody subscribes to pays nothing on its writes. The first subscriber
starts one synchronous Vue effect on the store's state, stopped by
`$dispose()`. A `computed` per field re-evaluates on every write of the store.
`fieldRef` costs the writes the same however many fields are read. With one
reader a `computed` is a little faster, and with several `fieldRef` is (log
section 35.125). `$reset` and an undo notify like any action.
`tests/store-field-events.test.ts`.

## Across tabs

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';
import { createChannel } from 'vapor-chamber';

const lane = createFastLane();
createChannel({ channel: 'my-app', lane, events: ['cart$state'] });
const useCart = defineChamberStore('cart', { state, reducers, share: lane });
```

Each local write sends the new state, with a version, as `cart$state`. Another
tab applies a newer one through the `cart$sync` command, marked
`origin: 'sync'`. Its plugins and listeners hear it and `persist` saves it.
`history` does not record it: a change made in another tab is not undone here.
The newer version wins and a tie goes to one tab's id, so two tabs writing at
once end on the same state. A state received is not sent back. A store
without `share` writes exactly as without it. A shared one pays an effect and
the send on each write (log section 35.129).

A tab opened later asks for the current state when it opens. A tab that has
written answers it. The new tab applies the answer by the same version rule,
so its next write builds on the others. With Node's `BroadcastChannel`
it caught up a median 1.2 ms after opening, 9.3 ms at most (30 runs, measured
2026-10-06). A write made before then is a concurrent write: every tab still
ends on one state. A tab of 1.26 never applies the ask, since its version is
below every tab's. `tests/store-share-late-tab.test.ts`.

What it does not do: the state crosses by structured clone, so it holds data,
not functions or class instances. With no `BroadcastChannel` (SSR) nothing is
sent. Undo is per tab. Undoing in one tab changes its state, which then
reaches the others as a write. A rollback of an older step keeps the states
the tab received. `tests/store-share.test.ts`,
`tests/store-rollback-rebase.test.ts`.

## URL-backed fields

Fields that belong in the URL should not also live in the store. Declare them
and they delegate:

```ts
const useFilters = defineChamberStore('filters', {
  state: () => ({ view: 'grid' }),
  reducers: { setView: (s, view: string) => ({ ...s, view }) },
  url: { page: 'page', sort: 'sort' },
});

const f = useFilters(bus, router);
f.url.page.set(2);   // a router navigation
f.url.page.value;    // read back from the URL, not from a mirror
```

There is no signal behind a `url` field, so the URL stays the single writer and
a shared link reproduces the view. Nothing has to be reconciled, because nothing
is duplicated.

The router arrives as an argument for the same reason the bus does. A store
with no `url` fields never pulls the router into its graph. It is taken
**structurally** (`StoreRouter`), so this module imports nothing from
`src/router`. Declaring `url` without passing a router is a named error, not an
undefined read.

## Lifecycle

```ts
useCart(bus) === useCart(bus)   // cached per bus
useCart(a) !== useCart(b)       // different bus, different store

cart.$reset()     // dispatches cart$reset: back to state(), as a fresh object
cart.$dispose()   // unregister handlers, drop from the registry
```

One id is one store per bus for one definition. A second `defineChamberStore`
with the same id takes over, the rule `register()` follows for a handler. That
second one may be an edited store module re-run by hot reload, or a module that
picked the same id. The new definition builds its own store from its `state()`
and registers its actions over the old ones. In development, `register()` warns
once per action it overwrites, which is how a clash shows. The old store's
`$dispose()` removes only what it still owns. A component that holds a store
needs none of this on a hot reload: Vue disposes it first, so the new
definition starts clean. Pinned in `tests/store-redefine.test.ts` and
`tests/vapor/store-hmr.test.ts`.

`$reset()` is a command like any action: it dispatches `<id>$reset`
(`cart$reset`). So `persist` saves the reset state, `history` records it, a
listener hears it and a plugin can refuse it. But `cache` and `idempotent`
never answer it from memory, and `debounce` never postpones it
(`tests/library-commands-memory.test.ts`). It returns the dispatch result.
On an async bus that is a promise, and the state is reset once it settles. The
`$` keeps the name apart from an action of your own called `reset`, which is
`cartReset`. Action names containing `$` are reserved for the library: a bus's
`naming` rule does not check them. An action key cannot be one of the store's
own members (`$id`, `state`, `url`, `$reset`, `$dispose`). It would replace
the member, so `defineChamberStore` throws and names the key.

`$reset()` goes back to whatever `state()` returns at that moment, so keep
`state()` the default. A `state()` that reads storage makes the reset hand
back the saved record, and `persist` then saves it again: the reset does
nothing. Load a saved record through an action instead, and the reset goes
back to the default:

```ts
const cartPersist = persist({ key: 'vc:cart', getState: () => cart.state.value });
const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),               // the default, never storage
  reducers: {
    load: (s, saved: { items: number[] } | null) => saved ?? s,
    add:  (s, id: number) => ({ items: [...s.items, id] }),
  },
});
const cart = useCart(bus);
bus.use(cartPersist);
cart.load(cartPersist.load());   // the saved record, as a command
cart.$reset();                   // back to { items: [] }, and saved as that
```

Both behaviours are pinned in `tests/store-reset-command.test.ts`.

### Loading saved state

A store has no setter, so saved state enters it the way every change does:
through an action it declares, like `load` above. The source does not
change the pattern:

```ts
cart.load(cartPersist.load(), { __origin: 'replay' });   // from storage
cart.load(window.__CART__, { __origin: 'replay' });      // from the server
```

From the server, send the store's **state**, not the commands that built
it: serialize `store.state.value` into the page and load it on the client.
The state is a fact, so the client ends exactly where the server did.
Replaying the commands instead (`createSSRPlugin` and `rehydrate`) runs every
reducer again on the client. Any reducer that is not deterministic (an id, a
timestamp, a counter) then ends somewhere else.

`__origin: 'replay'` marks the dispatch as restored state rather than a user
action. It arrives as `cmd.meta.origin`, so a listener can tell a load from
what the user did. `persist` saves what was loaded, and `$reset()` still goes
back to `state()`. Pinned in `tests/store-load-saved.test.ts`.

A store is shared, so disposal is refcounted: **the last holder out disposes,
not the first one in.** Every `useCart(bus)` call from inside an `effectScope`
joins that scope to the store's holder count and leaves when the scope ends.
The store is disposed when the count reaches zero. Two components can hold the
same store and the first to unmount does not take it away from the second.

Called outside a scope there is no lifetime to hook and nothing is counted.
The caller owns `$dispose()`, the same contract as every other composable here.

## Without Vue

`vapor-chamber/store/core` is the same store with no Vue in its graph, for an
app on the bus alone:

```ts
import { defineChamberStore } from 'vapor-chamber/store/core';
```

The same code serves both entries, so actions, `$reset`, undo, `$onField`,
`share` and the coded refusals behave the same. What differs:

- **The state cell** is the library's `signal()`: a plain `{ value }`, or a
  reactive signal once `configureAlienSignals()` (from
  `vapor-chamber/alien-signals`) has run. Then an alien-signals effect that
  reads `state.value` reruns on a write. Without either, react through the bus
  (`bus.on('cart*', ...)`) or `$onField`.
- **No scope, no holder count:** every caller owns `$dispose()`.
- **No `fieldRef`**, which returns a Vue ref. `$onField` gives the same
  per-field events.

`tests/store-core.test.ts`, which also checks the built entry imports no Vue.

## Status

Experimental, like the router. The action-name convention (`cart` + `add` ->
`cartAdd`) matches `useCommandGroup`, and the shape is expected to move before
it is marked stable.

### Open questions

Carried forward deliberately rather than answered early:

- **The SSR shape.** Stores are already keyed per bus, so a per-request bus
  gets per-request state and the isolation exists. Hydration has its one story
  ("Loading saved state" above). What is missing is the server-side warning
  class.
