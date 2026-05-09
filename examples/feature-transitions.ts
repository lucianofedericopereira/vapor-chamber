/**
 * Feature example: Transition-dispatched commands
 * ================================================
 * Dispatches bus commands from Vue <Transition> lifecycle hooks.
 * Enables animation coordination through the command bus without
 * direct DOM coupling — handlers control timing, plugins observe.
 */

import {
  createCommandBus,
  createAsyncCommandBus,
  setCommandBus,
  logger,
} from 'vapor-chamber'
import {
  createTransitionBridge,
  useTransitionCommand,
} from 'vapor-chamber/transitions'

// ─── 1. Factory usage (framework-agnostic) ───────────────────────────────────

const bus = createCommandBus({ onMissing: 'ignore' })
setCommandBus(bus)
bus.use(logger({ collapsed: true }))

// Register animation handlers
bus.register('modalBeforeEnter', (cmd) => {
  console.log('Preparing modal enter animation for:', cmd.target)
})

bus.register('modalAfterEnter', () => {
  console.log('Modal is now fully visible — focus trap can activate')
})

bus.register('modalBeforeLeave', () => {
  console.log('Starting modal exit — release focus trap')
})

bus.register('modalAfterLeave', () => {
  console.log('Modal removed from DOM — cleanup complete')
})

// Create the bridge — all hooks dispatch 'modal*' actions
const modal = createTransitionBridge({ bus, namespace: 'modal' })

// Simulate a transition lifecycle
const el = {} as Element
modal.onBeforeEnter(el)
console.log('Phase during enter:', modal.phase.value) // → 'entering'

modal.onEnter(el, () => console.log('done() called — enter complete'))
modal.onAfterEnter(el)
console.log('Phase after enter:', modal.phase.value)   // → 'idle'

modal.onBeforeLeave(el)
console.log('Phase during leave:', modal.phase.value)  // → 'leaving'

modal.onLeave(el, () => console.log('done() called — leave complete'))
modal.onAfterLeave(el)
console.log('Phase after leave:', modal.phase.value)   // → 'idle'

// ─── 2. Async handler controls animation timing ──────────────────────────────

const asyncBus = createAsyncCommandBus({ onMissing: 'ignore' })

asyncBus.register('drawerEnter', async (cmd) => {
  // Simulate a 300ms CSS animation
  await new Promise(r => setTimeout(r, 300))
  console.log('Drawer slide-in animation complete')
})

asyncBus.register('drawerLeave', async () => {
  await new Promise(r => setTimeout(r, 200))
  console.log('Drawer slide-out animation complete')
})

const drawer = createTransitionBridge({ bus: asyncBus, namespace: 'drawer' })

// done() is called automatically after the async handler resolves
drawer.onEnter(el, () => console.log('Drawer enter done() — Vue can proceed'))

// ─── 3. Vue composable usage ─────────────────────────────────────────────────

/*
 * <script setup>
 * import { useTransitionCommand } from 'vapor-chamber/transitions'
 *
 * // Bind all 8 hooks to the bus with 'notification' namespace
 * const notification = useTransitionCommand({ namespace: 'notification' })
 * </script>
 *
 * <template>
 *   <!-- v-bind spreads all hooks onto <Transition> automatically -->
 *   <Transition v-bind="notification">
 *     <div v-if="showToast" class="toast">
 *       {{ message }}
 *     </div>
 *   </Transition>
 *
 *   <!-- Reactive phase signal for conditional UI -->
 *   <span v-if="notification.phase.value === 'entering'">
 *     Appearing...
 *   </span>
 * </template>
 */

// ─── 4. Vapor component — same API ──────────────────────────────────────────

/*
 * <script setup vapor>
 * import { useTransitionCommand } from 'vapor-chamber/transitions'
 * import { defineVaporCommand } from 'vapor-chamber'
 *
 * // Forward animation events to whatever telemetry sink you use
 * defineVaporCommand('panelEnter', (cmd) => {
 *   sendMetric('panel_open', { element: cmd.target.tagName })
 * })
 *
 * const panel = useTransitionCommand({ namespace: 'panel' })
 * </script>
 *
 * <template>
 *   <Transition v-bind="panel">
 *     <aside v-if="open" class="side-panel">...</aside>
 *   </Transition>
 * </template>
 */

export {}
