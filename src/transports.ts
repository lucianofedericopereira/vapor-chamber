/**
 * vapor-chamber - Transport plugins
 *
 * Transports are AsyncPlugin factories that forward commands to a backend.
 * Use with createAsyncCommandBus() for full async dispatch support.
 */

import type { Command, CommandResult, AsyncPlugin, BaseBus, BusError, FailCode } from './command-bus';
import { MAX_TIMEOUT_MS, countOption } from './bounds';
import { DEV } from './dev';
import { matchesPattern, abortedResult, conditionOfStatus, _failures, _okResult, _errResult } from './command-bus';
import { _parseRetryAfter, postCommand } from './http';
import type { ProblemDetails } from './http-errors';
import type { HttpClient, HttpError } from './http';
import { signal } from './signal';
import type { Signal } from './signal';

/**
 * What each bridge declares: it answers a command itself, over a wire, so the
 * async bus's retry re-sends through it (docs/plan-shape.md 4) and the plugins
 * outside see one dispatch.
 */
const TRANSPORT = { transport: true } as const;

// ---------------------------------------------------------------------------
// Shared protocol types
// ---------------------------------------------------------------------------

/** The JSON shape sent to the backend endpoint */
export type CommandEnvelope = {
  command: string;
  target: any;
  payload?: any;
};

/**
 * A command's answer, the same on every wire (docs/plan-failures-and-contract.md
 * 4.4): `state` on success, `redirect` for a navigation, `problem` on failure,
 * one of the three. A batched result and a WebSocket frame carry `id` beside
 * it; a single command's failure is its non-2xx response's body.
 */
export type BackendResponse = {
  state?: unknown;
  /** A navigation the backend hands back instead of a result - see `onRedirect`. */
  redirect?: string;
  problem?: ProblemDetails;
};



// The transport's own failures, and a backend's: each through its own `fail`,
// so neither can speak as the other (plan 4.5).
const transportFail = _failures('transport');
const transportError = (code: FailCode, message: string, action?: string, context?: Record<string, unknown>): BusError =>
  transportFail(code, message, { action, context });
const remoteFail = _failures('remote');

/**
 * The failure a backend declared: `remote:<condition>:<code>`, the condition
 * from the problem's own `status` (else the response's), `detail` the message,
 * the rest `context`. `retryIn` is the response's `Retry-After` (RFC 9110),
 * never a body member: it is set after the spread, so a body cannot supply it.
 */
function remoteProblem(p: ProblemDetails, status?: number, retryIn?: number): BusError {
  const s = typeof p.status === 'number' ? p.status : status;
  const { status: _status, code, detail, ...params } = p;
  return remoteFail(
    `${s === undefined ? 'unknown' : conditionOfStatus(s)}:${code ?? 'problem'}` as FailCode,
    detail ?? (s === undefined ? 'The backend answered with no status.' : `HTTP ${s}`),
    { context: { ...params, status: s, code, retryIn } },
  );
}

/** A non-2xx: its problem, or, for a body that is not one, the status alone. */
function answered(status: number, data: unknown, headers?: Record<string, string>): BusError {
  const retryIn = _parseRetryAfter(headers?.['retry-after']);
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? remoteProblem(data as ProblemDetails, status, retryIn)
    : remoteFail(`${conditionOfStatus(status)}:http` as FailCode, `HTTP ${status}`, { context: { status, retryIn } });
}

/**
 * Why a request produced no answer: the backend's non-2xx (the HTTP client
 * throws it carrying the response), a timeout, the caller's abort, or no
 * response at all. `lost` means the outcome is unknown.
 */
function unanswered(e: unknown, action: string, signal?: AbortSignal): CommandResult {
  const err = e as HttpError;
  // The HttpClient contract: a failure carries its `response`, status included.
  if (err.response) return _errResult(answered(err.response.status, err.response.data, err.response.headers));
  if (err.name === 'TimeoutError') return _errResult(transportError('timeout:reply', err.message, action));
  if (err.name === 'AbortError') return abortedResult(action, signal);
  return _errResult(transportFail('lost:reply', `No response for "${action}".`, { action, cause: err }));
}

/** A redirect the backend answered with: the command fails, carrying the url. */
const redirected = (url: string, action: string, handled: boolean): BusError =>
  transportError('refused:redirect', `Redirected to ${url}.${DEV && !handled ? ' No onRedirect handler is configured.' : ''}`, action, { url });

