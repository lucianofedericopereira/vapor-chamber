# The failure and wire contract

What a failure is, how it is named, and the one shape both sides of the wire
read. A reference: the code anchors it, and each fact names its test where
one pins it. The retry rule that reads these failures is
[retry.md](./retry.md). Every code the library raises is listed in
[errors.md](./errors.md), generated from `ERROR_CODE_REGISTRY`.

**Reading by contract.** Every fact the client uses comes from a contract both
sides agreed to: this code model, the standards they speak (RFC 9110, RFC
9457) and the shared status table. One shape per fact, one author per fact: no
field repeats another, and the client never reconciles two spellings of the
same thing. What no contract covers reads as `unknown`.

## 1. Rules

1. **One error factory.** Every failure is built by it. A site names what
   failed and passes parameters, never severity or an emitter by hand.
2. **One object shape for every failure**, built in one place so it cannot
   drift. A handler's own throw stays raw (rule 8), so readers still see an
   app's error classes.
3. **RFC 9457 at the boundary, not on the fields.** `toJSON()` is the problem
   document: `type`, `detail` (the message), and `code`, `action` and the
   context as extensions. Inside, the fields stay the library's. `type` names
   the condition (`.../docs/errors.md#<condition>`), because RFC 9457 3.1.1
   makes `type` a client's primary identifier and 3.2 tells it to ignore
   unknown extensions. `code` stays the exact identity, and a backend's own
   `type` is kept. No `title`: it is optional, and the summaries live in
   `ERROR_CODE_REGISTRY` (tests/problem-type.test.ts).
4. **No stack for an expected refusal. A bug keeps its stack.** Only the
   `failed` condition captures one: stack capture is most of a refusal's cost.
