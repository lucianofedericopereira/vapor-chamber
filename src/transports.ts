/**
 * vapor-chamber - Transports
 *
 * A transport is the work for the actions it covers: declared once at the
 * async bus (`createAsyncCommandBus({ transport })`), it sends a command to a
 * backend where a local handler would run it. Every plugin wraps it, the
 * bus's retry re-sends through it, and its answer is written there.
 */

import type { Command, CommandResult, BaseBus, BusError, FailCode, MetaResponse, SendAt, Transport } from './command-bus';
import { _report } from './report';
import { type Delay, countOption, delayOption, isDelay } from './bounds';
import { Accepted } from './accepted';
import { DEV } from './dev';
import { abortedResult, BusError as BusErrorClass, _failures, _groupsAt, _setHub, _okResult, _errResult, _OUTBOX, _opened, _outboxOn, _replayOf, type BusGroups } from './command-bus';
import { createOutbox, type Outbox } from './outbox';
import { _appliedRemotely, _pushed } from './applied-remotely';
import { _answered, _combineSignals, _declaredWait, _encodeJson, _getJson, _headerOf, _headersOf, _postJson, _remoteProblem, _sleepMs } from './http';
import { conditionOf, retryClass } from './failure';
import type { CombinedSignal, GroupHub, HttpClient, HttpResponse } from './http';
import type { ProblemDetails } from './http-errors';
import { signal } from './signal';
import type { Signal } from './signal';

// The answer a 202 gets, for `instanceof` from this entry too.
export { Accepted };

// ---------------------------------------------------------------------------
// Shared protocol types
// ---------------------------------------------------------------------------

/**
 * A command on every wire (docs/contract.md 4): `id` where
 * answers are multiplexed (a batch, a WebSocket), as on the answer side; `meta`
 * only with a fact a backend can use. Its HTTP metadata, the idempotency key,
 * is the `Idempotency-Key` header when the request is the command, and that
 * name in `headers` when the command is multiplexed (OData JSON 4.01 19.1).
 * Log s35.138, 36.47.
 */
export type CommandEnvelope = {
  id?: string;
  command: string;
  target: any;
  payload?: any;
  meta?: EnvelopeMeta;
  headers?: Record<string, string>;
};

/** The part of a command's meta that crosses the wire as the command's own data. */
export type EnvelopeMeta = { correlationId?: string; causationId?: string };

/**
 * A key as the `Idempotency-Key` value: a Structured Field String, as the
 * draft requires (RFC 9651), quoted and printable ASCII. Percent-encoding
 * (UTF-8) yields only unreserved ASCII and %XX, never `"` or `\`, so quoting
 * is all it needs. It is reversible, so no two keys collide, and any backend
 * recovers the exact key (rawurldecode). Raw, a target outside Latin-1 made a
 * value Headers refuses and the request never left. A malformed key (a lone
 * surrogate) makes this throw, which the bus reports as transport:failed:send
 * on every wire. A key of unreserved characters only, as every `meta.id` is,
 * is its own encoding, so the scan skips the encode with the same bytes.
 * tests/idempotency-header.test.ts, tests/wire-envelope.test.ts.
 */
const UNRESERVED = /^[\w.~-]*$/;
const keyText = (key: string): string => (UNRESERVED.test(key) ? key : encodeURIComponent(key));
const keyHeader = (key: string): string => `"${keyText(key)}"`;

// One literal: JSON drops the undefined members, so the wire has only what is
// set. The key is never in it: a single request sends it as a header.
function envelopeOf(cmd: Command, id?: string): CommandEnvelope {
  const m = cmd.meta;
  const meta = m && (m.correlationId ?? m.causationId) !== undefined
    ? { correlationId: m.correlationId, causationId: m.causationId }
    : undefined;
  return { id, command: cmd.action, target: cmd.target, payload: cmd.payload, meta };
}

// A multiplexed command (a batch item, a frame): its envelope with its `id`,
// and a keyed command's key in `headers`, written only then.
function multiplexedOf(cmd: Command, id: string): CommandEnvelope {
  const envelope = envelopeOf(cmd, id);
  const key = cmd.meta?.idempotencyKey;
  if (key) envelope.headers = { 'Idempotency-Key': keyHeader(key) };
  return envelope;
}

/**
 * A multiplexed command as JSON, or the failure that says it cannot be. A
 * key's text (`keyText`) holds only unreserved characters, `%` and `!*'()`,
 * none of which JSON escapes, so its `headers` member is appended as text: the
 * bytes JSON.stringify writes for it as the last member, with no object and no
 * escaping pass (tests/idempotency-header.test.ts).
 */
function encodeMultiplexed(cmd: Command, id: string, url: string): string | BusError {
  const key = cmd.meta?.idempotencyKey;
  const data = _encodeJson(envelopeOf(cmd, id), url, cmd.action);
  return key && typeof data === 'string' ? `${data.slice(0, -1)},"headers":{"Idempotency-Key":"\\"${keyText(key)}\\""}}` : data;
}

/**
 * A command's answer, the same on every wire (docs/contract.md 4):
 * `state` on success, `redirect` for a navigation, `problem` on failure,
 * one of the three. A batched result and a WebSocket frame carry `id` beside
 * it; a single command's failure is its non-2xx response's body.
 */
export type BackendResponse = {
  state?: unknown;
  /**
   * Store states the server declares beside a success, by store id: each
   * store with that id on the bus takes its state, whatever the command was
   * (docs/store.md, A store behind a transport). Log s35.186.
   */
  stores?: Record<string, unknown>;
  /** A navigation the backend hands back instead of a result - see `onRedirect`. */
  redirect?: string;
  problem?: ProblemDetails;
};

/**
 * An app's own transport: `send` answers the command, and `local()` runs the
 * action's local handler (or the missing-handler outcome), its fallback. A
 * throw or a rejection fails the dispatch as `transport:failed:send`. A send
 * that calls `local()` declares `localFallback: true`: only then may its
 * actions have a handler, `optimistic` aside
 * (tests/register-shadow-check.test.ts).
 *
 * @example
 * const offlineFirst = defineTransport((cmd, local) => (navigator.onLine ? send(cmd) : local()), { localFallback: true })
 * const bus = createAsyncCommandBus({ transport: offlineFirst })
 */
export function defineTransport(send: Transport['send'], options?: { localFallback?: boolean }): Transport {
  return { id: ID, localFallback: options?.localFallback === true, send };
}

// The transport's own failures, and a backend's: each through its own `fail`,
// so neither can speak as the other (docs/contract.md 5).
// Every transport's owner name.
const ID = 'transport';
const transportFail = _failures(ID);
const remoteFail = _failures('remote');
const transportError = (code: FailCode, message: string, action?: string, context?: Record<string, unknown>): BusError =>
  transportFail(code, message, { action, context });
