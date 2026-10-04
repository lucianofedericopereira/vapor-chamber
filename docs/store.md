# `vapor-chamber/store`

**Experimental.** State whose every mutation is a command.

<!-- vc:sizeStore -->1.8<!-- /vc:sizeStore --> KB brotli. Imports `vue` and the failure module (`failure`, no bus, no probe), nothing else.

```ts
import { createCommandBus } from 'vapor-chamber';
import { defineChamberStore } from 'vapor-chamber/store';

const bus = createCommandBus();

const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  actions: {
    add:   (s, id: number) => ({ items: [...s.items, id] }),
    clear: () => ({ items: [] }),
  },
});

const cart = useCart(bus);
cart.add(42);            // dispatches `cartAdd`
cart.state.value.items;  // [42]
```

## Why this is not another store

`cart.add(42)` is a command. That one fact is the whole design, and it is why
this module is small: everything the bus already does applies to store state
with no store-specific code, undo aside, which takes one option (below).

| you want | you add | the store contributes |
| --- | --- | --- |
| persistence | `persist` plugin | nothing |
| undo / redo | `history` plugin, and `undo: true` on the store | the inverse: the state each action replaced |
| optimistic rollback | `optimistic` plugin | nothing |
| double-submit collapse | `idempotent` plugin | nothing |
| ordered same-key writes | `serialize` plugin | nothing |
| a devtools timeline | `vapor-chamber/devtools` | nothing |
| the same state in every tab | `createChannel`, and `share` on the store | the state it reached, with a version (below) |

Across tabs the store shares the STATE it reached, never the command: the old
plugin re-dispatched each command in every tab, so each tab re-derived its own
outcome, and two tabs disagreed for ever whenever the handler was not
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
(`register(action, handler, { undo })`). A store registers its actions with
none unless it is defined with `undo: true`: then history records a store
action and `undo()` leaves the state as it is. With it, each action and
`$reset` is registered with an inverse that puts back the state the action
replaced.

```ts
const useCart = defineChamberStore('cart', { state, actions, undo: true });
const bus = createCommandBus();
const h = history({ bus });
bus.use(h);
const cart = useCart(bus);
cart.add(1);
cart.add(2);
h.undo();   // items [1]
h.redo();   // items [1, 2]
```

The undo runs as a command, `cartAdd$undo` (every undo does, see the bus's
`register` options): persist stores the undone state, listeners and devtools
see it (`cmd.meta.origin` is `'undo'`; a redo re-dispatches the action with
`'redo'`), and a reload does not bring the undone state back. History does
not record it.

The store keeps its last 256 steps; an older one reads `canUndo` false
(`history` keeps 50 by default). A store's id and action keys cannot carry a
`$`: names with `$` are the library's (`store:invalid:name`).

`canUndo` is true only while the store holds the state that action produced.
A change the history did not record (its `filter` left it out) moves it, and
`undo()` then does nothing rather than undo that change too. Off by default, a
store's actions run exactly as without it. `tests/store-undo.test.ts`.

Pinia reaches a fraction of that by growing a roughly 70-line bus inside itself
(`action()` / `$onAction`), because no bus exists underneath it. Here one does,
so the store is the thin part. See `docs/whitepaper.md` section 3.6 (and its appendix A.3) for why this
package now ships a state layer at all, and which parts of that decision did not
change.

## The bus is a required argument

`useStore(bus)`, never `useStore()`. There is no fallback to the shared bus,
for two deliberate reasons:

- **The probe.** Reaching for `getCommandBus()` imports `chamber.ts`, whose
  top-level `probeVue()` then runs on any `vapor-chamber/store` import. That
  probe cannot resolve in a production bundle and is behind both of this
  package's shipped prod-only bugs. This module imports `vue` statically
  instead, which turns an upstream rename into a build error rather than a
  runtime null, and is also why it is a subpath: the root barrel is Vue-less by
  construction.
- **SSR.** Stores are cached per bus, so a per-request bus gets a per-request
  set of stores. A module global is the one thing that cannot give that, so
  defaulting to it would hand every request the same state.

