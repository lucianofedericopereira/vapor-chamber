# 4. Talking to a backend

This chapter sends commands to a server and takes its pushes back: the transports, batching,
realtime, and the HTTP client for every other request. The wire format both sides read is
[contract.md](../contract.md). The Laravel side is [chapter 11](./11-laravel.md).

## Choose a transport

Send commands to a backend over HTTP or WebSocket, and take pushes over SSE or Echo. Import from
`vapor-chamber/transports`.

A transport is declared at the async bus, `createAsyncCommandBus({ transport })`: one for every
action, or a map by action pattern where the most specific match wins (an exact name, then the
longest prefix, then `*`). It is the work for the actions it covers, where a local handler would
run. Every plugin wraps it, wherever it was installed. An action no pattern covers runs its local
handler, and a `$` action is the library's and always runs locally.

| Name | Use for |
|---|---|
| `httpTransport` | POST each command to one endpoint. `batch` coalesces a window's commands into one POST |
| `wsTransport` | WebSocket with auto-reconnect and a reactive `connected` signal |
| `defineTransport` | Your own `send(cmd, local)`. `{ localFallback: true }` when it falls back to the local handler |
| `createSseBridge` | Server pushes in: store states written, events emitted |
| `createEchoBridge` | Laravel Echo / Reverb channels -> store states, then `bus.emit()` |

## Send commands over HTTP

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';
import { httpTransport } from 'vapor-chamber/transports';

// The bus re-sends through the transport by the rule above (never a redirect).
// Until a 429 or 503 wait ends, another command for that action waits it too,
// unsent (transport:limited:held, docs/retry.md).
const bus = createAsyncCommandBus({
  onMissing: 'ignore',
  transport: {
    'order*': httpTransport({                 // only these go to the server; others stay local
      endpoint: '/api/commands',
      csrf: true,                             // the meta tag, else the XSRF-TOKEN cookie
      csrfCookieUrl: '/sanctum/csrf-cookie',  // default; '' disables the refresh fetch
      timeout: 8000,
    }),
  },
});

await bus.dispatch('orderCreate', { items: cart });
// -> POST /api/commands  { command: 'orderCreate', target: { items: ... } }
```

The response shape. `result.value` is the contents of `state`:

```json
{ "state": { "orderId": 42, "status": "pending" } }
```

Cancel in-flight requests when a Vapor scope is disposed:

```typescript
const ctrl = new AbortController();
onScopeDispose(() => ctrl.abort());
const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', scopeController: ctrl }) });
```

## Batch commands into one request

The same transport with `batch` keeps the same backend contract, CSRF, timeout and session
expiry. Commands sent within a window coalesce into one POST and are matched back to each caller
by id. The bus re-sends per command, each into the next batch. The call site sees no difference:
each `dispatch()` still resolves with its own result.

```typescript
const bus = createAsyncCommandBus({
  transport: httpTransport({
    endpoint: '/api/vc/batch',
    csrf: true,
    batch: { window: 'microtask' },   // default: same-tick coalescing, zero added latency
    // batch: { window: 20 },         // or hold the queue open N ms to catch separate ticks
  }),
});

bus.dispatch('formSet', { field: 'email' }, { value: 'a@b.com' });
bus.dispatch('cartAdd', product, { quantity: 2 });
// -> ONE HTTP round trip
```

```json
// -> POST /api/vc/batch
{ "commands": [{ "id": "c1", "command": "formSet", "target": { "field": "email" } },
              { "id": "c2", "command": "cartAdd", "target": { "id": 7 }, "payload": { "quantity": 2 } }] }
// <- a 200; each command's answer on its own result, a failure as its problem
{ "results": [{ "id": "c1", "state": {} },
             { "id": "c2", "problem": { "status": 409, "code": "out_of_stock", "detail": "Out of stock" } }] }