/**
 * Why a request produced no answer. The http client throws the core's failure
 * already read (`_answered`, log s35.131), and the transport passes it on as it
 * is - the failure a direct call sees. The one translation left: the caller's
 * abort of a dispatch is the bus's (`core:aborted:dispatch`). A custom client
 * that throws something else is read by its `response`, else as no reply.
 */
function unanswered(e: unknown, action: string, signal?: AbortSignal): CommandResult {
  if (signal?.aborted || (e as BusError)?.code === 'transport:aborted:request') return abortedResult(action, signal);
  if (e instanceof BusErrorClass) return _errResult(e);
  // A custom client's failure: its `response`, else the platform's exception
  // names (`AbortSignal.timeout()` throws a TimeoutError), else no reply.
  const err = e as { name?: unknown; message?: string; response?: { status: number; data: unknown; headers?: Record<string, string> } } | null;
  if (err?.response) return _errResult(_answered(err.response.status, err.response.data, _headersOf(err.response.headers)));
  if (err?.name === 'TimeoutError') return _errResult(transportError('timeout:reply', String(err.message), action));
  if (err?.name === 'AbortError') return abortedResult(action, signal);
  return _errResult(transportFail('lost:reply', `No response for "${action}".`, { action, cause: e }));
}

/**
 * The limits a server declared to one transport, by action: when each ends,
 * in ms since the epoch (docs/retry.md, The hold). Held per action, never per
 * transport: a 429 does not say what it covers (RFC 6585 4), and a whole
 * transport held would refuse commands the server accepts. tests/hold.test.ts.
 */
type Holds = Map<string, number>;

/**
 * A command whose action is held: refused at once and never sent, as
 * `transport:limited:held` with the time left as `retryIn`. It is the failure
 * its 429 would have been, so the bus's retry and the outbox wait it as they
 * wait a 429's (docs/retry.md). A hold past its end is forgotten here.
 */
function whileHeld(holds: Holds, action: string): CommandResult | undefined {
  const end = holds.get(action);
  if (end === undefined) return undefined;
  const left = end - Date.now();
  if (left > 0) return _errResult(transportError('limited:held', `"${action}" is held for ${left}ms: the server declared a limit.`, action, { retryIn: left }));
  holds.delete(action);
  return undefined;
}

/**
 * `result`, after holding its action when it is a `limited` failure (429,
 * 503) that declares a wait (`retryIn`, read by `_declaredWait`). A verdict
 * with a wait, such as a 409 `in_progress`, is one request's state and holds
 * nothing. A later end extends a hold and an earlier one never shortens it:
 * Retry-After is a minimum (RFC 9110 10.2.3). Failure paths only.
 */
function holding(holds: Holds, action: string, result: CommandResult): CommandResult {
  const wait = (result.error as BusError | undefined)?.context?.retryIn;
  if (typeof wait === 'number' && conditionOf(result.error) === 'limited') {
    const end = Date.now() + wait;
    const held = holds.get(action);
    if (held === undefined || held < end) holds.set(action, end);
  }
  return result;
}

/** A redirect the backend answered with: the command fails, carrying the url. */
const redirected = (url: string, action: string, handled: boolean): BusError =>
  transportError('refused:redirect', `Redirected to ${url}.${DEV && !handled ? ' No onRedirect handler is configured.' : ''}`, action, { url });

// What `meta.response` holds: the objects the client already built, no copy.
const responseOf = (res: { status: number; headers?: Record<string, string>; url?: string; redirected?: boolean }): MetaResponse =>
  ({ status: res.status, headers: res.headers ?? {}, url: res.url, redirected: res.redirected });

// An answer by contract: a `problem` is the failure, a `redirect` a navigation,
// anything else the success, its `state` the value (absent when the handler
// returned nothing: JSON drops `undefined`). A result's own headers are the
// response's, or the `headers` a batched result
// or a frame carries (OData JSON batch), read by `_headersOf`. `status`: a
// batched result's or a frame's own (OData 19.5), which stands for the
// response's when the problem has none. A single answer has none here.
function answerOf(r: BackendResponse, cmd: Command, headers?: unknown, status?: unknown): CommandResult {
  if (r.problem) {
    const own = _headersOf(headers);
    return _errResult(_remoteProblem(r.problem, typeof status === 'number' ? status : undefined, own && _declaredWait(own)));
  }
  if (typeof r.redirect === 'string') return _errResult(redirected(r.redirect, cmd.action, false));
  // The server applied it: history must not undo or redo it locally (R9).
  // The store states its reply declares travel with it to the bus.
  _appliedRemotely.set(cmd, r.stores);
  return _okResult(r.state);
}

/**
 * One answer of an HTTP transport's request. A redirect is a body member (a
 * browser's fetch cannot read a 3xx's Location): it goes to `navigate`
 * (typically Inertia's `router.visit`), and the command fails, carrying the
 * url. Anything else by contract (answerOf).
 */
function readAnswer(r: BackendResponse, cmd: Command, headers: unknown, navigate: ((url: string) => void) | undefined, status?: unknown): CommandResult {
  if (typeof r.redirect === 'string' && r.redirect) {
    navigate?.(r.redirect);
    return _errResult(redirected(r.redirect, cmd.action, !!navigate));
  }
  return answerOf(r, cmd, headers, status);
}

/**
 * An answer's own `Cache-Group-Invalidation` (RFC 9875), on a response, a
 * batched result or a frame, for the bus's group hub: the app's client (its
 * reads, the router), else the bus's own (cache()). tests/cache-groups.test.ts,
 * tests/cache-groups-hub.test.ts. With no hub nothing can act on it, and
 * development says so once per transport (`said`); production reads nothing.
 */
function groupsTo(hub: GroupHub | null | undefined, own: unknown, said: { warned: boolean }): void {
  if (hub) {
    const named = _headerOf(own, 'cache-group-invalidation');
    if (named !== undefined) hub.invalidateGroups(named);
  } else if (DEV && !said.warned && _headerOf(own, 'cache-group-invalidation') !== undefined) {
    said.warned = true;
    _report('warn', 'transport:missing:client', 'an answer named groups in Cache-Group-Invalidation, but nothing on this bus reads them. Give the transport the client the router reads, or install cache().');
  }
}

/**
 * A transport's bus's groups (BusGroups), its `client` the bus's hub: one
 * hub per bus, so a second, different client keeps the first and development
 * warns. At the bus's creation (Transport.attach).
 */
function joinGroups(bus: BaseBus, client: HttpClient | undefined): BusGroups {
  const g = _groupsAt(bus);
  if (client) {
    if (g.hub === null) _setHub(g, client);
    else if (DEV && g.hub.invalidateGroups !== client.invalidateGroups) {
      _report('warn', 'transport:conflict:client', 'two transports of one bus have different httpClients: the groups their answers name reach the first client only. Give the bus one client.');
    }
  }
  return g;
}

