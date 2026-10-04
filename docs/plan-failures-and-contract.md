# Plan: failures, the shared contract, and what comes back from splice

**Status:** draft, rev 23 (2026-09-30). Built, in v1.25.0: Phase 0's fixes, Phase 1's code model (4.5), the wire contract (4.4) and the retry model (7.1 item 3). The rest is for review and not built.
**Scope:** vapor-chamber alone. PHP is the first customer of what it defines,
but no backend dictates its internals.

How to read it: "Settled" items were agreed in discussion and carry their
reason. "Open" items carry the current position, for the owner to accept,
change or reject. Every claim of a defect names the reproduction that showed
it. Line numbers drift; function names are given where they are stable.

---

## 1. Rules this plan is judged by

These are the owner's, stated during the discussion that produced this plan.

0. **Correctness and performance dictate decisions; results talk.** A claim
   becomes a decision when it is measured or tested, not when it is argued
   (section 7.2).
1. **A decision stands on its reason, not its outcome.** The same shape can be
   rejected for a borrowed reason ("the standard says so") and accepted for one
   that belongs to this codebase (size, speed, one shape, less drift). The
   decision log records the reason that belongs here.
2. **Block core changes first.** A change passes when core is plainly wrong,
   when a plugin cannot do it, or when the plugin version is measurably slower.
   A better shape or architecture that keeps performance is always open to
   discussion, even when nothing is broken.
3. **Size is a discipline, not a number to argue away.** Its job is to force a
   rethink: one helper instead of N call sites, never pushing work out to call
   sites to keep a module small. Core may grow when it takes over work plugins
   and apps each repeat by hand. Report deltas on core ESM and on a tree-shaken
   ESM consumer; the IIFE builds are a legacy bridge and never decide a design.
4. **Prefer the library's own pieces over hand-rolled code**, in the library,
   in plugins and in consumers.
5. **Standards at the boundary.** Where a standard defines a shape between two
   parties, use it, so both sides share one shape. A standard governs a
   boundary, not the library's internals.
6. **Integrated lists are outcomes, never something to maintain.**
7. **Allow both paths** where two resolutions can share one contract, held
   together by a test that proves they agree.
8. **Pick the better option** and say why; "not worth it" needs its own
   evidence.
9. **Accessibility is designed in, not audited after.** Every UI-facing change
   names who it could exclude (keyboard, screen reader, magnification, reduced
   motion, cognitive load) before it is built, and is not done until its WCAG
   criterion has a test (section 8e).
10. **The front reads by contract, never guesses (owner, rev 21).** Every fact
   the client uses comes from a contract both sides agreed to: the code model,
   the standards they speak (RFC 9110, RFC 9457), the shared status table. One
   shape per fact, one author per fact: no field repeats another, and the
   client never reconciles two spellings of the same thing. What no contract
   covers reads as `unknown`.

---

## 2. What was found (evidence)

### 2.1 Defects in shipped behaviour, reproduced

| Defect | Reproduction | Kind |
|---|---|---|
| A stale `register()` cleanup deletes a NEWER owner's handler (and its undo). `register()` returns `() => { handlers.delete(action) ... }`, unconditional. | Bus level: A registers, B registers, A's cleanup runs, `dispatch` -> `ok: false`. Component level: `KeepAlive :max="1"` runs `register B -> dispose A`; B is on screen with no handler. HMR is safe (dispose runs first). | oversight: the whitepaper's "newest always wins regardless of teardown" was drawn from HMR only, and the fixture's assertion for it checks a module-level handler that cannot fail |
| A store created outside any scope is disposed by the first scoped holder that leaves. | `defineChamberStore`: module-level `useStore(bus)`, a scope joins and stops; the module's store answers `ok: false`, and the next `useStore` builds fresh state. `docs/store.md` says "the last holder out disposes" and the unscoped caller "owns `$dispose()`". The cookbook panel's `db/store.js` holds its rows store this way (its exposure is inferred, not run in the panel; 7.2). | oversight: only scoped+scoped sharing is tested |
| `useCommand` does not use `tryKeepAliveHooks`, which `useCommandHistory` and `useCommandError` use. | `KeepAlive` without `max`: A -> B -> A; A is on screen and B's handler answers. | omission (owner, 2026-09-27) |
| Three sites build `BusError` with severity `'error'` where the registry says `'warn'`: both `VC_CORE_THROTTLED` sites and `VC_CORE_ABORTED`. | Site-by-site comparison of every `new BusError(...)` against `ERROR_CODE_REGISTRY`: the sites pass no severity and the constructor defaults it. | drift |
| `validator()` refuses with a plain `Error`. | The registry declares `VC_VALIDATION_FAILED` for "schema or per-action validation". | drift |
| `Idempotency-Key` is sent raw, not as a quoted Structured Field String. | `createHttpBridge`; `docs/integrations/laravel.md` calls it "a standard `Idempotency-Key` request header". | drift against the library's own claim |
| `retry()` builds `_errResult(new Error('No attempts made'))` on EVERY dispatch, success included, for a result that can never be returned (`countOption` guarantees at least one attempt). | Happy-path bench, production mode: `retry` alone 48,857 ns per successful dispatch against 5,635 bare; the same plugin without that line 6,031. A realistic chain goes from 69,001 to 34,135 ns. | failure machinery on the happy path |
| `v-vc-command` sends keyboard focus to `<body>` for every in-flight dispatch, and it does not come back when the button is re-enabled. The directive sets `el.disabled = true`; HTML's focus fixup rule then moves focus off the button. | `tests/browser/command-focus.browser.test.ts`, real Chromium (headless shell 153), production mode: the engine moves focus to `<body>` after the rendering update; with the directive, during `{disabled: true, focused: false}`, after `{disabled: false, focused: false}`. A zero-delay timeout read the opposite, before the update ran. **FIXED (Unreleased):** `aria-disabled` in flight (not `aria-busy`, which can hide a button's name from a screen reader), a capture guard only while in flight, `preventDefault` on the starting press; the three things `disabled` also did pinned in the same file on the old code first; directive tests 80/80, browser 5/5 in production and development; `./directives` +0.1 KB brotli. | oversight: the `disabled` write is deliberate, its focus consequence was never considered |
| `useCommandHistory.undo()` / `redo()` move the stacks before the dispatch they start lands. | Code reading; the forward recorder keeps only `result.ok`. | oversight in the failure path (async was handled only for double recording, ledger 2026-09-15) |

### 2.2 Drift and dead claims found on the way

- Seven `VC_TEST_*` codes raised by the test tooling are not in the registry.
- `VC_CORE_HANDLER_THREW` and `VC_CORE_HANDLER_OVERWRITE` are declared and never raised.
- The whitepaper lists "Precognition" for `createFormBus`; `form.ts` has none.
- `scripts/generate-laravel.mjs` says a `ValidationException` maps to "422 + `{ ok: false, error }`", the pre-1.24 shape.
- The reference controller answers a `ValidationException` with its message only; `$e->errors()` is discarded.
- `examples/sprinkled-blade/mock-server.mjs` answers a malformed JSON body with 500; RFC 9110 makes it a 400.
- `docs/BUNDLE-SIZES.md` compares against `mitt` only.

### 2.3 Measurements

**Method caveat.** Every figure below comes from scratch benches: separate
processes, no self-control arm, absolute numbers, one run. That is below this
repo's own standard (the three-arm A/B harness of `tests/*-ab.test.ts`: arms
derived from the shipped source, a byte-identical self-control reading the
machine's noise band, rotating order, paired per-round ratios; figures stamped
into docs, never typed). Effects far outside any noise band stand as findings
(`retry` 8x on success, stack capture ~45x). Small ones (the 4-shape 10-15%,
FormBus pointer variants within ~1%) are NOT claimed until re-measured that way
(7.2 item 14).

