# `vapor-chamber/store`

**Experimental.** State whose every mutation is a command.

<!-- vc:sizeStore -->5.8<!-- /vc:sizeStore --> KB brotli. Its graph reaches `vue`, and never the bus or the Vue probe (see "The bus is always an argument" below).

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

`reducers` maps each action key to a reducer, `(state, target, payload) => nextState`. `add` on
store `cart` becomes the method `cart.add` and the action `cartAdd`. The name is `reducers`, not
`actions`, because elsewhere in the library `actions` names a set of actions (`ActionScope`), not
a map of functions.[^reducers-name]

[^reducers-name]: `tests/store-reducers-name.test.ts`.

## Why this is not another store

`cart.add(42)` is a command. That one fact is the whole design, and it is why this module is
small. Everything the bus already does applies to store state with no store-specific code. Undo
and saving are the exceptions: each is one option on the store (below).

| you want | you add | the store contributes |
| --- | --- | --- |
| persistence | `persist` on the store | its state, saved after any write (below) |
| undo / redo | `history({ bus })`, which installs itself, and `undo: true` on the store | the inverse: the state each action replaced |
| optimistic rollback | `optimistic: true` on the store | its steps, rolled back on a failure (below) |
| double-submit collapse | `idempotent` plugin | nothing |
| a store's server commands in order, reads included | `exclusive: true` on the store (below) | nothing |
| a devtools timeline | `vapor-chamber/devtools` | nothing |
| the same state in every tab | `share: shareTabs()` on the store | each write's command, applied by each tab (below) |

Across tabs a write crosses as its command, and each tab applies it with the store's reducer,
never through the bus. No plugin, listener or transport runs it twice.[^old-plugin]

[^old-plugin]: The old plugin re-dispatched each command in every tab, and every handler ran again there.

```ts
const bus = createCommandBus();
history({ bus });

const cart = useCart(bus);
cart.add(1);
// recorded - the store did not participate
```

### Undo

`history` reverses a command only through an inverse registered with it
(`register(action, handler, { undo })`). A store registers its actions with no inverse unless it
is defined with `undo: true`.

- Without it, history records a store action, and `undo()` leaves the state as it is.
- With it, each action and `$reset` is registered with an inverse that puts back the state the
  action replaced.

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

**The undo runs as a command,** `cartAdd$undo`, as every undo does (see the bus's `register`
options).

- A store with `persist` saves the undone state.
- Listeners and devtools see it with `cmd.meta.origin` `'undo'`. A redo re-dispatches the action
  with `'redo'`.
- A reload does not bring the undone state back. History does not record the undo.

**A redo is the same action again,** so plugins and listeners hear it as before. The store does
not run the reducer again: it writes the state the action produced, the same object, so an id
the reducer minted comes back unchanged. If the state moved after the undo, through a change
history did not record, the reducer runs instead.[^redo]

[^redo]: `tests/store-redo-recorded.test.ts`.

**An undo can reach an older step.** An optimistic action's failure and a transactional batch
dispatch `<action>$undo` for the action that failed, which need not be the newest. The store then
rebases:[^rebase]

- It starts from that step's state before, and re-applies every later step it holds by calling
  the reducer directly. Plugins and transports do not see those steps again.
- Every later write survives, including another tab's command, which is a step too and is
  re-applied by its reducer.
- A later `$reset`, a state a tab answered or a server's answer (below) keeps the state it set.
- An undo for a step the store does not hold, or for one already undone, changes nothing.
- A reducer that throws during the replay leaves the state as it was, and the `$undo` command
  fails.
- A reducer that computes only from its arguments rebases exactly. A reducer that mints a value,
  such as an id or a time, mints it again for each later step it replays.

[^rebase]: `tests/store-rollback-rebase.test.ts`.

**In development a store with `undo: true` runs each reducer twice**, as React's StrictMode
does, and warns once per action when the two results differ. Mint ids and times in the call,
`cart.add({ id: crypto.randomUUID(), name })`, and let the reducer only apply them. Production
runs each reducer once.[^twice]

[^twice]: `tests/store-reducer-twice.test.ts`.