/**
 * An answer, by contract: a `problem` is the failure, a `redirect` a
 * navigation, anything else the success, its `state` the value (absent when
 * the handler returned nothing: JSON drops `undefined`).
 */
function answerOf(r: BackendResponse, action: string): CommandResult {
  if (r.problem) return _errResult(remoteProblem(r.problem));
  if (typeof r.redirect === 'string') return _errResult(redirected(r.redirect, action, false));
  return _okResult(r.state);
}

// ---------------------------------------------------------------------------
// createHttpBridge
// ---------------------------------------------------------------------------

export type HttpBridgeOptions = {
  /** Backend endpoint URL (e.g. '/api/vc') */
  endpoint: string;
  /**
   * CSRF token strategy:
   *   - `false` (default) - don't attach any CSRF token
   *   - `true` - read from DOM (meta tag, cookie, hidden input) and attach
   *     as the appropriate header. Works with any server-rendered framework
   *     that exposes a token via one of those three sources - Laravel Blade,
   *     Rails, Django, .NET MVC, custom stacks. Auto-refreshes on HTTP 419.
   *   - `'inertia'` - defer token management to Inertia's Axios instance.
   *     The bridge will skip its own CSRF reading and rely on the consumer's
   *     `@inertiajs/inertia` axios setup to inject the token. Use this when
   *     vapor-chamber dispatches share an HTTP layer with Inertia routes.
   */
  csrf?: boolean | 'inertia';
  /**
   * URL to fetch on a CSRF-expiry response (HTTP 419) to obtain a fresh
   * token. The default targets the Laravel Sanctum SPA convention because
   * it's the most common 419-issuing backend; override for other frameworks
   * or set to '' to disable the refresh fetch.
   * Default: '/sanctum/csrf-cookie'.
   */
  csrfCookieUrl?: string;
  /** Additional headers merged into every request */
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
   * `redirect: 'follow'`, so the platform resolves a 3xx and hands the bridge
   * the FINAL response. A backend
   * that wants this hook must say so in the body. Pinned by
   * `tests/transports-coverage.test.ts` ("does not call onRedirect for a
   * redirect STATUS without a body field").
   */
  onRedirect?: (url: string) => void;
  /**
   * Which actions to forward. Glob patterns supported: '*', 'cart*'.
   * Default: all actions.
   */
  actions?: string[];
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
   * bus.use(createHttpBridge({ endpoint: '/api/vc', scopeController: ctrl }));
   */
  scopeController?: AbortController;
  /**
   * Custom HTTP client instance for advanced use cases (interceptors,
   * custom baseURL, etc). When provided, the bridge uses `client.post()`
   * instead of the built-in `postCommand()`.
   *
   * @example
   * const http = createHttpClient({ baseURL: '/api' });
   * http.interceptors.request.use((c) => { c.headers = { ...c.headers, 'X-Tenant': '42' }; return c; });
   * bus.use(createHttpBridge({ endpoint: '/vc', httpClient: http }));
   */
  httpClient?: HttpClient;
};


/**
 * createHttpBridge - fetch-based transport plugin.
 *
 * Intercepts matching commands and forwards them to the backend as JSON.
 * The backend receives `{ command, target, payload }` and answers `{ state }`
 * (or `{ redirect }`) on success, and a non-2xx RFC 9457 problem on failure,
 * read as `remote:<condition of its status>:<code>` (docs/plan-failures-and-
 * contract.md 4.4).
 *
 * Features: multi-source CSRF token reading (meta tag / cookie / hidden input),
 * automatic CSRF-expiry refresh on HTTP 419 (Laravel Sanctum convention by
 * default, configurable for other frameworks), session-expiry detection on
 * 401, request timeout, per-call AbortSignal. It sends each command once and
 * declares `transport: true`: the async bus re-sends through it by the
 * failure's condition, after a declared Retry-After (docs/plan-shape.md 4).
 *
 * @example
 * const bus = createAsyncCommandBus({ retry: { actions: { 'cart*': 'idempotent' } } })
 * bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))
 *
 * await bus.dispatch('cartAdd', product, { quantity: 2 })
 */
export function createHttpBridge(options: HttpBridgeOptions): AsyncPlugin {
  const { endpoint, actions, csrf = false, csrfCookieUrl, headers = {}, timeout = 10_000, signal, onSessionExpired, onRedirect, scopeController, httpClient } = options;
  // `csrf: 'inertia'` means: don't read CSRF from the DOM ourselves -
  // Inertia's Axios already injects the token. The HTTP layer shape just
  // needs to know "skip CSRF", same as `csrf: false`. Inertia handles it
  // upstream via its own request interceptor.
  const csrfFlag = csrf === 'inertia' ? false : csrf;
  // Merge external signal + scope controller signal for automatic cancellation
  const effectiveSignal = scopeController && signal
    ? (typeof AbortSignal.any === 'function'
        ? AbortSignal.any([signal, scopeController.signal])
        : signal) // fallback: prefer user signal if AbortSignal.any unavailable
    : scopeController?.signal ?? signal;

  return Object.assign(async (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => {
    if (actions?.length && !actions.some(p => matchesPattern(p, cmd.action))) return next();

    const envelope: CommandEnvelope = { command: cmd.action, target: cmd.target, payload: cmd.payload };

    // Forward the idempotency key stamped by the `idempotent` plugin as an
    // `Idempotency-Key` header so the backend can reject duplicate writes - the
    // wire half of exactly-once. No-op (same `headers` ref) when unset.
    const idemKey = cmd.meta?.idempotencyKey;
    // A Structured Field String, as the draft requires (RFC 9651): quoted and
    // printable ASCII. Percent-encoding (UTF-8) yields only unreserved ASCII and
    // %XX, never `"` or `\`, so quoting is all it needs; it is reversible, so no
    // two keys collide, and any backend recovers the exact key (rawurldecode).
    // Raw, a target outside Latin-1 made a value Headers refuses and the
    // request never left. A malformed key (a lone surrogate) makes this throw,
    // which the bus reports as <plugin>:failed:plugin. tests/idempotency-header.test.ts.
    const reqHeaders = idemKey ? { ...headers, 'Idempotency-Key': `"${encodeURIComponent(idemKey)}"` } : headers;

    // Merge bridge-level effectiveSignal with per-dispatch cmd.signal. The
    // dispatch-time signal (from `bus.dispatch(..., { signal })`) is
    // auto-propagated to the HTTP request - consumers don't need to wire it
    // through the bridge options.
    const perCallSignal = cmd.signal && effectiveSignal
      ? (typeof AbortSignal.any === 'function'
          ? AbortSignal.any([effectiveSignal, cmd.signal])
          : cmd.signal) // fallback: prefer the per-dispatch signal
      : (cmd.signal ?? effectiveSignal);

    try {
      const res = httpClient
        ? await httpClient.post<BackendResponse>(endpoint, envelope, {
            csrf: csrfFlag, csrfCookieUrl, headers: reqHeaders, timeout, retry: 0, signal: perCallSignal, onSessionExpired,
          })
        : await postCommand<BackendResponse>(endpoint, envelope, {
            csrf: csrfFlag, csrfCookieUrl, headers: reqHeaders, timeout, retry: 0, signal: perCallSignal, onSessionExpired,
          });

      if (!res.ok) return _errResult(answered(res.status, res.data, res.headers));
      const d = (res.data ?? {}) as BackendResponse;
      // A redirect is a body member (a browser's fetch cannot read a 3xx's
      // Location): handed to onRedirect (typically Inertia's `router.visit`),
      // and the command fails, carrying the url.
      if (typeof d.redirect === 'string' && d.redirect) {
        onRedirect?.(d.redirect);
        return _errResult(redirected(d.redirect, cmd.action, !!onRedirect));
      }
      return answerOf(d, cmd.action);
    } catch (e) {
      return unanswered(e, cmd.action, perCallSignal);
    }
  }, TRANSPORT);
}

// ---------------------------------------------------------------------------
// createBatchingHttpBridge
//
// createHttpBridge handles one dispatch per request; this variant adds
// microtask-coalescing on top - a burst of dispatches issued in the same tick
// is batched into one round trip - without changing that contract for anyone
// not opting in.
// ---------------------------------------------------------------------------

export type BatchingHttpBridgeOptions = HttpBridgeOptions & {
  /**
   * How long to hold the queue open before flushing.
   *   - `'microtask'` (default) - coalesce every dispatch issued within the
   *     same JS tick (`queueMicrotask`). Zero added latency: a synchronous
   *     burst of dispatches (e.g. a `formSet` immediately followed by a
   *     `submit`) becomes one HTTP round trip.
   *   - a number (ms) - hold the queue open for a small window instead,
   *     catching dispatches from separate ticks (e.g. two quick, distinct
   *     user interactions) at the cost of that much added latency.
   */
  window?: 'microtask' | number;
};

type BatchedCommandEnvelope = { id: string; command: string; target: any; payload?: any; idempotencyKey?: string };
// `{ id } & BackendResponse`, not a restatement of it. Spelled out by hand
// until now, which is why `code` had to be added in two places instead of one
// - and how the two shapes would have drifted again at the next field. The WS
// frame below already composes it this way.
type BatchedResult = { id: string } & BackendResponse;
type BatchResponse = { results?: BatchedResult[] };

type QueuedBatchEntry = { id: string; cmd: Command; resolve: (result: CommandResult) => void };

/**
 * createBatchingHttpBridge - coalescing fetch-based transport plugin.
 *
 * Same per-dispatch call shape and backend options as {@link createHttpBridge}
 * (CSRF, retry, timeout, session-expiry are all reused via the same
 * `postCommand`/`httpClient` path), but every command dispatched within the
 * batching window is queued and sent as ONE POST:
 *
 *   { commands: [{ id, command, target, payload }, ...] }
 *
 * matched back against:
 *
 *   { results: [{ id, state }, { id, redirect }, { id, problem }, ...] }
 *
 * A failed result carries its problem with the command's own `status`.
 *
 * Each queued command's own dispatch promise resolves independently - a
 * caller dispatches exactly as it would against createHttpBridge; the
 * coalescing is invisible to the call site.
 *
 * @example
 * const bus = createAsyncCommandBus()
 * bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', csrf: true }))
 * // two dispatches issued in the same tick -> one HTTP round trip:
 * bus.dispatch('formSet', { field: 'email' }, { value: 'a@b.com' })
 * bus.dispatch('cartAdd', product, { quantity: 2 })
 */
export function createBatchingHttpBridge(options: BatchingHttpBridgeOptions): AsyncPlugin {
  const { endpoint, actions, csrf = false, csrfCookieUrl, headers = {}, timeout = 10_000, signal, onSessionExpired, onRedirect, scopeController, httpClient, window: flushWindow = 'microtask' } = options;
  const csrfFlag = csrf === 'inertia' ? false : csrf;
  const effectiveSignal = scopeController && signal
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, scopeController.signal]) : signal)
    : scopeController?.signal ?? signal;

  let queue: QueuedBatchEntry[] = [];
  let scheduled = false;
  let seq = 0;

  function scheduleFlush(): void {
    if (scheduled) return;
    scheduled = true;
    if (flushWindow === 'microtask') queueMicrotask(flush);
    else setTimeout(flush, flushWindow);
  }

  async function flush(): Promise<void> {
    const batch = queue;
    queue = [];
    scheduled = false;
    /* v8 ignore next -- defensive: flush is only ever scheduled right after a
       queue.push, and nothing but flush drains the queue */
    if (batch.length === 0) return;


    const commands: BatchedCommandEnvelope[] = batch.map(({ id, cmd }) => {
      const entry: BatchedCommandEnvelope = { id, command: cmd.action, target: cmd.target, payload: cmd.payload };
      if (cmd.meta?.idempotencyKey) entry.idempotencyKey = cmd.meta.idempotencyKey;
      return entry;
    });

    try {
      const res = httpClient
        ? await httpClient.post<BatchResponse>(endpoint, { commands }, {
            csrf: csrfFlag, csrfCookieUrl, headers, timeout, retry: 0, signal: effectiveSignal, onSessionExpired,
          })
        : await postCommand<BatchResponse>(endpoint, { commands }, {
            csrf: csrfFlag, csrfCookieUrl, headers, timeout, retry: 0, signal: effectiveSignal, onSessionExpired,
          });

      if (!res.ok) {
        const err = answered(res.status, res.data, res.headers);
        for (const entry of batch) entry.resolve(_errResult(err));
        return;
      }

      const byId = new Map((res.data?.results ?? []).map((r) => [r.id, r]));
      // `onRedirect` navigates, so it fires once per batch - two navigations
      // in one tick race. Every redirected command still fails on its own,
      // carrying its own url.
      let navigated = false;
      for (const entry of batch) {
        const r = byId.get(entry.id);
        if (!r) {
          entry.resolve(_errResult(transportError('lost:result', `The batch answer is missing a result for "${entry.cmd.action}".`, entry.cmd.action, { id: entry.id })));
        } else if (typeof r.redirect === 'string' && r.redirect) {
          if (onRedirect && !navigated) {
            navigated = true;
            onRedirect(r.redirect);
          }
          entry.resolve(_errResult(redirected(r.redirect, entry.cmd.action, !!onRedirect)));
        } else {
          entry.resolve(answerOf(r, entry.cmd.action));
        }
      }
    } catch (e) {
      for (const entry of batch) entry.resolve(unanswered(e, entry.cmd.action, effectiveSignal));
    }
  }

  return Object.assign((cmd: Command, next: () => CommandResult | Promise<CommandResult>) => {
    if (actions?.length && !actions.some((p) => matchesPattern(p, cmd.action))) return next();
    if (cmd.signal?.aborted) return Promise.resolve(abortedResult(cmd.action, cmd.signal));

    return new Promise<CommandResult>((resolve) => {
      const id = `${Date.now()}-${++seq}`;
      queue.push({ id, cmd, resolve });
      scheduleFlush();
    });
  }, TRANSPORT);
}