Node 22, this machine, one run each; the ratios are the result, not the absolute numbers.

| Building one refusal (call depth 20) | ns/op |
|---|--:|
| `new BusError(...)`, stack captured | 37,918 |
| same, `Error.stackTraceLimit = 0` | 3,273 |
| plain `{ ok: false, code, action }` | 833 |
| `BusError` with an empty message | 37,953 |

Stack capture is about 90% of a refusal's cost; building the message string is noise.

FormBus, 10 fields, Vue signals, one case per Node process (a first run shared
closures across cases, so V8 shared their type feedback; it is discarded):

| One keystroke (`set`) | ns |
|---|--:|
| FormBus today | 5,780 |
| outside errors kept beside rule errors, keyed by field name | 5,838 |
| same, keyed by pointer computed per call | 6,419 |
| same, keyed by pointer from a map built once | 5,792 |
| by name, with 10 server errors re-applied every keystroke | 6,722 |
| by pointer per call, same | 9,238 |
| by pointer from the map, same | 6,834 |

Keying by pointer costs nothing when the name -> pointer map is built once.

Reading failures (`defaultIsRetryable`'s logic, 1,024 failures, one case per
process, two runs):

| Reader, failures it reads | ns per read |
|---|--:|
| today's reader, 1 shape (`BusError` only) | 41 / 32 |
| today's reader, 4 shapes (the common mix) | 44 / 38 |
| today's reader, 8 shapes | 99 / 107 |
| factory shape, retry derived per read from `condition` (a `Set` lookup) | 46 / 42 |

Up to 4 shapes costs about 10-15% (V8 caches up to 4 shapes per property read);
past that, about 2.5-3x. All of it is tens of nanoseconds on the failure path,
against about 38,000 ns for one stack capture. Deriving retry per read is no
faster than today; storing it at construction is the cheaper design.

Bytes on the wire for failures (one synthetic contract of 15 commands and 10
codes, 3,799 bytes, used as the zstd dictionary; one run):

| Payload | raw | gzip | brotli | zstd | zstd + contract dict |
|---|--:|--:|--:|--:|--:|
| one 422, full RFC 9457 JSON | 385 | 234 | 178 | 228 | 125 |
| one 422, minimal JSON (code, params, `errors`; nothing derivable) | 144 | 117 | 100 | 106 | 87 |
| one 422, CBOR in RFC 9290's model | 38 | 51 | 40 | 48 | 41 |
| batch of 20, 8 failures, full JSON | 2,404 | 585 | 466 | 589 | 398 |
| batch, minimal JSON | 1,491 | 349 | 288 | 356 | 292 |
| batch, CBOR | 595 | 259 | 209 | 260 | 243 |

Not sending what both sides know saves about 45% after brotli, in readable
JSON, with no encoder. CBOR matters where nothing compresses (3.8x raw); over
compressed HTTP it saves 60-80 bytes more. The RFC 9842 dictionary helps full
JSON most and CBOR not at all.

A successful dispatch (async bus, one handler, `NODE_ENV=production`, one
configuration per process; the chain is what the cookbook panel and sashimi
install):

| Plugins | ns per successful dispatch |
|---|--:|
| none | 5,635 |
| `validator` | 5,096 |
| `circuitBreaker` | 6,220 |
| `logger` (console stubbed) | 6,128 |
| `persist` | 7,558 |
| `metrics` | 7,618 |
| `serialize` | 7,700 |
| `history` | 8,141 |
| `idempotent` | 21,523 |
| `retry` | 48,857 |
| `retry` without its pre-built `Error` | 6,031 |
| chain: validator, idempotent, serialize, circuitBreaker, retry | 69,001 |
| same chain, `retry` fixed | 34,135 |

`idempotent`'s cost, piece by piece (each includes about 600 ns of harness):
`commandKey` of the target 3,688; the eviction loop, which builds an iterator on
every success even under the limit, 2,775; its extra promise 1,805. `serialize`
computes the same `commandKey` again for the same command.

### 2.4 Examples

`tsc -p examples/tsconfig.patterns.json` passes; `vapor-sfc` and `vapor-island-cart` build; the 12 PHP example files lint clean; the mock server's problems are read end to end by `createHttpBridge`. Not run: `exo-astro` (writes `.astro/` into the example), `router-demo` (static page). `vapor-island-cart` keeps module-level `reactive()` state instead of `defineChamberStore`, the shape section 2.1's store defect breaks.

---

## 3. Settled

1. **One error factory.** Every failure is built by it; sites name what failed and pass parameters, never severity or emitter by hand. Why: the drift in 2.1 and 2.2 is hand-filled fields; splice built from its table and did not drift.
2. **One object shape for every failure.** Why: correctness, one place builds it so it cannot drift. Speed is a minor reason, measured in 2.3: tens of nanoseconds, and only past 4 shapes. Limit: handler throws stay raw (item 10), so readers still see app error classes.
2b. ~~Derived facts are computed once, when the failure is built, and stored (retryable, kind).~~ **Reversed in rev 19 (section 4.5):** the retry verdict is the CALLER's policy over the condition, and an owner may only veto (gRPC A6, Temporal). Nothing that can raise retries is stored on a failure. The 2.3 reason was a few nanoseconds on the failure path; the new reason is who may decide.
3. **RFC 9457 at the boundary, not on the fields** (rev 19; was: RFC member names on `BusError`). `toJSON()` is the problem document (`type`, `detail` the message, `code`, `action`, `context` as extensions, `status` only when crossing to HTTP); inside, the fields stay the library's. `type` was left implicit until 2026-10-02 (7.2 item 16: 77 B brotli then); the owner reversed it (log s35.80): RFC 9457 3.1.1 makes `type` a client's primary identifier and 3.2 tells it to ignore unknown extensions, so with `about:blank` an RFC client dropped `code`. `type` now names the CONDITION (`.../docs/errors.md#<condition>`, a generated page), resolvable for library, app and backend failures alike; `code` stays the exact identity; a backend's own `type` is kept; no `title` (optional, and the summaries are not in the core). Why: an RFC governs a boundary (owner); and structured clone keeps only `name`, `message` and `stack` of an error (HTML Standard), so whatever crosses a worker or a channel must be serialized data anyway.
4. **No stack for expected refusals; bugs keep theirs.** Why: 2.3.
5. **Templates and fix text only in DEV builds; production carries a documentation link** (Vue's `error-reference`, React's error decoder).
6. **Codes are `owner:condition:subject` strings** (section 4). Why: splice's model (classification inside the code, owner inside the code); a string needs no allocated ranges, so no list to maintain; it crosses realms with no cast; it reads without a table.
7. **Integrated lists are generated outcomes.** `ERROR_CODE_REGISTRY` stops being a maintained source; the `BusErrorCode` union and `RETRYABLE_CODES` go.
8. **`register()`: last wins, deliberately, with ownership.** A cleanup removes only an entry it still owns. Two ACTIVE owners of one action is the only conflict, and the only case for `VC_CORE_HANDLER_OVERWRITE`'s meaning.
9. **`useCommand().register` uses `tryKeepAliveHooks`:** release on deactivate (ownership-checked), re-register on activate.
10. **Dispatch always returns a result** (unchanged); configuration mistakes throw at `register` / `seal` (unchanged); handler throws stay raw in `result.error` (1.23, unchanged).
11. **Casts only where the owner changes or the medium limits:** a foreign code is qualified on entry; URL, storage and human text get a codec or template. Nothing is cast inside the library or across its own realms.
12. **Tiered shared tables and a content-addressed handshake** (section 5).
13. **What comes back from splice** (section 6).

---

## 4. The code model

### 4.1 Shape

`owner:condition:subject`

