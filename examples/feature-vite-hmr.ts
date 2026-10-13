/**
 * Feature example: vaporChamberHMR - Vite hot reload that keeps the bus
 * =====================================================================
 * Without this plugin, each HMR update resets the bus: handlers are lost,
 * state is cleared, and the page feels like a full reload.
 *
 * With it: the bus and its handlers survive a hot update. A re-run module
 * still builds its own state again from the initial value.
 */

// ─── vite.config.ts ──────────────────────────────────────────────────────────

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vaporChamberHMR } from 'vapor-chamber/vite'

export default defineConfig({
  plugins: [
    vue(),
    vaporChamberHMR({
      verbose: true,    // log HMR events to console (dev only)
    }),
  ],
})

// ─── main.ts - unchanged; HMR is transparent ────────────────────────────────

// One entry for a Vue app: `vapor-chamber/vue` carries the bus too, and
// wires Vue (the root would not).
import { createCommandBus, setCommandBus, useCommandState } from 'vapor-chamber/vue'

const bus = createCommandBus()
setCommandBus(bus)

// This handler survives HMR - the bus is preserved across module reloads.
// Its own action: useCommandState below registers a handler per action in
// its map, and a second register of one action replaces the first.
bus.register('cartCheckout', (cmd) => {
  console.log('cartCheckout handler still registered after HMR ✓')
  return { ordered: cmd.target }
})

// This state does not survive a hot update: the re-run module builds it again
// from the initial value. Only the bus is kept.
// Outside a component, for brevity: in an app this runs in setup(). Here nothing
// disposes it automatically (the DEV heads-up says so); call dispose() when done.
const { state: cartState } = useCommandState(
  { items: [] as string[], count: 0 },
  {
    'cartAdd':    (s, cmd) => ({ items: [...s.items, cmd.target.name], count: s.count + 1 }),
    'cartRemove': (s, cmd) => ({ items: s.items.filter(n => n !== cmd.target.name), count: s.count - 1 }),
  }
)

bus.dispatch('cartAdd', { name: 'T-Shirt' })
// -> State: { items: ['T-Shirt'], count: 1 }
// -> After HMR: a new state, { items: [], count: 0 }, until this re-run
//    module dispatches cartAdd again and shows count: 1.

bus.dispatch('cartCheckout', { id: 1 })
// -> logs "cartCheckout handler still registered after HMR ✓"

/*
 * How it works:
 *
 * 1. On first load: bus is stored on globalThis.__VAPOR_CHAMBER_BUS__
 * 2. On HMR update: the preserved bus is restored via setCommandBus()
 * 3. New handler registrations from the updated module are added to the same bus
 * 4. The useCommandState signals are not kept: the re-run module creates new
 *    ones from their initial values.
 *
 * The plugin injects a shim import into every script (.ts, .js, .tsx, .jsx)
 * that imports vapor-chamber, never into a .vue file. One import reaches the
 * whole module graph, so no manual code changes are needed anywhere in the app.
 */

export { bus, cartState }