/**
 * What both HTTP sends go through. `signal`: the transport's own and its
 * scope's, either one cancels, combined once (its listeners live as long as
 * the transport, never detached). `post`: one request, through the app's
 * `httpClient` with the body as an object, else postCommand's path with it
 * already JSON. Each command is sent once (`retry: false`): the async bus
 * re-sends (docs/retry.md), so the two never multiply. `holds`: the limits
 * the server declared, read before each send; `dispose` forgets them.
 */
function httpSender(options: HttpTransportOptions) {
  const { endpoint, csrf = false, csrfCookieUrl, timeout = 10_000, signal, onSessionExpired, scopeController, httpClient, headers, poll } = options;
  const scope = scopeController && signal ? _combineSignals(signal, scopeController.signal).signal : scopeController?.signal ?? signal;
  // A NaN behaves like a missing option (bounds.ts): never a hot loop or an endless wait.
  const interval = delayOption(poll?.interval, 1000);
  const maxWait = countOption(poll?.maxWait, 300_000);
  // What stops every follow: the transport's dispose, its scope, or the command's signal.
  const stop = new AbortController();
  const holds: Holds = new Map();
  const said = { warned: false };
  // The bus's groups, from its attach: where an answer's groups go without a client.
  let groups: BusGroups | undefined;

  /**
   * A status monitor polled to the job's end: its `{ state }`, its problem, or
   * `transport:timeout:job` past `maxWait`. A passing failure of a poll says
   * nothing about the job, still running: a transient one by the one retry
   * rule (failure.ts retryClass) or one declaring a wait polls again. Anything
   * else ends it, as an abort does (tests/accepted-transient.test.ts).
   */
  async function follow(cmd: Command, location: string, answerHeaders: unknown, base: string | undefined): Promise<CommandResult> {
    let url = location;
    // A Location no URL holds is followed as sent: its failure ends `done`, never the dispatch.
    if (base) try { url = new URL(url, base).href; } catch { /* as sent */ }
    // Combined per follow and detached at its end: a listener left on the
    // scope would outlive it (tests/combine-signals.test.ts).
    const scoped = scope ? _combineSignals(stop.signal, scope) : undefined;
    const combined = cmd.signal ? _combineSignals(scoped ? scoped.signal : stop.signal, cmd.signal) : undefined;
    const sig = combined ? combined.signal : scoped ? scoped.signal : stop.signal;
    const end = Date.now() + maxWait;
    let wait = waitOf(_headersOf(answerHeaders), interval);
    try {
      for (;;) {
        if (sig.aborted) return abortedResult(cmd.action, sig);
        if (Date.now() + wait > end) return _errResult(transportError('timeout:job', `"${cmd.action}" was not done within ${maxWait}ms.`, cmd.action, { location: url, maxWait }));
        let r: HttpResponse<Monitor>;
        try {
          await _sleepMs(wait, sig);
          r = httpClient ? await httpClient.get<Monitor>(url, { signal: sig, dedupe: false }) : await _getJson<Monitor>(url, { headers, signal: sig, onSessionExpired });
        } catch (e) {
          if (sig.aborted) return abortedResult(cmd.action, sig);
          const declared = (e as BusError).context?.retryIn;
          if (retryClass(e) !== 'transient' && !isDelay(declared)) return _errResult(e as Error);
          wait = isDelay(declared) ? declared : interval;
          continue;
        }
        if (r.status !== 202) return r.data?.problem ? _errResult(_remoteProblem(r.data.problem)) : _okResult(r.data?.state);
        wait = waitOf(_headersOf(r.headers), interval);
      }
    } finally {
      combined?.detach();
      scoped?.detach();
    }
  }

  return {
    signal: scope,
    holds,
    /** See groupsTo. A single answer through the client is the client's own. */
    groups: (own: unknown): void => groupsTo(httpClient ?? groups?.hub, own, said),
    attach(bus: BaseBus): void { groups = joinGroups(bus, httpClient); },
    post<R>(json: string, body: () => unknown, headers: Record<string, string>, requestSignal: AbortSignal | undefined): Promise<HttpResponse<R>> {
      const config = { csrf, csrfCookieUrl, headers, timeout, retry: false as const, signal: requestSignal, onSessionExpired };
      return httpClient ? httpClient.post<R>(endpoint, body(), config) : _postJson<R>(endpoint, json, config);
    },
    /**
     * A 202 with a `Location` (RFC 9110 15.3.3): the work goes on, and the
     * answer is an `Accepted` whose `done` polls the monitor, its first wait
     * the 202's. `base` resolves a relative Location, as is without one. Any
     * other answer, a 202 without a Location included, is the result as read.
     */
    accepted(result: CommandResult, answerHeaders: unknown, base: string | undefined, cmd: Command): CommandResult {
      // One name read, no copy (_headerOf). The URL and the first wait are read
      // when `done` is: a 202 nobody follows costs neither.
      const location = result.ok ? _headerOf(answerHeaders, 'location') : undefined;
      if (!location) return result;
      return _okResult(new Accepted(() => follow(cmd, location, answerHeaders, base)));
    },
    dispose(): void {
      stop.abort();
      holds.clear();
    },
  };
}

/** What a status monitor answers: `{ state }` when the job is done, a problem when it failed, a 202 while it runs. */
type Monitor = { state?: unknown; problem?: ProblemDetails };

/**
 * The next poll's wait: the one an answer declares, read as any answer's
 * (`_declaredWait`: Retry-After, else RateLimit `t` with no quota left, else
 * X-RateLimit-Reset), else the interval. A poll inside a RateLimit window
 * exceeds the quota the draft asks a client to keep (-11, 7).
 */
const waitOf = (own: Record<string, string> | undefined, interval: Delay): Delay =>
  delayOption((own && _declaredWait(own)) ?? interval, interval);

// ---------------------------------------------------------------------------
// httpTransport
// ---------------------------------------------------------------------------

