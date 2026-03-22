/**
 * Feature example: persist plugin — localStorage / sessionStorage / custom storage
 * ==================================================================================
 * Auto-saves state to storage after each successful command.
 * Loads and rehydrates on page reload.
 */

import {
  createCommandBus,
  setCommandBus,
  useCommandState,
  useCommandGroup,
  persist,
} from 'vapor-chamber'

const bus = createCommandBus()
setCommandBus(bus)

// ─── Basic: persist cart state to localStorage ────────────────────────────────

type CartState = { items: Array<{ id: number; name: string; qty: number }>; total: number }

const defaultCart: CartState = { items: [], total: 0 }

// Create the persist plugin
const cartPersist = persist<CartState>({
  key: 'vc:cart',
  getState: () => cartState.state.value,
  // Only save after cart commands (ignore analytics, etc.)
  filter: (cmd) => cmd.action.startsWith('cart'),
})
bus.use(cartPersist)

// Load previously saved state (null if nothing stored or parse failed)
const savedCart = cartPersist.load()

// Initialize state with saved or default
const cartState = useCommandState<CartState>(
  savedCart ?? defaultCart,
  {
    'cartAdd': (state, cmd) => ({
      ...state,
      items: [...state.items, { ...cmd.target, qty: cmd.payload?.qty ?? 1 }],
      total: state.total + (cmd.target.price ?? 0) * (cmd.payload?.qty ?? 1),
    }),
    'cartRemove': (state, cmd) => ({
      ...state,
      items: state.items.filter(i => i.id !== cmd.target.id),
    }),
    'cartClear': () => defaultCart,
  }
)

// Dispatch commands — state is auto-saved after each one
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
  // Custom serializer — e.g. LZString compression for large state
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

// ─── IndexedDB adapter pattern ────────────────────────────────────────────────
// persist() accepts any object implementing { getItem, setItem, removeItem }.
// Build an async IDB adapter and pass it as `storage`:

/*
function createIdbAdapter(dbName: string, storeName: string) {
  // Simplified — use idb-keyval or similar in production
  let cache: Record<string, string> = {}

  // Warm the cache (async — call on app init)
  async function load() {
    const db = await openDB(dbName, 1, {
      upgrade(db) { db.createObjectStore(storeName) }
    })
    const all = await db.getAll(storeName)
    cache = Object.fromEntries(all.map((v, i) => [i, v]))
  }

  return {
    getItem: (key: string) => cache[key] ?? null,
    setItem: (key: string, value: string) => {
      cache[key] = value
      // Fire-and-forget async write
      openDB(dbName, 1).then(db => db.put(storeName, value, key))
    },
    removeItem: (key: string) => {
      delete cache[key]
      openDB(dbName, 1).then(db => db.delete(storeName, key))
    },
  }
}

const idbStorage = createIdbAdapter('vapor-chamber', 'state')
const idbPersist = persist({ key: 'large-dataset', getState: getData, storage: idbStorage })
bus.use(idbPersist)
*/
export {}
