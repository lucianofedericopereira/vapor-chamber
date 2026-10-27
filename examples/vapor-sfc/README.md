# Vapor SFC example

End-to-end runnable demo of vapor-chamber composables in a `<script setup vapor>`
SFC tree. Three panels show three usage patterns side by side:

| Panel        | Piece                                   | What it shows                                                    |
|--------------|-----------------------------------------|------------------------------------------------------------------|
| `CartPanel`  | `useCommand()`, a cart store, directives | A busy state per button, `pending('cartAdd', { id })`, and the cart the server confirmed |
| `SearchPanel`| `useCommand({ debounce })`              | Search as you type: the last text is sent, its results are shown |
| `StatusBar`  | `useSharedCommandState()`               | The whole bus: anything in flight, every failed command          |

`src/shop.ts` builds the bus with `httpTransport` and shares it. Its server is a
stand-in that lives in the page: an HTTP client whose `post` answers the wire
contract after a delay. The cart is a store the server writes (`answer`), so no
panel keeps a copy. `createVaporChamberApp` (the lib's wrapper around Vue 3.6's
`createVaporApp`) mounts the app.

## Run

```bash
npm install          # once, from the repo root
cd examples/vapor-sfc
npm run dev
```

Open the printed URL (default `http://localhost:5173`).

The examples are npm **workspaces**, so one `npm install` at the repo root
installs all of them into a single `node_modules/` and symlinks the library into
it - the example always runs against your working tree, with nothing to
re-sync after an edit. The library `dist/` builds itself: the repo root has a
`prepare` script, and this example's `predev`/`prebuild` hooks build it on demand
if `dist/` is missing.

Most CI jobs install the root project alone (`npm ci --workspaces=false
--include-workspace-root`). The `examples` job installs the workspaces, builds
the library and runs `npm run check:example`, which builds every example.

## What to look for

- **CartPanel** - the pressed button marks only itself busy (`aria-disabled`, so keyboard focus
  stays on it), not the other one or the page: each reads the key it
  dispatches, `pending('cartAdd', { id })`. "Add invalid product" shows the
  server's refusal. The third button asks for more than the stock when qty is
  above 10: `v-vc-optimistic` shows the count at once and takes it back.
- **SearchPanel** - type at least 2 characters (try `usb`). The search waits for a
  pause, sends the last text only, and lists the results. An older answer never
  replaces a newer one.
- **StatusBar** - its error list observes every failed dispatch on the bus. Its
  "loading..." indicator is `anyPending`: any command in flight, so a Cart click or a
  search lights it.

## Files

```
examples/vapor-sfc/
├── package.json          # workspace member - vue@<!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->, vite@^8
├── vite.config.ts        # @vitejs/plugin-vue + vaporChamberHMR
├── tsconfig.json         # strict TS, ES2022, vite/client types
├── index.html            # mount point + minimal styles
└── src/
    ├── main.ts           # createVaporChamberApp(App).mount('#app')
    ├── shop.ts           # the bus, its stand-in server and the cart store
    ├── App.vue           # composes the three panels
    ├── CartPanel.vue     # busy per button, the cart, the directives
    ├── SearchPanel.vue   # useCommand({ debounce }) with results
    └── StatusBar.vue     # useSharedCommandState
```

## Build

```bash
npm run build      # vue-tsc check + vite build
npm run preview    # serve the production build locally
```

## Notes

- This example uses the **local checkout** of vapor-chamber via
  `"file:../.."` in `package.json`. To run against a published version,
  swap to `"vapor-chamber": "^<!-- vc:version -->1.33.0<!-- /vc:version -->"`.
- Vue 3.6 is in **release candidate**. The example pins the RC the library is
  aligned to, `^<!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->`, and
  that pin is owned by the root `devDependencies.vue` - `npm run docs:stamp`
  rewrites it, and `lint:check` fails when the two disagree. When Vue 3.6 ships
  stable, bump the root and re-stamp. Nothing here is retyped by hand.
- To talk to a real backend, drop the `httpClient` option in `shop.ts`: the
  transport posts to `/api/vc`.
