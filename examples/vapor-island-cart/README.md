# Vapor island cart example

A runnable demo of **light-DOM Vapor custom-element islands** coordinating through one
vapor-chamber command bus. The hand-rolled `client:load` / `client:visible` / `client:idle`
hydration mirrors Astro's client directives - for real Astro pages, see the
[exo-astro example](../exo-astro) instead.

Everything on the page is real, server-rendered HTML - visible with JavaScript off. JS only
*upgrades* `<vc-products>` and `<vc-cart>` in place into Vapor custom elements
(`defineVaporCustomElement(..., { shadowRoot: false })`, so page CSS still applies) and wires their
interactivity. The two islands never talk to each other directly: the products island dispatches
`cartAdd` onto the bus, the cart island reads reactive `cart` state the handler mutates.

| Island         | Role     | Bus usage                                                  |
|----------------|----------|------------------------------------------------------------|
| `<vc-products>`| Emitter  | `bus.dispatch('cartAdd', product)` from `@click`          |
| `<vc-cart>`    | Consumer | reads reactive `cart`; dispatches `cartClear/Undo/Redo`   |

The bus (`src/store.ts`) is wired with four plugins:

- **`logger`** - logs `cart.*` commands.
- **`history`** - bus-backed undo/redo for `cartAdd` (`cartUndo` / `cartRedo`).
- **`sync`** - cross-tab sync over a `BroadcastChannel`; open two tabs and watch them stay in step.
- **`persist`** - restores the cart from `localStorage` on reload.

## Run

```bash
npm install          # once, from the repo root
cd examples/vapor-island-cart
npm run dev
```

Open the printed URL (default `http://localhost:8889`).

The examples are npm **workspaces**, so one `npm install` at the repo root
installs all of them into a single `node_modules/` and symlinks the library into
it - the example always runs against your working tree, with nothing to re-sync
after an edit. The library `dist/` builds itself: the repo root has a `prepare`
script, and this example's `predev`/`prebuild` hooks build it on demand if
`dist/` is missing.

> **Note** - `@vitejs/plugin-vue` declares its peer as `vue@^3.2.25`, and npm
> refuses to match a prerelease (`3.6.0-rc.x`) against a non-prerelease range.
> The root `package.json` carries an `overrides` entry pinning that one peer to
> the root's own `vue`, which is why a root `npm install` resolves. This folder
> also keeps an `.npmrc` with `legacy-peer-deps=true`, which is what makes a
> STANDALONE `npm install` in this directory work - npm does not read it for a
> workspace install from the root. Either way the warning is cosmetic:
> plugin-vue 6 fully supports Vue 3.6.

## What to look for

- **HTML-first** - view source (or disable JS): the menu and cart are already there. Hydration only
  adds behaviour.
- **Island hydration strategies** - `src/main.ts` builds a `tag -> loader` map from
  `src/islands/*.vue` and hydrates on `client:load`, `client:visible` (IntersectionObserver), or
  `client:idle` (`requestIdleCallback`). The demo markup uses `client:load`.
- **Light-DOM custom elements** - the `.vue` islands have no `<style>`; with `shadowRoot: false`
  the page stylesheet (`src/style.css`) styles them directly.
- **Undo/redo** - add a few items, then use <-/->. Buttons disable via reactive `cantUndo`/`cantRedo`.
- **Cross-tab sync** - open the URL in two tabs and add items in one.

## Notes on the Vite config

`vite.config.ts` has no `vue` alias. It used to point `vue` at a with-vapor build; since Vue rc.5,
`vue.runtime.esm-bundler.js` re-exports `@vue/runtime-vapor` itself, and building this example with
and without the alias gave byte-identical output (the export list is pinned by
`tests/vue-bundler-vapor-exports.test.ts`). `vaporChamberHMR()` keeps bus state across HMR.

Aligned with Vue <!-- vc:vueAligned -->3.6.0-rc.8<!-- /vc:vueAligned --> and the working-tree vapor-chamber (`vapor-chamber: file:../..`).
