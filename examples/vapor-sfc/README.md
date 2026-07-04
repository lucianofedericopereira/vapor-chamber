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
cd examples/vapor-sfc
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`).

The example links to the repo's working tree via `file:../..`, so it always runs
against your local library code. The library `dist/` builds itself: the repo root
has a `prepare` script (runs on root `npm install` and on git installs), and this
example's `predev`/`prebuild` hooks build it on demand if `dist/` is missing.
No manual step.

## What to look for

- **CartPanel** — the loading button disables only itself, not the whole page.
  Each `useCommand` instance has its own `loading` signal.
- **SearchPanel** — type 2+ characters; watch the browser console for
  `[searchExecute]` lines. No reactive overhead per keystroke.
- **StatusBar** — observes both. The "loading…" indicator shows whenever any
  dispatch is in flight on the bus, regardless of which component triggered
  it. Erroring out (clicking "Add invalid product") populates the shared
  error list.

## Files

```
examples/vapor-sfc/
├── package.json          # workspace deps — vue@^3.6.0-beta.17, vite@^8
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
  swap to `"vapor-chamber": "^1.7.0"`.
- Vue 3.6 is currently in beta. The example pins to `^3.6.0-beta.17`. When
  Vue 3.6 ships stable, bump to `^3.6.0`.
- The example registers handlers inline in `App.vue` for clarity. In a real
  app, handlers live in feature modules and are installed at startup.
