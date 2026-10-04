/**
 * Feature example: useCommandGroup - namespace isolation
 * =======================================================
 * Prevents action name collisions across teams and feature modules.
 * Each group operates on the same shared bus but with a namespace prefix.
 */

import { createCommandBus, setCommandBus } from 'vapor-chamber'
// Composables from the Vue entry: it wires Vue, so their cleanup and
// reactivity hold in a production build (the root would not).
import { useCommandGroup } from 'vapor-chamber/vue'

const bus = createCommandBus()
setCommandBus(bus)

// ─── Cart feature ─────────────────────────────────────────────────────────────

// Outside a component, for brevity: in an app this runs in setup(). Here nothing
// disposes it automatically (the DEV heads-up says so); call dispose() when done.
const cart = useCommandGroup('cart')

// Register namespaced handlers
cart.register('add', (cmd) => {
  console.log('cartAdd', cmd.target)
  // returns updated state
  return { ...cmd.target }
})

cart.register('remove', (cmd) => {
  console.log('cartRemove', cmd.target)
})

cart.register('clear', () => {
  console.log('cart cleared')
})

// ─── Orders feature ───────────────────────────────────────────────────────────

const orders = useCommandGroup('orders')

orders.register('cancel', (cmd) => {
  console.log('order cancelled', cmd.target.id)
})

orders.register('refund', (cmd) => {
  console.log('order refunded', cmd.target.id, 'amount:', cmd.payload?.amount)
})

// ─── Telemetry feature ────────────────────────────────────────────────────────

const telemetry = useCommandGroup('telemetry')

telemetry.register('event', (cmd) => {
  // forward to whatever metrics / telemetry sink you use
  console.log('[telemetry]', cmd.target.name, cmd.target.params)
})

// ─── Subscribe to a namespace with on() ───────────────────────────────────────

cart.on('*', (cmd, result) => {
  console.log('[audit] cart command:', cmd.action, result.ok ? '✓' : '✗')
})
// Listens to 'cart*' - only cart commands. Subscribed before the dispatches
// below: a listener hears what is dispatched after it subscribes.

// ─── Dispatch - no prefix needed inside the group ─────────────────────────────

cart.dispatch('add', { id: 1, name: 'T-Shirt' }, { qty: 2 })
// -> dispatches 'cartAdd' on the shared bus

orders.dispatch('cancel', { id: 42 })
// -> dispatches 'ordersCancel'

telemetry.dispatch('event', { name: 'page_view', params: { page: '/shop' } })
// -> dispatches 'telemetryEvent'

// Cross-namespace dispatch does NOT trigger handlers (isolated):
orders.dispatch('add', { id: 99 })
// -> dispatches 'ordersAdd' - no handler, so it fails as core:missing:handler

// ─── Cleanup on component unmount ─────────────────────────────────────────────
// useCommandGroup registers cleanup via onScopeDispose automatically.
// Explicit dispose is available if needed:
// cart.dispose()
// orders.dispose()