```

## Add request headers and read the response

A plugin adds headers to the request a transport sends through `cmd.meta.request`. Header names
are lowercase. A tracing plugin writes a W3C `traceparent`:

```typescript
bus.use({
  started: (cmd) => { cmd.meta.request = { headers: { traceparent: tracer.current() } }; },   // your tracer
});
```

- The transport's own `headers` go out as they are, with the plugin's headers added.
- A batch sends one request, so it merges the headers of every command in it.[^meta-request]

A reply that came over HTTP carries the response it arrived in, as `cmd.meta.response`:
`status`, `headers` (names lowercase), `url` and `redirected`, as Fetch names them. It is the 2xx
the reply came in. A 202 says accepted, not finished. A local handler leaves it `undefined`, and
a non-2xx answer belongs to the error.[^meta-response]

[^meta-request]: `tests/meta-request.test.ts`.

[^meta-response]: `tests/meta-response.test.ts`.

## Use WebSocket, SSE or Laravel Echo

```typescript
const ws = wsTransport({
  url: 'wss://api.example.com/commands',
  timeout: 10_000,     // per-message response timeout
  reconnect: true,
  maxReconnects: 10,
});
const bus = createAsyncCommandBus({ transport: { 'chat*': ws, 'presence*': ws } });
ws.connect();

ws.isConnected();      // imperative
ws.connected.value;    // reactive signal - bindable in templates, no polling
ws.outbox.pending.value; // commands held while the socket is down
ws.disconnect();       // intentional close, suppresses reconnect
```

While the socket is down, a dispatch answers an `Accepted`. Its `done` settles with the reply
once the socket opens and the command is sent. The transport's own outbox holds up to 100
commands in memory, each for at most `timeout`, and `disconnect()` settles what it holds. To hold
them durably, give the bus an outbox: `createAsyncCommandBus({ transport, outbox: createOutbox() })`
also holds a WebSocket action while the socket is down, saved in `localStorage` and shared by the
origin's tabs.

A server's push is a name and data on every wire: an SSE event, an Echo broadcast, or a
WebSocket frame `{ event, data }` with no `id`. Each store state under the data's `stores` is
written to the store with that id, then the event is emitted on the bus. A push is never
dispatched, so no plugin runs and no transport sends it back
([docs/contract.md](../contract.md#4-the-wire)).

```typescript
// event: cartChanged, data: {"stores":{"cart":{...}}} -> the cart store, then bus.emit('cartChanged', data)
createSseBridge({ url: '/api/events', events: ['cartChanged'] }).install(bus);
// onEvent: (event, bus) => ... reads each event itself, in place of the push
```

For Echo and Reverb you pass your own instance, so the library never imports `laravel-echo`:

```typescript
const realtime = createEchoBridge({
  echo,
  channels: [
    { name: `user.${userId}`, type: 'private',  events: ['OrderShipped'] },
    { name: 'lobby',          type: 'presence', events: ['MessagePosted'] },
  ],
});
realtime.install(bus);   // OrderShipped -> bus.emit('OrderShipped', payload)
// realtime.dispose();
```

## Queue commands while offline

`createOutbox` holds the commands of the actions it covers while the app is offline, and sends
them when it reconnects. Each goes out with its idempotency key, so the backend runs a write
once:

```typescript
import { Accepted, createAsyncCommandBus } from 'vapor-chamber';
import { createOutbox } from 'vapor-chamber/outbox';
import { httpTransport } from 'vapor-chamber/transports';

const outbox = createOutbox({ actions: ['cart*', 'order*'] });
const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });

