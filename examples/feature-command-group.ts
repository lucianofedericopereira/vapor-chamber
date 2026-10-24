/**
 * Feature example: useCommandGroup - teams share one bus without name collisions
 * ===============================================================================
 * A group puts its namespace in front of every action it registers, dispatches
 * or listens to. The cart team and the orders team each write `remove`; the bus
 * holds `cartRemove` and `ordersRemove`. A group hears only its own commands,
 * and `dispose()` takes all of them off the bus.
 */

// One entry for a Vue app: `vapor-chamber/vue` carries the bus too, and it
// wires Vue, so the composables' cleanup and reactivity hold in a production
// build (the root would not).
import { createCommandBus, setCommandBus, useCommandGroup, type BusError } from 'vapor-chamber/vue'

const bus = createCommandBus()
setCommandBus(bus)

// Outside a component, for brevity: in an app each group is made in setup()
// and leaves with the component. Here nothing disposes it automatically (the
// DEV heads-up says so), so the end of the file calls dispose().
const cart = useCommandGroup('cart')
const orders = useCommandGroup('orders')

cart.register('add', (cmd) => `added ${cmd.target.name} x${cmd.payload?.qty ?? 1}`)
cart.register('remove', (cmd) => `cart removed ${cmd.target.name}`)
orders.register('cancel', (cmd) => `order ${cmd.target.id} cancelled`)
orders.register('remove', (cmd) => `order ${cmd.target.id} deleted`)

// `on('*')` listens to `cart*`: it hears the cart's commands and no other.
// Subscribed first, since a listener hears what is dispatched after it.
cart.on('*', (cmd, result) => console.log('[audit]', cmd.action, result.ok ? 'ok' : 'failed'))

const code = (r: { ok: boolean; error?: unknown }) => (r.ok ? 'ok' : (r.error as BusError).code)

console.log('--- No prefix inside the group ---')
console.log(cart.dispatch('add', { name: 'T-Shirt' }, { qty: 2 }).value) // cartAdd
console.log(orders.dispatch('cancel', { id: 42 }).value)                 // ordersCancel

console.log('--- The same short name in two groups ---')
console.log(cart.dispatch('remove', { name: 'T-Shirt' }).value)  // cartRemove
console.log(orders.dispatch('remove', { id: 42 }).value)         // ordersRemove

console.log('--- Isolated: orders has no add ---')
console.log('ordersAdd ->', code(orders.dispatch('add', { id: 99 })))

console.log('--- dispose() takes the group off the bus ---')
cart.dispose()
console.log('cartAdd ->', code(cart.dispatch('add', { name: 'T-Shirt' })))
console.log('ordersCancel ->', code(orders.dispatch('cancel', { id: 43 })))
orders.dispose()
