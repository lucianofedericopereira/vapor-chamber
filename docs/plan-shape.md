# Plan: finish the shape

**Goal:** a good shape for what is built: fixes, consistency, cleanup, and the
architecture try (one scheduler, health per target). The larger plan
(`docs/plan-failures-and-contract.md`) stays as the reference and the list of
the work after this one. A release is not this plan's goal; 1.25.0 is the
version when one is cut (2.0.0 waits for Vue 3.6).

**Each step is done when** its tests are on the right shape at 100% coverage,
and it is measured (size, and speed where a path changed).

## 1. What was changed without being asked

Decided by the project's rules (correctness, the success models read, what
1.24 shipped); the retry model itself is not decided here.

1. REVERTED to 1.24: `retry()` re-runs a handler's own throw. The retry model
   is decided (plan 7.1 item 3) and lands after this plan; until then the
   code keeps what 1.24 shipped.
2. REVERTED to 1.24: 5xx retried (the AWS SDK and .NET defaults too); a
   plugin's own throw stays not retried, as in 1.24.
3. KEPT: the HTTP client honours `Retry-After` on any status (RFC 9110).
4. REVERTED: `X-RateLimit-Reset` read again, as the wait's fallback (Envoy reads it).
5. KEPT: `connect({ retry: n })` wraps its bridge in `retrying()` (the IIFE users keep the feature).
6. KEPT: the PHP controller sends `errors` pointers for a `ValidationException` (FormBus had nothing to read) and no longer takes a code from `type`.
7. KEPT: `HttpError`'s `cause` option and `VcTestError`'s `emitter` removed (no caller).
8. KEPT: the ledger's revert after `clear()` (a defect, with its failing test).
9. KEPT: dead code removed (measured by coverage).
10. KEPT, re-measured after the reverts: the size budgets and the ESM ceiling.

One deviation from 1.24 stays, on correctness: a request with no response
(`lost`) is re-sent only for a command with an idempotency key (the outcome is
unknown; gRPC retries only what never reached the server).

## 2. Fixes that finish the shape

0. DONE: the scheduler (`src/scheduler.ts`): `serialize()`'s lanes, `retry()`'s
   waits and the outbox's `Retry-After` wait share one module. Its size paid for
   by sharing the buses' `use()`/`respond()`/`dispose()`, a single-promise async
   `request()` (22% faster), debounce on one map and the dead `globalThis`
   guards; the budgets were lowered to the result.
1. DONE, **health per target**, the try's second half, on the contract instead
   of a shared state object: every `limited` refusal (throttle, circuit
   breaker, rate limit, a backend's 429/503) declares `retryIn`, and `retry()`,
   `retrying()` and the outbox already wait for a declared `retryIn`, in any
   plugin order. Found on the way and fixed with its failing test: a backend's
   failure never opened the breaker. The retry budget belongs to the retry
   model (below, "After this plan").
2. DONE, **the HTTP client's safe helpers** return their own error shape (`{ message, code }`, typed as such, while a problem body has `detail`). Return the contract's problem.
3. DONE, **the contract doc** states what the code does: a `problem` in a 2xx on the single endpoint is read as the failure it declares.
4. DONE, **the `Plugin` type** is loose on the async bus (three `const plugin: any` escapes; the whitepaper names this and defers it). Type what the code does.
5. DONE, **comments that carry history** instead of the current reason (release-by-release logs in source headers). Keep the reason, point at the CHANGELOG for the past.
6. DONE, **router tests** that build their own router: move them onto `tests/router/fixture.ts`.
7. DONE, **stale docs:** search for behaviour this work changed; remove the whitepaper's "Precognition" claim for FormBus (nothing implements it); `examples/feature-retry.ts` matches statuses inside `error.message` (the default rule reads the condition).

## 3. When a release is cut

1. CHANGELOG: one migration section for the four breaking changes (codes, wire contract, retries, IIFE target); version 1.25.0 (2.0.0 waits for Vue 3.6's release).
2. One full verification, then the owner pushes; tag only after green CI on every job.

## 4. DONE: the retry model (plan 7.1 item 3, decided): the build

The mechanics the decision leaves open, settled from the code:

1. **The boundary.** The async runner retries the call that produces the
   outcome: a handler's `execute`, and a plugin that declares itself a
   transport (`transport: true`; the bridges do). A transport that passes a
   command on is not retried there. The plugins outside see one dispatch - the
   property `retrying()` has today, whose engine moves into the runner.
2. **Bounds.** 3 attempts in total; full jitter over `base * 2^n` (base 200 ms),
   capped at 20 s (`maxDelay`); a declared `retryIn` is waited as declared,
   and one longer than the cap is not re-sent: the failure is returned with it.
3. **The budget, per bus** (gRPC A6): 10 tokens; a retryable failure costs 1, a
   success refunds 0.1; a retry runs only while more than half remain.
4. **The class rule.** Final never (the verdict conditions, `aborted`,
   `exceeded`, a library bug); transient always (`limited`, `timeout`, a
   declared `retryIn`); uncertain (`lost`, `failed`, `unexpected`, `unknown`)
   only for an action declared idempotent, or a command carrying an
   idempotency key.
5. **Declarations.** `createAsyncCommandBus({ retry: { actionPolicies: { pattern:
   'idempotent' | false | n } } })`, and `retry` on a schema action, which the
   schema bus maps to the same option; `retry: false` turns the default off.
6. **Removed:** `retry()`, `retrying()`, the IIFEs' `connect({ retry })` (the
   bus default applies). The sync bus does not retry (it cannot wait).

## After this plan

1.25.0 ends with section 4. For 1.26, recorded in the larger plan: chained actions,
`BusSchema` `fails`, the PHP package, wire compression (tables, handshake,
CBOR), the debug mode and the fuse, `Retry-After` for a batched command, the
remaining accessibility items. (`HttpError` and `RouterError` joining: done, s35.131.)
