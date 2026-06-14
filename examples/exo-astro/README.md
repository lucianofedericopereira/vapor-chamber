# exo on Astro example

Declarative **event-bus directives for Astro pages** over one vapor-chamber bus.
Astro renders static HTML; the only client JavaScript is the bus plus a ~150-line
directive scanner ([src/directives/index.ts](src/directives/index.ts)). No
framework runtime, no islands, no shared mutable state between sections.

Four directives, one rule:

| Directive | Does |
|---|---|
| `v-scope='{"open":false}'` | declare reactive local state (inline JSON) |
| `v-bind-text="cart.count"` | reactive `textContent` via dot-path |
| `v-show="cart.hasItems"` | toggle `display:none` on truthiness |
| `v-command="cart.add"` | dispatch a named bus command on click (`v-target` / `v-payload` JSON companions) |

**The only write path is `v-command`** — every mutation goes through a named
command handler. Sector A dispatches named commands into the void; Sector B
reads reactive state from the atmosphere. Complete decoupling, and the whole
vapor-chamber plugin pipeline (logging, validation, history, persist, sync)
applies automatically — the bus instance is already there.

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

```bash
cd examples/exo-astro
npm install
npm run dev
```

Open `http://localhost:8890` and click "Add" **during the first 2 seconds** —
watch the buffered clicks land when the hydration note flips to ✅.

The example links to the repo's working tree via `file:../..`, so it always runs
against the latest library code; `predev`/`prebuild` hooks build the lib `dist/`
on demand (the repo root also builds it via its `prepare` script on install).

To use this pattern standalone (outside this repo), install vapor-chamber
straight from its git repo — the authoritative source while releases lag:

```bash
npm install github:lucianofedericopereira/vapor-chamber
```

and copy `src/directives/index.ts` into your Astro project.
