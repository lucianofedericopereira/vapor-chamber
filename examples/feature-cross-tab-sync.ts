/**
 * Feature example: sync plugin — cross-tab coordination via BroadcastChannel
 * ===========================================================================
 * Commands dispatched in one tab are re-dispatched in all other open tabs.
 * Keeps cart, auth state, and notifications in sync across tabs automatically.
 */

import {
  createCommandBus,
  setCommandBus,
  useCommandState,
  sync,
  persist,
} from 'vapor-chamber'

const bus = createCommandBus()
setCommandBus(bus)

// ─── Basic: sync cart across all open tabs ────────────────────────────────────

const tabSync = sync(
  {
    channel: 'vapor-chamber:app',   // all tabs sharing this channel stay in sync
    // Only sync state-changing commands — skip read-only / analytics
    filter: (cmd) => cmd.action.startsWith('cart') || cmd.action.startsWith('auth'),
  },
  // Pass bus.dispatch so the plugin can re-dispatch received commands
  { dispatch: bus.dispatch.bind(bus) }
)
bus.use(tabSync)

// ─── State that syncs automatically across tabs ───────────────────────────────

type CartState = { items: Array<{ id: number; qty: number }>; count: number }

const cartState = useCommandState<CartState>(
  { items: [], count: 0 },
  {
    'cartAdd':    (state, cmd) => ({
      items: [...state.items, cmd.target],
      count: state.count + 1,
    }),
    'cartRemove': (state, cmd) => ({
      items: state.items.filter(i => i.id !== cmd.target.id),
      count: state.count - 1,
    }),
    'cartClear':  () => ({ items: [], count: 0 }),
  }
)

// Tab A dispatches → Tab B and Tab C automatically update:
bus.dispatch('cartAdd', { id: 1, name: 'T-Shirt' })
// Other tabs receive 'cartAdd' via BroadcastChannel and re-dispatch it locally.
// cartState.state.value updates reactively in all tabs.

// ─── Auth sync: logout everywhere ────────────────────────────────────────────

bus.register('authLogout', () => {
  // Clear local state
  localStorage.removeItem('token')
  window.location.href = '/login'
})

// Dispatching 'authLogout' in any tab → all tabs redirect to /login
// bus.dispatch('authLogout', {})

// ─── Filtering: only sync specific namespaces ─────────────────────────────────

const notificationSync = sync(
  {
    channel: 'vapor-chamber:notifications',
    filter: (cmd) => cmd.action.startsWith('notification'),
    onReceive: (cmd) => {
      // Return false to suppress re-dispatch for specific commands
      if (cmd.action === 'notificationClear' && document.hidden) return false
    },
  },
  { dispatch: bus.dispatch.bind(bus) }
)
bus.use(notificationSync)

// ─── Combined with persist: survive both tab close AND page reload ─────────────

type UserPrefs = { theme: 'light' | 'dark'; lang: string }

const prefsPersist = persist<UserPrefs>({
  key: 'vc:prefs',
  getState: () => prefsState.state.value,
  filter: (cmd) => cmd.action.startsWith('prefs'),
})
bus.use(prefsPersist)

const prefsSync = sync(
  {
    channel: 'vapor-chamber:prefs',
    filter: (cmd) => cmd.action.startsWith('prefs'),
  },
  { dispatch: bus.dispatch.bind(bus) }
)
bus.use(prefsSync)

const prefsState = useCommandState<UserPrefs>(
  prefsPersist.load() ?? { theme: 'light', lang: 'en' },
  {
    'prefsSetTheme': (state, cmd) => ({ ...state, theme: cmd.target.theme }),
    'prefsSetLang':  (state, cmd) => ({ ...state, lang: cmd.target.lang }),
  }
)

// User changes theme in Tab A → persisted to localStorage AND synced to all tabs
bus.dispatch('prefsSetTheme', { theme: 'dark' })

// ─── Cleanup ──────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  tabSync.close()
  notificationSync.close()
  prefsSync.close()
})

console.log('BroadcastChannel open?', tabSync.isOpen())
export {}