export type HttpTransportOptions = {
  /** Backend endpoint URL (e.g. '/api/vc') */
  endpoint: string;
  /**
   * CSRF token strategy:
   *   - `false` (default) - don't attach any CSRF token
   *   - `true` - read from DOM (meta tag, cookie, hidden input) and attach
   *     as the appropriate header. Works with any server-rendered framework
   *     that exposes a token via one of those three sources - Laravel Blade,
   *     Rails, Django, .NET MVC, custom stacks. Auto-refreshes on HTTP 419.
   *     An Inertia app on Laravel uses `true` too: with no meta tag it reads
   *     the XSRF-TOKEN cookie Laravel sets. The transport makes its own requests,
   *     which no Axios interceptor of the app touches.
   */
  csrf?: boolean;
  /**
   * URL to fetch on a CSRF-expiry response (HTTP 419) to obtain a fresh
   * token. The default targets the Laravel Sanctum SPA convention because
   * it's the most common 419-issuing backend; override for other frameworks
   * or set to '' to disable the refresh fetch.
   * Default: '/sanctum/csrf-cookie'.
   */
  csrfCookieUrl?: string;
  /** Additional headers merged into every request. A name matches in any case: its first spelling is kept and the last value wins (the Fetch Standard's "set"), so it goes out once. */
  headers?: Record<string, string>;
  /** Request timeout in ms. Default: 10_000 */
  timeout?: number;
  /** External AbortSignal (e.g. tied to component lifecycle) */
  signal?: AbortSignal;
  /**
   * Called when a 401 session-expired response is received.
   * A `session-expired` CustomEvent is also dispatched on `window`.
   */
  onSessionExpired?: (status: number) => void;
  /**
   * Called when the backend answers with a `{ redirect: '/path' }` field in
   * its JSON body. Useful for handing a navigation to Inertia's router so a
   * vapor-chamber dispatch can move the page:
   *
   *   onRedirect: (url) => router.visit(url)
   *
   * Either way the command fails as `transport:refused:redirect`, the url in
   * `error.context.url`.
   *
   * BODY FIELD ONLY, never a 3xx with `Location`: `fetch` defaults to
   * `redirect: 'follow'`, so the platform resolves a 3xx and hands the transport
   * the FINAL response. A backend
   * that wants this hook must say so in the body. Pinned by
   * `tests/transports-coverage.test.ts` ("does not call onRedirect for a
   * redirect STATUS without a body field").
   */
  onRedirect?: (url: string) => void;
  /**
   * Coalesce the commands sent within a window into one POST
   * (`{ commands: [...] }` answered by `{ results: [...] }`). Absent: one
   * request per command.
   */
  batch?: HttpBatchOptions;
  /**
   * Abort controller whose signal cancels all in-flight requests when the
   * owning scope/component is disposed. In Vapor components, create an
   * AbortController in setup and pass it here - call `.abort()` in
   * onScopeDispose to cancel orphaned requests automatically.
   *
   * @example
   * // In <script setup vapor>:
   * const ctrl = new AbortController();
   * onScopeDispose(() => ctrl.abort());
   * createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', scopeController: ctrl }) });
   */
  scopeController?: AbortController;
  /**
   * Custom HTTP client instance for advanced use cases (interceptors,
   * custom baseURL, etc). When provided, the transport uses `client.post()`
   * instead of the built-in `postCommand()`.
   *
   * @example
   * const http = createHttpClient({ baseURL: '/api' });
   * http.interceptors.request.use((c) => { c.headers = { ...c.headers, 'X-Tenant': '42' }; return c; });
   * createAsyncCommandBus({ transport: httpTransport({ endpoint: '/vc', httpClient: http }) });
   */
  httpClient?: HttpClient;
  /**
   * How a 202's status monitor is polled once its `Accepted`'s `done` is read
   * (src/accepted.ts). `interval`: the wait when an answer declares none, in
   * ms, default 1000. `maxWait`: then `done` is `transport:timeout:job`, in ms,
   * default 300_000. A poll goes through `httpClient` when given.
   */
  poll?: { interval?: number; maxWait?: number };
};

export type HttpBatchOptions = {
  /**
   * How long to hold the queue open before flushing.
   *   - `'microtask'` (default) - coalesce every command sent within the
   *     same JS tick (`queueMicrotask`). Zero added latency: a synchronous
   *     burst of dispatches (e.g. a `formSet` immediately followed by a
   *     `submit`) becomes one HTTP round trip.
   *   - a number (ms) - hold the queue open for a small window instead,
   *     catching dispatches from separate ticks (e.g. two quick, distinct
   *     user interactions) at the cost of that much added latency.
   */
  window?: 'microtask' | number;
};

/**
 * httpTransport - commands sent over fetch, as JSON.
 *
 * The backend receives `{ command, target, payload, meta? }`, with
 * `Accept: application/json, application/problem+json` and a keyed command's
 * `Idempotency-Key`, and answers
 * `{ state, stores? }`, `{ stores }` or `{ redirect }` on success, and a
 * non-2xx RFC 9457 problem on failure,
 * read as `remote:<condition of its status>:<code>` (docs/contract.md 4).
 *
 * Features: multi-source CSRF token reading (meta tag / cookie / hidden input),
 * automatic CSRF-expiry refresh on HTTP 419 (Laravel Sanctum convention by
 * default, configurable for other frameworks), session-expiry detection on
 * 401, request timeout, per-call AbortSignal. It sends each command once: the
 * async bus re-sends through it by the failure's condition, after a declared
 * Retry-After (docs/retry.md). After a 429 or 503 that declares a wait, it
 * sends no command for that action until the wait ends: each fails at once as
 * `transport:limited:held`, which the bus waits out (docs/retry.md, The hold).
 *
 * With `batch`, every command sent within the window goes as ONE POST:
 *
 *   { commands: [{ id, command, target, payload, meta?, headers? }, ...] }
 *
 * a keyed command's `Idempotency-Key` in its `headers`, matched back against:
 *
 *   { results: [{ id, status, headers, state, stores? }, { id, status, headers, redirect }, { id, status, headers, problem }, ...] }
 *
 * Each result carries the command's own `status` and `headers` (OData JSON
 * batch): a problem with no status reads the result's, and its
 * `Retry-After` sets the wait as a single response's does. Each dispatch
 * settles on its own result: the coalescing is invisible to the call site.
 *
 * @example
 * const bus = createAsyncCommandBus({
 *   transport: httpTransport({ endpoint: '/api/vc', csrf: true }),
 *   retry: { actionPolicies: { 'cart*': 'idempotent' } },
 * })
 * await bus.dispatch('cartAdd', product, { quantity: 2 })
 */
export function httpTransport(options: HttpTransportOptions): Transport {
  const http = httpSender(options);
  return { id: ID, localFallback: false, send: options.batch ? sendBatched(options, options.batch, http) : sendOne(options, http), dispose: http.dispose, attach: http.attach };
}

type HttpSender = ReturnType<typeof httpSender>;

