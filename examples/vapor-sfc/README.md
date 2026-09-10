# Vapor SFC example

End-to-end runnable demo of vapor-chamber composables in a `<script setup vapor>`
SFC tree. Three panels show three usage patterns side by side:

| Panel        | Composable                        | When to use                                                       |
|--------------|-----------------------------------|-------------------------------------------------------------------|
| `CartPanel`  | `useCommand()`               | Per-component reactive `loading` / `lastError` (button-scoped UI) |
| `SearchPanel`| `defineVaporCommand()`            | Fire-and-forget hot paths (telemetry, scroll, keystroke search)   |
| `StatusBar`  | `useSharedCommandState()`         | Cross-component aggregate state (toolbars, status bars)           |

The bus is bootstrapped by `createVaporChamberApp` (the lib's wrapper around
Vue 3.6's `createVaporApp`), and the Vite HMR plugin preserves bus state
across hot reloads.

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
if `dist/` is missing. No manual step.

CI installs the root project alone (`npm ci --workspaces=false
--include-workspace-root`), since no CI job builds an example.

## What to look for

- **CartPanel** - the loading button disables only itself, not the whole page.
  Each `useCommand` instance has its own `loading` signal.
- **SearchPanel** - type 2+ characters; watch the browser console for
  `[searchExecute]` lines. No reactive overhead per keystroke.
- **StatusBar** - observes both. The "loading..." indicator shows whenever any
  dispatch is in flight on the bus, regardless of which component triggered
  it. Erroring out (clicking "Add invalid product") populates the shared
  error list.

## Files

```
examples/vapor-sfc/
├── package.json          # workspace member - vue@<!-- vc:vueAligned -->3.6.0-rc.7<!-- /vc:vueAligned -->, vite@^8
├── vite.config.ts        # @vitejs/plugin-vue + vaporChamberHMR
├── tsconfig.json         # strict TS, ES2022, vue:client types
├── index.html            # mount point + minimal styles
└── src/
    ├── main.ts           # createVaporChamberApp(App).mount('#app')
    ├── App.vue           # registers handlers, composes the three panels
    ├── CartPanel.vue     # useCommand pattern
    ├── SearchPanel.vue   # defineVaporCommand pattern
    └── StatusBar.vue     # useSharedCommandState pattern
```

## Build

```bash
npm run build      # vue-tsc check + vite build
npm run preview    # serve the production build locally
```

## Notes

- This example uses the **local checkout** of vapor-chamber via
  `"file:../.."` in `package.json`. To run against a published version,
  swap to `"vapor-chamber": "^<!-- vc:version -->1.19.0<!-- /vc:version -->"`.
- Vue 3.6 is in **release candidate**. The example pins the RC the library is
  aligned to, `^<!-- vc:vueAligned -->3.6.0-rc.7<!-- /vc:vueAligned -->`, and
  that pin is owned by the root `devDependencies.vue` - `npm run docs:stamp`
  rewrites it, and `lint:check` fails when the two disagree. When Vue 3.6 ships
  stable, bump the root and re-stamp. Nothing here is retyped by hand.
- The example registers handlers inline in `App.vue` for clarity. In a real
  app, handlers live in feature modules and are installed at startup.
