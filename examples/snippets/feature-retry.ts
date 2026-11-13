/**
 * Feature example: the async bus's retry
 * ======================================
 * On by default. The bus re-sends the call that produced the outcome - a
 * handler, or the bus's transport - so the plugins outside see one
 * dispatch: a circuit breaker counts one, a rate limit spends one.
 * Each trial below registers a handler that fails a few times on a bus of its
 * own, and prints how often the bus sent it.
 */

import { BusError, conditionOf, createAsyncCommandBus, createAsyncSchemaCommandBus, type AsyncCommandBus } from 'vapor-chamber'
import { httpTransport } from 'vapor-chamber/transports'

// `context.attempts` says how many sends were made, when more than one.
const attemptsOf = (error: Error) => (error as BusError).context?.attempts ?? 1

async function trial(bus: AsyncCommandBus, action: string, failures: number, failure: () => Error, target: object = {}, payload?: object) {
  let sent = 0
  bus.register(action, async () => {
    if (++sent <= failures) throw failure()
    return 'answered'
  })
  const result = await bus.dispatch(action, target, payload)
  const end = result.ok ? result.value : `${conditionOf(result.error) ?? result.error.message} after ${attemptsOf(result.error)}`
  console.log(`${action}: sent ${sent}x ->`, end)
}

// A slow server answers `limited` (a 429 or 503). A plain throw is a failure that may have landed.
const slow = () => new BusError('limited:rate', 'Slow down', { context: { retryIn: 20 } })
const broke = () => new Error('upstream down')

// ─── The default ──────────────────────────────────────────────────────────────
//
// A transient failure is re-sent for any action: `limited` (a 429 or 503, a
// rate limit) and a 408 (the server never got the whole request). 3 attempts
// in total, after a jittered wait under 200ms, then 400ms. A declared wait
// (`Retry-After`, `context.retryIn`) sets when, never whether. A verdict
// (422, 404, 403, 409), an abort and a redirect are never re-sent. Until a 429
// or 503 wait ends, another command for that action waits it too, unsent.

await trial(createAsyncCommandBus(), 'reportBuild', 2, slow)    // sent 3x, answered
await trial(createAsyncCommandBus(), 'reportDeploy', 5, slow)   // sent 3x, then the failure is returned
await trial(createAsyncCommandBus(), 'reportPublish', 1, broke) // sent 1x: a plain throw may have landed

// ─── Uncertain failures: declare what is safe to run twice ───────────────────
//
// No response, a 500 or a handler's throw may have landed: re-sending a write
// could run it twice. The bus re-sends one only for an action declared
// idempotent - it then stamps one Idempotency-Key on every attempt, so the
// backend collapses them - or a command that already carries a key.

const retry = {
  actionPolicies: {               // the most specific match wins
    'cart*': 'idempotent',   // setting a quantity twice is setting it once
    catalogFetch: 'idempotent',
    invoicePay: false,       // never re-sent, whatever the failure
    searchRun: 2,            // at most 2 attempts
  },
} as const

await trial(createAsyncCommandBus({ retry }), 'catalogFetch', 2, broke) // sent 3x, answered
await trial(createAsyncCommandBus({ retry }), 'invoicePay', 1, slow)    // sent 1x, whatever the failure
await trial(createAsyncCommandBus({ retry }), 'searchRun', 5, slow)     // sent 2x

// The same declarations on a schema, next to the action they describe:
const schemaBus = createAsyncSchemaCommandBus({
  cartSet: { retry: 'idempotent', target: { id: 'number' }, payload: { qty: 'number' } },
  orderPay: { retry: false, target: { orderId: 'number' } },
})
await trial(schemaBus, 'cartSet', 2, broke, { id: 1 }, { qty: 2 })   // sent 3x, answered
await trial(schemaBus, 'orderPay', 1, slow, { orderId: 7 })          // sent 1x

// ─── Over the wire ───────────────────────────────────────────────────────────
//
// The transport is re-sent like a handler. A server's verdict is never re-sent,
// and its message is the server's own.

const shop = createAsyncCommandBus({
  transport: httpTransport({ endpoint: '/api/vc', csrf: true }),
  retry,
})
const added = await shop.dispatch('cartAdd', { id: 1 }, { qty: 2 })
console.log('cartAdd:', added.ok ? added.value : added.error.message)
const order = await shop.dispatch('orderCreate', { items: [1, 2, 3] })
if (!order.ok) console.log(`orderCreate: ${conditionOf(order.error)}, sent ${attemptsOf(order.error)}x -`, order.error.message)

// ─── Bounds, and turning it off ──────────────────────────────────────────────
//
// Each bus also keeps a budget: when failures pile up (half of 10 tokens
// spent, a success refunds a tenth), it returns them at once, so retries
// cannot multiply the load on a backend that is down. That is why each trial
// above has a bus of its own.

const tuned = createAsyncCommandBus({ retry: { maxAttempts: 4, baseDelay: 500, maxDelay: 10_000 } })
const once = createAsyncCommandBus({ retry: false })
await trial(once, 'reportOnce', 1, slow)     // sent 1x

export { shop, schemaBus, tuned, once }
