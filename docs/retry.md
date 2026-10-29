# The async bus's retry

The async bus re-sends a failed command by one rule. The sync bus never re-sends, because it
cannot wait.[^policy-test]

[^policy-test]: Every statement on this page is pinned by `tests/retry-policy.test.ts`, unless a footnote names another test.

## What it re-sends

The runner re-sends the call that produced the outcome: the action's work, its transport or its
local handler. So the plugins see one dispatch.

- A transport that answers with its local handler (`defineTransport`'s `local()`) is re-sent
  whole.
- A transport's own throw (`transport:failed:send`) is a bug and is never re-sent.

## Which failures

The rule reads the failure's condition (`retryClass`, `src/failure.ts`). The HTTP client reads
it the same way.

| class | conditions | re-sent |
|---|---|---|
| transient | `limited`, a 408 | for any action |
| uncertain | `lost`, `failed`, `unexpected`, `unknown`, a 504, a transport's own timeout | only for an action declared idempotent, or a command with an idempotency key |
| final | a verdict (`invalid`, `refused`, `missing`, `already`, `conflict`, `unauthenticated`), `aborted`, `exceeded`, a library bug | never |

**A declared wait (`context.retryIn`) sets when, never whether** (RFC 9110 10.2.3).

- From an HTTP answer it is `Retry-After`, else the `RateLimit` field's `t` for a policy with no
  quota left (`r=0`), else `X-RateLimit-Reset` (`_declaredWait`, `src/http.ts`).
- The client, every transport, a batched result's own headers, an app's own `httpClient` (header
  names in any case) and a 202's next poll all read it the same way.[^declared-wait]
- `X-RateLimit-Reset` has no standard. Digits a timer can wait are delay seconds, and larger ones
  are Unix seconds, as Laravel and GitHub send it.
- A transient failure with a wait is re-sent for any action, after the wait.
- A verdict with a wait, such as a 409 with `Retry-After`, is re-sent only when the command is
  identified.[^unidentified]

[^declared-wait]: `tests/declared-wait.test.ts`, `tests/accepted.test.ts`.

[^unidentified]: `tests/retry-unidentified.test.ts`.

A plugin's own refusal is never re-sent, though its condition is transient: it sits outside the
call the runner re-sends. A call throttled at the sender (`pace`) never reaches the
bus.[^retryable-column] A replay belongs to its own scheduler, the outbox's.

[^retryable-column]: `tests/retryable-column.test.ts`.

## The hold

A transport the library ships (`httpTransport`, single or batched, and `wsTransport`) holds an
action after a `limited` answer (429, 503) that declares a wait.[^hold]

- Until the wait ends, a command for that action is not sent. It fails at once as
  `transport:limited:held`, with `retryIn` set to the time left.
- The rule above waits it as it waits a 429's, so the command is sent when the wait ends.
- A time left over `maxDelay`, `retry: false` or a policy `false` returns the failure.
- The dispatch's abort and `dispose()` end the wait.
- The outbox keeps the record and flushes after the wait.

[^hold]: `tests/hold.test.ts`.

The hold covers the action on that transport, never the whole transport, since a 429 does not
say what it covers (RFC 6585 4).

- A verdict with a wait (a 409) holds nothing. Neither does a success that reports `RateLimit`
  with `r=0`.
- A later answer with a later end extends a hold. An earlier one never shortens it.
- The transport's `dispose()`, which the bus's `dispose()` runs, forgets its holds.

## Bounds

- 3 attempts in total, the first included (`maxAttempts`).
- The wait is drawn uniformly under `baseDelay * 2^(n-1)`, base 200 ms (full jitter).
- It is capped at 20 s (`maxDelay`). A declared `retryIn` is waited as declared. One longer than
  the cap is not re-sent: the failure is returned.
- A failure sent more than once carries `context.attempts`.
- The HTTP client (`createHttpClient`, `postCommand`) takes the same bound,
  `retry: { maxAttempts }`, 3 by default.[^one-client] It is on for a GET through a client and
  off for any other method. `retry: {}` turns it on and `retry: false` off.
- The client waits the same schedule, base 200 ms and cap 20 s.[^http-schedule] A declared wait
  sets its own. The client sleeps a wait of up to 30 s inside the request, and a longer one ends
  the request.
- A transport sends each command once, through an app's client too. The bus re-sends it, so the
  two never multiply.

[^one-client]: `tests/one-client.test.ts`.

[^http-schedule]: `tests/http-retry-schedule.test.ts`.

## The budget

One budget per bus, as in gRPC's retry design (A6).[^budget]

- It holds 10 tokens.
- Each failure the rule would re-send costs 1. So does the last attempt's failure, and the
  failure of an action declared `false`, which is never re-sent.
- Each success refunds 0.1.
- A re-send runs only while more than half the tokens remain.

So 3 attempts of one dispatch cost 3 tokens.

[^budget]: `tests/retry-policy.test.ts`, "the budget".

## Declaring an action

```ts
createAsyncCommandBus({
  retry: { actionPolicies: { cartAdd: 'idempotent', 'cart*': 2, checkout: false } },
});
```

A policy is `'idempotent'`, `false` (never re-sent) or an attempt count. The most specific
pattern wins: the exact name, then the longest prefix, then `*`.[^policies]

- A schema action's `retry` maps to the same option.
- `retry: false` turns the default off.
- The IIFEs' `connect({ retry })` passes `retry` to the async bus.

An action declared idempotent is stamped with one idempotency key, the same on every attempt.

[^policies]: `tests/retry-action-policies.test.ts`.
