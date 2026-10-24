/**
 * Feature example: a store's persist - localStorage / sessionStorage / custom storage
 * ==================================================================================
 * A store with `persist` saves its state after its writes, once per microtask,
 * and reads it back when it is created on the next page load. Reload this page:
 * every "on load" line shows what the last visit saved.
 */

import { createCommandBus, indexedDbStorage, saveTo } from 'vapor-chamber'
import { defineChamberStore } from 'vapor-chamber/store'

const bus = createCommandBus()

// ─── Basic: the cart in localStorage ─────────────────────────────────────────

type Line = { id: number; name: string; price: number; qty: number }
type CartState = { items: Line[]; total: number }

// The saved cart is the store's first state; `state()` stays the default,
// which `$reset()` goes back to.
const useCart = defineChamberStore('cart', {
  state: (): CartState => ({ items: [], total: 0 }),
  reducers: {
    add: (state, line: Line) => ({
      items: [...state.items, line],
      total: state.total + line.price * line.qty,
    }),
  },
  persist: saveTo({ key: 'vc:cart' }),
})

// Outside a component, for brevity: in an app this runs in setup(), and the
// store is disposed with its last holder. Here the caller owns $dispose().
const cart = useCart(bus)
console.log('Cart on load:', cart.state.value)

// A first visit fills the cart, a later one finds it there.
if (cart.state.value.items.length === 0) {
  cart.add({ id: 1, name: 'T-Shirt', price: 29.99, qty: 2 })   // dispatches `cartAdd`: saved after it
  cart.add({ id: 2, name: 'Hoodie', price: 59.99, qty: 1 })
}

// ─── sessionStorage: gone when the tab closes ────────────────────────────────

type SearchState = { query: string; page: number }

const search = defineChamberStore('search', {
  state: (): SearchState => ({ query: '', page: 1 }),
  reducers: {
    query: (state, q: string) => ({ ...state, query: q, page: 1 }),
    nextPage: (state) => ({ ...state, page: state.page + 1 }),
  },
  persist: saveTo({ key: 'vc:search', storage: sessionStorage }),
})(bus)
console.log('Search on load:', search.state.value)
search.query('shirt')
search.nextPage()

// ─── Custom serialization: any format the storage holds ──────────────────────

type Prefs = { userId: string }

const prefs = defineChamberStore('prefs', {
  state: (): Prefs => ({ userId: 'usr_123' }),
  reducers: { identify: (_state, userId: string) => ({ userId }) },
  persist: saveTo({
    key: 'vc:prefs',
    // e.g. LZString compression for a large state
    serialize: (state) => btoa(JSON.stringify(state)),
    deserialize: (raw) => {
      try { return JSON.parse(atob(raw)) }
      catch { return null }
    },
  }),
})(bus)
console.log('Prefs on load:', prefs.state.value)
prefs.identify('usr_456')

// ─── IndexedDB: large state, no localStorage quota ───────────────────────────
// Its answers are promises: the store starts on `state()` and takes the saved
// state when the read lands, the writes made before then replayed on top.

const dataset = defineChamberStore('dataset', {
  state: () => ({ rows: [] as number[] }),
  reducers: { visit: (state) => ({ rows: [...state.rows, state.rows.length + 1] }) },
  persist: saveTo({ key: 'large-dataset', storage: indexedDbStorage() }),
})(bus)
dataset.$onField('rows', (rows) => console.log('Dataset rows:', rows))
dataset.visit()                      // one more row each visit, replayed on the saved rows

await Promise.resolve()               // the save runs one microtask after the write
console.log('Prefs are stored as:', localStorage.getItem('vc:prefs'))

// ─── Logout ──────────────────────────────────────────────────────────────────

// Each store goes back to its default, and that is what is saved.
function onLogout() {
  cart.$reset()
  search.$reset()
  prefs.$reset()
  dataset.$reset()
}

export { onLogout, cart }
