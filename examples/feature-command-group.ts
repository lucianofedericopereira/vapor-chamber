/**
 * Feature example: useCommandGroup — namespace isolation
 * =======================================================
 * Prevents action name collisions across teams and feature modules.
 * Each group operates on the same shared bus but with a namespace prefix.
 */

import { createCommandBus, setCommandBus, useCommandGroup, useCommandState } from 'vapor-chamber'

const bus = createCommandBus()
setCommandBus(bus)

// ─── Cart feature ─────────────────────────────────────────────────────────────

const cart = useCommandGroup('cart')

const cartInitial = { items: [] as Array<{ id: number; qty: number }>, total: 0 }

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

// ─── Analytics feature ────────────────────────────────────────────────────────

const analytics = useCommandGroup('analytics')

analytics.register('track', (cmd) => {
  console.log('[GA4]', cmd.target.event, cmd.target.params)
})

// ─── Dispatch — no prefix needed inside the group ─────────────────────────────

cart.dispatch('add', { id: 1, name: 'T-Shirt' }, { qty: 2 })
// → dispatches 'cartAdd' on the shared bus

orders.dispatch('cancel', { id: 42 })
// → dispatches 'ordersCancel'

analytics.dispatch('track', { event: 'page_view', params: { page: '/shop' } })
// → dispatches 'analyticsTrack'

// Cross-namespace dispatch does NOT trigger handlers (isolated):
orders.dispatch('add', { id: 99 })
// → dispatches 'ordersAdd' — no handler registered, dead-letter

// ─── Subscribe to a namespace with on() ───────────────────────────────────────

cart.on('*', (cmd, result) => {
  console.log('[audit] cart command:', cmd.action, result.ok ? '✓' : '✗')
})
// Listens to 'cart*' — only cart commands

// ─── Cleanup on component unmount ─────────────────────────────────────────────
// useCommandGroup registers cleanup via onScopeDispose automatically.
// Explicit dispose is available if needed:
// cart.dispose()
// orders.dispose()