const result = await bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
if (result.ok && result.value instanceof Accepted) {
  toast(`Saved offline - ${outbox.pending.value} pending`);
  const answer = await result.value.done;   // the server's answer, once sent
}
```

- **Held.** While offline, a covered command answers an `Accepted` at once. It is saved in
  `localStorage` by default and shared by the origin's tabs. `storage: indexedDbStorage()`, from
  the root, saves it in IndexedDB, and `storage: null` keeps it in this tab's memory.
- **Sent.** The window's `online` event or `flush()` sends the records one at a time, through
  their transports. Each tab sends only its own records. When a tab closes, another tab takes
  its records over.[^outbox-tabs]
- **Judged.** A failure the server gave as its verdict on the command is final: a 4xx other
  than 401, 408, 419 and 429, with no `Retry-After`. A validator's `invalid` refusal is final
  too. The record is dropped, and its caller's `done` settles with the failure. A record whose
  caller is gone goes to the `rejected` signal. Every other failure keeps the record and stops
  the flush. `createOutbox({ isRetryable: (error, record) => boolean })` sets your own rule.
- **Waited.** When an answer declares `Retry-After`, the outbox flushes again after that wait,
  never sooner than 1 s. While the answer repeats, the wait doubles up to 30 s, and a longer
  declared wait wins. A success starts it over.[^outbox-wait]
- **Bounded.** `maxSize` (200 by default) drops the oldest record past it, and `ttl` drops a
  record held longer than it. Its caller's `done` settles with `outbox:exceeded:queue` or
  `outbox:timeout:queue`.
- **Dated.** `record.queuedAt` is RFC 3339 text. `Date.parse(record.queuedAt)` gives the
  milliseconds.

[^outbox-tabs]: `tests/outbox-tabs.test.ts`.

[^outbox-wait]: `tests/wire-contract.test.ts`.

## Use the HTTP client directly

Two levels share the same retry, timeout and CSRF machinery:

- **`postCommand`**: the single-purpose POST helper that `httpTransport` builds on, for one-off
  HTTP control outside the transport.
- **`createHttpClient`**: a full client (GET, POST, PUT, PATCH, DELETE) with interceptors, LRU
  caching, request dedupe, safe mode and file download, for any HTTP need in an app that already
  uses vapor-chamber, command bus or not.

```typescript
import { createHttpClient, problemOf } from 'vapor-chamber';

const http = createHttpClient({ baseURL: '/api', csrf: true });

await http.get('/users', { params: { page: 1 } });
await http.post('/cart', { itemId: 1, qty: 2 });
await http.delete('/cart/1');

const result = await http.safe.post('/login', credentials);   // never throws
if (result.error) console.log(problemOf(result.error)?.errors); // a BusError; problemOf reads its RFC 9457 problem

await http.download('/export/csv', 'products.csv');

http.interceptors.request.use((config) => {
  config.headers = { ...config.headers, 'X-Custom': '1' };
  return config;
});

const adminHttp = http.create({ baseURL: '/admin/api' });   // defaults merged, its own interceptors
```

- **A 304 can resolve.** A request the app made conditional (`If-None-Match`,
  `If-Modified-Since`) throws its 304 like any non-2xx. `resolveNotModified: true`, per request or
  on the client, resolves it instead: `status` 304, `ok` false as Fetch says, `data` the empty
  body. It is never cached, and `postCommand` takes it too.[^not-modified]
- **The final URL.** A response's `url` is the URL Fetch reached after any redirect, and
  `redirected` says whether it followed one.

[^not-modified]: `tests/http-not-modified.test.ts`.

### How a failure is judged

**Three named rules decide what happens to a failure.** Each is stated once, and all three are
exported from the package root.

- `isRetryableStatus(status)`: *may the client send this request again?* True for 408, 429 and
  every 5xx.
  - The bound is the bus's: `retry: { maxAttempts }`, attempts in total, 3 by default. It is on
    for a GET and off for a write. `retry: {}` turns it on, `retry: false` off.
  - 408, 429 and 503 are re-sent for any method. Every other 5xx and no reply are re-sent only
    for an idempotent method or a request with an `Idempotency-Key`.
  - A declared wait sets when, never whether: `Retry-After`, else the `RateLimit` field's `t`
    when `r=0`, else `X-RateLimit-Reset`. With none, the wait is the async bus's: random, under
    200 ms doubling per re-send, capped at 20 s.
  - While re-sends are on, an unidentified request (a POST or PATCH with no `Idempotency-Key`)
    that got no reply, a 502 or a 504 fails with `context.outcome: 'unknown'`.
  - Any other 4xx is sent once, unless identified and answered with a wait.
- `failureCondition(error, signal?)`: *what went wrong, by contract?* It reads a library
  failure's own condition, or an HTTP response's status through the status table. A timeout, an
  abort and `lost` (no response) have their own. Pass the command's `signal`, and an abort with
  your own `Error` reason reads `aborted` too. The async bus's retry and the outbox judge a
  failure by it.
- `classifyError(error)`: *can a cached response stand in for this failure?* `transient` is true
  for a timeout, a network failure (no response) or a 5xx. It is false for every 4xx, 408 and 429
  included, so `serveStaleOnError` does not serve stale data for them.

Every failure is the core's `BusError`, the same one a transport returns for the same answer:
`remote:<condition>:<code>`, `transport:timeout:reply`, `transport:lost:reply`, or the caller's
`transport:aborted:request`, which is never retried.

### Cache reads

**Caching (GET only):** `cache: true` for a flat TTL, or an object for more:

```typescript
// Stale-while-revalidate: a hit past `ttl` but inside `ttl + staleTtl` is served
// instantly (stale: true) while a background fetch refreshes it.
const res = await http.get('/dashboard/stats', { cache: { ttl: 30_000, staleTtl: 5 * 60_000 } });
if (res.revalidation) { const fresh = await res.revalidation; }

