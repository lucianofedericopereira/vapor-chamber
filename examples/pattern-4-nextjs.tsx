/**
 * Pattern 4: Next.js App Router + vapor-chamber
 * ==============================================
 * Vapor Chamber is not a Laravel tool.
 * This example uses a Next.js frontend with API routes as the backend.
 *
 * The bus is plain JS and its command state (`commandState`) is a plain
 * subscribe-and-read store, so React reads it with `useSyncExternalStore`:
 * every component sees the same busy flag and the same failure, with no
 * `useState` kept by hand.
 *
 * app/providers.tsx - configure the bus once at the app root
 */

'use client'
import { useSyncExternalStore } from 'react'
import { commandState, createAsyncCommandBus, setCommandBus } from 'vapor-chamber'
import { httpTransport } from 'vapor-chamber/transports'

// Singleton bus - shared across all 'use client' components. Its retry is on
// by default: the transport's transient failures are re-sent.
// Log via onAfter: it observes settled results on the async bus. The logger()
// plugin would print the settled result here too.
const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) })
bus.onAfter((cmd, result) => {
  console.log(`⚡ ${cmd.action}`, result.ok ? result.value : result.error)
})

// Installed as the shared bus here, at module scope, before any component
// renders: a child that calls getCommandBus() in its first render would
// otherwise get a default bus, and setting one after it was used is the DEV
// warning's case. (A useEffect runs after the children's first render.)
setCommandBus(bus) // accepts either bus flavor

// One handle for the app's life: what is in flight on the bus, and what failed.
const state = commandState(bus)
const subscribe = (notify: () => void) => state.subscribe(notify)

/** Is `action` in flight on the bus (from any caller), and the bus's latest failure of any action. */
export function useCommandState(action: string, target: unknown = {}) {
  const busy = useSyncExternalStore(subscribe, () => state.pending(action, target).value)
  const error = useSyncExternalStore(subscribe, () => state.lastError.value)
  return { busy, error }
}

export { bus, state }

/*
 * app/components/CheckoutButton.tsx
 * ----------------------------------
 */
type CartItem = { id: number; qty?: number }

export function CheckoutButton({ items }: { items: CartItem[] }) {
  const { busy, error } = useCommandState('orderCreate')

  async function checkout() {
    if (busy) return // a press in flight is ignored
    state.clear() // the last failure is not this press's
    await bus.dispatch('orderCreate', {}, { items })
  }

  return (
    <>
      {/* aria-disabled, not disabled: keyboard focus stays on the button */}
      <button type="button" onClick={checkout} aria-disabled={busy}>
        {busy ? 'Processing...' : 'Complete purchase'}
      </button>
      <p role="status" className="error">{error?.message}</p>
    </>
  )
}

/*
 * app/api/vc/route.ts - Next.js API Route handler
 * --------------------------------------------------
 * A failure is an RFC 9457 problem, the same contract the Laravel controller
 * answers (examples/laravel-backend/VaporChamberController.php).
 *
 * const problem = (status: number, code: string, detail: string) =>
 *   Response.json({ status, code, detail }, { status, headers: { 'Content-Type': 'application/problem+json' } })
 *
 * export async function POST(req: Request) {
 *   const { command, target, payload } = await req.json()
 *   switch (command) {
 *     case 'orderCreate': return Response.json({ state: await orderService.create(payload) })
 *     case 'cartAdd':     return Response.json({ state: await cartService.add(target, payload) })
 *     default:            return problem(404, 'unknown_command', `Unknown command: ${command}`)
 *   }
 * }
 */

/*
 * Protocol - what the backend receives:
 * POST /api/vc
 * { "command": "orderCreate", "target": {}, "payload": { "items": [...] } }
 *
 * What it returns:
 * { "state": { "orderId": "ord_abc123", "status": "pending" } }
 * or, on failure, a problem: { "status": 422, "code": "...", "detail": "..." }
 *
 * Same protocol as Laravel. Different runtime, identical contract.
 */