// ---------------------------------------------------------------------------
// createWsBridge
// ---------------------------------------------------------------------------

export type WsBridgeOptions = {
  /** WebSocket server URL */
  url: string;
  /**
   * Which actions to forward. Glob patterns supported: '*', 'cart*'.
   * Default: all actions.
   */
  actions?: string[];
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
  /** Per-message response timeout in ms. Default: 10_000 */
  timeout?: number;
  /**
   * Maximum number of messages to queue while disconnected.
   * When exceeded, the oldest queued message is dropped with an error.
   * Default: 100
   */
  maxQueueSize?: number;
};

type PendingRequest = {
  action: string;
  resolve: (result: CommandResult) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

/**
 * createWsBridge - WebSocket transport plugin with reconnect and message queuing.
 *
 * Commands are sent as JSON frames over a persistent WebSocket connection.
 * Pending messages are queued during disconnects and flushed on reconnect.
 *
 * @example
 * const bus = createAsyncCommandBus()
 * const ws = createWsBridge({ url: 'wss://api.example.com/vc' })
 * bus.use(ws)
 * ws.connect()
 */
export function createWsBridge(options: WsBridgeOptions): AsyncPlugin & {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  /** Reactive connection state - bindable in Vapor/VDOM templates without polling. */
  connected: Signal<boolean>;
} {
  const {
    url,
    actions,
    reconnect = true,
    reconnectDelay: rawReconnectDelay = 1000,
    maxReconnects: rawMaxReconnects = 10,
    onConnect,
    onDisconnect,
    onError,
    timeout: wsTimeout = 10_000,
    maxQueueSize: rawMaxQueueSize = 100,
  } = options;

  // Two refusal gates and a delay, all three defeated by the same bad number.
  // `reconnectCount >= maxReconnects` never refuses, so the socket retries
  // forever; `reconnectDelay * reconnectCount` is then NaN, which setTimeout
  // treats as 0, so "forever" is also "as fast as the event loop allows" -
  // a hot loop against the server it is meant to be backing off from. And
  // `queue.length >= maxQueueSize` never drops, so the offline queue grows
  // without bound the whole time.
  const maxReconnects = countOption(rawMaxReconnects, 10);
  const reconnectDelay = countOption(rawReconnectDelay, 1000, 0, MAX_TIMEOUT_MS);
  const maxQueueSize = countOption(rawMaxQueueSize, 100);

  let ws: WebSocket | null = null;
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  // Reactive signal for connection state - usable in Vapor/VDOM templates
  const connected = signal(false);

  const pending = new Map<string, PendingRequest>();
  const queue: Array<{ id: string; envelope: CommandEnvelope; timeout: number; queuedAt: number }> = [];

  function genId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function send(id: string, envelope: CommandEnvelope, timeout: number): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, ...envelope }));
    } else {
      if (queue.length >= maxQueueSize) {
        const dropped = queue.shift()!;
        // `!` on the pending lookup, not a guard: `settle()` removes an entry
        // from BOTH `pending` and `queue`, and `failAllPending()` clears both
        // together - so a queued id always has a pending record. A miss would
        // mean the invariant broke, and throwing says so instead of silently
        // dropping a caller's promise (it would hang until its own timeout).
        const req = pending.get(dropped.id)!;
        clearTimeout(req.timeoutId);
        pending.delete(dropped.id);
        req.resolve(_errResult(transportError('lost:command', `WS queue overflow: "${dropped.envelope.command}" dropped`, dropped.envelope.command, { dropped: dropped.envelope })));
      }
      queue.push({ id, envelope, timeout, queuedAt: Date.now() });
    }
  }

  function flushQueue(): void {
    const items = queue.splice(0);
    const now = Date.now();
    for (let i = 0; i < items.length; i++) {
      const { id, envelope, timeout, queuedAt } = items[i];
      const elapsed = now - queuedAt;
      if (elapsed >= timeout) {
        // Message expired while queued - reject it instead of sending stale
        // commands. Same invariant as the overflow path above: a queued id
        // always has a pending record, so this is `!` rather than a guard.
        const req = pending.get(id)!;
        clearTimeout(req.timeoutId);
        pending.delete(id);
        req.resolve(_errResult(transportError('timeout:reply', `WS queued message "${envelope.command}" expired after ${elapsed}ms (timeout: ${timeout}ms)`, envelope.command, { elapsed, timeout })));
        continue;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, ...envelope }));
      } else {
        // Socket closed mid-flush - re-queue the remainder so they either go
        // out on reconnect or settle via failAllPending/expiry, instead of
        // silently hanging until each per-request timeout.
        queue.unshift(...items.slice(i));
        return;
      }
    }
  }

  /**
   * Settle every in-flight request immediately with a failure result, and drop
   * any unsent queued messages. Called on terminal teardown - an explicit
   * `disconnect()`, or a socket close with no reconnect pending - so a caller
   * awaiting a response doesn't hang until its per-request timeout fires.
   * Uses `resolve({ ok:false })`, matching every other settle path: the bus
   * never rejects a dispatch promise; failures are `CommandResult` values.
   */
  function failAllPending(reason: string): void {
    if (pending.size === 0 && queue.length === 0) return;
    queue.length = 0;
    const reqs = Array.from(pending.values());
    pending.clear();
    for (const req of reqs) {
      req.resolve(_errResult(transportError('lost:reply', reason)));
    }
  }

  function scheduleReconnect(): void {
    /* v8 ignore next -- defensive: scheduleReconnect's only call site (onclose)
       already guards with this exact condition before calling it */
    if (!reconnect || intentionalClose || reconnectCount >= maxReconnects) return;
    reconnectCount++;
    const delay = reconnectDelay * reconnectCount;
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
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
      connected.value = true;
      flushQueue();
      onConnect?.();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as { id: string } & BackendResponse;
        const req = pending.get(data.id);
        if (req) {
          clearTimeout(req.timeoutId);
          pending.delete(data.id);
          req.resolve(answerOf(data, req.action));
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (event) => {
      connected.value = false;
      // This socket is dead - drop the reference (unless a newer socket already
      // replaced it) so the connect() liveness guard lets the next attempt through.
      if (ws === socket) ws = null;
      onDisconnect?.(event);
      // Reconnect if we still can; otherwise this close is terminal - fail any
      // in-flight requests now rather than leaving them to hang until timeout.
      if (!intentionalClose && reconnect && reconnectCount < maxReconnects) {
        scheduleReconnect();
      } else {
        failAllPending('WebSocket connection closed before response');
      }
    };

    ws.onerror = (event) => {
      onError?.(event);
    };
  }

  function disconnect(): void {
    intentionalClose = true;
    connected.value = false;
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

  function isConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  const plugin: AsyncPlugin = async (cmd: Command, next: () => CommandResult | Promise<CommandResult>): Promise<CommandResult> => {
    if (actions?.length && !actions.some(p => matchesPattern(p, cmd.action))) {
      return next();
    }

    // Pre-flight abort - don't enqueue if signal is already tripped.
    if (cmd.signal?.aborted) return abortedResult(cmd.action, cmd.signal);

    return new Promise<CommandResult>((resolve) => {
      const id = genId();
      let abortHandler: (() => void) | null = null;

      // Naturally idempotent - no `settled` flag needed: the first call
      // detaches every other settle source (timer cleared, `pending` entry
      // deleted, abort listener removed), and each teardown line plus
      // `resolve()` itself is a no-op when repeated.
      const settle = (result: CommandResult): void => {
        clearTimeout(timeoutId);
        pending.delete(id);
        // Drop any queued copy too. The per-request timer is armed BEFORE
        // send(), so a request can settle (timeout, abort, disconnect) while
        // still sitting in `queue` waiting for a socket. Leaving it there meant
        // a dead entry occupied a maxQueueSize slot and had to be recognised
        // again later - once by the overflow path's `pending.get(...)` miss,
        // once by flushQueue's elapsed check. Two mechanisms responsible for
        // one fact. Removing it here makes settle() the single source of truth
        // for "this request is over", so maxQueueSize counts LIVE requests only.
        const queuedIndex = queue.findIndex((q) => q.id === id);
        if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
        if (abortHandler && cmd.signal) {
          cmd.signal.removeEventListener('abort', abortHandler);
        }
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        settle(_errResult(transportError('timeout:reply', `WS request "${cmd.action}" timed out after ${wsTimeout}ms`, cmd.action, { timeout: wsTimeout })));
      }, wsTimeout);

      pending.set(id, {
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

      send(id, { command: cmd.action, target: cmd.target, payload: cmd.payload }, wsTimeout);
    });
  };

  return Object.assign(plugin, { connect, disconnect, isConnected, connected }, TRANSPORT);
}

// ---------------------------------------------------------------------------
// createSseBridge
// ---------------------------------------------------------------------------

export type SseBridgeOptions = {
  /** SSE endpoint URL */
  url: string;
  /**
   * Called for each server-sent event. Use this to dispatch incoming
   * server events back into the command bus.
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
  onEvent: (event: MessageEvent, bus: BaseBus) => void;
  /** Send credentials with the SSE request. Default: false */
  withCredentials?: boolean;
  /** Reconnect automatically (EventSource does this natively). Default: true */
  reconnect?: boolean;
};

/**
 * createSseBridge - server-sent events bridge for unidirectional server push.
 *
 * SSE is receive-only: the server pushes events to the client.
 * Use `onEvent` to map incoming server events to bus dispatches.
 *
 * @example
 * const sse = createSseBridge({
 *   url: '/api/vc/stream',
 *   onEvent: (event, bus) => {
 *     const { command, target } = JSON.parse(event.data)
 *     bus.dispatch(command, target)
 *   }
 * })
 * sse.install(bus)
 *
 * // Later, on component unmount:
 * sse.teardown()
 */
export function createSseBridge(options: SseBridgeOptions): {
  install(bus: BaseBus): void;
  teardown(): void;
  isConnected(): boolean;
} {
  const { url, onEvent, withCredentials = false, reconnect = true } = options;

  let source: EventSource | null = null;

  function install(bus: BaseBus): void {
    if (typeof EventSource === 'undefined') return;
    source = new EventSource(url, { withCredentials });

    source.onmessage = (event) => {
      try {
        onEvent(event, bus);
      } catch (e) {
        console.error('[vapor-chamber] SSE onEvent error:', e);
      }
    };

    source.onerror = () => {
      // EventSource reconnects on its own, so `reconnect: true` needs no code.
      // `reconnect: false` did until now: the option was declared, typed and
      // documented with a default, and never read - setting it did nothing at
      // all. Closing the stream is the only way to stop EventSource retrying,
      // so that is what it means.
      if (!reconnect) teardown();
    };
  }

  function teardown(): void {
    source?.close();
    source = null;
  }

  function isConnected(): boolean {
    return source !== null && source.readyState === EventSource.OPEN;
  }

  return { install, teardown, isConnected };
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
   * Map an incoming broadcast to the bus. Default: `bus.emit(event, payload)` so
   * `on(event)` listeners fire. Provide this to dispatch a command instead, or
   * to rename/drop events.
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
 * Protocol-aware over the generic WS bridge: subscribes public / private /
 * presence channels and routes each broadcast to `bus.emit()` (or a command via
 * `onBroadcast`). Presence membership (`here` / `joining` / `leaving`) is emitted
 * too. Receive-only by design - outbound commands still go through the HTTP
 * bridge. Pass your own Echo instance; the bridge never imports laravel-echo, so
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
 * realtime.teardown();
 */
export function createEchoBridge(options: EchoBridgeOptions): {
  install(bus: BaseBus): void;
  teardown(): void;
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
            else bus.emit(event, payload);
          } catch (e) {
            console.error('[vapor-chamber] Echo broadcast error:', e);
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

  function teardown(): void {
    for (const name of joined) {
      try { echo.leave(name); } catch { /* echo may already be torn down */ }
    }
    joined.length = 0;
  }

  return { install, teardown };
}
