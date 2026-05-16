/**
 * vapor-chamber - Transport plugins
 *
 * v0.4.2 — Added: createHttpBridge, createWsBridge, createSseBridge.
 *
 * Transports are AsyncPlugin factories that forward commands to a backend.
 * Use with createAsyncCommandBus() for full async dispatch support.
 */

import type { Command, CommandResult, AsyncPlugin, BaseBus } from './command-bus';
import { matchesPattern, abortedResult, } from './command-bus';
import { postCommand } from './http';
import type { HttpClient } from './http';
import { signal } from './signal';
import type { Signal } from './signal';

// ---------------------------------------------------------------------------
// Shared protocol types
// ---------------------------------------------------------------------------

/** The JSON shape sent to the backend endpoint */
export type CommandEnvelope = {
  command: string;
  target: any;
  payload?: any;
};

/** The JSON shape expected from the backend */
export type BackendResponse = {
  ok?: boolean;
  state?: any;
  error?: string;
};

// ---------------------------------------------------------------------------
// createHttpBridge
// ---------------------------------------------------------------------------

export type HttpBridgeOptions = {
  /** Backend endpoint URL (e.g. '/api/vc') */
  endpoint: string;
  /**
   * CSRF token strategy:
   *   • `false` (default) — don't attach any CSRF token
   *   • `true` — read from DOM (meta tag, cookie, hidden input) and attach
   *     as the appropriate header. Works with any server-rendered framework
   *     that exposes a token via one of those three sources — Laravel Blade,
   *     Rails, Django, .NET MVC, custom stacks. Auto-refreshes on HTTP 419.
   *   • `'inertia'` — defer token management to Inertia's Axios instance.
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
  /** Max retry attempts on 5xx / 429 / 408. Default: 0 */
  retry?: number;
  /**
   * Actions that must never be retried regardless of the `retry` setting.
   * Use for payment and other non-idempotent commands to prevent double execution.
   * @example noRetry: ['paymentCharge', 'orderPlace']
   */
  noRetry?: string[];
  /** External AbortSignal (e.g. tied to component lifecycle) */
  signal?: AbortSignal;
  /**
   * Called when a 401 session-expired response is received.
   * A `session-expired` CustomEvent is also dispatched on `window`.
   */
  onSessionExpired?: (status: number) => void;
  /**
   * Called when a backend response indicates a redirect (3xx response with
   * `Location` header, OR a `{ redirect: '/path' }` field in the JSON body).
   * Useful for handing 302s to Inertia's router so vapor-chamber dispatches
   * can trigger page navigations:
   *
   *   onRedirect: (url) => router.visit(url)
   *
   * If not set, redirects are surfaced as `{ ok: false, error: 'Redirect to /path' }`.
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
   * AbortController in setup and pass it here — call `.abort()` in
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
 * createHttpBridge — fetch-based transport plugin.
 *
 * Intercepts matching commands and forwards them to the backend as JSON.
 * The backend receives `{ command, target, payload }` and returns `{ ok, state, error }`.
 *
 * Features: multi-source CSRF token reading (meta tag / cookie / hidden input),
 * automatic CSRF-expiry refresh on HTTP 419 (Laravel Sanctum convention by
 * default, configurable for other frameworks), session-expiry detection on
 * 401, Retry-After header support, request timeout, per-call AbortSignal,
 * jittered exponential backoff.
 *
 * @example
 * const bus = createAsyncCommandBus()
 * bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true, retry: 2 }))
 *
 * await bus.dispatch('cartAdd', product, { quantity: 2 })
 */
export function createHttpBridge(options: HttpBridgeOptions): AsyncPlugin {
  const { endpoint, actions, csrf = false, csrfCookieUrl, headers = {}, timeout = 10_000, retry = 0, noRetry = [], signal, onSessionExpired, onRedirect, scopeController, httpClient } = options;
  // `csrf: 'inertia'` means: don't read CSRF from the DOM ourselves —
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

  return async (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => {
    if (actions?.length && !actions.some(p => matchesPattern(p, cmd.action))) return next();

    const envelope: CommandEnvelope = { command: cmd.action, target: cmd.target, payload: cmd.payload };
    const effectiveRetry = noRetry.includes(cmd.action) ? 0 : retry;

    // Merge bridge-level effectiveSignal with per-dispatch cmd.signal. The
    // dispatch-time signal (from `bus.dispatch(..., { signal })`) is
    // auto-propagated to the HTTP request — consumers don't need to wire it
    // through the bridge options.
    const perCallSignal = cmd.signal && effectiveSignal
      ? (typeof AbortSignal.any === 'function'
          ? AbortSignal.any([effectiveSignal, cmd.signal])
          : cmd.signal) // fallback: prefer the per-dispatch signal
      : (cmd.signal ?? effectiveSignal);

    try {
      const res = httpClient
        ? await httpClient.post<BackendResponse>(endpoint, envelope, {
            csrf: csrfFlag, csrfCookieUrl, headers, timeout, retry: effectiveRetry, signal: perCallSignal, onSessionExpired,
          })
        : await postCommand<BackendResponse>(endpoint, envelope, {
            csrf: csrfFlag, csrfCookieUrl, headers, timeout, retry: effectiveRetry, signal: perCallSignal, onSessionExpired,
          });

      // Backend redirect — either a body field or a 3xx status. Pass the URL
      // to onRedirect (typically Inertia's `router.visit`) and resolve as a
      // failed dispatch. If onRedirect isn't set, surface as a string error.
      const redirectUrl = (res.data as any)?.redirect;
      if (redirectUrl && typeof redirectUrl === 'string') {
        if (onRedirect) {
          onRedirect(redirectUrl);
          return { ok: false, error: new Error(`Redirected to ${redirectUrl}`) };
        }
        return { ok: false, error: new Error(`Backend redirect to ${redirectUrl} (no onRedirect handler configured)`) };
      }

      if (!res.ok) {
        const msg = (res.data as any)?.message ?? (res.data as any)?.error ?? `HTTP ${res.status}`;
        return { ok: false, error: new Error(msg) };
      }

      if (res.data?.ok === false) {
        return { ok: false, error: new Error(res.data.error ?? 'Backend error') };
      }

      return { ok: true, value: res.data?.state };
    } catch (e) {
      return { ok: false, error: e as Error };
    }
  };
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
  resolve: (result: CommandResult) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

/**
 * createWsBridge — WebSocket transport plugin with reconnect and message queuing.
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
  /** Reactive connection state — bindable in Vapor/VDOM templates without polling. */
  connected: Signal<boolean>;
} {
  const {
    url,
    actions,
    reconnect = true,
    reconnectDelay = 1000,
    maxReconnects = 10,
    onConnect,
    onDisconnect,
    onError,
    timeout: wsTimeout = 10_000,
    maxQueueSize = 100,
  } = options;

  let ws: WebSocket | null = null;
  let reconnectCount = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let intentionalClose = false;

  // Reactive signal for connection state — usable in Vapor/VDOM templates
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
        const req = pending.get(dropped.id);
        if (req) {
          clearTimeout(req.timeoutId);
          pending.delete(dropped.id);
          req.resolve({ ok: false, error: new Error(`WS queue overflow: "${dropped.envelope.command}" dropped`) });
        }
      }
      queue.push({ id, envelope, timeout, queuedAt: Date.now() });
    }
  }

  function flushQueue(): void {
    const items = queue.splice(0);
    const now = Date.now();
    for (const { id, envelope, timeout, queuedAt } of items) {
      const elapsed = now - queuedAt;
      if (elapsed >= timeout) {
        // Message expired while queued — reject it instead of sending stale commands
        const req = pending.get(id);
        if (req) {
          clearTimeout(req.timeoutId);
          pending.delete(id);
          req.resolve({ ok: false, error: new Error(`WS queued message "${envelope.command}" expired after ${elapsed}ms (timeout: ${timeout}ms)`) });
        }
        continue;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, ...envelope }));
      }
    }
  }

  function scheduleReconnect(): void {
    if (!reconnect || intentionalClose || reconnectCount >= maxReconnects) return;
    reconnectCount++;
    const delay = reconnectDelay * reconnectCount;
    reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
  }

  function connect(): void {
    if (typeof WebSocket === 'undefined') return;
    intentionalClose = false;

    ws = new WebSocket(url);

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
          if (data.ok === false) {
            req.resolve({ ok: false, error: new Error(data.error ?? 'WebSocket error') });
          } else {
            req.resolve({ ok: true, value: data.state });
          }
        }
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = (event) => {
      connected.value = false;
      onDisconnect?.(event);
      if (!intentionalClose) scheduleReconnect();
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

    // Pre-flight abort — don't enqueue if signal is already tripped.
    if (cmd.signal?.aborted) return abortedResult(cmd.action, cmd.signal);

    return new Promise<CommandResult>((resolve) => {
      const id = genId();
      let abortHandler: (() => void) | null = null;
      let settled = false;

      const settle = (result: CommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        pending.delete(id);
        if (abortHandler && cmd.signal) {
          cmd.signal.removeEventListener('abort', abortHandler);
        }
        resolve(result);
      };

      const timeoutId = setTimeout(() => {
        settle({ ok: false, error: new Error(`WS request "${cmd.action}" timed out after ${wsTimeout}ms`), value: undefined });
      }, wsTimeout);

      pending.set(id, {
        resolve: settle,
        reject: (e) => settle({ ok: false, error: e, value: undefined }),
        timeoutId,
      });

      // Mid-flight abort — drop the pending request and resolve with abort error.
      // The server may still process the command; this only cancels the client-side
      // wait. WS transports don't have per-message cancellation in the protocol.
      if (cmd.signal) {
        abortHandler = () => settle(abortedResult(cmd.action, cmd.signal!));
        cmd.signal.addEventListener('abort', abortHandler);
      }

      send(id, { command: cmd.action, target: cmd.target, payload: cmd.payload }, wsTimeout);
    });
  };

  return Object.assign(plugin, { connect, disconnect, isConnected, connected });
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
 * createSseBridge — server-sent events bridge for unidirectional server push.
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
  const { url, onEvent, withCredentials = false } = options;

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
      // EventSource reconnects automatically — no manual handling needed
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