- **owner**: `core`, a plugin's name, `app`, `remote` (a backend), `test`, or a feature's name for a function that is not a plugin (`ssr` for `rehydrate()`, `schema` for `synthesize()`, `directive` for `v-vc-command`; shape rule 2, log s35.78).
- **condition**: a small fixed vocabulary the library owns, the equivalent of splice's tens digit and HTTP's status classes. Retryability and kind derive from it.
- **subject**: what the failure is about (`handler`, `action`, `payload`, `reply`, `queue`, ...).

A receiver that has never seen a code still knows its condition, so it still knows whether to retry.

### 4.2 Condition vocabulary (from the mapping; four extensions to splice's set)

| condition | meaning | retry by default | gRPC / Connect |
|---|---|:-:|---|
| `missing` | the thing is not there | no | NOT_FOUND (a missing handler: UNIMPLEMENTED) |
| `already` | it is there already | no | ALREADY_EXISTS |
| `conflict` (ext.) | the state is not the one the request assumed (409, 412) | no | ABORTED / FAILED_PRECONDITION |
| `invalid` | input broke a rule | no | INVALID_ARGUMENT / OUT_OF_RANGE |
| `refused` | a rule or a party said no (403) | no | PERMISSION_DENIED |
| `unauthenticated` (ext.) | no valid session or token; sign in, then the same request (401, 419) | no | UNAUTHENTICATED |
| `limited` | a rate, a window or a circuit holds it back | yes | RESOURCE_EXHAUSTED / UNAVAILABLE |
| `timeout` | no reply in time | yes | DEADLINE_EXCEEDED |
| `lost` | the outcome is unknown or data was dropped | no; yes when the command is idempotent | none (gRPC's UNAVAILABLE is retry-safe, which `lost` is not) |
| `aborted` (ext.) | the caller cancelled | no | CANCELLED (not gRPC's ABORTED, which is `conflict`) |
| `exceeded` (ext.) | a bound hit by a bug (recursion depth) | no | INTERNAL |
| `failed` | code threw or a step failed | no | INTERNAL |
| `unexpected` (ext.) | the other side answered off-protocol | no | INTERNAL / UNKNOWN |
| `unknown` | fallback | no | UNKNOWN |

(`lost` is also an extension.) `conflict` and `unauthenticated` were added
on 2026-10-02 (owner; log s35.79): gRPC's canonical codes draw both
distinctions, which `already` and `refused` hid. Our words are kept; the last
column reads any condition in gRPC's terms (Connect spells them `not_found`,
`invalid_argument`, ...).

### 4.3 Mapping of today's codes

| Today | Proposed |
|---|---|
| `VC_CORE_NO_HANDLER` | `core:missing:handler` |
| `VC_CORE_HANDLER_OVERWRITE` | `core:already:handler` (two active owners only) |
| `VC_CORE_HANDLER_THREW` | `core:failed:handler` (declared; still not raised) |
| `VC_CORE_BEFORE_CANCEL` | `core:refused:hook` |
| `VC_CORE_NAMING_VIOLATION` | `core:invalid:name` |
| `VC_CORE_SEALED` | `core:refused:bus` |
| `VC_CORE_MAX_DEPTH` | `core:exceeded:depth` |
| `VC_CORE_REQUEST_TIMEOUT` | `core:timeout:request` |
| `VC_CORE_THROTTLED` | `core:limited:handler` |
| `VC_CORE_ABORTED` | `core:aborted:dispatch` |
| `VC_PLUGIN_THREW` | `<plugin id>:failed:plugin` (`plugin:failed:plugin` when it declares none; 4.5) |
| `VC_HOOK_ERROR` | `core:failed:hook` |
| `VC_LISTENER_ERROR` | `core:failed:listener` |
| `VC_VALIDATION_FAILED` | `validator:invalid:payload`, `validateSchemas:invalid:payload` (split by owner) |
| `VC_PLUGIN_CIRCUIT_OPEN` | `circuitBreaker:limited:action` |
| `VC_PLUGIN_RATE_LIMITED` | `rateLimit:limited:action` |
| `VC_PLUGIN_CACHE_MISS` | none: not a failure; moves to the diagnostics channel |
| `VC_TRANSPORT_TIMEOUT` | `transport:timeout:reply` |
| `VC_TRANSPORT_CLOSED` | `transport:lost:reply` |
| `VC_TRANSPORT_QUEUE_FULL` | `transport:lost:command` (data was dropped; today it is categorised as general) |
| `VC_TRANSPORT_REDIRECT` | `transport:refused:redirect` |
| `VC_TRANSPORT_PROTOCOL` | `transport:lost:result` |
| `VC_WORKFLOW_STEP_FAILED` | `workflow:failed:step` |
| `VC_WORKFLOW_COMPENSATE_FAILED` | `workflow:failed:compensation` |
| `VC_UNKNOWN` | `core:unknown:error` (not retryable; today it is) |
| `VC_TEST_*` (seven) | `test:<condition>:<subject>` |

### 4.4 The wire contract (rewritten in rev 21)

One shape per fact, the same on both sides; RFC 9457 at the boundary with only
the members that carry something.

**The request** (rev 22, log s35.138): one envelope on every wire,
`{ id?, command, target, payload?, meta? }`. `id` where answers are
multiplexed (a batch item, a WebSocket frame), as on the answer side; `meta`
only with a fact a backend can use: `idempotencyKey`, `correlationId`,
`causationId`. A batch is `{ commands: [envelope, ...] }`. A single request also
sends the `Idempotency-Key` header for standard tooling; the backend reads
`meta`.

| Answer | Shape |
|---|---|
| single command, success | 2xx `{ state }`, or `{ redirect }` |
| single command, failure | non-2xx, `application/problem+json`: `{ status, code, detail, errors?, ...params }` |
| batch | 200 `{ results: [{ id, state } \| { id, redirect } \| { id, problem }] }` |
| WebSocket frame | `{ id, state } \| { id, redirect } \| { id, problem }` |

`errors` is `[{ pointer, detail }]`, the pointer into the envelope the client
sent: `/payload/<field>` (RFC 6901, `~0`/`~1` escaped), one spelling. `type` and `title` are not sent:
`code` is the identity, and `title` repeated the status's reason phrase. No `ok`
flag: the presence of `problem` is the failure, and an answer without one is
the success, its `state` the value (absent when the handler returned nothing:
JSON drops `undefined`). The single endpoint reads a 2xx the same way: a body
`{ problem }` is that failure, its condition from the problem's own `status`,
so a backend that cannot set the HTTP status still declares one.

**The client reads, by contract:** a problem becomes
`remote:<condition>:<code>`, the condition from the problem's `status` (a
batched result has no HTTP status of its own; the reference controller already
puts it in each problem) through the status table below, `detail` the
message, everything else `context`. `Retry-After` (RFC 9110), where a response
carries it, goes to `context.retryIn`, never from the body. The owner is the transport's fact.