// One request per command.
function sendOne(options: HttpTransportOptions, http: HttpSender): Transport['send'] {
  const { endpoint, headers = {}, onRedirect, httpClient } = options;
  const effectiveSignal = http.signal;
  const holds = http.holds;

  return async (cmd: Command): Promise<CommandResult> => {
    if (holds.size !== 0) {
      const held = whileHeld(holds, cmd.action);
      if (held) return held;
    }
    const envelope = envelopeOf(cmd);
    // Encoded here, so a command JSON cannot hold fails as transport:invalid:json
    // with nothing sent, never as a lost reply (tests/invalid-json.test.ts).
    const data = _encodeJson(envelope, endpoint, cmd.action);
    if (typeof data !== 'string') return _errResult(data);

    // Forward the idempotency key stamped by the `idempotent` plugin as an
    // `Idempotency-Key` header so the backend can reject duplicate writes - the
    // wire half of exactly-once. With neither it nor a plugin's
    // `meta.request` headers, the transport's own `headers` go as they are.
    const idemKey = cmd.meta?.idempotencyKey;
    const added = cmd.meta?.request?.headers;
    let reqHeaders = headers;
    if (idemKey || added) {
      reqHeaders = { ...headers, ...added };
      if (idemKey) reqHeaders['Idempotency-Key'] = keyHeader(idemKey);
    }

    // Merge the transport's effectiveSignal with per-dispatch cmd.signal. The
    // dispatch-time signal (from `bus.dispatch(..., { signal })`) is
    // auto-propagated to the HTTP request - consumers don't need to wire it
    // through the transport's options. Detached when the request settles.
    const combined = cmd.signal && effectiveSignal ? _combineSignals(effectiveSignal, cmd.signal) : undefined;
    const perCallSignal = combined?.signal ?? cmd.signal ?? effectiveSignal;

    try {
      const res = await http.post<BackendResponse>(data, () => envelope, reqHeaders, perCallSignal);

      // Only an app's own client returns a non-2xx (ours throws it): its names in any case.
      if (!res.ok) return holding(holds, cmd.action, _errResult(_answered(res.status, res.data, _headersOf(res.headers))));
      if (cmd.meta) cmd.meta.response = responseOf(res);
      // Through the client, the client read its groups. Without one, the bus's hub.
      if (!httpClient) http.groups(res.headers);
      // The envelope is an object, or nothing (no state).
      if (res.data !== null && res.data !== undefined && (typeof res.data !== 'object' || Array.isArray(res.data))) {
        return _errResult(remoteFail('unexpected:json', `The reply for "${cmd.action}" is not the JSON envelope.`, { action: cmd.action }));
      }
      const result = readAnswer((res.data ?? {}) as BackendResponse, cmd, res.headers, onRedirect);
      return res.status === 202 ? http.accepted(result, res.headers, res.url, cmd) : result;
    } catch (e) {
      return holding(holds, cmd.action, unanswered(e, cmd.action, perCallSignal));
    } finally {
      combined?.detach();
    }
  };
}

// `{ id } & BackendResponse`, so the two shapes cannot drift. A WS frame is
// one too. `status` and `headers`: the result's own response status and
// headers, as an OData JSON batch response carries them; it has no HTTP
// response of its own.
type BatchedResult = { id: string; status?: number; headers?: Record<string, string> } & BackendResponse;
/** A WebSocket push: a frame with no `id`, the SSE event's name and data (docs/contract.md 4). */
type PushFrame = { event?: unknown; data?: unknown };
type BatchResponse = { results?: BatchedResult[] };

// `data`: the command's envelope as JSON, encoded at dispatch. `leave`: set at
// the flush for a command that carries a signal; its abort counts it out of the request.
type QueuedBatchEntry = { id: string; cmd: Command; data: string; resolve: (result: CommandResult) => void; leave?: () => void };

