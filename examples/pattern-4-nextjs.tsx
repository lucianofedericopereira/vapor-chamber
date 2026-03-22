/**
 * Pattern 4: Next.js App Router + vapor-chamber
 * ==============================================
 * Vapor Chamber is not a Laravel tool.
 * This example uses a Next.js frontend with API routes as the backend.
 *
 * app/providers.tsx — configure the bus once at the app root
 */

'use client'
import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'
import { retry, logger } from 'vapor-chamber'
import { useEffect } from 'react'

// Singleton bus — shared across all 'use client' components
const bus = createAsyncCommandBus()
bus.use(logger({ collapsed: true }))
bus.use(retry({ maxAttempts: 3, baseDelay: 200 }))
bus.use(createHttpBridge({ endpoint: '/api/vc' }))

export function VaporChamberProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    setCommandBus(bus as any)
  }, [])
  return <>{children}</>
}

/*
 * app/components/CheckoutButton.tsx
 * ——————————————————————————————————
 * 'use client'
 * import { useCommand } from 'vapor-chamber'
 * import type { CartItem } from '../types'
 *
 * export function CheckoutButton({ items }: { items: CartItem[] }) {
 *   const { dispatch, loading, lastError } = useCommand()
 *
 *   return (
 *     <>
 *       <button
 *         onClick={() => dispatch('orderCreate', { items })}
 *         disabled={loading.value}
 *       >
 *         {loading.value ? 'Processing…' : 'Complete purchase'}
 *       </button>
 *       {lastError.value && (
 *         <p className="error">{lastError.value.message}</p>
 *       )}
 *     </>
 *   )
 * }
 */

/*
 * app/api/vc/route.ts — Next.js API Route handler
 * ——————————————————————————————————————————————————
 * export async function POST(req: Request) {
 *   const { command, target, payload } = await req.json()
 *
 *   const state = await match(command)
 *     .with('orderCreate', () => orderService.create(target))
 *     .with('cartAdd',     () => cartService.add(target, payload))
 *     .otherwise(() => { throw new Error(`Unknown command: ${command}`) })
 *
 *   return Response.json({ state })
 * }
 */

/*
 * Protocol — what the backend receives:
 * POST /api/vc
 * { "command": "orderCreate", "target": { "items": [...] } }
 *
 * What it returns:
 * { "state": { "orderId": "ord_abc123", "status": "pending" } }
 *
 * Same protocol as Laravel. Different runtime, identical contract.
 */
export {}
