/**
 * Feature example: the store - state whose every change is a command
 * =================================================================
 * `picks.add(42)` dispatches `picksAdd`, so the bus's plugins and history apply
 * with no store code: history undoes it and the devtools show it. The store's own
 * options save it (`persist: saveTo(...)`) and keep every tab on one state
 * (`share: shareTabs()`). A store behind a transport takes the server's answer
 * as its state.
 */

import { createAsyncCommandBus, history, saveTo, shareTabs } from 'vapor-chamber'
import { httpTransport } from 'vapor-chamber/transports'
import { defineChamberStore, fieldRef } from 'vapor-chamber/store'

// Two actions are the server's. Every other action, `$reset` included, runs here.
const api = httpTransport({ endpoint: '/api/vc' })
const bus = createAsyncCommandBus({ transport: { cartAdd: api, cartClear: api } })
const h = history({ bus })

// ─── A local store: saved, shared, undone ────────────────────────────────────

type Picks = { ids: number[]; count: number }

const usePicks = defineChamberStore('picks', {
  state: (): Picks => ({ ids: [], count: 0 }),
  reducers: {
    add: (s: Picks, id: number) => ({ ids: [...s.ids, id], count: s.count + 1 }),
  },
  undo: true,                            // every action and $reset can be undone through `history`
  persist: saveTo({ key: 'vc:picks' }),  // the saved state is the first state of the next page load
  share: shareTabs(),                    // every tab holds the same state, over one BroadcastChannel
})

const picks = usePicks(bus)
console.log('Picks on load:', picks.state.value)   // what the last visit saved

bus.on('picks*', (cmd) => console.log('command:', cmd.action))

await picks.add(42)                      // dispatches `picksAdd`
await picks.add(7)
h.undo()                                 // dispatches `picksAdd$undo`: back to [42]
console.log('After undo:', picks.state.value)
await picks.$reset()                     // dispatches `picks$reset`: a command too
await picks.add(42)                      // what the next load restores
console.log('Picks:', picks.state.value)

// ─── Field events: react to one field, not every write ──────────────────────

const off = picks.$onField('count', (n) => console.log('count is now', n))
// In a component: a read-only ref that re-renders on `count` alone.
const count = fieldRef(picks, 'count')
await picks.add(1)
console.log('count ref:', count.value)
off()

// ─── A store behind a transport: the server's answer is its state ───────────
// The transport sends `cartAdd` and `cartClear`, so they have no local change:
// `null` gives the methods and the actions, and `answer` turns the reply into
// the store's next state. A server can also name the store itself,
// `{ state, stores: { cart: {...} } }` (docs/store.md, "A store behind a transport").

type Cart = { count: number; total: number; lastAdded?: string }

const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ count: 0, total: 0 }),
  reducers: { add: null, clear: null },
  answer: (_s, value) => value as Cart,
})

const cart = useCart(bus)
const reply = await cart.add({ id: 3 }, { qty: 2 })
console.log('Server answered:', reply.ok ? reply.value : reply.error.message, '-> cart:', cart.state.value)

// ─── Without Vue: the same store over the library's signal ──────────────────
// import { defineChamberStore } from 'vapor-chamber/store/core'
// Same options and members; no component scope, so call `$dispose()` yourself.

export { picks, cart }