// serveStaleOnError: a *transient* failure with a retained entry resolves instead
// of rejecting - { data, stale: true, servedOnError: true, error }.
// Business errors (4xx) are never masked this way.
await http.get('/dashboard/stats', { cache: { ttl: 30_000, serveStaleOnError: true } });
```

- **A write invalidates.** A successful `post`, `put`, `patch` or `delete` drops the cached entry
  for its URL, as RFC 9111 asks. It also drops the `Location` and `Content-Location` its answer
  names on the same origin, so the next `get` of any of them fetches.
- **In-flight reads too.** That invalidation and `clearCache()` also cover reads already on the
  wire. Such a read still answers its callers but is not stored, and a read made after the
  invalidation fetches again instead of joining it.[^cache-writes]
- **The server can name stale groups** (RFC 9875). A read's `Cache-Groups` names its groups, and
  a write's `Cache-Group-Invalidation` names the groups it changed. The client drops its cached
  reads in those groups, and `onInvalidateGroup(listener)` hears each group (the router listens
  there). `invalidateGroups(groups)` does the same by hand. A transport given the client
  (`httpTransport({ httpClient })`, `wsTransport({ httpClient })`) passes a batched result's or a
  frame's groups to it.[^cache-groups]
- **ETag refresh.** When a stored response has an `ETag`, its stale refresh asks
  `If-None-Match`. A 304 keeps the copy: the refresh resolves to the stored response, the same
  data object, for a new window. A response with `Cache-Control: no-store` is not
  stored.[^etag]
- **`cacheMode`** sets Fetch's cache mode for one request, for the browser's cache and the
  client's alike. `'no-cache'` asks the server before a stored copy is used (with its `ETag`),
  `'reload'` reads past it, and `'no-store'` neither reads nor stores.[^cache-mode]

[^cache-writes]: `tests/http-cache-writes.test.ts`.

[^cache-groups]: `tests/cache-groups.test.ts`.

[^etag]: `tests/http-etag-refresh.test.ts`.

[^cache-mode]: `tests/http-cache-mode.test.ts`.

### Keep a request out of the global error handler

**`silent`** is a per-request opt-out for a global error handler the host installs:

```typescript
await http.post('/analytics/beacon', payload, { silent: true }).catch((e) => {
  e.context.silent;   // true - a global handler can check this and skip the toast
});
```

## Parse a streamed body

`vapor-chamber/stream-parser` is a dependency-free incremental JSON parser. It consumes a
streamed `fetch()` or SSE body as it arrives, without buffering the whole payload (LLM
completions, large exports). It is subpath-only and adds nothing to the IIFE bundles.

```typescript
import { createStreamParser } from 'vapor-chamber/stream-parser';

const parser = createStreamParser({
  onValue: (key, value, path) => console.log(key, value, path),
});
await parser.stream(await fetch('/api/stream'));
```

Next: [5. Vue and Vapor components](./05-vue.md).
