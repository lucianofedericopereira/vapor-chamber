# `vapor-chamber/store`

**Experimental.** State whose every mutation is a command.

<!-- vc:sizeStore -->0.7<!-- /vc:sizeStore --> KB brotli. Imports `vue` and nothing else.

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
with no store-specific code.

| you want | you add | the store contributes |
| --- | --- | --- |
| persistence | `persist` plugin | nothing |
| undo / redo | `history` plugin | nothing |
| cross-tab sync | `sync` plugin | nothing |
| optimistic rollback | `optimistic` plugin | nothing |
| double-submit collapse | `idempotent` plugin | nothing |
| ordered same-key writes | `serialize` plugin | nothing |
| a devtools timeline | `vapor-chamber/devtools` | nothing |

```ts
const bus = createCommandBus();
bus.use(history());
bus.use(persist({ keys: ['cartAdd', 'cartClear'] }));

const cart = useCart(bus);
cart.add(1);
// saved, undoable, and visible in the timeline - the store did not participate
```

Pinia reaches a fraction of that by growing a roughly 70-line bus inside itself
(`action()` / `$onAction`), because no bus exists underneath it. Here one does,
so the store is the thin part. See `docs/whitepaper.md` section 6 for why this
package now ships a state layer at all, and what about that decision did not
change.

## The bus is a required argument

`useStore(bus)`, never `useStore()`. There is no fallback to the shared bus,
and the omission is deliberate twice over:

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
to. It measured 16.7 KB raw against a 1-2 KB design estimate; required, it is
1.4 KB. `tests/chamber-store.test.ts` asserts the built entry's import list is
exactly `['vue']`.

## State is shallow and replaced wholesale

Every action returns a **new** state object:

```ts
actions: {
  add: (s, id: number) => ({ items: [...s.items, id] }),   // yes
  bad: (s, id: number) => { s.items.push(id); return s; }, // no-op to the signal
}
```

State is a `shallowRef`, measured at about 3.4x a deep `ref` on array state
(`tests/signal-shallow-ab.test.ts`). A reducer that mutates and returns the same
object does not notify, which is why `$reset` and every action build fresh
objects. `state` is exposed with a getter and no setter, so `cart.state.value =
x` throws in strict mode: the bus is the only mutation channel.

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

cart.$reset()     // back to state(), as a fresh object
cart.$dispose()   // unregister handlers, drop from the registry
```

Created inside an `effectScope`, a store disposes with it. Outside one, the
caller owns `$dispose` - the same contract as every other composable here.

## Status

Experimental, like the router. The action-name convention (`cart` + `add` ->
`cartAdd`) matches `useCommandGroup`, and the shape is expected to move before
it is marked stable.

### Open questions

Carried forward deliberately rather than answered early:

- **A Vue-less store.** The bus runs with no Vue in the tree, and the signal
  shim and `vapor-chamber/alien-signals` both exist. A store built on the shim
  could serve that root, where Pinia structurally cannot. It would be this
  module's second genuine differentiator after the bus, and it is not decided.
- **The SSR shape.** Stores are already keyed per bus, so a per-request bus
  gets per-request state and the isolation exists. What is not yet written down
  is one documented story for hydration and for the server-side warning class.
