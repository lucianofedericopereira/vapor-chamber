/**
 * Feature example: the async bus's retry
 * ======================================
 * On by default. The bus re-sends the call that produced the outcome - a
 * handler, or a transport (the bridges) - so the plugins outside see one
 * dispatch: a circuit breaker counts one, a rate limit spends one.
 */

import { createAsyncCommandBus, createAsyncSchemaCommandBus, conditionOf } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'

// ─── The default ──────────────────────────────────────────────────────────────
//
// A transient failure is re-sent for any action: `limited` (a 429 or 503, a
// rate limit) and a 408 (the server never got the whole request). 3 attempts
// in total, after a jittered wait under 200ms, then 400ms. A declared wait
// (`Retry-After`, `context.retryIn`) sets when, never whether. A verdict
// (422, 404, 403, 409), an abort and a redirect are never re-sent.

const bus = createAsyncCommandBus()
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))

// ─── Uncertain failures: declare what is safe to run twice ───────────────────
//
// No response, a 500 or a handler's throw may have landed: re-sending a write
// could run it twice. The bus re-sends one only for an action declared
// idempotent - it then stamps one Idempotency-Key on every attempt, so the
// backend collapses them - or a command that already carries a key.

const shop = createAsyncCommandBus({
  retry: {
    actionPolicies: {               // the most specific match wins
      'cart*': 'idempotent',   // setting a quantity twice is setting it once
      orderPay: false,         // never re-sent, whatever the failure
      searchRun: 2,            // at most 2 attempts
    },
  },
})
shop.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))

// The same declarations on a schema, next to the action they describe:
const schemaBus = createAsyncSchemaCommandBus({
  cartSet: { retry: 'idempotent', target: { id: 'number' }, payload: { qty: 'number' } },
  orderPay: { retry: false, target: { orderId: 'number' } },
})

// ─── Bounds, and turning it off ──────────────────────────────────────────────
//
// Each bus also keeps a budget: when failures pile up (half of 10 tokens
// spent, a success refunds a tenth), it returns them at once, so retries
// cannot multiply the load on a backend that is down.

const tuned = createAsyncCommandBus({ retry: { maxAttempts: 4, baseDelay: 500, maxDelay: 10_000 } })
const once = createAsyncCommandBus({ retry: false })

// ─── Reading the outcome ─────────────────────────────────────────────────────

const result = await shop.dispatch('orderCreate', { items: [1, 2, 3] })
if (!result.ok) {
  // `context.attempts` says how many sends were made, when more than one.
  console.error(`Order failed (${conditionOf(result.error)}):`, result.error?.message)
}

export { bus, schemaBus, tuned, once }