// The commands of one window, one request.
function sendBatched(options: HttpTransportOptions, batchOptions: HttpBatchOptions, http: HttpSender): Transport['send'] {
  const { endpoint, headers = {}, onRedirect, httpClient } = options;
  const effectiveSignal = http.signal;
  const holds = http.holds;
  // A number window by the timer rule; 'microtask', a missing or a NaN window
  // is the default, the microtask (tests/timer-delays.test.ts).
  const flushMs = delayOption(batchOptions.window ?? 'microtask', undefined);

  let queue: QueuedBatchEntry[] = [];
  let scheduled = false;
  let seq = 0;

  function scheduleFlush(): void {
    if (scheduled) return;
    scheduled = true;
    if (flushMs === undefined) queueMicrotask(flush);
    else setTimeout(flush, flushMs);
  }

  async function flush(): Promise<void> {
    const batch = queue;
    queue = [];
    scheduled = false;
    // Every command aborted while it waited for the window: nothing to send.
    if (batch.length === 0) return;

    // A command that carries a signal settles on its abort; the request is
    // cancelled once every command in it has aborted (the HTTP client's rule).
    // With the transport's signal too, either one cancels; detached when it settles.
    let requestSignal = effectiveSignal;
    let combined: CombinedSignal | undefined;
    if (batch.some((entry) => entry.cmd.signal)) {
      const ctrl = new AbortController();
      let live = batch.length;
      for (const entry of batch) if (entry.cmd.signal) entry.leave = () => { if (--live === 0) ctrl.abort(); };
      if (effectiveSignal) combined = _combineSignals(effectiveSignal, ctrl.signal);
      requestSignal = combined ? combined.signal : ctrl.signal;
    }

    // One request: its commands' `meta.request` headers merged in queue order.
    let batchHeaders = headers;
    for (const { cmd } of batch) {
      const added = cmd.meta?.request?.headers;
      if (added) batchHeaders = { ...batchHeaders, ...added };
    }

    try {
      const res = await http.post<BatchResponse>(
        `{"commands":[${batch.map((entry) => entry.data).join(',')}]}`,
        () => ({ commands: batch.map(({ id, cmd }) => multiplexedOf(cmd, id)) }),
        batchHeaders,
        requestSignal,
      );

      if (!res.ok) {
        const err = _answered(res.status, res.data, _headersOf(res.headers));
        for (const entry of batch) entry.resolve(holding(holds, entry.cmd.action, _errResult(err)));
        return;
      }

      const response = responseOf(res);
      for (const entry of batch) if (entry.cmd.meta) entry.cmd.meta.response = response;
      if (!httpClient) http.groups(res.headers);
      const byId = new Map((res.data?.results ?? []).map((r) => [r.id, r]));
      // `onRedirect` navigates, so it fires once per batch - two navigations
      // in one tick race. Every redirected command still fails on its own,
      // carrying its own url.
      let navigated = false;
      const navigate = onRedirect && ((url: string) => {
        if (!navigated) {
          navigated = true;
          onRedirect(url);
        }
      });
      for (const entry of batch) {
        const r = byId.get(entry.id);
        if (!r) {
          entry.resolve(_errResult(transportError('lost:result', `The batch answer is missing a result for "${entry.cmd.action}".`, entry.cmd.action, { id: entry.id })));
          continue;
        }
        // A batched result's own 202 (OData JSON batch), its Location against the batch's response.
        const result = readAnswer(r, entry.cmd, r.headers, navigate, r.status);
        if (result.ok) http.groups(r.headers);
        entry.resolve(r.status === 202 ? http.accepted(result, r.headers, res.url, entry.cmd) : result.ok ? result : holding(holds, entry.cmd.action, result));
      }
    } catch (e) {
      for (const entry of batch) entry.resolve(holding(holds, entry.cmd.action, unanswered(e, entry.cmd.action, effectiveSignal)));
    } finally {
      combined?.detach();
    }
  }

  return (cmd: Command): Promise<CommandResult> => {
    if (cmd.signal?.aborted) return Promise.resolve(abortedResult(cmd.action, cmd.signal));
    // A held command never joins a window: the others in it are sent.
    if (holds.size !== 0) {
      const held = whileHeld(holds, cmd.action);
      if (held) return Promise.resolve(held);
    }

    const id = `${Date.now()}-${++seq}`;
    // Encoded now, so a command JSON cannot hold fails alone, before it is
    // queued, and never fails the batch it would have joined.
    const data = encodeMultiplexed(cmd, id, endpoint);
    if (typeof data !== 'string') return Promise.resolve(_errResult(data));

    return new Promise<CommandResult>((resolve) => {
      const entry: QueuedBatchEntry = { id, cmd, data, resolve };
      const signal = cmd.signal;
      if (signal) {
        // Before the flush the command leaves the queue, never sent; after,
        // it settles now and counts itself out of the request.
        const onAbort = (): void => {
          const at = queue.indexOf(entry);
          if (at !== -1) queue.splice(at, 1);
          else entry.leave?.();
          resolve(abortedResult(cmd.action, signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.resolve = (r) => { signal.removeEventListener('abort', onAbort); resolve(r); };
      }
      queue.push(entry);
      scheduleFlush();
    });
  };
}

// ---------------------------------------------------------------------------
// wsTransport
// ---------------------------------------------------------------------------

export type WsTransportOptions = {
  /** WebSocket server URL */
  url: string;
  /** Automatically reconnect on disconnect. Default: true */
  reconnect?: boolean;
  /** Base reconnect delay in ms. Default: 1000 */
  reconnectDelay?: number;
  /** Max reconnect attempts. Default: 10 */
  maxReconnects?: number;
  /** Called when the connection is established */
  onConnect?: () => void;
  /** Called when the connection is lost */
  onDisconnect?: (event: CloseEvent) => void;
  /** Called on WebSocket error */
  onError?: (event: Event) => void;
  /**
   * Per-message response timeout in ms, from the send. Also the longest a
   * command waits in the transport's own outbox while the socket is down.
   * Default: 10_000
   */
  timeout?: number;
  /**
   * The app's client: a frame's own `Cache-Group-Invalidation` (RFC 9875) drops
   * its reads in those groups and reaches the router (`invalidateGroups`).
   * Without it nothing acts on the groups. tests/cache-groups.test.ts.
   */
  httpClient?: HttpClient;
};

type PendingRequest = {
  cmd: Command;
  action: string;
  resolve: (result: CommandResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

/**
 * wsTransport - commands over one WebSocket, with reconnect and an outbox.
 *
 * Commands are sent as JSON frames over a persistent WebSocket connection.
 * While the socket is not open, a command is held in the transport's own
 * outbox (`outbox`, in memory: at most 100, each for at most `timeout`) and
 * answers an `Accepted` whose `done` settles with the reply once sent. An
 * app outbox (`createAsyncCommandBus({ outbox })`) that covers the action
 * holds it instead, durably when it has storage. `disconnect()`, and a close
 * with no reconnect left, settle the transport's own held callers.
 * A frame with no `id`, `{ event, data }`, is the server's push: the store
 * states under `data.stores` written, then the event emitted on the bus that
 * declares this transport, never dispatched (docs/contract.md 4).
 *
 * @example
 * const ws = wsTransport({ url: 'wss://api.example.com/vc' })
 * const bus = createAsyncCommandBus({ transport: ws })
 * ws.connect()
 */
export function wsTransport(options: WsTransportOptions): Transport & {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  /** Reactive connection state - bindable in Vapor/VDOM templates without polling. */
  connected: Signal<boolean>;
  /** The commands held while the socket is down: `pending`, `rejected`, `flush()`, `clear()`. */
  outbox: Outbox;
} {
  const {
    url,
    reconnect = true,
    reconnectDelay: rawReconnectDelay = 1000,
    maxReconnects: rawMaxReconnects = 10,
    onConnect,
    onDisconnect,
    onError,
    timeout: rawWsTimeout = 10_000,
    httpClient,
  } = options;
  const said = { warned: false };

  // A refusal gate and a delay, both defeated by the same bad number.
  // `reconnectCount >= maxReconnects` never refuses, so the socket retries
  // forever; `reconnectDelay * reconnectCount` is then NaN, which setTimeout
  // treats as 0, so "forever" is also "as fast as the event loop allows" -
  // a hot loop against the server it is meant to be backing off from. The
  // reply timeout is a delay too: a timer fires at once on NaN or past
  // MAX_TIMEOUT_MS, which failed every command after 1 ms
  // (tests/nan-options.test.ts).
  const maxReconnects = countOption(rawMaxReconnects, 10);
  const reconnectDelay = delayOption(rawReconnectDelay, 1000);
  const wsTimeout = delayOption(rawWsTimeout, 10_000);

  let ws: WebSocket | null = null;
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  // Reactive signal for connection state - usable in Vapor/VDOM templates
  const connected = signal(false);

  const pending = new Map<string, PendingRequest>();
  const holds: Holds = new Map();
  // The bus that declares this transport (Transport.attach): where its pushes go.
  let bus: BaseBus | null = null;
  // Its groups (joinGroups): where a frame's groups go without a client.
  let groups: BusGroups | undefined;

  function genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Settle every in-flight request immediately with a failure result, and the
   * callers the transport's own outbox holds. Called on terminal teardown - an
   * explicit `disconnect()`, or a socket close with no reconnect pending - so a
   * caller awaiting a response doesn't hang until its per-request timeout fires.
   * Uses `resolve({ ok:false })`, matching every other settle path: the bus
   * never rejects a dispatch promise; failures are `CommandResult` values.
   */
  function failAllPending(reason: string): void {
    void outbox.clear();
    if (pending.size === 0) return;
    const reqs = Array.from(pending.values());
    pending.clear();
    for (const req of reqs) {
      req.resolve(_errResult(transportError('lost:reply', reason)));
    }
  }

  function connect(): void {
    if (typeof WebSocket === 'undefined') return;
    // Already connecting/connected - a second socket would orphan the first
    // with its handlers still live. Manual connect() also supersedes any
    // pending reconnect timer.
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    intentionalClose = false;

    const socket = new WebSocket(url);
    ws = socket;

    ws.onopen = () => {
      reconnectCount = 0;
      // Here, in onclose and in disconnect(): the bookkeeping is in the
      // `finally`, so a sync subscriber of `connected` that throws cannot skip
      // it (pinned by tests/ws-transport-throwing-subscriber.test.ts).
      try {
        connected.value = true;
      } finally {
        // What waits goes out: the transport's own held commands, and an
        // app outbox's that cover this transport's actions.
        outbox[_OUTBOX].opened();
        if (bus !== null) _opened(bus);
        onConnect?.();
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as BatchedResult & PushFrame;
        // A frame with no `id` answers no command: it is the server's push.
        if (data.id === undefined) {
          if (bus !== null && typeof data.event === 'string') _pushed(bus, data.event, data.data);
          return;
        }
        const req = pending.get(data.id);
        if (req) {
          clearTimeout(req.timeoutId);
          pending.delete(data.id);
          const result = answerOf(data, req.cmd, data.headers, data.status);
          if (result.ok) groupsTo(httpClient ?? groups?.hub, data.headers, said);
          req.resolve(result.ok ? result : holding(holds, req.action, result));
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (event) => {
      // A socket already replaced (`disconnect()` then `connect()`) closing
      // late is not the transport's close: the transport's state is the new
      // socket's. tests/ws-transport-stale-close.test.ts.
      if (ws !== null && ws !== socket) {
        onDisconnect?.(event);
        return;
      }
      try {
        connected.value = false;
      } finally {
        // This socket is dead - drop the reference (unless a newer socket already
        // replaced it) so the connect() liveness guard lets the next attempt through.
        if (ws === socket) ws = null;
        onDisconnect?.(event);
        // Reconnect if we still can; otherwise this close is terminal - fail any
        // in-flight requests now rather than leaving them to hang until timeout.
        if (!intentionalClose && reconnect && reconnectCount < maxReconnects) {
          reconnectTimer = setTimeout(connect, delayOption(reconnectDelay * ++reconnectCount, 0));
        } else {
          failAllPending('WebSocket connection closed before response');
        }
      }
    };

    ws.onerror = (event) => {
      onError?.(event);
    };
  }

  function disconnect(): void {
    intentionalClose = true;
    try {
      connected.value = false;
    } finally {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Fail any in-flight requests immediately - the caller explicitly tore the
      // connection down; don't make them wait out the per-request timeout.
      failAllPending('WebSocket disconnected');
      ws?.close();
      ws = null;
    }
  }

  function isConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  const sendCommand = async (cmd: Command): Promise<CommandResult> => {
    // Pre-flight abort - don't enqueue if signal is already tripped.
    if (cmd.signal?.aborted) return abortedResult(cmd.action, cmd.signal);
    if (holds.size !== 0) {
      const held = whileHeld(holds, cmd.action);
      if (held) return held;
    }

    return new Promise<CommandResult>((resolve) => {
      const id = genId();
      // Encoded before anything is armed: an envelope JSON cannot hold (a
      // BigInt in the payload) fails this dispatch alone, as
      // transport:invalid:json (tests/ws-transport-unencodable-queued.test.ts,
      // tests/invalid-json.test.ts).
      const data = encodeMultiplexed(cmd, id, url);
      if (typeof data !== 'string') {
        resolve(_errResult(data));
        return;
      }
      // Not open: refused unsent, before anything is armed. Only a replay or
      // a send racing a close reaches here; the outbox holds the rest.
      const socket = ws;
      if (socket === null || socket.readyState !== WebSocket.OPEN) {
        resolve(_errResult(transportError('limited:socket', `The socket is not open: "${cmd.action}" was not sent.`, cmd.action)));
        return;
      }
      let abortHandler: (() => void) | null = null;

      // Naturally idempotent - no `settled` flag needed: the first call
      // detaches every other settle source (timer cleared, `pending` entry
      // deleted, abort listener removed), and each teardown line plus
      // `resolve()` itself is a no-op when repeated.
      const settle = (result: CommandResult): void => {
        clearTimeout(timeoutId);
        pending.delete(id);
        if (abortHandler && cmd.signal) {
          cmd.signal.removeEventListener('abort', abortHandler);
        }
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        settle(_errResult(transportError('timeout:reply', `WS request "${cmd.action}" timed out after ${wsTimeout}ms`, cmd.action, { timeout: wsTimeout })));
      }, wsTimeout);

      pending.set(id, {
        cmd,
        action: cmd.action,
        resolve: settle,
        timeoutId,
      });

      // Mid-flight abort - drop the pending request and resolve with abort error.
      // The server may still process the command; this only cancels the client-side
      // wait. WS transports don't have per-message cancellation in the protocol.
      if (cmd.signal) {
        abortHandler = () => settle(abortedResult(cmd.action, cmd.signal!));
        cmd.signal.addEventListener('abort', abortHandler);
      }

      socket.send(data);
    });
  };

  // The transport's own outbox, in this tab's memory: it holds a send while the socket is not open,
  // with the released bound (100) and expiry (the reply timeout). Its replays
  // go to `sendCommand` itself, at the work step of the bus that declares it.
  const outbox = createOutbox({ storage: null, maxSize: 100, ttl: wsTimeout, isOnline: isConnected });
  const own = outbox[_OUTBOX].adapt('*', { id: ID, localFallback: false, send: sendCommand });

  // Disposing the bus closes the socket, as disconnect() does, and forgets the
  // server's limits. A disconnect() alone keeps them: the server is the same.
  const dispose = (): void => {
    holds.clear();
    disconnect();
    outbox.dispose();
  };
  const attach = (b: BaseBus): void => {
    bus = b;
    groups = joinGroups(b, httpClient);
    // Off an async bus (the test bus) a replay is this transport's own send.
    const direct: SendAt = (_unwrap, action, target, payload, key) => sendCommand(_replayOf(action, target, payload, key));
    if (!_outboxOn(b, outbox[_OUTBOX])) outbox[_OUTBOX].attach(direct);
  };
  return { id: ID, localFallback: false, send: own.send, dispose, attach, connect, disconnect, isConnected, connected, outbox };
}

// ---------------------------------------------------------------------------
// createSseBridge
// ---------------------------------------------------------------------------

export type SseBridgeOptions = {
  /** SSE endpoint URL */
  url: string;
  /**
   * Called for each server-sent event, in place of the push. It may
   * dispatch a command, which then runs every plugin and the action's
   * transport.
   *
   * @example
   * createSseBridge({
   *   url: '/api/vc/events',
   *   onEvent: (event, bus) => {
   *     const data = JSON.parse(event.data)
   *     bus.dispatch(data.command, data.target, data.payload)
   *   }
   * })
   */
  onEvent?: (event: MessageEvent, bus: BaseBus) => void;
  /**
   * The event types read, each the `event:` line a server writes. Default:
   * an event with none (`message`). Laravel's `eventStream()` names every
   * event, `update` unless a `StreamedEvent` names it.
   */
  events?: string[];
  /** Send credentials with the SSE request. Default: false */
  withCredentials?: boolean;
  /** Reconnect automatically (EventSource does this natively). Default: true */
  reconnect?: boolean;
};

/**
 * createSseBridge - server-sent events bridge for unidirectional server push.
 *
 * SSE is receive-only: the server pushes events to the client. Without
 * `onEvent`, each event is a push: its `data` read as JSON, each store state
 * under `stores` written by that store, then the event emitted on the bus by
 * its type, never dispatched (docs/contract.md 4). Data that is not JSON,
 * such as the `</stream>` that ends Laravel's event stream, is ignored.
 *
 * @example
 * const sse = createSseBridge({ url: '/api/vc/stream', events: ['update'] })
 * // event: update, data: {"stores":{"cart":{...}}} -> the cart store's state
 * sse.install(bus)
 *
 * // Later, on component unmount:
 * sse.dispose()
 */
export function createSseBridge(options: SseBridgeOptions): {
  install(bus: BaseBus): void;
  dispose(): void;
  isConnected(): boolean;
} {
  const { url, onEvent, events, withCredentials = false, reconnect = true } = options;

  let source: EventSource | null = null;

  function install(bus: BaseBus): void {
    if (typeof EventSource === 'undefined') return;
    // A second install replaces the stream: the first one, left open, was
    // out of dispose()'s reach and kept delivering to its bus.
    dispose();
    source = new EventSource(url, { withCredentials });

    const read = (event: MessageEvent): void => {
      if (onEvent === undefined) {
        let data: unknown;
        try { data = JSON.parse(event.data as string); } catch { return; }
        _pushed(bus, event.type, data);
        return;
      }
      try {
        onEvent(event, bus);
      } catch (e) {
        _report('error', 'transport:failed:onEvent', `the SSE bridge's onEvent threw on "${event.type}"`, e, { event: event.type });
      }
    };
    if (events === undefined) source.onmessage = read;
    else for (const type of events) source.addEventListener(type, read);

    source.onerror = () => {
      // EventSource reconnects on its own, so `reconnect: true` needs no code.
      // Closing the stream is the only way to stop EventSource retrying, so
      // that is what `reconnect: false` means.
      if (!reconnect) dispose();
    };
  }

  function dispose(): void {
    source?.close();
    source = null;
  }

  function isConnected(): boolean {
    return source !== null && source.readyState === EventSource.OPEN;
  }

  return { install, dispose, isConnected };
}

// ---------------------------------------------------------------------------
// createEchoBridge - Laravel Echo / Reverb realtime -> bus
// ---------------------------------------------------------------------------

export type EchoChannelType = 'public' | 'private' | 'presence';

export type EchoSubscription = {
  /** Channel name. Echo adds the `private-` / `presence-` prefix itself. */
  name: string;
  /** Channel kind. Default: 'public'. */
  type?: EchoChannelType;
  /** Server-broadcast event names to listen for on this channel. */
  events: string[];
};

export type EchoBridgeOptions = {
  /**
   * A configured laravel-echo instance (or any object exposing
   * `channel(name)` / `private(name)` / `join(name)` and `leave(name)`). The
   * bridge takes your app's Echo so it never imports laravel-echo itself -
   * keeping vapor-chamber backend-agnostic and the dependency out of the bundle.
   */
  echo: any;
  /** Channels + events to subscribe on install. */
  channels: EchoSubscription[];
  /**
   * Map an incoming broadcast to the bus. Default: a push, each store state
   * under the payload's `stores` written by that store, then
   * `bus.emit(event, payload)` so `on(event)` listeners fire. Provide this to
   * dispatch a command instead, or to rename/drop events.
   */
  onBroadcast?: (info: { channel: string; event: string; payload: any }, bus: BaseBus) => void;
  /**
   * For presence channels, also emit membership changes as bus events
   * `"<name>:here"`, `"<name>:joining"`, `"<name>:leaving"`. Default: true.
   */
  presenceEvents?: boolean;
};

/**
 * createEchoBridge - wire Laravel Echo / Reverb realtime channels to the bus.
 *
 * Protocol-aware over the generic WS transport: subscribes public / private /
 * presence channels and routes each broadcast to `bus.emit()`, after writing
 * the store states its payload declares under `stores` (or a command via
 * `onBroadcast`). Presence membership (`here` / `joining` / `leaving`) is emitted
 * too. Receive-only by design - outbound commands still go through the HTTP
 * transport. Pass your own Echo instance; the bridge never imports laravel-echo, so
 * non-Laravel consumers don't pay for it.
 *
 * @example
 * import Echo from 'laravel-echo';
 * const echo = new Echo({ broadcaster: 'reverb', ... });
 * const realtime = createEchoBridge({
 *   echo,
 *   channels: [
 *     { name: 'orders', type: 'private', events: ['OrderShipped', 'OrderCancelled'] },
 *     { name: 'lobby',  type: 'presence', events: ['MessagePosted'] },
 *   ],
 * });
 * realtime.install(bus);   // OrderShipped -> bus.emit('OrderShipped', payload)
 * // on teardown:
 * realtime.dispose();
 */
export function createEchoBridge(options: EchoBridgeOptions): {
  install(bus: BaseBus): void;
  dispose(): void;
} {
  const { echo, channels, onBroadcast, presenceEvents = true } = options;
  const joined: string[] = [];

  function install(bus: BaseBus): void {
    for (const sub of channels) {
      const type = sub.type ?? 'public';
      const ch = type === 'private' ? echo.private(sub.name)
               : type === 'presence' ? echo.join(sub.name)
               : echo.channel(sub.name);
      joined.push(sub.name);

      for (const event of sub.events) {
        ch.listen(event, (payload: any) => {
          try {
            if (onBroadcast) onBroadcast({ channel: sub.name, event, payload }, bus);
            else _pushed(bus, event, payload);
          } catch (e) {
            _report('error', 'transport:failed:onBroadcast', `the Echo bridge's broadcast handler threw on "${event}"`, e, { channel: sub.name, event });
          }
        });
      }

      if (type === 'presence' && presenceEvents) {
        ch.here?.((members: any) => bus.emit(`${sub.name}:here`, members));
        ch.joining?.((member: any) => bus.emit(`${sub.name}:joining`, member));
        ch.leaving?.((member: any) => bus.emit(`${sub.name}:leaving`, member));
      }
    }
  }

  function dispose(): void {
    for (const name of joined) {
      try { echo.leave(name); } catch { /* echo may already be torn down */ }
    }
    joined.length = 0;
  }

  return { install, dispose };
}
