# exo on Astro example

**Static Astro HTML made live by attributes alone**, over one vapor-chamber bus.
Astro renders the page at build time. The only client JavaScript is the bus, two
small stores ([src/store.ts](src/store.ts)) and the library's page bindings. No
framework runtime, no islands, no scanner of the example's own.

| Attribute | Does |
|---|---|
| `data-vc-command="cartAdd"` | dispatch that command on click (`data-vc-target` and `data-vc-payload` hold JSON) |
| `data-vc-text="cart.count"` | set the text from a store field (`<store id>.<field>`) |
| `data-vc-show="cart.count"` | hide the element unless the field is truthy and not an empty array |
| `data-vc-each="cart.items"` | clone the `<template>` child once per entry, each row reading its own entry |

`bindCommands(root, { bus })` gives a `data-vc-command` element what a Vue
`v-vc-command` has: it ignores a press in flight, sets `aria-disabled` and
`vc-loading` meanwhile, sets `vc-error` and announces a failure. `bindDisplay`
draws the text, show and each attributes from a store, once at bind time and
again on each write of the field. Both are the library's own, so the example
carries no reactivity of its own.

**The only write path is a command.** Section A dispatches named commands onto
the bus without knowing who handles them. Section B reads the cart store without
knowing who wrote it. Even the Details toggle is a command (`uiToggleDetails`),
and its state, whether the note is open, lives in a small `ui` store. Clear is
the store's own `cart$reset`.

**Whatever starts hidden says so in the HTML**: a `hidden` attribute next to its
`data-vc-show`. The script is a module, so it runs after parse. Without the
attribute the empty cart's table would paint first and vanish a frame later. The
markup owns the first paint and the binding owns every state after it.

A reducer formats what the page prints (`$8.00`), because a display binding only
prints the string it is handed.

## The headline: dispatch before hydration

The demo creates its stores **2 seconds late** on purpose. Clicks made before
that are not lost. The bus is created with:

```ts
const bus = createCommandBus({
  buffer: createBuffer({     // hold commands with no handler yet
    ttl: 30_000,             // drop commands that wait > 30s
    onDrop: (action, dropped) => console.warn(action, dropped),
  }),
});
bindCommands(document.body, { bus });   // wired at load, before any store
```

A store registers its actions when `useCart(bus)` runs, and the held commands
run then, in order. A held click answers an `Accepted`, whose `done` settles
with the handler's result. `ttl` keeps a section that never hydrates from
pinning stale clicks in memory, and `onDrop` makes every drop observable.
`bindDisplay` runs after the stores exist, so it draws the state the replay
reached. A display bound before its store is a development warning
(`bind:missing:store`).

## Run

It needs **Node 24.5.0 or later**, the library's floor. Astro 7.4's own floor,
22.23.4, is below it.

```bash
cd examples/exo-astro
npm install
npm run dev
```

Astro's dev toolbar reports **"No islands detected"**. That is intended:
this page ships no framework component and no `client:*` directive, just static
HTML plus one plain `<script>` module holding the bus and the stores. The
toolbar's audit only knows how to look for islands.

Open `http://localhost:8890` and click "Add" **during the first 2 seconds**.
Watch the buffered clicks land when the note under the title says "Hydrated".
Add `?delay=8000` to widen the window. Each change is also spoken through the
library's shared live region (`announce()`), so a screen reader user hears what
a sighted one sees change. Then press "Details": that toggle is the `ui` store's
`open` field, while the text inside it reads the cart store.

The example links to the repo's working tree through `file:../..`, so it always runs
against the latest library code. The `predev` and `prebuild` hooks build the
library's `dist/` on demand.

To use this pattern standalone (outside this repo), install vapor-chamber
straight from its git repo, the authoritative source while releases lag:

```bash
npm install github:lucianofedericopereira/vapor-chamber
```

and copy `src/store.ts` and the page's `<script>` into your Astro project.
