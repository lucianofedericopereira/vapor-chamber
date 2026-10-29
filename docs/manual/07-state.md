# 7. State

This chapter keeps app state in a store whose every mutation is a command, so undo, saving,
optimistic updates and tab sharing come from the bus. The full guide is [store.md](../store.md).
`vapor-chamber/store` is experimental.

## Define a store and use it

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

- `reducers` maps each action key to `(state, target, payload) => nextState`. `add` on store
  `cart` becomes the method `cart.add` and the action `cartAdd`.
- Every reducer returns a **new** state object. A reducer that mutates and returns the same
  object does not notify.
- Pass the bus every time: `useCart(bus)`. The store is cached per bus, which also isolates SSR
  requests.
- `cart.$reset()` dispatches `cart$reset` and goes back to `state()`.

## Add undo

Define the store with `undo: true` and install `history`:

```ts
const useCart = defineChamberStore('cart', { state, reducers, undo: true });
const bus = createCommandBus();
const h = history({ bus });
const cart = useCart(bus);
cart.add(1);
cart.add(2);
h.undo();   // items [1]
h.redo();   // items [1, 2]
```

Mint ids and times in the call, not in the reducer: `cart.add({ id: crypto.randomUUID(), name })`.
In development a store with `undo: true` runs each reducer twice and warns when the results
differ. Undo is local: a command a transport carried out cannot be undone on the client.

## Save the state

```ts
const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),               // the default, never storage
  reducers: { add: (s, id: number) => ({ items: [...s.items, id] }) },
  persist: saveTo({ key: 'vc:cart' }),                            // localStorage by default
});
const cart = useCart(bus);   // the saved record is its first state
cart.add(1);                 // saved after it, once per microtask
cart.$reset();               // back to { items: [] }, and saved as that
```

`saveTo` takes `storage` (`sessionStorage`, `indexedDbStorage()` or your own), `validate` and a
serializer. On an async storage, `await cart.$ready` before a check that reads the state.

## Share it across tabs

```ts
import { defineChamberStore, shareTabs } from 'vapor-chamber/store';

const useCart = defineChamberStore('cart', { state, reducers, share: shareTabs() });
```

Each write crosses as its command, and every tab applies it with the store's reducer. An undo in
one tab undoes it in every tab. It needs `BroadcastChannel` and Web Locks.

## Keep a store behind a transport

For an action the server carries out, write the reducer as `null`, and let the answer write the
state:

```ts
// the server replies { state: { order: 7 }, stores: { cart: { items: [] } } }
const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  reducers: { add: null }, // sent: no local change
  answer: (_state, value) => value as { items: number[] }, // when cartAdd answers the cart
});
```

- The server can also name stores' states in a `stores` member of any reply or push.
- `optimistic: true` shows the change at once, and the reply replaces it.
- `version` keeps an older answer from replacing a newer one, and `exclusive: true` sends the
  store's commands one at a time.

## Read one field

```ts
import { fieldRef } from 'vapor-chamber/store';

const count = fieldRef(cart, 'count');      // a read-only ref: count.value
cart.$onField('count', (n) => announce(n)); // or a plain callback; returns the unsubscribe
```

## Delegate fields to the URL

Fields that belong in the URL live in the router, not the store:

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

## Use a store with no Vue

`vapor-chamber/store/core` is the same store with no Vue in its graph. Its state cell is the
library's `signal()`, and every caller owns `$dispose()`.

Next: [8. Pages without a build](./08-pages-without-a-build.md).