The first draft defaulted the argument and paid both costs while claiming not
to: it measured 16.7 KB raw against a design estimate of 1-2 KB. With the
argument required, it is <!-- vc:sizeStoreRaw -->4.1<!-- /vc:sizeStoreRaw --> KB minified
(<!-- vc:sizeStore -->1.8<!-- /vc:sizeStore --> KB brotli), the `./store` row of
[BUNDLE-SIZES.md](./BUNDLE-SIZES.md). `tests/chamber-store.test.ts` asserts the
built entry's import list is exactly `vue` and `./failure.js`, the failure module (it mints the store's coded refusals: `store:missing:bus`, `store:missing:router`, `store:already:member`).

## State is shallow and replaced wholesale

Every action returns a **new** state object:

```ts
actions: {
  add: (s, id: number) => ({ items: [...s.items, id] }),   // yes
  bad: (s, id: number) => { s.items.push(id); return s; }, // no-op to the signal
}
```

State is a `shallowRef`. The number behind that choice is a dispatch rate, not
a property of the ref: on the real dispatch path, 100 array appends run at about
3.4x a deep `ref`, because `ref` wraps an array in a deep reactive proxy that
wholesale replacement never needs. The A/B is `tests/signal-shallow-ab.test.ts`;
the absolute figures live in finding 5 of
[performance.md](./performance.md#reactive-runtime-notes-vue-36).
A reducer that mutates and returns the same
object does not notify, which is why `$reset` and every action build fresh
objects. `state` is exposed with a getter and no setter, so `cart.state.value =
x` throws in strict mode: the bus is the only mutation channel.

## Reading one field

A component that reads `cart.state.value.count` re-renders on every write of
the store, because `state` is one ref. To react to one field:

```ts
import { fieldRef } from 'vapor-chamber/store';

const count = fieldRef(cart, 'count');      // a read-only ref: count.value
cart.$onField('count', (n) => announce(n)); // or a plain callback; returns the unsubscribe
```

Each fires only when a write changes that field (compared by identity). A
store nobody subscribes to pays nothing on its writes; the first subscriber
starts one synchronous Vue effect on the store's state, stopped by
`$dispose()`. Against a `computed` per field, which re-evaluates on every
write of the store, `fieldRef` costs the writes the same however many fields
are read: with one reader a `computed` is a little faster, with several
`fieldRef` is (log section 35.125). `$reset` and an undo notify like any
action. `tests/store-field-events.test.ts`.

## Across tabs

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';
import { createChannel } from 'vapor-chamber';

const lane = createFastLane();
createChannel({ channel: 'my-app', lane, events: ['cart$state'] });
const useCart = defineChamberStore('cart', { state, actions, share: lane });
```

Each local write sends the new state, with a version, as `cart$state`. Another
tab applies a newer one through the `cart$sync` command, marked
`origin: 'sync'`: its plugins and listeners hear it, `persist` saves it, and
`history` does not record it (a change made in another tab is not undone
here). The newer version wins and a tie goes to one tab's id, so two tabs
writing at once end on the same state; a state received is not sent back. A
store without `share` writes exactly as without it; a shared one pays an effect
and the send on each write (log section 35.129).

What it does not do: a tab opened later starts from `state()` and catches up
on the next write; the state
crosses by structured clone, so it holds data, not functions or class
instances; with no `BroadcastChannel` (SSR) nothing is sent. Undo is per tab:
undoing in one tab changes its state, which then reaches the others as a
write. `tests/store-share.test.ts`.

## URL-backed fields

Fields that belong in the URL should not also live in the store. Declare them
and they delegate:

```ts
const useFilters = defineChamberStore('filters', {
  state: () => ({ view: 'grid' }),
  actions: { setView: (s, view: string) => ({ ...s, view }) },
  url: { page: 'page', sort: 'sort' },
});

const f = useFilters(bus, router);
f.url.page.set(2);   // a router navigation
f.url.page.value;    // read back from the URL, not from a mirror
```

There is no signal behind a `url` field, so the URL stays the single writer and
a shared link reproduces the view. Nothing has to be reconciled, because nothing
is duplicated.

The router arrives as an argument for the same reason the bus does: a store with
no `url` fields never pulls the router into its graph. It is taken
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
with the same id - an edited store module re-run by hot reload, or two
modules that picked the same id - takes over, the rule `register()` follows
for a handler: the new definition builds its own store from its `state()` and
registers its actions over the old ones (in development, `register()` warns
once per action it overwrites, which is how a clash shows), and the old
store's `$dispose()` removes only what it still owns. A component that holds a
store needs none of this on a hot reload: Vue disposes it first, so the new
definition starts clean. Pinned in `tests/store-redefine.test.ts` and
`tests/vapor/store-hmr.test.ts`.

`$reset()` is a command like any action: it dispatches `<id>$reset`
(`cart$reset`), so `persist` saves the reset state, `history` records it, a
listener hears it and a plugin can refuse it. It returns the dispatch result;
on an async bus that is a promise, and the state is reset once it settles. The
`$` keeps the name apart from an action of your own called `reset`, which is
`cartReset`. Action names containing `$` are reserved for the library: a bus's
`naming` rule does not check them. An action key cannot be one of the store's
own members (`$id`, `state`, `url`, `$reset`, `$dispose`): it would replace
it, so `defineChamberStore` throws and names the key.

`$reset()` goes back to whatever `state()` returns at that moment, so keep
`state()` the default. A `state()` that reads storage makes the reset hand
back the saved record, and `persist` then saves it again: the reset does
nothing. Load a saved record through an action instead, and the reset goes
back to the default:

```ts
const cartPersist = persist({ key: 'vc:cart', getState: () => cart.state.value });
const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),               // the default, never storage
  actions: {
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
reducer again on the client, and any reducer that is not deterministic (an
id, a timestamp, a counter) ends somewhere else.

`__origin: 'replay'` marks the dispatch as restored state rather than a user
action: it arrives as `cmd.meta.origin`, so a listener can tell a load from
what the user did. `persist` saves what was loaded, and
`$reset()` still goes back to `state()`. Pinned in
`tests/store-load-saved.test.ts`.

A store is shared, so disposal is refcounted: **the last holder out disposes,
not the first one in.** Every `useCart(bus)` call from inside an `effectScope`
joins that scope to the store's holder count and leaves when the scope ends;
the store is disposed when the count reaches zero. Two components can hold the
same store and the first to unmount does not take it away from the second.

Called outside a scope there is no lifetime to hook, nothing is counted, and
the caller owns `$dispose()` - the same contract as every other composable here.

## Without Vue

`vapor-chamber/store/core` is the same store with no Vue in its graph, for an
app on the bus alone:

```ts
import { defineChamberStore } from 'vapor-chamber/store/core';
```

One implementation serves both entries, so actions, `$reset`, undo, `$onField`,
`share` and the coded refusals behave the same. What differs:

- **The state cell** is the library's `signal()`: a plain `{ value }`, or a
  reactive signal once `configureAlienSignals()` (from
  `vapor-chamber/alien-signals`) has run, so an alien-signals effect that reads
  `state.value` reruns on a write. Without either, react through the bus
  (`bus.on('cart*', ...)`) or `$onField`.
- **No scope, no holder count:** every caller owns `$dispose()`.
- **No `fieldRef`**, which returns a Vue ref; `$onField` gives the same
  per-field events.

`tests/store-core.test.ts`, which also checks the built entry imports no Vue.

## Status

Experimental, like the router. The action-name convention (`cart` + `add` ->
`cartAdd`) matches `useCommandGroup`, and the shape is expected to move before
it is marked stable.

### Open questions

Carried forward deliberately rather than answered early:

- **The SSR shape.** Stores are already keyed per bus, so a per-request bus
  gets per-request state and the isolation exists, and hydration has its one
  story ("Loading saved state" above). What is missing is the server-side
  warning class.
