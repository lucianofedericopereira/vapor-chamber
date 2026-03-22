/**
 * Feature example: Transport plugins
 * ====================================
 * createHttpBridge — fetch-based HTTP transport
 * createWsBridge   — WebSocket transport with reconnect
 * createSseBridge  — Server-sent events for server push
 */

import { createAsyncCommandBus, createCommandBus } from 'vapor-chamber'
import { createHttpBridge, createWsBridge, createSseBridge } from 'vapor-chamber/transports'
import { retry } from 'vapor-chamber'

// ─── HTTP Bridge ──────────────────────────────────────────────────────────────

const httpBus = createAsyncCommandBus()

httpBus.use(retry({ maxAttempts: 3, baseDelay: 300 }))

httpBus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,                          // auto-reads X-XSRF-TOKEN cookie
  headers: {
    'X-App-Version': '2.0.0',
    'Accept-Language': navigator.language,
  },
  timeout: 15_000,                     // 15s timeout
  actions: ['cart*', 'order*'],      // only forward these; others stay local
}))

// Local handlers run first; if missing, HTTP bridge forwards to server
httpBus.register('cartAddLocal', (cmd) => {
  // This stays local — not forwarded
  return { applied: true, item: cmd.target }
})

await httpBus.dispatch('cartAdd', { id: 1 }, { qty: 2 })    // → POST /api/vc
await httpBus.dispatch('cartAddLocal', { id: 99 })           // → local only

// ─── WebSocket Bridge ─────────────────────────────────────────────────────────

const wsBus = createAsyncCommandBus()

const wsBridge = createWsBridge({
  url: 'wss://api.example.com/vc',
  reconnect: true,
  reconnectDelay: 1_000,
  maxReconnects: 10,
  onConnect: () => console.log('WS connected'),
  onDisconnect: (e) => console.log('WS disconnected, code:', e.code),
})

wsBus.use(wsBridge)
wsBridge.connect()                // explicit connect — allows deferring connection

// Commands are queued during disconnect and flushed on reconnect
await wsBus.dispatch('chat.send', { roomId: 'general' }, { text: 'Hello!' })
await wsBus.dispatch('presence.join', { userId: 42, roomId: 'general' })

console.log('WS open?', wsBridge.isConnected())

// On component unmount:
// wsBridge.disconnect()

// ─── SSE Bridge (server push) ─────────────────────────────────────────────────

const mainBus = createCommandBus()

mainBus.register('notifications.new', (cmd) => {
  const notification = cmd.target as { id: string; message: string }
  console.log('[Notification]', notification.message)
  // Update UI reactively via useCommandState
})

mainBus.register('cartExternalUpdate', (cmd) => {
  console.log('[Another tab] cart updated:', cmd.target)
})

const sseBridge = createSseBridge({
  url: '/api/vc/stream',
  withCredentials: true,           // send cookies with SSE request
  onEvent: (event, bus) => {
    // Server sends: { "command": "notifications.new", "target": { "id": "...", "message": "..." } }
    const data = JSON.parse(event.data) as { command: string; target: any }
    bus.dispatch(data.command, data.target)
  },
})

sseBridge.install(mainBus)

console.log('SSE connected?', sseBridge.isConnected())

// On app teardown:
// sseBridge.teardown()

// ─── Combined: HTTP + SSE (most common real-world setup) ─────────────────────

const productionBus = createAsyncCommandBus()
productionBus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))

const productionSse = createSseBridge({
  url: '/api/vc/stream',
  onEvent: (event, bus) => {
    const { command, target } = JSON.parse(event.data)
    bus.dispatch(command, target)
  },
})
productionSse.install(productionBus as any)

// Commands flow out via HTTP; server events flow in via SSE
// Full bidirectional without WebSocket complexity
export {}
