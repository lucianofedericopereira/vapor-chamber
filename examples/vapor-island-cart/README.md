# Vapor island cart example

A runnable demo of **light-DOM Vapor custom-element islands** that coordinate through one
vapor-chamber command bus. The `client:load` / `client:visible` / `client:idle` hydration,
`defineWidget`'s `when`, mirrors Astro's client directives. For real Astro pages, see the
[exo-astro example](../exo-astro) instead.

Everything on the page is real, server-rendered HTML, visible with JavaScript off. JS only
*upgrades* `<vc-products>` and `<vc-cart>` in place into Vapor custom elements
(`defineVaporCustomElement(..., { shadowRoot: false })`, so page CSS still applies) and wires
their interactivity. The two islands never talk to each other directly: the products island
dispatches `cartAdd` onto the bus, and the cart island reads the `cart` store's state.

| Island         | Role     | Bus usage                                                  |
|----------------|----------|------------------------------------------------------------|
| `<vc-products>`| Emitter  | `dispatch('cartAdd', product)` from `@click`           |
| `<vc-cart>`    | Consumer | reads `cart.state`, and calls `cart.$reset()`, `history.undo()` and `redo()` |

The cart is one store (`src/store.ts`), and what the page needs of it are options on it:

- **`undo: true`:** each action's inverse is the state it replaced. `useCommandHistory` records
  `cartAdd` and gives reactive `canUndo` and `canRedo`. Clear (`cart.$reset()`) is not undone.
- **`persist: saveTo({ key })`:** the cart comes back after a reload.
- **`share: shareTabs()`:** the cart is the same in every open tab. Each write crosses as the
  command that made it, and every tab runs the store's own reducer. An undo crosses as the id of
  the command it reverses, so Undo in either tab removes the last add in both. A tab that opens
  asks the others for the state.

A `logger` on the bus prints the `cart*` commands. Open two tabs and watch them stay in step.

## Run

```bash
npm install          # once, from the repo root
cd examples/vapor-island-cart
npm run dev
```

Open the printed URL (default `http://localhost:8889`).

The examples are npm **workspaces**, so one `npm install` at the repo root installs all of them
into a single `node_modules/` and symlinks the library into it. The example always runs against
your working tree, with nothing to re-sync after an edit. The library's `dist/` builds itself:
the repo root has a `prepare` script, and this example's `predev`/`prebuild` hooks build it on
demand if `dist/` is missing.

> **Note:** `@vitejs/plugin-vue` declares its peer as `vue@^3.2.25`, and npm refuses to match a
> prerelease (`3.6.0-rc.x`) against a non-prerelease range. The root `package.json` carries an
> `overrides` entry pinning that one peer to the root's own `vue`, which is why a root
> `npm install` resolves. Install from the root: this folder has no `.npmrc` of its own. Either
> way the warning is cosmetic, since plugin-vue 6 fully supports Vue 3.6.

## What to look for

- **HTML first:** view the source (or disable JS). The menu and cart are already there, and
  hydration only adds behaviour.
- **Island hydration strategies:** `src/main.ts` defines one widget per `src/islands/*.vue`
  with `defineWidget(tag, loader, { when })`. The tag's first element carries `client:load`,
  `client:visible` (one shared IntersectionObserver) or `client:idle`
  (`requestIdleCallback`). The demo markup uses `client:load`.
- **Light-DOM custom elements:** the `.vue` islands have no `<style>`. With `shadowRoot: false`,
  the page stylesheet (`src/style.css`) styles them directly.
- **Undo and redo:** add a few items, then use <- and ->. The buttons go `aria-disabled` from
  `canUndo` and `canRedo` (not `disabled`, which would drop keyboard focus on the last undo). A
  tab that opened after the add holds no command to undo, so its Undo reads disabled until it
  adds something itself.
- **Heard, not only seen:** each add is announced through the library's `announce()`.
- **Cross-tab sync:** open the URL in two tabs, add items in one, then press Undo in the other.

## Notes on the Vite config

`vite.config.ts` has no `vue` alias, because `vue.runtime.esm-bundler.js` re-exports
`@vue/runtime-vapor` itself.[^exports] `vaporChamberHMR()` marks a hot update, so the cart store
keeps its state. After rebuilding the library, delete `node_modules/.vite`, or Vite serves the old
pre-bundled copy.

[^exports]: The export list is pinned by `tests/vue-bundler-vapor-exports.test.ts`.

Aligned with Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> and the working-tree vapor-chamber (`vapor-chamber: file:../..`).
