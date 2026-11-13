/**
 * Feature example: vaporChamberHMR - a hot update keeps the bus and the cart
 * ==========================================================================
 * Edit the module that holds your handlers and your store, and Vite runs it
 * again. The shared bus stays and the cart keeps its items: the plugin marks
 * the update, and the store the module builds starts from the state of the one
 * it replaces (docs/store.md). Without the plugin the same edit gives an empty
 * cart.
 *
 * Two files, one app: the config, and the module a component imports.
 */

// --- vite.config.ts ---------------------------------------------------------

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vaporChamberHMR } from 'vapor-chamber/vite'

export default defineConfig({
  plugins: [
    vue(),
    vaporChamberHMR({ verbose: true }), // logs each hot update to the console (serve only)
  ],
})

// --- src/cart.ts ------------------------------------------------------------

// One entry for a Vue app: `vapor-chamber/vue` carries the bus too, and
// wires Vue (the root would not).
import { getCommandBus } from 'vapor-chamber/vue'
import { defineChamberStore } from 'vapor-chamber/store'

// The shared bus, not a new one: a store belongs to its bus, so a re-run
// module that made its own bus would start every store from nothing.
const bus = getCommandBus()

// An edited handler replaces the old one when the module re-runs.
bus.register('cartCheckout', (cmd) => {
  console.log('cartCheckout runs, handler edited or not')
  return { ordered: cmd.target }
})

type Cart = { items: string[]; count: number }
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [], count: 0 }),
  reducers: {
    add:    (s: Cart, item: { name: string }) => ({ items: [...s.items, item.name], count: s.count + 1 }),
    remove: (s: Cart, item: { name: string }) => ({ items: s.items.filter((n) => n !== item.name), count: s.count - 1 }),
  },
})

// Outside a component, for brevity: in an app a component calls `useCart(bus)`
// in setup() and the store leaves with it. Here the module owns the store, and
// a re-run takes it over with its state.
const cart = useCart(bus)

// A component calls `cart.add({ name })` (the command `cartAdd`) or
// `bus.dispatch('cartCheckout', order)`, and reads `cart.state.value`.
export { bus, cart }
