/**
 * Feature example: Transports
 * ===========================
 * httpTransport   - fetch-based HTTP transport
 * wsTransport     - WebSocket transport with reconnect
 * createSseBridge - Server-sent events for server push
 *
 * A transport is declared at the bus and is the work for the actions it
 * covers: every plugin wraps it, wherever it was installed.
 *
 * Run it from a server that has no WebSocket at `/vc` and no stream at
 * `/api/vc/stream` (examples/static-server.mjs is one) and those two parts
 * print their failure: the socket never opens, the stream answers 404.
 */

import { Accepted, createAsyncCommandBus } from 'vapor-chamber'
import { defineChamberStore } from 'vapor-chamber/store'
import { httpTransport, wsTransport, createSseBridge } from 'vapor-chamber/transports'

// ─── HTTP ─────────────────────────────────────────────────────────────────────

// One transport for two patterns: only these actions are sent to the server.
// The bus re-sends through it what the answer declares temporary, after the
// wait it declares (feature-retry.ts).
// The build this page was made from, set by the server's `.env` as
// `VITE_APP_VERSION="${APP_VERSION}"` (pattern-2-laravel-vite.ts). A server
// that compares it answers a command from an old page `{ redirect }`. With no
// version set the page sends no header and nothing is checked.
const version = import.meta.env.VITE_APP_VERSION
const api = httpTransport({
  endpoint: '/api/vc',
  csrf: true,                          // the meta tag, else the XSRF-TOKEN cookie
  headers: {
    ...(version && { 'X-App-Version': version }),
    'Accept-Language': navigator.language,
  },
  onRedirect: (url) => location.assign(url),
  timeout: 15_000,                     // 15s timeout
})
const httpBus = createAsyncCommandBus({ transport: { 'cart*': api, 'order*': api } })

// The transport is the work for every action its patterns cover - a local
// handler for one of them never runs. Anything that must stay local needs a
// name no pattern covers.
httpBus.register('uiCartApply', async (cmd) => {
  // 'uiCartApply' matches neither 'cart*' nor 'order*' -> runs locally
  return { applied: true, item: cmd.target }
})

const added = await httpBus.dispatch('cartAdd', { id: 1 }, { qty: 2 })     // -> POST /api/vc
console.log('cartAdd (HTTP):', added.ok ? added.value : added.error.message)
const applied = await httpBus.dispatch('uiCartApply', { id: 99 })           // -> local only
console.log('uiCartApply (local):', applied.ok ? applied.value : applied.error.message)

// ─── WebSocket ────────────────────────────────────────────────────────────────

const ws = wsTransport({
  url: `ws://${location.host}/vc`,
  reconnect: true,
  reconnectDelay: 500,
  maxReconnects: 3,
  onConnect: () => console.log('WS connected'),
  onDisconnect: (e) => console.log('WS disconnected, code:', e.code),
})

const wsBus = createAsyncCommandBus({ transport: ws })
ws.connect()                      // explicit connect - allows deferring connection

// While the socket is down a dispatch is held in the transport's own outbox:
// it answers an Accepted whose `done` settles with the reply once sent.
async function send(action: string, target: object, payload?: object) {
  const sent = await wsBus.dispatch(action, target, payload)
  if (sent.ok && sent.value instanceof Accepted) {
    console.log(`${action} (WS): held, the socket is not open`)
    void sent.value.done.then((end) => console.log(`${action} (WS):`, end.ok ? end.value : end.error.message))
  } else {
    console.log(`${action} (WS):`, sent.ok ? sent.value : sent.error.message)
  }
}
await send('chatSend', { roomId: 'general' }, { text: 'Hello!' })
await send('presenceJoin', { userId: 42, roomId: 'general' })

// A frame with no `id`, `{"event": "chatPosted", "data": {...}}`, is the
// server's push: emitted on wsBus, its `data.stores` written first.
wsBus.on('chatPosted', (cmd) => console.log('[Chat]', cmd.target))

// On component unmount (wsBus.dispose() disconnects it too):
// ws.disconnect()

// ─── SSE Bridge (server push) ─────────────────────────────────────────────────

// Commands flow out over HTTP, and the server's events flow in over SSE: full
// bidirectional without WebSocket complexity. A push never reaches the
// transport: it is applied and emitted, not dispatched.
// `cartAdd` is sent (`cart*`), so it has no local change: the server's push
// writes the count.
const cart = defineChamberStore('cart', {
  state: () => ({ count: 0 }),
  reducers: { add: null },
})(httpBus)
cart.$onField('count', (n) => console.log('[Cart] count is now', n))

// A push is a fact the server declared: emitted on the bus by its event name,
// never dispatched, so no handler runs for it and nothing goes back.
httpBus.on('notificationsNew', (cmd) => {
  const notification = cmd.target as { id: string; message: string }
  console.log('[Notification]', notification.message)
})

const sseBridge = createSseBridge({
  url: '/api/vc/stream',
  withCredentials: true,           // send cookies with SSE request
  // The server writes `event: notificationsNew` and `data: {"id": "...", "message": "..."}`.
  // A `stores` member in the data, `{"stores": {"cart": {...}}}`, is written to
  // the store with that id before the event is emitted.
  events: ['notificationsNew', 'cartChanged'],
})

sseBridge.install(httpBus)

// Your own reading in place of the push: `onEvent` gets every event as sent.
// const logOnly = createSseBridge({ url: '/api/vc/log', onEvent: (event) => console.log(event.data) })

await new Promise((resolve) => setTimeout(resolve, 1500))
console.log('WS open?', ws.isConnected())
console.log('SSE connected?', sseBridge.isConnected())

// On app teardown:
// sseBridge.dispose()

export { httpBus, wsBus, ws, sseBridge, cart }