**Undo is local.** A store's undo restores its own state and sends nothing. A command a
transport carried out reads `canUndo` false in history, because only the server can reverse what
the server applied: send a compensating command.[^remote-step] A sent action that got no reply
fails with `context.outcome: 'unknown'` when nothing identifies it. An optimistic action still
rolls it back to the last confirmed state, and its `done` carries the outcome. Re-read the
server, since the write may have landed.[^unidentified]

[^remote-step]: `tests/undo-remote-step.test.ts`.

[^unidentified]: `tests/retry-unidentified.test.ts`.

- The store keeps its last 256 steps. An older one reads `canUndo` false. `history` keeps 50 by
  default.
- A store's id and action keys cannot carry a `$`, because names with `$` are the library's
  (`store:invalid:name`).

**One undo reverses a command and the recorded commands it caused, and one redo replays them.**
A reaction's follow-up carries its cause (`causationId`). So a store derived from another through
a reaction stays right at every press, and the reaction does not run on the undo or the redo. A
press stops at a command it cannot undo. To derive a plain value, subscribe with
`$onField`.[^group]

[^group]: `tests/history-group.test.ts`, `tests/reaction-undo-redo.test.ts`.

A handler that dispatches a command of its own declares itself the cause:
`bus.dispatch('statsBump', t, { __causationId: cmd.meta.id })`, or for a store action
`stats.bump(t, { __causationId: cmd.meta.id })`. One undo then takes the child with its parent,
and a redo applies it once, because the parent's handler dispatches it again. A child that
declares nothing is its own step, and a redo of its parent applies it a second
time.[^child-redo]

[^child-redo]: `tests/history-child-redo.test.ts`.

**`canUndo` is true only while the store holds the state that action produced.**

- A change the history did not record (its `actions` or `actionFilter` left it out) moves it,
  and `undo()` then does nothing rather than undo that change too.
- A server's state that reached another tab moves it too, and `useCommandHistory`'s `canUndo`
  turns false.
- `canUndo` is history's check. A rollback (an optimistic action's failure, a transactional
  batch) reverses the step that failed and does not consult it. So the rebase above runs for an
  older step whose `canUndo` is false.[^undo-check]
- Without `undo: true`, a store's actions run exactly as they would with no
  history.[^store-undo]

[^undo-check]: `tests/undo-check.test.ts`.

[^store-undo]: `tests/store-undo.test.ts`.

Pinia reaches a fraction of this by growing a small bus inside itself, because no bus exists
underneath it. Here one does, so the store is the thin part.[^pinia] `docs/whitepaper.md`
section 3.6 and its appendix A.3 say why this package ships a state layer at all, and which
parts of that decision did not change.

[^pinia]: In Pinia 4.0.3, read 2026-10-06, that bus is about 60 lines: `action()` 44 and its `$onAction` subscriptions 15.

## A store behind a transport

A transport (`httpTransport`, `wsTransport`, `defineTransport`) is the work for the actions its
pattern covers: it sends them to the server. Such an action has no local change, so its reducer
is `null`. `reducers: { add: null }` still gives `cart.add()` and the action `cartAdd`.

- A function there could never run, and `useStore(bus)` refuses it with `core:invalid:handler`,
  unless the store is `optimistic` (below) or the transport declares `localFallback`.
- `null` on an action no transport sends is refused the same way.[^shadow]

[^shadow]: `tests/register-shadow-check.test.ts`.

The dispatch is `ok`, its value the answer's `state`. Whether that value is a store's state is
known by the side that declares it, never guessed:

- **The server declares it**, per reply: a `stores` member beside `state`, store states by store
  id. Each store with that id on the bus takes its state, whatever the command was. So a
  `checkout` can update the cart and the stock (docs/integrations/laravel.md shows the action's
  return).
- **The app declares it**, per store: `answer(state, value, cmd)` returns the next state from the
  command's own `state`. TanStack Query's `setQueryData` in `onSuccess` and Apollo's `update` do
  the same.
- **Neither**: the store keeps its state.

```ts
// the server replies { state: { order: 7 }, stores: { cart: { items: [] } } }
const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as number[] }),
  reducers: { add: null }, // sent: no local change
  answer: (_state, value) => value as { items: number[] }, // when cartAdd answers the cart
});
```

How the two are written:

- Both write as a step of the command that got the reply, inside the dispatch. So the store's
  `persist` saves it and a listener reads it, whichever command got the reply.[^declared]
