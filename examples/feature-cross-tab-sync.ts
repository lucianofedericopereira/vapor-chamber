/**
 * Feature example: the same cart, prefs and logout in every open tab
 * =================================================================
 * Two kinds of thing cross between tabs, and each has its own piece.
 *
 * A STORE crosses by itself. A store with `share: shareTabs()` sends each
 * write's command. The tab holding the store's Web Lock runs every tab's
 * command and posts it on, and every tab applies it with the store's reducer,
 * with no dispatch, so every tab ends on one state. Mint ids and times in the
 * call, never in the reducer. An undo in
 * any tab undoes the command in every tab. A tab opened later asks for the
 * state when it opens.
 *
 * A FACT that is no store's state crosses on a lane, through `createChannel`.
 * "The user logged out" is computed once, where it happened, and every other
 * tab applies it. The bridge is not a bus plugin, so it costs the dispatch
 * path nothing.
 *
 * Open this page in two tabs and dispatch in one: the other logs what arrived.
 */

import { createChannel, createCommandBus, saveTo, shareTabs } from 'vapor-chamber'
import { createFastLane } from 'vapor-chamber/fast-lane'
import { defineChamberStore } from 'vapor-chamber/store'

const bus = createCommandBus()

// ─── State: the cart and the prefs ───────────────────────────────────────────

type CartState = { items: Array<{ id: number; qty: number }>; count: number }

// Outside a component, for brevity: in an app this runs in setup(). Created
// here, the store lives until `cart.$dispose()`.
const cart = defineChamberStore('cart', {
  state: (): CartState => ({ items: [], count: 0 }),
  reducers: {
    add: (state, item: { id: number; qty: number }) => ({ items: [...state.items, item], count: state.count + 1 }),
  },
  share: shareTabs(),
})(bus)
cart.$onField('count', (n) => console.log('[cart] count is now', n))

type Prefs = { theme: 'light' | 'dark'; lang: string }

// Shared across the open tabs, and saved: it survives the last tab closing.
const prefs = defineChamberStore('prefs', {
  state: (): Prefs => ({ theme: 'light', lang: 'en' }),
  reducers: { setTheme: (state, theme: Prefs['theme']) => ({ ...state, theme }) },
  share: shareTabs(),
  persist: saveTo({ key: 'vc:prefs' }),
})(bus)
prefs.$onField('theme', (theme) => console.log('[prefs] theme is now', theme))

// ─── Facts: logout everywhere, a cleared notification ────────────────────────

// One lane carries the app's facts. The channel decides which of them cross.
const lane = createFastLane()

bus.register('authLogout', () => {
  lane.emit('loggedOut', { at: Date.now() })   // the clock is read ONCE, here
})
bus.register('notificationsClear', (cmd) => {
  lane.emit('notificationCleared', cmd.target)
})

// Every tab runs these, the one that logged out included.
lane.on('loggedOut', () => {
  console.log('[auth] logged out, going to /login')
  localStorage.removeItem('token')
  window.location.href = '/login'
})
lane.on<{ id: number }>('notificationCleared', (n) => console.log('[notifications] cleared', n.id))

const facts = createChannel({
  channel: 'vapor-chamber:facts',      // all tabs sharing this channel stay in step
  lane,
  events: ['loggedOut', 'notificationCleared'],   // the wire contract, declared, not guessed at
  onReceive: (event) => {
    // Return false to drop a fact from another tab without applying it.
    if (event === 'notificationCleared' && document.hidden) return false
  },
})

// On unmount: facts.dispose()

// ─── This tab's first changes: the others log them as they arrive ────────────

cart.add({ id: 1, qty: 1 })
prefs.setTheme('dark')

console.log('BroadcastChannel open?', facts.isOpen())

export { bus, cart, prefs }
