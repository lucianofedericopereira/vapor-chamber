/**
 * Pattern 4: Next.js App Router + vapor-chamber
 * ==============================================
 * Vapor Chamber is not a Laravel tool.
 * This example uses a Next.js frontend with API routes as the backend.
 *
 * app/providers.tsx - configure the bus once at the app root
 */

'use client'
import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'

// Singleton bus - shared across all 'use client' components. Its retry is on
// by default: the bridge's transient failures are re-sent.
// Log via onAfter: it observes settled results on the async bus (the sync
// logger() plugin would see an unresolved Promise here).
const bus = createAsyncCommandBus()
bus.onAfter((cmd, result) => {
  console.log(`⚡ ${cmd.action}`, result.ok ? result.value : result.error)
})
bus.use(createHttpBridge({ endpoint: '/api/vc' }))
// Installed as the shared bus here, at module scope, before any component
// renders: a child that calls getCommandBus() in its first render would
// otherwise get a default bus, and setting one after it was used is the DEV
// warning's case. (A useEffect runs after the children's first render.)
setCommandBus(bus) // accepts either bus flavor

export function VaporChamberProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export { bus }

/*
 * app/components/CheckoutButton.tsx
 * ----------------------------------
 * React state, not vapor-chamber's composables: `useCommand()` is a Vue
 * composable, and its signals do not re-render a React component. The bus is
 * plain JS, so a React component dispatches on it and keeps its own state.
 *
 * 'use client'
 * import { useState } from 'react'
 * import { bus } from '../providers'
 * import type { CartItem } from '../types'
 *
 * export function CheckoutButton({ items }: { items: CartItem[] }) {
 *   const [busy, setBusy] = useState(false)
 *   const [error, setError] = useState<string | null>(null)
 *
 *   async function checkout() {
 *     if (busy) return                       // a press in flight is ignored
 *     setBusy(true)
 *     const result = await bus.dispatch('orderCreate', {}, { items })
 *     setBusy(false)
 *     setError(result.ok ? null : result.error.message)
 *   }
 *
 *   return (
 *     <>
 *       {/* aria-disabled, not disabled: keyboard focus stays on the button *\/}
 *       <button onClick={checkout} aria-disabled={busy}>
 *         {busy ? 'Processing...' : 'Complete purchase'}
 *       </button>
 *       <p role="status" className="error">{error}</p>
 *     </>
 *   )
 * }
 */

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