**The status table** says only what RFC 9110 says of a status, plus the
reference backend's declared 419: 404/410 `missing`, 409/412 `conflict`,
401/419 `unauthenticated`, 403 `refused`, 429/503 `limited`, 408/504 `timeout`, 501/502/505 `unexpected`, any
other 5xx `failed`, any other 4xx `invalid` (RFC 9110's class meaning). A
backend declares a code's meaning by the status it sends; the PHP side derives
the status from the declared meaning, so the two cannot disagree.

**Off contract:** a non-2xx whose body is not a problem is
`remote:<condition of its status>:http`; a batch that answers nothing for a
command is `transport:lost:result` (it may have run: re-sent only with an idempotency key); a problem with no status is
`remote:unknown:<code>`. No response
at all is the transport's own failure, not the HTTP client's class leaking
through: `transport:lost:reply` (network), `transport:timeout:reply`,
`core:aborted:dispatch`. `lost` means the outcome is unknown, so it is retried
only for an action declared idempotent or a command that carries an
idempotency key (7.1 item 2); a blind re-send of a write that may have landed
is not retried.

**Retries: one rule, one place.** `failureCondition(error)` gives any
failure its condition by contract (its code; an HTTP status through the table;
a timeout or abort by name; the Fetch standard's `TypeError` for no response,
`lost`; anything else, a handler's own throw included, `failed`). The async
bus applies the class rule (7.1 item 3, `docs/plan-shape.md` 4) at the call
that produced the outcome, a handler or a plugin declaring `transport: true`,
so the plugins outside see one dispatch, per command on a batch. Transient
(`limited`, `timeout`, a declared `context.retryIn`: a `Retry-After`, a
throttle's wait) is re-sent for any action, after the declared wait when there
is one. Uncertain (`lost`, `unexpected`, `unknown`, and a `failed` that is not
a party's own bug) only for an action declared idempotent or a command
carrying an idempotency key. The other side's verdict (`invalid`, `refused`,
`missing`, `already`), an abort, a depth bound and a bug (`failed` raised by
the library or a plugin) never. A failure sent more than once carries
`context.attempts`. The bridges have no retry option; `noRetry` is replaced by
that declaration of "safe to send again". The outbox reads the same condition:
the backend's 4xx verdict (`invalid`, `refused`, `missing`, `already`,
`conflict`) drops a record, an expired session (`unauthenticated`, 401 and
419) keeps it; of the failures the library or a plugin raised, only `invalid`
(a validator or schema rejection, the same answer on every flush) drops it;
anything else keeps it. `Retry-After` is
honoured on any status; in the HTTP client `X-RateLimit-Reset` is its fallback
for the wait.

**Kept, and why.** `{ state }` rather than the bare value: one inner shape for
the single answer, a batched result (`{ id, ... }`) and a frame, with room for
`redirect`. `redirect` as a body member rather than a 3xx: a browser's `fetch`
cannot read a 3xx's `Location` (the response is opaque). 419 in the table:
Laravel answers an expired CSRF token with it before any controller runs.

**Why (the omission of rev 18-20).** The client accepted two failure shapes
(`{ ok: false, error, code }` and `{ problem }`), three message spellings
(`detail`, `error`, `message`) and, in FormBus, a list or a map with
`field`/`pointer` and `detail`/`message`; it dropped the problem's own
`status` and guessed `refused` for every 2xx refusal. Measured against a real
registry (7.2 item 9) the old status derivation was also wrong where it
guessed beyond RFC 9110. Removed in the same release that renames the codes.

**Open:** `Retry-After` for a batched command has no header to ride; a
`retryAfter` member on the problem (RFC 9457 extension, RFC 9110's meaning) is
the proposal, for the owner.

### 4.5 Ownership and the internal shape (rev 19, from research)

**Owner by wiring, never declared.** A party gets a `fail` bound to its owner when it is wired (the plugin's declared name at `use()`, `core` inside the bus, `remote` in a transport), as OpenTelemetry binds a scope at `getTracer(name)`. A site passes `condition:subject` only; it cannot name another owner because it only holds its own `fail`, the way Temporal lets user code create one failure kind and reserves the rest to the runtime. The owner is kept in the code's private `#code` (a JS brand check, the language's sealer), so it is unforgeable rather than discouraged. Whatever enters without an owner is qualified on entry: a plugin's throw by the runner, a backend's code as `remote:<condition from status>:<its code>`; a handler's raw throw stays the app's own error, with no owner (`ownerOf` is `undefined`).

**Plugin names** (owner, rev 19): the owner of a plugin's failures is the plugin's DECLARED name. Not `Function.name`: arrows have none and a minifier renames declarations, so the same failure would carry different codes in DEV and production.

**The shape.** One class, `extends Error`:

| Field | Rule | Model |
|---|---|---|
| `code` | `owner:condition:subject`; the condition is the contract, the subject a refinement; an unknown subject reads as its condition | RFC 3463 `class.subject.detail`; Azure `innererror`; SQLSTATE ranges by prefix |
| `message` | the fact; every value in it is also in `context`, so it can be rebuilt from code + context (DEV templates now, the i18n plugin later) | AIP-193 metadata rule |
| `action`, `context`, `errors`, `cause` | as today; `errors` is `[{ detail, pointer }]` | RFC 9457 extension, JSON:API |
| owner | `#owner`, written only by the wiring | object-capability brands |

Not on the object: **severity** (the logger decides from owner and condition; no surveyed model stores it on the error, OpenTelemetry puts it on the log record), **emitter** (the owner), **retryable** (the caller's policy; an owner may only veto, which is safe even from a backend because it can only lower retries). **Stack:** decided by the constructor from the condition, only `failed` (a bug) captures one, as Java's `writableStackTrace` and Effect's `Fail` / `Die` split. **Subclasses:** not needed for identity (a clone drops them); `HttpError` and `RouterError` joined, 7.1 item 16.

---

## 5. The wire: tables and handshake

### 5.1 Three tiers of shared knowledge

| Tier | Who knows it | How a code travels |
|---|---|---|
| core | every vapor-chamber, versioned with the library | an index into the core table |
| the app's contract (`fails` in the schema) | both sides, because the contract was generated for both | an index into the contract table |
| a plugin's codes | not guaranteed on the other side | the readable string, until its table is known |

Most plugin failures (throttle, circuit, rate limit) never cross a byte wire; between tabs and workers structured clone carries them as objects.

**Rev 21:** a code's meaning never needs a table: the condition travels in the status (HTTP) or the code (in process). The tables are for compression (an index instead of a string) and documentation (`fix`, templates).

### 5.2 Handshake (Avro's RPC handshake; RFC 9842's hash header on HTTP)

- Each table is identified by the hash of its content and is immutable: a change is a new hash, never an update (Unison's model).
- The handshake exchanges hashes. When they match, nothing more is sent. An unknown hash makes that table cross once; the receiver caches it by hash, across sessions.
- WebSocket: at open. HTTP: a request header carrying the hashes the client holds. Tabs and workers: none.
- Plugin tables are one more hash, so plugins share their table a single time with no ranges and no central list.
- Codes are append-only within a table; an old client decodes a code it does not know as its condition plus `unknown` subject.
- Parameters never enter a table (HPACK's never-indexed rule after CRIME/BREACH).

### 5.3 Encoding

- Byte wires (WebSocket, batched HTTP, storage): CBOR in RFC 9290's model: integer keys for the standard members, only parameters and the where travelling; the code composed as splice composed it, the condition a small integer that decodes with no table and the subject a table index or its string.
- Plain HTTP by default: minimal RFC 9457 JSON (code, parameters, `errors`; nothing derivable); CBOR when `Accept` asks for it.
- In-process: plain objects, no encoding (splice's header ran where no wire existed; that is the part not to repeat).

---

## 6. From splice

| splice | Verdict |
|---|---|
| `MSG_SET` composed codes | reuse: section 4 |
| `MSG_GET` templates, parameters at the site | reuse: DEV templates |
| `RESULT_META_MAP` read by the runtime | reuse the model: derived from the condition |
| origin bit | reuse: the owner part |
| 3-byte header | reuse where bytes cross: section 5.3 |
| plugin descriptor | reuse, plus the plugin's codes and table hash |
| `getDiagnostics` / `getSummary` | reuse: inspection by name |
| `emitSystemMessage` | reuse as a bus-level diagnostics event, not `postMessage` |
| result hooks per kind | reuse, keyed by condition |
| never-throwing dispatch, freeze, wrap-once | already present |
| first-wins registration | replaced: settled item 8 |
| `ContextPool` | not reused: measured and declined before |
| `catch {}` around listeners | not reused: vapor-chamber logs them |

---

## 7. Open

Split by what settles each item. 7.1 is a judgement: evidence informs it but
cannot decide it. 7.2 is a question of fact: a measurement or a test decides
it, and no discussion is needed once it is run.

### 7.1 To discuss (the owner decides)

Current position after each.

**The code model**
1. The mapping's four findings: `QUEUE_FULL` -> `lost`, `UNKNOWN` not retryable, `CACHE_MISS` to diagnostics, `VALIDATION_FAILED` split by owner. Position: take all four.
2. Retry rule: the condition decides; an idempotent command also retries `lost`. Taken in rev 21 (4.4).
3. **Retry: DECIDED (owner, 2026-09-28) and BUILT in v1.25.0** (`docs/plan-shape.md` 4; `tests/retry-policy.test.ts`).
   - Retry is the runner's, at the invocation boundary where the outcome is produced, not a plugin the app installs and orders: every success model makes it the default of the layer that owns the call (AWS SDKs, .NET standard handler, Temporal activities). The plugins outside see one dispatch.
   - On by default and bounded: 3 attempts in total, full jitter, a server-declared wait honoured and clamped, a retry budget per bus (AWS SDK and gRPC A6 token buckets), so retries cannot prolong an outage.
   - The class rule decides: final (a 4xx verdict, an abort, a depth bound, a library bug) never; transient (`limited`, `timeout`, a `Retry-After`) always; uncertain (`lost`, `failed`, `unexpected`, `unknown`) only when the action is declared safe to repeat or the command carries an idempotency key.
   - Declared per action in the schema (idempotent, a retry override, or off), as gRPC's service config; the idempotency key follows the declaration.
   - `retry()` and `retrying()` are gone with it. Chained actions in general (workflow compensation, the ledger's revert, the outbox's flush) are a separate primitive; retry does not wait for it.
   Sources: Polly, the .NET standard resilience handler, Temporal retry policies, AWS SDK retry behavior, gRPC A6, Envoy, Effect `Schedule` (section 9).
4. `status` on internal failures. Position: only at the foreign boundary, derived from the condition.

**Schema and vocabulary**
5. The shape of `fails` in `BusSchema`: code, status, which where it can point at. `BusSchema` is already plain data (`defineSchema` returns its input), so the JS literal and the JSON file are one shape with many authors.
6. One type vocabulary for `FieldType` and the router's `ParamType` (they name the same primitives differently), with a codec per boundary (JSON, URL): the names and the codec split.

**Plugins and wire**
7. The descriptor is declared by the plugin's author (name, codes, table hash); the installer keeps priority. Position: take it.
8. The HTTP handshake header: our own (7.2 item 6); its name and the table cache's storage remain to decide.

**Components**
9. `KeepAlive` listeners: pause like `useCommandHistory`, or stay live on purpose. Position: pause; a cached page is refreshed by the router's re-read.
10. FormBus accepts outside errors by where. DECIDED on the measurements in 2.3 (about 1 us per keystroke when present, nothing when absent) and done: `setErrors`, `submit()` mapping a field-carrying failure, `aria`, `errorId`, `firstInvalid`.
11. `persist` applies what it loads: today a deliberate "auto-save" with no setter.
12. Handler throws stay raw. Position: keep (1.23), classify through `cause`.

**The fuse (owner, 2026-09-27)**
14. Errors as a fuse: the happy path (the 200s) runs on a fast lane with no failure machinery; the first failure blows the fuse for that key, and only then does the careful path switch on (stack capture, diagnostics, warnings, a trace of the next dispatches), resetting after a run of successes, like a circuit breaker's half-open state. The fuse governs the cost of observing and reporting, never whether a rule is checked. See 7.2 item 13.

**Modes (owner, 2026-09-27)**
15. A debug mode: production code paths with observation on (the fuse's careful path, the diagnostics channel, the devtools timeline, an inspection endpoint through `createMcpHandler`), as a second build flag beside `__VC_DEV__` (`__VC_DEBUG__`, Vue's `__VUE_PROD_DEVTOOLS__` pattern), folded away when off. Position: take it. Condition: debug changes what is observed, never what happens, enforced by a contract test running the suite in production and debug and asserting identical results (7.2 item 15). Measurements and browser tests run on production and debug builds, not DEV.

**Shape (rev 19)**
16. `HttpError` and `RouterError`: the same class now, or take the code format first and join later. The two shapes of a backend's code CLOSED in rev 21 (4.4): both paths read `remote:<condition>:<code>`; `HttpError` remains only for no response at all. CLOSED in s35.131: `HttpError` removed, the client's every failure the core's `BusError` (`transport:` for no answer), `RouterError` already one.
17. Plugins that declare no name: owner `plugin`. DONE (the DEV warning naming the install site is not built).
18. How `fail` reaches a plugin: DONE as the third argument, bound when the runner is built (the happy path measured unchanged); `wired(plugin)`, exported from `vapor-chamber` beside `createTestBus`, for a plugin called outside a bus (the `vapor-chamber/vitest` pure entry imports nothing from the library at runtime, so it cannot carry it). Qualification on the way out was not benched and stays an alternative.

**PHP as first customer**
13. Scope of a PHP package (Composer): attributes that author the same `BusSchema` shape, a `Problem` helper, `generate-laravel` made runnable by users.

### 7.2 To measure or verify (evidence decides)

Each with the check that settles it.

1. **Factory size:** DONE with item 16.
2. **Monomorphic readers:** DONE (2.3). Real but small; settled item 2's reason corrected to correctness, and item 2b added.
3. **Build path and runtime path agree:** a contract test that the build-time resolution and the runtime lookup of `fail(...)` produce identical objects.
4. **Standard Schema as the one path:** validation speed and size of `BusSchema` through `~standard` against today's `schemaValidator`.
5. **FormBus pointer map:** DONE (2.3). Built once, it costs the same as keying by name.
6. **RFC 9842's header:** DONE. The browser sets `Available-Dictionary` from its own dictionary cache and the RFC is scoped to content encoding, so the handshake needs its own header (7.1 item 8 answered: own header, RFC 9842's pattern). RFC 9842 itself stays usable for its real purpose: the contract served with `Use-As-Dictionary`, compressing later JSON (2.3).
7. **CBOR:** bytes DONE (2.3). Result: minimal JSON on HTTP (the biggest win, no encoder); CBOR only on channels without compression (WebSocket frames, storage); the RFC 9842 dictionary as a bonus where supported. Still open: an existing encoder's size against a subset of our own, for the WebSocket path only.
8. **The handshake:** bytes saved per connection and per failure with matching and non-matching hashes.
9. **The condition vocabulary against real plugins:** DONE. The panel's 24 problem codes all fit the twelve conditions. The rev 18-20 status derivation did not: no entry for 401, 405, 413, 415, 419, 503, and two codes derived wrong (`refused` sent with 422, `in_progress` with 409). Result: rule 10 and 4.4 (rev 21). sashimi's own codes: one, `signed_out`.
10. **The panel's exposure to the store defect:** run it in the panel (inferred so far).
11. **Phase 0 fixes against consumers:** sashimi DONE against the deploy copy (subpaths aliased to its dist; published 1.24 as control): `router-sashimi` 150/150; `router-wire` 102/110, all eight the migration (2 renamed validator code, 2 its own `new BusError('VC_CORE_HANDLER_THREW')`, 4 reading a backend refusal from `error.code` or by "not a BusError"); no behaviour moved. The panel was read, not run (read-only here): two tests name `VC_CORE_NO_HANDLER`.
13. **The fuse's premise:** DONE (2.3). The happy path was not lean, but not because of reporting: the reporting plugins cost 0.5-2 us each. The cost was failure machinery built eagerly (`retry`'s `Error`, half the chain) and keying repeated per plugin. Result for 7.1 item 14: the fuse holds first as a RULE (nothing failure-related is built on success; a command's key is computed once and shared), which the factory and build checks can enforce; a runtime switch only earns its place for observation that is expensive and not yet failure-only (devtools timeline, traces: not measured).
15. **Debug changes nothing but observation:** the suite in production and in debug mode, results asserted identical; and debug's cost on the happy path, measured.
14. **Re-measure 2.3 under the house A/B harness** (`tests/*-ab.test.ts`), with ratios stamped into this plan by the bench reporter instead of typed.
16. **Ownership prototype (4.5):** DONE, and landed (owner: "good lets continue"). Three-arm A/B, production, 11 rounds: happy path 0.99-1.03x (noise); failures that captured a stack 4-12x faster; refusals that already skipped it 1.02-1.07x. Locking `code` (freeze, non-writable) cost 10-30% there; a private `#code` with a getter measured as a plain field. Size on the 2022 IIFE target against the old code on the same target: core +12 / +58, full +79 / +57; ESM consumer +68 brotli (6,328). `toJSON` with only the needed members, `type` implicit (owner): a docs URL in `type` cost 77 brotli. A `super()` inside `try/finally` made the compiler lower the private field into WeakMap helpers even on es2022; removed.
12. **Needs a real-browser runner (now exists: `npm run test:browser`):** the directive's focus loss is DONE (2.1, a Phase 0 defect). Still to run: RFC 9111 revalidation through `fetch` against `http-cache`'s time windows; form-associated custom elements on Vue's `VaporElement`.

---

## 8. Order of work (proposal)

Each phase lands with: a test that fails on 1.24 for every defect it fixes; size on core ESM and a tree-shaken ESM consumer, before and after; the speed bench where relevant; and the lines it lets the cookbook panel and sashimi delete.

- **Phase 0, defects alone:** `retry`'s pre-built `Error` (halves a realistic chain), the directive's focus loss (DONE), section 2.1's `register()` ownership, the store's unscoped holder, `useCommand`'s `KeepAlive` hooks, the three severities, `validator()`'s code, the quoted `Idempotency-Key`, the history order. Smallest changes, each with its failing test first.
- **Phase 1, the code model:** the factory, `owner:condition:subject`, generated lists, build checks (every code documented, raised and tested, as rustc's tidy does), DEV templates.
- **Phase 2, the schema:** `fails`, one vocabulary, Standard Schema as the one path.
- **Phase 3, plugins:** the descriptor, the diagnostics channel, hooks per condition, inspection by name.
- **Phase 4, the wire:** tables, handshake, CBOR.
- **Phase 5, components and the browser runner:** FormBus, `persist`, the directive, freshness, custom elements.
- **Phase 6, PHP:** the package and the contract test pair.

---

## 8b. Tooling in place (2026-09-27)

- `npm run test:browser` (`vitest.browser.config.ts`): real Chromium through
  `@vitest/browser-playwright` 5.0.1 and Playwright 1.63, headless shell only,
  production mode by default (`VC_MODE=development` for dev paths). Tests live
  in `tests/browser/`, which the default config excludes. Opt-in: not part of
  `npm test`. Since 2026-09-30, when the headless shell of the installed
  Playwright is not on the machine the run uses the system Chrome and says so
  (`scripts/browser-channel.mjs`, `tests/browser-channel.test.ts`).
- The Vitest MCP server (`vc-vitest-mcp`), registered in the owner's MCP client
  at local scope (nothing in the repo): `runTests` warm, `getTestResults`,
  `getCoverageGaps` for the failure branches of each prototype.
- For performance claims: the house three-arm A/B (`tests/*-ab.test.ts`) and
  the bench-ratios reporter; for size: `measure-size`, `check-size`.

## 8c. Accessibility track (2026-09-27)

Done, each test-first (red on the old code, then green):

- `v-vc-command` keeps keyboard focus through a dispatch (2.1; `aria-disabled`,
  not `disabled`, and not `aria-busy`, which can hide a button's name).
- `stampActiveLinks` sets `aria-current="page"` on the exact match only, and
  leaves another purpose's `aria-current` alone (`tests/router/dom.test.ts`).
- The router announces client-side navigations in an assertive live region,
  and `focusOnNavigate` moves focus to a small element the app names
  (`src/router/announce.ts`; 7 tests plus one in real Chromium). Router +0.4 KB
  brotli, core unchanged, all budgets and ESM ceilings pass.
- `MenuItem.exactActive` / `Breadcrumb.current` documented as the fields for
  `aria-current`; `MenuItem.active` as not.

Found in the cookbook panel (read-only here; for its owner): `PanelNav.vue`
binds `:aria-current="item.active ? 'page' : undefined"`. `active` is a prefix
match that also lights up a parent, so a nested menu announces two current
pages; `exactActive` is the field.

Still to do on this track:

- Non-button targets of `v-vc-command` (`<a>`, `role="button"`): in flight they
  get no `aria-disabled` and no guard, so the app's own listeners still run.
  fui guards Enter/Space on keydown for such elements.
- An accessibility-tree assertion in the browser tests (name kept, disabled
  exposed), the check that would have caught `aria-busy` on its own.
- Lint: Biome's built-in `a11y` rule group first; an ESLint add-on (the panel
  uses `eslint-plugin-vuejs-accessibility`) only if Biome does not cover
  templates. Owner, 2026-09-27: "to explore later".
- Reading: Lit's form participation and accessibility patterns
  (`ElementInternals`, `formDisabledCallback`, custom states), the WAI-ARIA
  Authoring Practices on focusable disabled controls.
- Browser runner note: the first run after a new dependency can report "no
  tests" while Vite optimises it and reloads; the next run is stable.

## 8d. The router against the rest of the library (2026-09-27)

The router imports almost nothing from core (`dev`, `http`, `dict`, `freeze`,
`bounds`). That is the design, not drift: `docs/router.md`, "Navigation as a
command (optional)", keeps the bus out on purpose ("it is sugar, and skipping it
costs nothing"). Measured against the rest of this plan, what it hand-rolls or
predates:

1. `routerError('cancelled')` builds an `Error` (a stack capture) for every
   superseded navigation; a search box driving query navigations pays one per
   keystroke. Measure with the house A/B; it goes with "no stack for expected
   refusals".
2. `routerError` is already one factory over a closed list of 23 codes, all
   raised: the easiest first adopter of `owner:condition:subject`
   (`router:missing:route`, `router:failed:loader`). `HARD_NAV_CODES` then
   derives ("missing or failed route, component, server HTML"), and a
   backend's problem inside `load_failed` is read through the cause-chain
   reader instead of each consumer digging `cause` (the panel's `problemOf()`).
3. `ParamType` (`int`, `bool`) and the schema's `FieldType` (`number`,
   `boolean`): 7.1 item 6.
4. Ten router test files each build their own router; `tests/router/fixture.ts`
   now exists for them.

Done here: the announcer's hand-kept focusable-selector list replaced by the
platform's own answer (`tabIndex`), -0.1 KB raw.

## 8e. Accessibility as a first-class requirement (2026-09-27)

Owner, 2026-09-27: "accessibility should be 1st citizen the problem is the
how", and "most places have accessibility as an afterthought, here too, mea
culpa, but I want to do it right". The three defects fixed so far (command
buttons dropping focus, no `aria-current`, silent navigations) were not hard;
nobody asked "who cannot use this?" when each was designed. The how below makes
that question impossible to skip.

### The how

1. **What to say and where to go are data.** A failure carries a human
   `detail` (localized by the backend: Laravel's validation messages already
   are) and a where. The contract decides the announcement and the focus
   target; the library holds no strings.
2. **When to react is a fact every command already carries: `meta.origin`.**
   Announce what the user did (`'user'`, `'undo'`, `'redo'`); stay silent for
   `'remote'`, `'sync'`, `'replay'`, `'agent'` (background work must not talk
   over the user). The failure's condition sets urgency: `invalid`, `refused`
   polite; `failed`, `lost` assertive.
3. **One reaction layer, the library's own mechanism: a plugin** reading the
   bus lifecycle, as `history` and `logger` do. Two primitives: announce through
   ONE shared live region per document (created on first use, or an element the
   app registers; Angular CDK's LiveAnnouncer, React Aria's `announce`), and
   focus-after-render (the panel's `focusWhenRendered` rule; `tabindex="-1"`
   only when the platform says the element is not focusable). The router's page
   changes go through the same region.
4. **Elements render the state by construction:** the directive
   (`aria-disabled` in flight, done), links (`aria-current` from `exactActive`,
   done for plain links), `RouterOutlet` (hosts the region), FormBus
   (`invalid` and `describedBy` per field once it takes errors by where).
5. **Override, never lock in:** a command opts out (`meta.a11y: false`); the app
   replaces the announcing function (its own status bar, its own words).

### Definition of done

A UI-facing feature is done when its WCAG criterion has a test: a browser test
where the platform matters, with an accessibility-tree assertion (Playwright's
role engine: name, role, state). **The browser suite joins CI** (Chromium on
Linux at least); opt-in suites erode.

**Done 2026-09-27:** `.github/workflows/ci.yml` has a `browser` job (Ubuntu,
Node 22, Playwright's headless Chromium with its system libraries), running the
suite in production and development mode on every push and pull request.
Checked locally before any push: the workflow parses, the lockfile carries the
browser packages, `lint:check` and `typecheck` pass (seven doc markers were
restamped with `npm run docs:stamp`: the Vapor outlet's figures moved with the
router's announcer), and the full Node suite passes (190 files, 2,548 tests).
A cold Vite cache passed three runs of three; the one "no tests" run seen
earlier needs a warm cache missing a new import, which CI never has. Not yet
seen: a real CI run, which needs the owner's push.

### Automation is not enough

GDS tested tools on a deliberately inaccessible page and the best found about
half the barriers
(https://accessibility.blog.gov.uk/2017/02/24/what-we-found-when-we-tested-tools-on-the-worlds-least-accessible-webpage/).
So: manual passes with NVDA and VoiceOver on the main flows each release, and
testing with disabled users on the flows that matter most, as Gatsby did with
Fable Tech Labs (that is what corrected "focus a wrapper").

### Criteria the library touches (from the owner's WCAG 2.1 AA checklist, section 2)

Page content (images, headings, language, contrast) is the app's; these are the
ones a library feature can meet or break.

| # | Criterion | Library piece | Status | Test |
|---|---|---|---|---|
| 2.4 | focus can leave every widget [2.1.2] | directive in-flight guard blocks clicks only, never focus | holds | browser: focus kept |
| 2.6 | page title [2.4.2] | router `meta.title` is an i18n key; the app sets `document.title` | app; the announcer reads it | announce tests |
| 2.7 | skip repeated blocks [2.4.1] | `focusOnNavigate` can target a skip link | app provides the link | announce test (skip link kept focusable) |
| 2.11, 2.13 | accessible name contains visible text [1.1.1, 4.1.2, 2.5.3] | directive keeps the name in flight (no `aria-busy`) | done | browser: role engine finds "Save" |
| 2.12 | role and state exposed [4.1.2] | `aria-disabled` in flight; `aria-current`; FormBus `aria(field)` | done | browser + `tests/router/dom.test.ts` + `tests/form-a11y.test.ts` |
| 2.16 | keyboard alone [2.1.1] | directive on a non-native `role="button"`: focusable, Enter on key down, Space on key up | DONE | `tests/browser/command-keyboard.browser.test.ts` |
| 2.20 | actions on release [2.5.2] | directive listens to `click` | holds | existing directive tests |
| 2.23, 2.24 | focus or a change never navigates by itself [3.2.1, 3.2.2] | preheat on hover/focus never navigates; query-only navigations move no focus and are not announced | holds | announce test (query-only) |
| 2.25 | time limits [2.2.1] | a 419 refreshes CSRF and resends, so no user-facing expiry | holds | existing bridge tests |
| 2.26 | status messages without moving focus [4.1.3] | `announce()` (src/a11y.ts), one shared region pair; the directive announces failures, the router page changes | commands and router done; forms via the plugin open | `tests/a11y-announce.test.ts`, `tests/browser/command-errors.browser.test.ts` |
| 2.27, 2.28 | errors identify the field and say how to fix [3.3.1, 3.3.3] | failure `detail` + where; FormBus `setErrors`, `aria`, `errorId`, `firstInvalid`; the plugin for focus | FormBus done; focus via the plugin open | `tests/form-a11y.test.ts`, `tests/browser/form-errors.browser.test.ts` |
| 2.29 | reversible, checked or confirmed [3.3.4] | both histories move the stacks back when an undo or redo does not land; one ledger | DONE | `tests/history-undo-lands.test.ts` |
| (1.4.1) | not by colour alone | `vc-error` stays for styling; the failure is also announced in words | DONE | `tests/browser/command-errors.browser.test.ts` |
| 2.2 | auto-updating content can be paused [2.2.2] | revalidation, polling, SSE update what is on screen | AUDIT: does the app get a pause? | to decide |

### Audit of what exists (built before this rule)

Done 2026-09-27: FormBus errors and aria facts; `vc-error` (announced in
words); the directive on `role="button"` (keyboard); both histories (a refused
undo no longer reads as done); the shared live regions (`announce()`), used by
the directive and the router, which makes a region in `RouterOutlet`
unnecessary.

Still open: Biome lints the examples' HTML and Vue files with its `a11y` rules
(probe 2026-09-27: 26 buttons without an explicit `type`, which defaults to
submit inside a form); pausing auto-updating content (2.2.2); transitions and
`prefers-reduced-motion`; form participation for custom elements; focusing the
first invalid field after a failed submit (the plugin); Biome's `a11y` lint
rules.

### Language (owner, 2026-09-27)

i18n comes LATER, as a plugin, and an English fallback lands much later, once
the rest of this plan has landed. Until then: what the library announces is the
failure's own message (a backend's `detail` arrives localized; the library's own
failures read in English), and an app that needs other words uses
`setAnnouncer`. No translation work in the library before then.

### Docs

An accessibility page in `docs/`: what the library guarantees (busy states,
announcements, focus after navigation and errors, `aria-current`) and what only
the app can do (the words, headings, a skip link, colour contrast, page titles).

### Draft for the decision log (owner to approve; not written there)

> | 2026-09-27 | Accessibility is a requirement, designed in rather than audited
> after. Every UI-facing change names who it could exclude before it is built,
> and is done only when its WCAG criterion has a test; the browser suite joins
> CI. Why: the first audit found three defects in shipped behaviour (command
> buttons sent keyboard focus to <body> on every dispatch, no `aria-current`,
> silent client-side navigations), none hard, all from the question never being
> asked. | docs/plan-failures-and-contract.md section 8e;
> tests/browser/; tests/router/announce.test.ts |

## 9. Sources

- Joe Duffy, "The Error Model": https://joeduffyblog.com/2016/02/07/the-error-model/
- matklad, "The Second Great Error Model Convergence": https://matklad.github.io/2025/12/29/second-error-model-convergence.html
- Yuan et al., "Simple Testing Can Prevent Most Critical Failures", OSDI 2014: https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf
- Google AIP-193, Errors: https://google.aip.dev/193
- RFC 9457, Problem Details: https://datatracker.ietf.org/doc/html/rfc9457
- RFC 9290, Concise Problem Details: https://datatracker.ietf.org/doc/html/rfc9290
- RFC 9842, Compression Dictionary Transport: https://www.rfc-editor.org/rfc/rfc9842.html
- RFC 7541, HPACK: https://httpwg.org/specs/rfc7541.html
- JSON:API errors: https://jsonapi.org/format/
- Node.js `internal/errors.js`: https://github.com/nodejs/node/blob/main/lib/internal/errors.js
- React error codes: https://legacy.reactjs.org/blog/2016/07/11/introducing-reacts-error-code-system.html
- Go 1.13 errors: https://go.dev/blog/go1.13-errors
- Smithy behaviour traits: https://smithy.io/2.0/spec/behavior-traits.html
- Apache Avro specification (RPC handshake): https://avro.apache.org/docs/1.11.1/specification/
- Unison, content-addressed code: https://www.unison-lang.org/docs/the-big-idea/
- Honda, Yoshida, Carbone, "Multiparty Asynchronous Session Types", POPL 2008: https://www.doc.ic.ac.uk/~yoshida/multiparty/multiparty.pdf
- rustc tidy error-code checks: https://doc.rust-lang.org/stable/nightly-rustc/tidy/error_codes/index.html
- TypeScript `diagnosticMessages.json`: https://github.com/microsoft/TypeScript/blob/main/src/compiler/diagnosticMessages.json
- FormatJS precompilation: https://formatjs.github.io/docs/guides/advanced-usage/
- Laravel Wayfinder: https://github.com/laravel/wayfinder
- splice: https://github.com/lucianofedericopereira/splice (read at 7f7ec32)
- RFC 3463, Enhanced Mail System Status Codes: https://www.rfc-editor.org/rfc/rfc3463.html
- SQLSTATE classes, ISO/IEC 9075 (Oracle): https://docs.oracle.com/cd/E15817_01/appdev.111/b31230/ch2.htm
- Azure REST API guidelines, errors: https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md
- OpenTelemetry Instrumentation Scope: https://opentelemetry.io/docs/specs/otel/common/instrumentation-scope/
- Temporal failures: https://docs.temporal.io/references/failures
- gRPC A6, client retries: https://github.com/grpc/proposal/blob/master/A6-client-retries.md
- MDN, private elements and brand checks: https://developer.mozilla.org/docs/Web/JavaScript/Reference/Classes/Private_elements
- Java `Throwable` (writableStackTrace): https://docs.oracle.com/en/java/javase/17/docs/api/java.base/java/lang/Throwable.html
- Effect, expected errors and `Cause`: https://effect.website/docs/error-management/expected-errors/
- HTML Standard, structured serialization of errors: https://html.spec.whatwg.org/multipage/structured-data.html

---

## Revision log

| rev | date | change |
|---|---|---|
| 1 | 2026-09-27 | First draft from the discussion: evidence, settled items, code model, wire, splice reuse, open items, order of work. |
| 2 | 2026-09-27 | Section 7 split into 7.1 to discuss and 7.2 to measure or verify; two unmeasured claims marked (the FormBus pointer map, the panel's exposure to the store defect). |
| 3 | 2026-09-27 | Rule 0 (results decide). Measured 7.2 items 2 and 5 (2.3); the first runs of both benches were discarded (shared V8 feedback). Settled item 2's reason corrected to correctness; item 2b added (derived facts stored at construction). |
| 4 | 2026-09-27 | Measured 7.2 items 6 and 7 (wire bytes in 2.3); handshake header answered (our own). Added the fuse (7.1 item 14, 7.2 item 13). |
| 5 | 2026-09-27 | Measured the happy path (7.2 item 13, 2.3): `retry` builds an `Error` on every success, now a Phase 0 defect; the fuse recast as a rule first, a runtime switch only for expensive observation. |
| 6 | 2026-09-27 | Method caveat on 2.3 (scratch benches, below the house A/B standard); 7.2 item 14 to re-measure under it. |
| 7 | 2026-09-27 | Debug mode added (7.1 item 15, 7.2 item 15): production paths plus observation, a build flag beside `__VC_DEV__`. |
| 8 | 2026-09-27 | Browser runner and MCP server wired (8b). The directive's focus loss confirmed in Chromium and moved to Phase 0; 7.2 item 12 partly done. |
| 9 | 2026-09-27 | The directive's focus loss fixed (CHANGELOG Unreleased, whitepaper note updated); first Phase 0 item done. |
| 10 | 2026-09-27 | Accessibility track (8c): `aria-current`, the route announcer and `focusOnNavigate` landed; the panel's `aria-current` binding noted; lint and Lit reading queued. |
| 11 | 2026-09-27 | `v-vc-command` in-flight state extended to `role="button"`; browser tests on `tap` + matchers and a shared router fixture; router explored (8d). |
| 12 | 2026-09-27 | Rule 9 and section 8e: accessibility as a first-class requirement (the how, definition of done, CI, criteria mapping, audit list, docs page, draft decision-log entry). |
| 13 | 2026-09-27 | Criterion 2.16 done: keyboard activation for a non-native `role="button"` with the directive. |
| 14 | 2026-09-27 | The browser suite joins CI (8e); lint:check, typecheck and the full Node suite green locally. |
| 15 | 2026-09-27 | FormBus takes outside errors and exposes accessibility facts (7.1 item 10 decided on 2.3 and done; criteria 2.12, 2.27 updated). |
| 16 | 2026-09-27 | History order fixed (move-then-revert) in both histories, now one ledger; full IIFE budget raised with measured steps (owner: "better architecture for free"). |
| 17 | 2026-09-27 | `announce()` built (one shared region pair); `vc-error` made semantic (failures announced); the router moved onto the shared region. |
| 18 | 2026-09-27 | i18n recorded as a later plugin, English fallback after the plan lands (8e, Language). |
| 19 | 2026-09-27 | Section 4.5 from research: owner by wiring (plugin's declared name), `#owner` brand, severity and retryable off the object, verdict as caller policy with owner veto; settled 2b reversed, settled 3 moved to the boundary; 7.1 items 16-18, 7.2 item 16. |
| 20 | 2026-09-27 | Phase 1's code model landed: owner by wiring, `#code`, `toJSON` with needed members, `remote:refused`, `wired` (root export), `VC_TEST_*` renamed, IIFE target 2022 (owner); 7.2 items 1 and 16 done; 7.1 item 16 gains the two-shapes question. |
| 21 | 2026-09-27 | Rule 10 (the front reads by contract, never guesses; one shape and one author per fact). 4.4 rewritten as the wire contract: RFC 9457 with the needed members, the problem's own `status` read through a table that says only what RFC 9110 says, no `ok`/`error`/`message`/`type`/`title`, one FormBus error shape; the half-migrated old shapes removed in this release. 4.5 moved after 4.4. 7.1 item 16 closed; 7.2 items 9 and 11 done. |
| 22 | 2026-09-28 | 4.4: a success is any answer without `problem`; retries are one rule (`failureCondition`) applied by `retrying(transport)` (the wire) and `retry()` (the command), `noRetry` replaced by the idempotency key, the bridges' retry option removed; the outbox reads the same condition; `emitter` and `X-RateLimit-Reset` gone. Tests reorganized into `tests/wire-contract.test.ts`; the history-organized fixtures removed. |
| 23 | 2026-09-30 | Brought into line with v1.25.0 as shipped: the status line says what is built; settled item 3's `toJSON()` sends no `type`; 4.3's plugin-throw row carries the plugin's owner; 4.4's retry paragraph and 7.1 item 3 state the bus's class rule in place of `retrying()` / `retry()`, with both routes to an uncertain re-send (declared idempotent, or keyed). |
