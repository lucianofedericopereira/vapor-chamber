# Vapor island cart example

A runnable demo of **light-DOM Vapor custom-element islands** coordinating through one
vapor-chamber command bus. The hand-rolled `client:load` / `client:visible` / `client:idle`
hydration mirrors Astro's client directives — for real Astro pages, see the
[exo-astro example](../exo-astro) instead.

Everything on the page is real, server-rendered HTML — visible with JavaScript off. JS only
*upgrades* `<vc-products>` and `<vc-cart>` in place into Vapor custom elements
(`defineVaporCustomElement(..., { shadowRoot: false })`, so page CSS still applies) and wires their
interactivity. The two islands never talk to each other directly: the products island dispatches
`cart.add` onto the bus, the cart island reads reactive `cart` state the handler mutates.

| Island         | Role     | Bus usage                                                  |
|----------------|----------|------------------------------------------------------------|
| `<vc-products>`| Emitter  | `bus.dispatch('cart.add', product)` from `@click`          |
| `<vc-cart>`    | Consumer | reads reactive `cart`; dispatches `cart.clear/undo/redo`   |

The bus (`src/store.ts`) is wired with four plugins:

- **`logger`** — logs `cart.*` commands.
- **`history`** — bus-backed undo/redo for `cart.add` (`cart.undo` / `cart.redo`).
- **`sync`** — cross-tab sync over a `BroadcastChannel`; open two tabs and watch them stay in step.
- **`persist`** — restores the cart from `localStorage` on reload.

## Run

```bash
cd examples/vapor-island-cart
npm install
npm run dev
```

Open the printed URL (default `http://localhost:8889`).

The example links to the repo's working tree via `file:../..`, so it always runs
against your local library code. The library `dist/` builds itself: the repo root
has a `prepare` script (runs on root `npm install` and on git installs), and this
example's `predev`/`prebuild` hooks build it on demand if `dist/` is missing.
No manual step.

> **Note** — while Vue 3.6 is in beta, `@vitejs/plugin-vue` declares its peer as
> `vue@^3.2.25`, and npm refuses to match a prerelease (`3.6.0-beta.x`) against a
> non-prerelease range. This folder ships an `.npmrc` with `legacy-peer-deps=true`
> so `npm install` just works. The peer warning is cosmetic — plugin-vue 6
> fully supports Vue 3.6.

## What to look for

- **HTML-first** — view source (or disable JS): the menu and cart are already there. Hydration only
  adds behaviour.
- **Island hydration strategies** — `src/main.ts` builds a `tag → loader` map from
  `src/islands/*.vue` and hydrates on `client:load`, `client:visible` (IntersectionObserver), or
  `client:idle` (`requestIdleCallback`). The demo markup uses `client:load`.
- **Light-DOM custom elements** — the `.vue` islands have no `<style>`; with `shadowRoot: false`
  the page stylesheet (`src/style.css`) styles them directly.
- **Undo/redo** — add a few items, then use ↩/↪. Buttons disable via reactive `cantUndo`/`cantRedo`.
- **Cross-tab sync** — open the URL in two tabs and add items in one.

## Notes on the Vite config

`vite.config.ts` aliases `vue` to `vue/dist/vue.runtime-with-vapor.esm-browser.js`. Vue's default
runtime entry ships **no** Vapor runtime, and both the compiled Vapor SFC helpers and
vapor-chamber's `defineVaporCustomElement` probe read off `import('vue')` — so the alias points
`vue` at the build that actually contains Vapor. `vaporChamberHMR()` keeps bus state across HMR.

Aligned with Vue 3.6.0-beta.15 and vapor-chamber ≥1.6.0 (`vapor-chamber: file:../..`).
