/**
 * Feature example: persist plugin - localStorage / sessionStorage / custom storage
 * ==================================================================================
 * Auto-saves state to storage after each successful command.
 * Loads and rehydrates on page reload.
 */

import { createCommandBus, setCommandBus, persist, indexedDbStorage } from 'vapor-chamber'
// Composables from the Vue entry, which wires Vue (the root would not).
import { useCommandState } from 'vapor-chamber/vue'

const bus = createCommandBus()
setCommandBus(bus)

// ─── Basic: persist cart state to localStorage ────────────────────────────────

type CartState = { items: Array<{ id: number; name: string; price?: number; qty: number }>; total: number }

const defaultCart: CartState = { items: [], total: 0 }

// Create the persist plugin
const cartPersist = persist<CartState>({
  key: 'vc:cart',
  getState: () => cartState.state.value,
  // Only cart commands (ignore analytics, etc.): the bus skips persist for the rest
  actions: ['cart*'],
})
bus.use(cartPersist)

// Load previously saved state (null if nothing stored or parse failed)
const savedCart = cartPersist.load()

// Initialize state with saved or default
// Outside a component, for brevity: in an app this runs in setup(). Here nothing
// disposes it automatically (the DEV heads-up says so); call dispose() when done.
const cartState = useCommandState<CartState>(
  savedCart ?? defaultCart,
  {
    'cartAdd': (state, cmd) => ({
      ...state,
      items: [...state.items, { ...cmd.target, qty: cmd.payload?.qty ?? 1 }],
      total: state.total + (cmd.target.price ?? 0) * (cmd.payload?.qty ?? 1),
    }),
    'cartRemove': (state, cmd) => {
      const gone = state.items.find(i => i.id === cmd.target.id)
      return {
        items: state.items.filter(i => i.id !== cmd.target.id),
        // The removed line's amount comes off the total.
        total: state.total - (gone ? (gone.price ?? 0) * gone.qty : 0),
      }
    },
    'cartClear': () => defaultCart,
  }
)

// Dispatch commands - state is auto-saved after each one
bus.dispatch('cartAdd', { id: 1, name: 'T-Shirt', price: 29.99 }, { qty: 2 })
bus.dispatch('cartAdd', { id: 2, name: 'Hoodie', price: 59.99 })

console.log('Cart:', cartState.state.value)
console.log('Saved to localStorage key "vc:cart"')

// ─── SessionStorage: clear on tab close ───────────────────────────────────────

type SearchState = { query: string; results: any[]; page: number }

const searchPersist = persist<SearchState>({
  key: 'vc:search',
  getState: () => searchState.state.value,
  storage: typeof sessionStorage !== 'undefined' ? sessionStorage : undefined,
})
bus.use(searchPersist)

const searchState = useCommandState<SearchState>(
  searchPersist.load() ?? { query: '', results: [], page: 1 },
  {
    'searchQuery': (state, cmd) => ({ ...state, query: cmd.target.q, page: 1 }),
    'searchNextPage': (state) => ({ ...state, page: state.page + 1 }),
  }
)

// ─── Custom serialization: compress large state ────────────────────────────────

const analyticsPrefs = persist<{ events: string[]; userId: string }>({
  key: 'vc:analytics',
  getState: () => ({ events: ['page_view', 'click'], userId: 'usr_123' }),
  // Custom serializer - e.g. LZString compression for large state
  serialize: (state) => btoa(JSON.stringify(state)),
  deserialize: (raw) => {
    try { return JSON.parse(atob(raw)) }
    catch { return null }
  },
})
bus.use(analyticsPrefs)

// ─── Manual operations ────────────────────────────────────────────────────────

// Trigger an immediate save (e.g. on beforeunload)
window.addEventListener('beforeunload', () => {
  cartPersist.save()
})

// Clear on logout
function onLogout() {
  cartPersist.clear()
  searchPersist.clear()
  analyticsPrefs.clear()
}

// ─── IndexedDB: large state, no localStorage quota ────────────────────────────
// Its answers are promises: read the saved state with hydrate(), before the
// first dispatch. load() reads a synchronous storage only.

const dataset = { rows: [] as number[] }
const idbPersist = persist({ key: 'large-dataset', getState: () => dataset, storage: indexedDbStorage() })
bus.use(idbPersist)
const savedDataset = await idbPersist.hydrate()
if (savedDataset) dataset.rows = savedDataset.rows

export { onLogout }
