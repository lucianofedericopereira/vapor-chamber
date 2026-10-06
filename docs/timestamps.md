# Timestamps

One rule: a timestamp that stays in the process is **epoch milliseconds**, a
number (`Date.now()`). One that crosses a boundary (storage, a backend, a
panel a person reads) is **RFC 3339 text in UTC**. That text names its own unit
and zone (`2026-10-02T17:41:19.250Z`). Every timestamp the library produces:

| Where | Field | Form | Crosses a boundary? | Pinned by |
|---|---|---|---|---|
| Every command | `meta.ts` | epoch ms | no: the bridges send no timestamp | `tests/timestamps.test.ts` |
| `metrics()` | an entry's `timestamp` | epoch ms | no | `tests/timestamps.test.ts` |
| `useCommandError()` | an entry's `timestamp` | epoch ms | no | `tests/timestamps.test.ts` |
| `vapor-chamber/devtools` | the timeline event's `time` | epoch ms, as Vue's devtools API takes it | handed to the devtools API | `tests/devtools.test.ts` |
| `vapor-chamber/devtools` | the inspector's `time` row | RFC 3339 text | yes: shown to a person | `tests/devtools.test.ts` |
| `createOutbox()` | a record's `queuedAt` | RFC 3339 text | yes: storage, and a backend a custom `OutboxStorage` syncs to | `tests/outbox.test.ts` |

`meta.ts` is a wall clock, for correlation and audit, not for timing: it can
move backwards when the system clock does. Time a span with
`performance.now()` (see the field's own comment in `src/command-bus.ts`).

A **duration** is milliseconds, a number, wherever it appears (`retryIn`,
`timeout`, `maxDelay`, `bufferTTL`). A backend's `Retry-After` header arrives
as seconds or an HTTP-date (RFC 9110 5.6.7). The client reads it into
`retryIn` (`tests/retry-after-grammar.test.ts`).
