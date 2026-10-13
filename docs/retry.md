# The async bus's retry

The async bus re-sends a failed command by one rule. The sync bus never
re-sends: it cannot wait. Every statement here is pinned by
`tests/retry-policy.test.ts`, unless another test is named.

## What it re-sends

The runner re-sends the call that produced the outcome. That is a handler,
or a plugin that declares `transport: true`, as the bridges do. A transport
that passed the command on is not re-sent there. The plugins outside see one
dispatch.

## Which failures

The rule reads the failure's condition (`retryClass`, src/failure.ts). The
http client reads it the same way.

| class | conditions | re-sent |
|---|---|---|
| transient | `limited`, a 408 | for any action |
| uncertain | `lost`, `failed`, `unexpected`, `unknown`, a 504, a transport's own timeout | only for an action declared idempotent, or a command with an idempotency key |
| final | a verdict (`invalid`, `refused`, `missing`, `already`, `conflict`, `unauthenticated`), `aborted`, `exceeded`, a library bug | never |

A declared wait (`context.retryIn`) sets when, never whether (RFC 9110
10.2.3). From an http answer it is `Retry-After`, else the RateLimit field's
`t` for a policy with no quota left (`r=0`), else `X-RateLimit-Reset`
(`declaredWait`, src/http.ts). A transient failure with a wait is re-sent for any
action, after the wait. A verdict with a wait, such as a 409 with
`Retry-After`, is re-sent only when identified
(tests/retry-unidentified.test.ts:126,135).

A plugin's own refusal and a `register({ throttle })` refusal are never
re-sent, though their condition is transient: they sit outside the call the
runner re-sends (tests/retryable-column.test.ts). A replay belongs to its own
scheduler, the outbox's.

## Bounds

- 3 attempts in total, the first included (`maxAttempts`).
- The wait is drawn uniformly under `baseDelay * 2^(n-1)`, base 200 ms (full
  jitter).
- It is capped at 20 s (`maxDelay`). A declared `retryIn` is waited as
  declared. One longer than the cap is not re-sent: the failure is returned.
- A failure sent more than once carries `context.attempts`.
- The http client (`createHttpClient`, `postCommand`, `retry` above 0) waits
  the same schedule, base 200 ms and cap 20 s
  (tests/http-retry-schedule.test.ts). A declared wait sets its own. It
  sleeps one of up to 30 s inside the request, and a longer one ends it.

## The budget

One budget per bus, as in gRPC's retry design (A6). It holds 10 tokens. Each
re-send costs 1, each success refunds 0.1. A re-send runs only while more
than half the tokens remain.

## Declaring an action

```ts
createAsyncCommandBus({
  retry: { actionPolicies: { cartAdd: 'idempotent', 'cart*': 2, checkout: false } },
});
```

A policy is `'idempotent'`, `false` (never re-sent) or an attempt count. The
most specific pattern wins: the exact name, then the longest prefix, then `*`
(tests/retry-action-policies.test.ts). A schema action's `retry` maps to the
same option. `retry: false` turns the default off. The IIFEs' `connect({ retry })`
passes `retry` to the async bus.

An action declared idempotent is stamped with one idempotency key, the same
on every attempt.