5. **Templates and fix text only in DEV builds.** Production carries the
   facts and a documentation link (the problem's `type`).
6. **Codes are `owner:condition:subject` strings.** A string needs no
   allocated ranges, so no list to maintain. It crosses realms with no cast
   and reads without a table.
7. **`register()`: last wins, with ownership.** A cleanup removes only an
   entry it still owns (tests/register-ownership.test.ts).
8. **Dispatch always returns a result.** A configuration mistake throws at
   setup (`register`, `seal`, a plugin's options). A handler's throw stays raw
   in `result.error`.
9. **Casts only where the owner changes or the medium limits.** A foreign
   code is qualified on entry. URL, storage and human text get a codec or a
   template. Nothing is cast inside the library or across its own realms.

## 2. Shape

`owner:condition:subject`

- **owner**: `core`, a plugin's declared name, `app`, `remote` (a backend) or
  `test`. A function that is not a plugin takes its feature's name: `ssr` for
  `rehydrate()`, `schema` for `synthesize()`, `directive` for `v-vc-command`,
  `router` for the router.
- **condition**: a small fixed vocabulary the library owns (section 3).
  Whether a failure is re-sent derives from it ([retry.md](./retry.md)).
- **subject**: what the failure is about (`handler`, `action`, `payload`,
  `reply`, `queue`, ...).

A receiver that has never seen a code still knows its condition, and so
whether to re-send it.

## 3. Conditions

| condition | meaning | gRPC / Connect |
|---|---|---|
| `missing` | the thing is not there | NOT_FOUND (a missing handler: UNIMPLEMENTED) |
| `already` | it is there already | ALREADY_EXISTS |
| `conflict` | the state is not the one the request assumed (409, 412) | ABORTED / FAILED_PRECONDITION |
| `invalid` | input broke a rule | INVALID_ARGUMENT / OUT_OF_RANGE |
| `refused` | a rule or a party said no (403) | PERMISSION_DENIED |
| `unauthenticated` | no valid session or token: sign in, then the same request (401, 419) | UNAUTHENTICATED |
| `limited` | a rate, a window or a circuit holds it back | RESOURCE_EXHAUSTED / UNAVAILABLE |
| `timeout` | no reply in time | DEADLINE_EXCEEDED |
| `lost` | the outcome is unknown or data was dropped | none (gRPC's UNAVAILABLE is retry-safe, which `lost` is not) |
| `aborted` | the caller cancelled | CANCELLED (not gRPC's ABORTED, which is `conflict`) |
| `exceeded` | a bound hit by a bug (recursion depth) | INTERNAL |
| `failed` | code threw or a step failed | INTERNAL |
| `unexpected` | the other side answered off the protocol | INTERNAL / UNKNOWN |
| `unknown` | the fallback | UNKNOWN |

`conflict`, `unauthenticated`, `lost`, `aborted`, `exceeded` and `unexpected`
extend splice's set. gRPC's canonical codes draw the `conflict` and
`unauthenticated` distinctions, which `already` and `refused` hid. Connect
spells the last column `not_found`, `invalid_argument`, and so on.

## 4. The wire

One shape per fact, the same on both sides. RFC 9457 at the boundary, with
only the members that carry something (tests/wire-contract.test.ts,
tests/wire-envelope.test.ts).

**The request.** One envelope on every wire: `{ id?, command, target,
payload?, meta? }`. `id` appears where answers are multiplexed (a batch item,
a WebSocket frame). `meta` appears only with a fact a backend can use:
`idempotencyKey`, `correlationId`, `causationId`. A batch is `{ commands:
[envelope, ...] }`. A single request also sends the `Idempotency-Key` header
for standard tooling. The backend reads `meta`.

| Answer | Shape |
|---|---|
| single command, success | 2xx `{ state, stores? }`, or `{ redirect }` |
| single command, failure | non-2xx, `application/problem+json`: `{ status, code, detail, errors?, ...params }` |
| batch | 200 `{ results: [{ id, state, stores? } \| { id, redirect } \| { id, problem }] }`, each with `headers?` |
| WebSocket frame | `{ id, state, stores? } \| { id, redirect } \| { id, problem }`, with `headers?` |

`stores` holds store states by store id. Each store with that id on the
client's bus takes its state ([store.md](./store.md)).

`errors` is `[{ pointer, detail }]`, the pointer into the envelope the client
sent: `/payload/<field>`, or `/target/<field>` for a field of the target
(RFC 6901, `~0` and `~1` escaped). FormBus maps a `/payload/` pointer to its
field and leaves any other one, by design (src/form.ts:204-214).
`type` and `title` are not sent: `code` is the identity, and `title` repeated
the status's reason phrase. There is no `ok` flag. The presence of `problem`
is the failure, and an answer without one is the success. Its `state` is the
value, absent when the handler returned nothing (JSON drops `undefined`). The
single endpoint reads a 2xx the same way: a body `{ problem }` is that
failure, its condition from the problem's own `status`. So a backend that
cannot set the HTTP status still declares one.

**The client reads, by contract.** A problem becomes
`remote:<condition>:<code>`. The condition comes from the problem's `status`
through the status table. A batched result has no HTTP status of its own, and
the reference controller puts one in each problem. `detail` is the message,
and everything else is `context`. `Retry-After` (RFC 9110), where a response
carries it, goes to `context.retryIn`, never from the body. A batched result
or a frame stands for its own response through its `headers`, as in an OData
JSON batch response (OData JSON Format 4.01, section 19), so its
`Retry-After` is read the same way (tests/batch-retry-after.test.ts). The
owner is the transport's fact.

**The status table** (`conditionOfStatus`, src/failure.ts) says only what RFC
9110 says of a status, plus the reference backend's 419
(tests/http-errors.test.ts):

- 404 and 410 `missing`, 409 and 412 `conflict`, 401 and 419
  `unauthenticated`, 403 `refused`.
- 429 and 503 `limited`, 408 and 504 `timeout`, 501, 502 and 505
  `unexpected`.
- any other 5xx `failed`, any other 4xx `invalid` (RFC 9110's class meaning).

A backend declares a code's meaning by the status it sends. The reference
controller derives the status from the declared meaning, so the two cannot
disagree.

**Off the contract:**

- A non-2xx whose body is not a problem is `remote:<condition of its
  status>:http`.
- A batch that answers nothing for a command is `transport:lost:result`. It
  may have run.
- A problem with no status is `remote:unknown:<code>`.
- No response at all is the transport's own failure: `transport:lost:reply`
  (network), `transport:timeout:reply`, or `core:aborted:dispatch` for the
  caller's abort.
- A request that JSON cannot encode (a BigInt, a cycle) is never sent:
  `transport:invalid:json`, the TypeError its cause, never re-sent. A batched
  command fails alone (tests/invalid-json.test.ts).

**One reader.** `failureCondition(error, signal?)` gives any failure its
condition: its code, an HTTP status through the table, a timeout by name, a
cancel (named `AbortError`, or the signal's own reason), the Fetch standard's
`TypeError` for no response (`lost`), and `failed` for anything else, a
handler's own throw included. The async bus re-sends by it
([retry.md](./retry.md)). The bridges have no retry option of their own.

**The outbox** reads the same condition. The backend's 4xx verdict
(`invalid`, `refused`, `missing`, `already`, `conflict`) drops a record. An
expired session (`unauthenticated`, 401 and 419) keeps it. Of the failures
the library or a plugin raised, only `invalid` drops it: a validator or
schema gives the same answer on every flush. Anything else keeps it, and so
does any answer that declares a wait.

**Kept, and why.** `{ state }` rather than the bare value: one inner shape
for the single answer, a batched result and a frame, with room for
`redirect`. `redirect` as a body member rather than a 3xx: a browser's
`fetch` cannot read a 3xx's `Location`. 419 in the table: Laravel answers an
expired CSRF token with it before any controller runs.

## 5. Ownership and the failure object

**Owner by wiring, never declared by the site.** A party gets a `fail` bound
to its owner when it is wired: a plugin's declared name at `use()`, `core`
inside the bus, `remote` in a transport. OpenTelemetry binds a scope at
`getTracer(name)` the same way. A site passes `condition:subject` only, and
cannot name another owner, because it holds only its own `fail`
(tests/errors-match-catalogue.test.ts). The code is kept in the object's
private `#code`, a brand check, so it is unforgeable. Whatever enters without
an owner is qualified on entry: a plugin's throw by the runner
(`<id>:failed:plugin`), a backend's code as `remote:<condition>:<its code>`.
A handler's raw throw stays the app's own error, with no owner (`ownerOf` is
`undefined`).

**A plugin's name** is its declared `id`, never `Function.name`: an arrow has
none and a minifier renames declarations, so one failure would carry
different codes in DEV and production. A plugin with no `id` is `plugin`.

**The object.** One class, `BusError extends Error`:

| Field | Rule |
|---|---|
| `code` | `owner:condition:subject`, read-only. An unknown subject reads as its condition. |
| `message` | the fact. Every value in it is also in `context`. |
| `action`, `context`, `cause` | as given. A field-level failure carries `context.errors` as `[{ pointer, detail }]`. |
| `name` | `AbortError` for an `aborted` code, `BusError` otherwise (tests/abort-one-shape.test.ts) |

Not on the object:

- **severity**: whoever logs decides. `ERROR_CODE_REGISTRY` suggests a level.
- **emitter**: the owner is in the code.
- **retryable**: the caller's policy, read from the condition
  ([retry.md](./retry.md)).

**Stack:** decided by the constructor from the condition. Only `failed` (a
bug) captures one (tests/before-cancel.test.ts:43, router-codes.test.ts).

## 6. The router

The router raises the core's failure without importing the bus:
src/failure.ts holds `BusError` alone. Every router failure is a `BusError`
coded `router:condition:subject`, its target in `context.to` and the original
error in `cause`. A superseded navigation is `router:aborted:navigation`, with
no stack. `HARD_NAV_CODES` is the rule where the server gets the last word: a
route, component or server HTML that is missing or failed, which the default
`onError` answers with a full page load (tests/router/router-codes.test.ts).
`problemOf(error)` (src/http-errors.ts) reads a backend's problem through the
`cause` chain once, so a consumer does not dig (tests/problem-of.test.ts).

## Sources

- RFC 9457, Problem Details: https://datatracker.ietf.org/doc/html/rfc9457
- RFC 9110, HTTP Semantics: https://www.rfc-editor.org/rfc/rfc9110.html
- RFC 6901, JSON Pointer: https://www.rfc-editor.org/rfc/rfc6901.html
- OData JSON Format 4.01, batch responses: https://docs.oasis-open.org/odata/odata-json-format/v4.01/odata-json-format-v4.01.html
- gRPC status codes: https://grpc.github.io/grpc/core/md_doc_statuscodes.html
- Google AIP-193, Errors: https://google.aip.dev/193
- OpenTelemetry Instrumentation Scope: https://opentelemetry.io/docs/specs/otel/common/instrumentation-scope/
- Temporal failures: https://docs.temporal.io/references/failures
- MDN, private elements and brand checks: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes/Private_elements
- Java `Throwable` (writableStackTrace): https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/Throwable.html
- Effect, expected errors and `Cause`: https://effect.website/docs/error-management/expected-errors/
- splice: https://github.com/lucianofedericopereira/splice
