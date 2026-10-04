/**
 * Feature example: the offline outbox - commands queued offline, replayed once
 * ===========================================================================
 * Offline, a write is stored instead of sent and answers `{ queued: true }`.
 * Back online it is replayed in order with its ORIGINAL idempotency key, so a
 * backend that already saw it answers from its cache instead of running it
 * again. A refused replay is dropped (`outboxRejected`); the rest go on.
 */

import { createAsyncCommandBus, idempotent } from 'vapor-chamber'
import { createOutbox } from 'vapor-chamber/outbox'
import { createHttpBridge } from 'vapor-chamber/transports'

const bus = createAsyncCommandBus()

// Outermost: offline writes are captured before any wire work happens.
const outbox = createOutbox({ actions: ['cart*', 'order*'] })
outbox.install(bus)
bus.use(idempotent({ actions: ['order*'] }), { priority: 100 })
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))

// Restore what a previous session left queued, before the first flush.
await outbox.hydrate()

// ─── Dispatch as usual; the answer says whether it went or waits ─────────────

const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 })
if (result.ok && (result.value as { queued?: boolean } | undefined)?.queued) {
  console.log(`Saved offline - ${outbox.pending.value} pending`)
}

// ─── What happens to a queued command ───────────────────────────────────────

// Each replay carries its record's key in the envelope's meta (and the
// Idempotency-Key header), and `meta.origin === 'replay'` in handlers.
bus.on('outboxRejected', (cmd) => {
  const { record, error } = cmd.target as { record: { action: string }; error: Error }
  console.warn(`Dropped ${record.action}: ${error.message}`)  // the server refused it
})

// `autoFlush` (the default) flushes on the browser's 'online' event; a manual
// flush returns a summary.
const { replayed, failed, rejected } = await outbox.flush()
console.log({ replayed, failed, rejected })

// `pending` is a signal: bind it in a template ("3 changes pending sync").
export { outbox }
