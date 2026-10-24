/**
 * Feature example: vaporChamberWire - a root-only app that works in a build
 * =========================================================================
 * An app that imports only from the package root (`vapor-chamber`) needs this
 * plugin on Vite. The root can only look for Vue at runtime, and that lookup
 * fails in a production bundle: `pending` would never change. With the plugin
 * a build wires the root to Vue statically, so the lookup and its dynamic
 * `import('vue')` fold out of the bundle. Under the dev server it does not
 * redirect. It defines `__VC_WIRED__`, which quiets the root's DEV hint to
 * import from `vapor-chamber/vue`, and `__VC_LEAN__` from its `profile` option.
 *
 * Two files, one app: the config, and an app that imports the root alone.
 */

// --- vite.config.ts ---------------------------------------------------------

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { vaporChamberHMR, vaporChamberWire } from 'vapor-chamber/vite'

export default defineConfig({
  plugins: [
    vue(),
    vaporChamberWire({
      // 'vapor' when the app calls the library's Vapor API (createVaporChamberApp,
      // a defineVapor* component wrapper): those then come from
      // `vapor-chamber/vapor`. Default: 'vue'.
      entry: 'vue',
      // 'lean' trades speed for memory where the library offers the choice
      // (today: commandState().pending's per-key slots). Default: 'performance'.
      profile: 'performance',
    }),
    vaporChamberHMR(), // the two compose: HMR is serve-only, wiring build-only
  ],
})

// esbuild or webpack: no plugin; import the composables from
// 'vapor-chamber/vue' (or '/vapor') and define `__VC_WIRED_BUILD__: 'true'`.

// --- src/main.ts ------------------------------------------------------------

import { createApp, defineComponent, h } from 'vue'
import { createAsyncCommandBus, setCommandBus, useCommand } from 'vapor-chamber' // the root only

const bus = createAsyncCommandBus()
setCommandBus(bus)

bus.register('orderSubmit', async () => {
  await new Promise((resolve) => setTimeout(resolve, 600))
  return { ordered: true }
})

// Built with the plugin, the button shows "Ordering..." while the command is in
// flight. Click it on the built page.
const Order = defineComponent({
  setup() {
    const cmd = useCommand()
    const order = { id: 7 }
    const busy = cmd.pending('orderSubmit', order)
    return () => h('button', {
      id: 'order',
      type: 'button',
      'aria-disabled': busy.value,
      onClick: () => { if (!busy.value) cmd.dispatch('orderSubmit', order) },
    }, busy.value ? 'Ordering...' : 'Order')
  },
})

createApp(Order).mount('#app')
