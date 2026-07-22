# exo on Astro example

Declarative **event-bus directives for Astro pages** over one vapor-chamber bus.
Astro renders static HTML; the only client JavaScript is the bus plus a
single-file directive scanner ([src/directives/index.ts](src/directives/index.ts)).
No framework runtime, no islands, no shared mutable state between sections.

Five directives, one rule:

| Directive | Does |
|---|---|
| `v-scope='{"open":false}'` | declare reactive local state (inline JSON) |
| `v-bind-text="cart.count"` | reactive `textContent` via dot-path |
| `v-show="cart.hasItems"` | toggle `display:none` on truthiness |
| `v-each="items"` | repeat a row prototype once per array entry, each clone scoped to its item |
| `v-command="cart.add"` | dispatch a named bus command on click (`v-target` / `v-payload` JSON companions) |

`v-each` takes its row prototype from a `<template>` child, or — for table
sections, where parsers disagree about `<template>` and a dropped one silently
becomes a real row — from the first element child, which it detaches:

```html
<tbody v-each="items">
  <tr><td v-bind-text="name"></td><td v-bind-text="price"></td></tr>
</tbody>
```

**An element that starts hidden must say so in the HTML** — `style="display:none"`
next to its `v-show`. The script is a module, so it runs after parse: without
it, the empty cart's table and buttons paint first and vanish a frame later.
The markup owns the initial state, the directive owns every state after it.

**The only write path is `v-command`** — every mutation goes through a named
command handler. Sector A dispatches named commands into the void; Sector B
reads reactive state from the atmosphere. Complete decoupling, and the whole
vapor-chamber plugin pipeline (logging, validation, history, persist, sync)
applies automatically — the bus instance is already there.

Local state is not an exception to that rule: a binding reads from the nearest
`v-scope` that **declared** its head key and falls through to the global bus
state otherwise, so one subtree mixes both freely — and the handler that flips
local state writes it via `scopeOf(el)`, never the click site.

Two properties worth knowing if you copy the file: reactivity is **deep**
(`cart.count = 7` re-runs the same effects a top-level write does, which is what
keeps dot-path bindings live), and `scan()` is **idempotent** — re-running it on
`astro:page-load` after a client-side page swap re-wires new nodes without
double-binding clicks or resetting live scope state.

The scanner's contract is pinned by
[`tests/examples/exo-astro-directives.test.ts`](../../tests/examples/exo-astro-directives.test.ts)
in the repo suite — `npm test` from the repo root covers this example too.

## The headline: dispatch before hydration

The demo registers its handlers **2 seconds late** on purpose. Clicks made
before that are not lost — the bus is created with:

```ts
const bus = createCommandBus({
  onMissing: 'buffer',     // queue commands with no handler yet (v1.5.0)
  bufferTTL: 30_000,       // reap commands that wait > 30s (v1.6.0)
  onBufferOverflow: (action, dropped) => console.warn(action, dropped), // v1.6.0
});
```

Buffered commands replay in order the moment `register()` happens. `bufferTTL`
guarantees a section that never hydrates can't pin stale clicks in memory, and
`onBufferOverflow` makes every drop observable. This is the exact use case the
buffer mode was built for.

## Run

Needs **Node ≥ 22.12** — Astro 7's own floor. (vapor-chamber itself still runs
on Node ≥ 20.19; only this example carries the higher bar.)

```bash
cd examples/exo-astro
npm install
npm run dev
```

Astro's dev toolbar will report **"No islands detected"**. That is the point,
not a problem: this page ships no framework component and no `client:*`
directive — just static HTML plus one plain `<script>` module holding the bus
and the scanner. The toolbar's audit only knows how to look for islands.

Open `http://localhost:8890` and click "Add" **during the first 2 seconds** —
watch the buffered clicks land when the hydration note flips to ✅. Then hit
"Details": that toggle is local `v-scope` state written by a bus handler, while
the text inside it reads bus state through the same binding.

The example links to the repo's working tree via `file:../..`, so it always runs
against the latest library code; `predev`/`prebuild` hooks build the lib `dist/`
on demand (the repo root also builds it via its `prepare` script on install).

To use this pattern standalone (outside this repo), install vapor-chamber
straight from its git repo — the authoritative source while releases lag:

```bash
npm install github:lucianofedericopereira/vapor-chamber
```

and copy `src/directives/index.ts` into your Astro project.