- The command's own `answer` runs first and the states the server named last, so what the server
  named wins.
- History records the command once and cannot undo it, since only the server can reverse what it
  applied.
- A failed command writes nothing.
- A 202 answers an `Accepted`, which is not the final state. The `answer` and the declared states
  are written when its `done` settles ok, with its value, and `done` settles after
  them.[^accepted]
- Only an object is a state. An `answer` result or a declared state that is anything else,
  `null` included, is not written, and development warns once.
- With `optimistic: true` the store shows the change at once, and the reply replaces it (below).
- A store id is an external string. Only the reply's own keys are read (`src/dict.ts`), and an
  id with no store is ignored.[^answer-tests]

[^declared]: `tests/store-persist-declared.test.ts`.

[^accepted]: `tests/accepted-applies-on-done.test.ts`.

[^answer-tests]: `tests/store-bridged-answer.test.ts`, `tests/store-declared-by-server.test.ts`, `tests/store-answer-not-a-state.test.ts`.

**A server's push declares store states the same way:** a `stores` member in its data, over SSE,
Echo or a WebSocket ([contract.md](./contract.md#4-the-wire)). Each named store takes its state
through the same path, `version` included, on any bus, and then the event is emitted. A push is
not a command, so it is never sent, and the store's `persist` saves the pushed state. A store
that keeps steps (`undo: true`) keeps a pushed state through a rollback, as it keeps an
answer.[^push]

[^push]: `tests/inbound-push.test.ts`.

**Two writes in flight can be answered in any order.** The server may apply them in either
order, and the replies may arrive in either order. Only the server knows which state is newer, so
let it say so with a number that grows with each write it applies:

```ts
defineChamberStore('cart', {
  state: () => ({ rev: 0, items: [] as number[] }),
  reducers,
  answer: (_state, value) => value as { rev: number; items: number[] },
  version: (state) => state.rev, // an older answer never replaces a newer one
});
```

- The store writes an answer only when its version is higher than the one it holds. An ETag
  cannot do this: RFC 9110 defines it for equality, not order.
- A version that is not a number is written in arrival order, and development warns once.
- Without `version`, the last answer to arrive wins.

`exclusive: true` makes that safe too. It sends the store's sent actions one at a time, so the
server applies and answers them in the order they were sent. It orders the store's reads as well
as its writes, so a read in flight cannot land after a write's answer and put the older state
back.

```ts
const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/vc' }) } });
const useCart = defineChamberStore('cart', { state, reducers, answer, exclusive: true });
```

- Only the actions a transport sends take the store's turn. An action that runs locally runs at
  once: queued behind a server command, a reducer that command's handler wrote through would wait
  on itself.
- A write can wait for its store's read in flight, one round trip at most. While it waits, it
  already reads as pending in `commandState(bus).pending()`, from its dispatch, so a spinner
  bound to it lights through the wait.
- An answer with no `state` (the server's handler returned nothing) writes
  nothing.[^version]

[^version]: `tests/store-answer-version.test.ts`, `tests/store-optimistic.test.ts`.

**`optimistic: true` shows a sent action at once.** Its reducer applies before the server
answers.

- A failure rolls it back, with the later steps rebased.
- The answer replaces it.
- A plugin's refusal never shows it.
- The dispatch answers an `Accepted`, whose `done` settles with the server's answer.
- The change shows even while `exclusive` holds the command for its turn.
- History undoes it only when the store also declares `undo`.

The store's `answer` is `register`'s `answer` option: the bus calls it when a transport
answered. A `null` reducer is `register(action, null, { answer })`, the options of a sent action
with no handler.

## The bus is always an argument

`useStore(bus)`, never `useStore()`. There is no fallback to the shared bus, for two reasons:

- **The probe.** Reaching for `getCommandBus()` imports `chamber.ts`, whose top-level
  `probeVue()` then runs on any `vapor-chamber/store` import. That probe cannot resolve in a
  production bundle, and it is behind both of this package's shipped prod-only bugs. This module
  imports `vue` statically instead, which turns an upstream rename into a build error rather than
  a runtime null. That is also why it is a subpath: the root barrel is Vue-less by construction.
- **SSR.** Stores are cached per bus, so a per-request bus gets a per-request set of stores. A
  module global is the one thing that cannot give that, so defaulting to it would hand every
  request the same state.

With the bus a mandatory argument, the store is <!-- vc:sizeStoreRaw -->15.6<!-- /vc:sizeStoreRaw --> KB minified
(<!-- vc:sizeStore -->5.8<!-- /vc:sizeStore --> KB brotli), the `./store` row of
[BUNDLE-SIZES.md](./BUNDLE-SIZES.md).[^first-draft] Its built entry's one external is `vue`, and
no chunk in it is `chamber.js`, the bus or the root barrel.[^graph] What it holds:

- the store code both entries share.
- the failure module that mints the store's coded refusals (`store:missing:bus`,
  `store:missing:router`, `store:already:member`, `store:invalid:name`).
- the library's `$` names and the commands a transport carried out.
- the fast lane the field events ride.
- `saveTo` and `shareTabs`.

[^first-draft]: The first draft defaulted the argument and paid both costs while claiming not to. It measured 16.7 KB raw, against a design estimate of 1-2 KB.

[^graph]: `tests/chamber-store.test.ts` walks the built entry's graph.

## State is shallow and replaced wholesale

Every reducer returns a **new** state object:

```ts
reducers: {
  add: (s, id: number) => ({ items: [...s.items, id] }),   // yes
  bad: (s, id: number) => { s.items.push(id); return s; }, // no-op to the signal
}
```

State is a `shallowRef`. A `ref` wraps an array in a deep reactive proxy that wholesale
replacement never needs, and on the real dispatch path array state runs faster without
it.[^shallow]

- A reducer that mutates and returns the same object does not notify. That is why `$reset` and
  every action build fresh objects.
- `state` is exposed with a getter and no setter, so `cart.state.value = x` throws in strict
  mode. The bus is the only mutation channel.

[^shallow]: The A/B is `tests/signal-shallow-ab.test.ts`, and the dated figure is in [performance.md](./performance.md#reactive-runtime-notes-vue-36).

**`deep: true`** (the Vue entry) makes `state.value` Vue's reactive view of the state, for a form
whose nested fields a `v-model` mutates in place. Vue readers track those fields. The store keeps
the raw state, so a mutation in place is not a write: reducers get the raw state, and persist,
tab sharing and field events follow the store's actions.[^deep]

[^deep]: `tests/store-deep.test.ts`.

**`coalesce: true`** writes the state once per microtask, for a list that a burst of dispatches
fills, read by a `v-for`.

- Each of the store's actions and `$reset` chains on the pending state, and an action's result is
  the pending state.
- A state from outside the store (a server's, another tab's, a seed) is written at once, after
  the pending state lands. So a seeded store reads its seed when it is created, and
  `storeStates` reads a write made in the same tick.
- It is refused with `undo: true` or `optimistic: true` (`store:invalid:coalesce`), because the
  undo ring records each write as it lands.[^coalesce]

[^coalesce]: `tests/store-coalesce.test.ts`, `tests/store-facts-lane.test.ts`.

## Reading one field

A component that reads `cart.state.value.count` re-renders on every write of the store, because
`state` is one ref. To react to one field:

```ts
import { fieldRef } from 'vapor-chamber/store';

const count = fieldRef(cart, 'count');      // a read-only ref: count.value
cart.$onField('count', (n) => announce(n)); // or a plain callback; returns the unsubscribe
```

- Each fires only when a write changes that field, compared by identity.
- A store nobody subscribes to pays nothing on its writes.
- A store has one watcher, a synchronous Vue effect on its state. The first subscriber or `share`
  starts it, and `$dispose()` stops it. It feeds the field events and the tab
  send.[^one-watcher]
- A `computed` per field re-evaluates on every write of the store. `fieldRef` costs the writes the
  same however many fields are read. With one reader a `computed` is a little faster, and with
  several `fieldRef` is.[^field-ab]
- `$reset` and an undo notify like any action.[^field-events]
- A subscriber that throws is logged, and the write and the other subscribers go on.
- Subscribing or unsubscribing during a write works as for a `bus.on` listener. One removed is
  not called again, and one added is called from the next write.
- A write made in a subscriber is delivered after the current write, in order, so every
  subscriber ends on the store's state.[^field-delivery]

[^one-watcher]: `tests/store-one-watcher.test.ts`.

[^field-ab]: Log section 35.125.

[^field-events]: `tests/store-field-events.test.ts`.

[^field-delivery]: `tests/store-field-subscriber-throw.test.ts`, `tests/store-field-unsubscribe-during-write.test.ts`, `tests/store-write-during-delivery.test.ts`.

## Across tabs

```ts
import { defineChamberStore, shareTabs } from 'vapor-chamber/store';

const useCart = defineChamberStore('cart', { state, reducers, share: shareTabs() });
```

`shareTabs()` opens one `BroadcastChannel` per shared store, named `vc:store:<id>`, and
`shareTabs('name')` names it.

- Each write crosses as the command it came from: its action, target, payload and `meta.id`.
- Every other tab applies it with the store's own reducer, with no dispatch. No plugin, listener,
  reaction or transport runs it again, so the server never gets it twice.
- The tab's `history` records the same command, and its `persist` saves the state.
- A received command is not sent back.

**Undo follows the command, not the tab.** With tea in the cart, tab A adds coffee, and both
tabs show tea and coffee. An undo in either tab names the coffee command. It crosses as that
command's id, and every tab undoes it itself, so both show tea. A redo crosses as the command
again, and every history moves it back.[^propagate-undo]

[^propagate-undo]: `tests/store-propagate-undo.test.ts`.

**Two tabs that write at once end on one state, with both writes kept.** The store takes a Web
Lock named like its channel. The tab the browser grants it (the lead) runs every tab's command
and posts it on, and every other tab runs only what the lead posts.

- So two writes that set one field, two appends, or a `$reset` against an add end the same in
  every tab: the lead's run of them.
- A write still shows at once in its own tab. The lead's command may reach a tab before the lead
  has run that tab's own write. The tab then runs its own write again over the lead's, so its
  state becomes the lead's.
- Its history records the lead's command under its own write, as the other tabs' do, so Undo and
  Redo take the same step in every tab.
- Each tab runs the reducer, so mint ids and times in the call, as for
  `undo: true`.[^converge]

[^converge]: `tests/store-share-converge.test.ts`, `tests/store-share-history.test.ts`.

**A tab sends only while another tab is there.**[^late-tab]

- It asks when it opens, and the lead answers with the store's state. Until then the new tab
  holds its own writes, and over the answer it runs them again and sends them. What the lead sent
  before its answer is in that answer, so it is not applied again.
- A tab that leaves says so on `pagehide` and frees the lock. It asks again when the page comes
  back from the back-forward cache.
- When the lead leaves, the browser grants the lock to a waiting tab. Every other tab asks it and
  sends its own writes again, so none is lost.
- An undo stops at a state another tab sent, an answer or a server's state. The other tabs do not
  hold the commands under it, so the tab takes the state the undo reached.
- A tab alone sends its ask and, once granted the lock, its `lead`, then nothing. So a store in
  one tab writes at a plain store's cost.

[^late-tab]: `tests/store-share-late-tab.test.ts`, `tests/store-propagate-undo.test.ts`.

A new tab reads `state()` until the lead's answer, so `await cart.$ready` before a check that
reads the state. It resolves once the tab took the answer or, alone, was granted the lock (see
"Saved state" below).[^ready]

[^ready]: `tests/store-ready.test.ts`.

What it does not do:[^share-limits]

- A command crosses by structured clone, so it carries data. A function fails to send: the change
  stays in its tab, and development warns.
- A class instance arrives as a plain object, without its methods.
- With no `BroadcastChannel` (SSR) nothing opens.
- Without Web Locks nothing opens either, because no tab could run the commands for the others,
  and tabs could end on two states. Development warns `store:missing:locks`.
- A tab that does not hold an undone command (it opened later, or its ring moved past it) takes
  the state the undo reached.

[^share-limits]: `tests/store-share.test.ts`, `tests/store-rollback-rebase.test.ts`.

## URL-backed fields

Fields that belong in the URL should not also live in the store. Declare them, and they
delegate:

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

There is no signal behind a `url` field, so the URL stays the single writer, and a shared link
reproduces the view. Nothing has to be reconciled, because nothing is duplicated.

The router arrives as an argument for the same reason the bus does. A store with no `url` fields
never pulls the router into its graph. It is taken **structurally** (`StoreRouter`), so this
module imports nothing from `src/router`. Declaring `url` without passing a router is a named
error, not an undefined read.

## Lifecycle

```ts
useCart(bus) === useCart(bus)   // cached per bus
useCart(a) !== useCart(b)       // different bus, different store

cart.$reset()     // dispatches cart$reset: back to state(), as a fresh object
cart.$dispose()   // unregister handlers, drop from the registry
```

**A store is shared, so disposal is refcounted: the last holder out disposes, not the first one
in.** Every `useCart(bus)` call from inside an `effectScope` joins that scope to the store's
holder count, and leaves when the scope ends. The store is disposed when the count reaches zero.
So the first of two components that hold the same store does not take it away from the second
when it unmounts.

Called outside a scope, there is no lifetime to hook and nothing is counted. The caller owns
`$dispose()`, the same contract as every other composable here.

`$dispose()` always finishes. A cleanup that throws, such as an app's own `share` closing its
channel, is logged. The other cleanups still run and the store leaves the registry, so the next
`useCart(bus)` builds a new one.[^dispose]

[^dispose]: `tests/store-dispose-cleanup-throw.test.ts`.

**One id is one store per bus, for one definition.** A second `defineChamberStore` with the same
id takes over, the rule `register()` follows for a handler. That second one may be an edited store
module re-run by hot reload, or a module that picked the same id.

- The new definition builds its own store from its `state()` and registers its actions over the
  old ones.
- In development, `register()` warns once per action it overwrites, which is how a clash shows.
  The exception is a hot update the plugin marks, where the re-run is the update.
- The old store's `$dispose()` removes only what it still owns.[^redefine]

[^redefine]: `tests/store-redefine.test.ts`.

**A hot update keeps the store's state**, in development under `vaporChamberHMR()`. The plugin
marks the update, and a store built inside it starts from the state of the store it replaces: the
one it takes over (a store created at module load), or the one its component disposed before the
reloaded setup.

- The state is matched to the new `state()` by key, at every level of plain objects.
- A new key starts from its declared value, and a key the edit removed goes.
- A key the app added at runtime stays, so a dictionary declared `{}` keeps its entries.
- Outside the mark, a takeover builds from `state()`, in development and production
  alike.[^hmr]

[^hmr]: `tests/vapor/store-hmr.test.ts`, `tests/store-hot-update.test.ts`.

**`$reset()` is a command like any action:** it dispatches `<id>$reset` (`cart$reset`).

- The store's `persist` saves the reset state, `history` records it, a listener hears it and a
  plugin can refuse it.
- `cache` and `idempotent` never answer it from memory, and the sender's `pace` runs it at
  once.[^library-commands]
- It returns the dispatch result. On an async bus that is a promise, and the state is reset once
  it settles.
- The `$` keeps the name apart from an action of your own called `reset`, which is `cartReset`.
  Action names that contain `$` are reserved for the library, and a bus's `naming` rule does not
  check them.
- An action key cannot be one of the store's own members (`$id`, `state`, `url`, `$reset`,
  `$dispose`, `$onField`, `$ready`). It would replace the member, so `defineChamberStore` throws
  `store:already:member` and names the key.

[^library-commands]: `tests/library-commands-memory.test.ts`.

`$reset()` goes back to whatever `state()` returns at that moment, so keep `state()` the default.
A `state()` that reads storage makes the reset hand back the saved record, and the reset does
nothing.[^reset]

[^reset]: Pinned in `tests/store-reset-command.test.ts`.

### Saved state

`persist: saveTo({ key })` (from `vapor-chamber` or the store entries) saves the store's state
under a key, and reads it back when the store is created:

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

- The saved state is the store's first state. With none, or one the rules below refuse, the store
  starts on `state()`, and `$reset()` always goes back to it.
- The store saves after any of its writes, whatever wrote it: an action, `$reset`, an undo, a
  server's answer or push, another tab's state.
- A burst of writes in one task is saved once, with the last state, one microtask after it.
- A state the store already read or saved is not saved again.[^persist]

[^persist]: `tests/store-persist.test.ts`.

The options:

- **`key`** is needed: `saveTo` throws without it.
- **`storage`**: `localStorage` by default, `sessionStorage`, or any object with `getItem` and
  `setItem`. Blocked site data, a full quota or a storage that throws is warned, and the write it
  follows still succeeds.
- **`validate(state)`**: a check of the read state's shape. False refuses it, with a warning, and
  the store starts on `state()`.
- **`serialize`, `deserialize`**: JSON by default.

**`indexedDbStorage()` answers with promises,** so the store cannot have the saved state when it
is created. It starts on `state()` and takes the saved state when the read lands. The writes made
before then are replayed on top by the undo ring's rule: a reducer runs again, and a state set
whatever came before (`$reset`, a server's state) is kept. Nothing is saved before the read
lands, and an undo cannot take back a write made before it.[^idb]

[^idb]: `tests/store-persist-idb.test.ts`.

**`store.$ready` resolves once the store holds the state it starts from:** the saved state read,
and with `share` the other tabs' state taken. Await it before a check that reads the state.
Otherwise a new visit's "empty? add the starter lines" runs on `state()` and adds them again over
the saved cart:

```ts
const cart = useCart(bus);
await cart.$ready;
if (cart.state.value.items.length === 0) cart.add(starter);
```

It never waits on a field event. So it resolves when nothing was saved, when the saved state
equals `state()`, when the read fails and when the store is disposed first. A store with neither
`persist` on an async storage nor `share` is ready at once.[^ready-2]

[^ready-2]: `tests/store-ready.test.ts`.

### Loading state from the server

A store has no setter, so a state from the server enters it the way every change does: through
an action it declares.

```ts
cart.load(window.__CART__, { __origin: 'replay' });      // from the server
```

From the server, send the stores' **states**, not the commands that built them
(`vapor-chamber/ssr`):

- `storeStates(bus)` reads every store the request wrote into the page. A store still on its
  first state is left out, so the client's own load stands.
- `seedStores(bus, states)` gives them to the client's stores.
- The state is a fact, so the client ends exactly where the server did, a reducer that mints an
  id or a timestamp included.
- A store created later starts from its state. One already there takes it through its own write,
  so its `persist` saves it.[^ssr-states]

[^ssr-states]: `tests/ssr-store-states.test.ts`.

`liveStores(bus)`, beside them, lists the stores in use on a bus in the order they were created,
as a new array, so a loop may dispose or create stores. A disposed store and a seeded id with no
store are left out. It reads the registry the bus keeps, so no dispatch or write pays for
it.[^live-stores]

[^live-stores]: `tests/live-stores.test.ts`.

`__origin: 'replay'` marks the dispatch as restored state rather than a user action. It arrives
as `cmd.meta.origin`, so a listener can tell a load from what the user did. The store's
`persist` saves what was loaded, and `$reset()` still goes back to `state()`.[^load-saved]

[^load-saved]: Pinned in `tests/store-load-saved.test.ts`.

## Without Vue

`vapor-chamber/store/core` is the same store with no Vue in its graph, for an app on the bus
alone:

```ts
import { defineChamberStore } from 'vapor-chamber/store/core';
```

The same code serves both entries, so actions, `$reset`, undo, `$onField`, `share` and the coded
refusals behave the same. What differs:

- **The state cell** is the library's `signal()`: a plain `{ value }`, or a reactive signal once
  `configureAlienSignals()` (from `vapor-chamber/alien-signals`) has run. Then an alien-signals
  effect that reads `state.value` reruns on a write. Without either, react through the bus
  (`bus.on('cart*', ...)`) or `$onField`.
- **No scope, no holder count:** every caller owns `$dispose()`.
- **No `fieldRef`**, which returns a Vue ref. `$onField` gives the same per-field events.

`tests/store-core.test.ts` pins this, and checks that the built entry imports no Vue.

## Status

Experimental, like the router. The action-name convention (`cart` + `add` -> `cartAdd`) matches
`useCommandGroup`, and the shape is expected to move before it is marked stable.

### Open questions

Not answered yet:

- **The SSR shape.** Stores are already keyed per bus, so a per-request bus gets per-request
  state, and the isolation exists. Hydration has its one story ("Loading state from the server"
  above). What is missing is the server-side warning class.
