/**
 * Feature example: sync bridge - cross-tab coordination via BroadcastChannel
 * ===========================================================================
 * A handler computes a FACT and emits it on an event channel; the bridge puts
 * that fact on a BroadcastChannel, and every other open tab applies it.
 *
 * WHAT CROSSES IS A FACT, NOT A COMMAND, and that is the point. If the command
 * crossed, each tab would re-run the handler and derive its own outcome - so a
 * handler that mints an id, reads a clock or starts from different state would
 * leave the tabs permanently different, and a handler that dispatches a nested
 * command would apply that derivation twice per tab. Sending what was computed
 * removes all of it: the receiving tab applies values rather than recomputing
 * them, and a derivation never crosses unless you emit it.
 *
 * The bridge is not a bus plugin, so it costs the dispatch path nothing.
 */

import {
  createCommandBus,
  setCommandBus,
  useCommandState,
  sync,
  persist,
} from 'vapor-chamber'
import { createFastLane } from 'vapor-chamber/fast-lane'

const bus = createCommandBus()
setCommandBus(bus)

// The shared event channel. One lane can carry every synced fact in the app;
// the bridge decides which of them cross.
const lane = createFastLane()

// ─── Basic: mirror the cart across all open tabs ──────────────────────────────

type CartState = { items: Array<{ id: number; qty: number }>; count: number }

// The single writer. A local emit and a fact from another tab both land here,
// so there is exactly one code path that changes cart state.
const cartState = useCommandState<CartState>(
  { items: [], count: 0 },
  {
    // Facts are absolute ("the cart is this"), not relative ("add one"), so a
    // tab that was opened later converges instead of drifting.
    'cartChanged': (_state, cmd) => cmd.target as CartState,
  }
)
lane.on<CartState>('cartChanged', (next) => { bus.dispatch('cartChanged', next) })

// The handler COMPUTES; it does not write.
bus.register('cartAdd', (cmd) => {
  const s = cartState.state.value
  lane.emit('cartChanged', {
    items: [...s.items, cmd.target as { id: number; qty: number }],
    count: s.count + 1,
  })
})

const tabSync = sync({
  channel: 'vapor-chamber:app',   // all tabs sharing this channel stay in step
  lane,
  events: ['cartChanged'],        // the wire contract, declared, not guessed at
})

// Tab A dispatches -> Tab A computes and emits -> Tab B and Tab C apply:
bus.dispatch('cartAdd', { id: 1, qty: 1 })
// cartState.state.value is the same object in every tab.

// ─── Auth sync: logout everywhere ────────────────────────────────────────────

bus.register('authLogout', () => {
  lane.emit('loggedOut', { at: Date.now() })   // the clock is read ONCE, here
})

lane.on('loggedOut', () => {
  localStorage.removeItem('token')
  window.location.href = '/login'
})

const authSync = sync({ channel: 'vapor-chamber:auth', lane, events: ['loggedOut'] })

// ─── Dropping a fact on arrival ───────────────────────────────────────────────

const notificationSync = sync({
  channel: 'vapor-chamber:notifications',
  lane,
  events: ['notificationCleared'],
  onReceive: (event, _data) => {
    // Return false to drop a fact from another tab without applying it.
    if (event === 'notificationCleared' && document.hidden) return false
  },
})

// ─── Combined with persist: survive both tab close AND page reload ─────────────

type UserPrefs = { theme: 'light' | 'dark'; lang: string }

const prefsState = useCommandState<UserPrefs>(
  { theme: 'light', lang: 'en' },
  { 'prefsChanged': (_state, cmd) => cmd.target as UserPrefs }
)
lane.on<UserPrefs>('prefsChanged', (next) => { bus.dispatch('prefsChanged', next) })

const prefsPersist = persist<UserPrefs>({
  key: 'vc:prefs',
  getState: () => prefsState.state.value,
  filter: (cmd) => cmd.action === 'prefsChanged',
})
bus.use(prefsPersist)

bus.register('prefsSetTheme', (cmd) => {
  lane.emit('prefsChanged', { ...prefsState.state.value, theme: (cmd.target as UserPrefs).theme })
})

const prefsSync = sync({ channel: 'vapor-chamber:prefs', lane, events: ['prefsChanged'] })

// User changes theme in Tab A -> persisted to localStorage AND mirrored to all tabs
bus.dispatch('prefsSetTheme', { theme: 'dark', lang: 'en' })

// ─── Cleanup ──────────────────────────────────────────────────────────────────

window.addEventListener('beforeunload', () => {
  tabSync.close()
  authSync.close()
  notificationSync.close()
  prefsSync.close()
})

console.log('BroadcastChannel open?', tabSync.isOpen())
export {}
