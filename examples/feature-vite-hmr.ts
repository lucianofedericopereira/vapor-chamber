/**
 * Feature example: vaporChamberHMR — Vite state-preserving hot reload
 * ====================================================================
 * Without this plugin, each HMR update resets the bus: handlers are lost,
 * state is cleared, and the page feels like a full reload.
 *
 * With it: handlers survive, state is preserved, HMR is transparent.
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

// ─── main.ts — unchanged; HMR is transparent ────────────────────────────────

import {
  createCommandBus,
  setCommandBus,
  useCommandState,
} from 'vapor-chamber'

const bus = createCommandBus()
setCommandBus(bus)

// This handler survives HMR — the bus is preserved across module reloads
bus.register('cartAdd', (cmd) => {
  console.log('cartAdd handler still registered after HMR ✓')
  return { added: cmd.target }
})

// State also survives — items in the cart stay after a component hot-reload
const { state: cartState } = useCommandState(
  { items: [] as string[], count: 0 },
  {
    'cartAdd':    (s, cmd) => ({ items: [...s.items, cmd.target.name], count: s.count + 1 }),
    'cartRemove': (s, cmd) => ({ items: s.items.filter(n => n !== cmd.target.name), count: s.count - 1 }),
  }
)

bus.dispatch('cartAdd', { name: 'T-Shirt' })
// → State: { items: ['T-Shirt'], count: 1 }
// → After HMR: still { items: ['T-Shirt'], count: 1 }  (not reset)

/*
 * How it works:
 *
 * 1. On first load: bus is stored on globalThis.__VAPOR_CHAMBER_BUS__
 * 2. On HMR update: the preserved bus is restored via setCommandBus()
 * 3. New handler registrations from the updated module are added to the same bus
 * 4. The reactive state (useCommandState signals) also persists because it's
 *    backed by Vue's reactive system which survives module replacement
 *
 * The plugin injects a shim import into every file that imports vapor-chamber,
 * so no manual code changes are needed anywhere in the app.
 */

export { bus, cartState }
