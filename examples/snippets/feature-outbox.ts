/**
 * Feature example: the offline outbox - commands held offline, replayed once
 * ===========================================================================
 * Offline, a write is stored instead of sent and answers an `Accepted`, whose
 * `done` settles with the server's answer once it is sent. Back online it is
 * replayed in order with its ORIGINAL idempotency key, so a backend that
 * already saw it answers from its cache instead of running it again. A refused
 * replay is dropped and its `done` says why; the rest go on. The queue is
 * stored, so a reload keeps it.
 */

import { Accepted, createAsyncCommandBus, idempotent } from 'vapor-chamber'
import { createOutbox } from 'vapor-chamber/outbox'
import { httpTransport } from 'vapor-chamber/transports'

// A bus option: it holds at the work step, below every plugin. The queue is
// saved in localStorage (`storage: indexedDbStorage()` for IndexedDB) and
// shared by the origin's tabs: each tab sends what its own callers wait on, and
// a closed tab's records go to another tab. A previous session's queue loads
// now, and goes first.
const outbox = createOutbox({ actions: ['cart*', 'order*'] })
const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', csrf: true }), outbox })
bus.use(idempotent({ actions: ['order*'] }))

console.log(`Held from an earlier visit: ${outbox.pending.value}`)

// ─── Dispatch as usual; the answer says whether it went or waits ─────────────

async function write(action: string, target: object, payload?: object) {
  const result = await bus.dispatch(action, target, payload)
  if (result.ok && result.value instanceof Accepted) {
    console.log(`${action}: held, ${outbox.pending.value} pending`)
    // Each replay carries its record's key (the Idempotency-Key header) and
    // `meta.origin === 'replay'`. `done` settles with what the server answers.
    void result.value.done.then((end) => {
      console.log(end.ok ? `${action}: sent once, answered` : `${action}: dropped, ${end.error.message}`)
    })
  } else {
    console.log(`${action}: sent at once`, result.ok ? result.value : result.error.message)
  }
}

await write('cartAdd', { id: 1 }, { qty: 2 })
await write('orderCreate', { sku: 'A1' })   // the static server has no such command: its replay is refused

// A record no caller waits on (a closed tab's, an earlier visit's): its refusal lands here.
console.log('Dropped with no caller waiting:', outbox.rejected.value)

// `autoFlush` (the default) flushes on the browser's 'online' event; a manual
// flush returns a summary.
const { replayed, failed, rejected } = await outbox.flush()
console.log({ replayed, failed, rejected })

// `pending` is a signal: bind it in a template ("3 changes pending sync").
export { bus, outbox }
