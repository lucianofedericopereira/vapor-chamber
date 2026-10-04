/**
 * Feature example: the store - state whose every change is a command
 * =================================================================
 * `cart.add(42)` dispatches `cartAdd`, so the bus's plugins apply with no
 * store code: history undoes it, persist saves it, the devtools show it, and
 * `share` keeps the same state in every tab.
 */

import { createCommandBus, createChannel, history } from 'vapor-chamber'
import { createFastLane } from 'vapor-chamber/fast-lane'
import { defineChamberStore, fieldRef } from 'vapor-chamber/store'

const bus = createCommandBus()
const h = history({ bus })
bus.use(h)

// Cross-tab: the store sends its state on a lane, a channel carries the lane.
const lane = createFastLane()
createChannel({ channel: 'app', lane, events: ['cart$state'] })

type Cart = { items: number[]; count: number }

const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [], count: 0 }),
  actions: {
    add: (s: Cart, id: number) => ({ items: [...s.items, id], count: s.count + 1 }),
    clear: () => ({ items: [], count: 0 }),
  },
  undo: true,   // every action and $reset can be undone through `history`
  share: lane,  // every tab holds the same state
})

const cart = useCart(bus)

cart.add(42)                 // dispatches `cartAdd`
cart.add(7)
h.undo()                     // dispatches `cartAdd$undo`: back to [42]
cart.$reset()                // dispatches `cart$reset`: a command too
console.log(cart.state.value)

// ─── Field events: react to one field, not every write ─────────────────────

const off = cart.$onField('count', (n) => console.log('count is now', n))
// In a component: a read-only ref that re-renders on `count` alone.
const count = fieldRef(cart, 'count')
console.log(count.value)
off()

// ─── Without Vue: the same store over the library's signal ─────────────────
// import { defineChamberStore } from 'vapor-chamber/store/core'
// Same options and members; no component scope, so call `$dispose()` yourself.

export { cart }
