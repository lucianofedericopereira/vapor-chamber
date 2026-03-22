/**
 * Feature example: retry plugin — configurable backoff for failed dispatches
 * ==========================================================================
 */

import { createAsyncCommandBus } from 'vapor-chamber'
import { retry } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'

// ─── Basic: retry all failed commands up to 3 times ──────────────────────────

const bus = createAsyncCommandBus()
bus.use(retry({ maxAttempts: 3, strategy: 'exponential', baseDelay: 200 }))
// Delays: 200ms, 400ms — then gives up

// ─── Fixed delay ──────────────────────────────────────────────────────────────

bus.use(retry({ maxAttempts: 5, strategy: 'fixed', baseDelay: 500 }))
// Delays: 500ms, 500ms, 500ms, 500ms

// ─── Linear backoff ───────────────────────────────────────────────────────────

bus.use(retry({ maxAttempts: 4, strategy: 'linear', baseDelay: 100 }))
// Delays: 100ms, 200ms, 300ms

// ─── Only retry specific actions ─────────────────────────────────────────────

const apiBus = createAsyncCommandBus()
apiBus.use(retry({
  maxAttempts: 5,
  baseDelay: 300,
  actions: ['api*', 'webhook*'],   // glob patterns
}))

// Non-matching actions are not retried, even if they fail:
apiBus.register('uiClick', () => { throw new Error('not retried') })

// ─── Custom retryable predicate ───────────────────────────────────────────────

const smartBus = createAsyncCommandBus()
smartBus.use(retry({
  maxAttempts: 4,
  baseDelay: 200,
  isRetryable: (error, attempt) => {
    // Don't retry client errors (4xx) — only server/network errors
    if (error.message.includes('400') || error.message.includes('422')) return false
    if (error.message.includes('401') || error.message.includes('403')) return false
    // Only retry up to attempt 2 for timeout errors
    if (error.message.includes('timed out') && attempt > 2) return false
    return true
  },
}))

// ─── Combined with HTTP bridge ────────────────────────────────────────────────

const productionBus = createAsyncCommandBus()

productionBus.use(retry({
  maxAttempts: 3,
  strategy: 'exponential',
  baseDelay: 500,
  isRetryable: (err) => {
    // Retry network and 5xx errors only
    if (err.message.includes('fetch failed')) return true
    if (err.message.includes('HTTP 5')) return true
    return false
  },
}))

productionBus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  timeout: 10_000,
}))

// Flaky network? Commands are retried automatically with increasing delays.
const result = await productionBus.dispatch('orderCreate', { items: [1, 2, 3] })
if (!result.ok) {
  console.error('Order failed after all retries:', result.error?.message)
}

export {}
