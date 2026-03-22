/**
 * vapor-chamber - Transport plugins
 *
 * v0.4.2 — Added: createHttpBridge, createWsBridge, createSseBridge.
 *
 * Transports are AsyncPlugin factories that forward commands to a backend.
 * Use with createAsyncCommandBus() for full async dispatch support.
 */

import type { Command, CommandResult, AsyncPlugin, BaseBus } from './command-bus';
import { matchesPattern } from './command-bus';
import { postCommand } from './http';

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
   * Read CSRF token from DOM (meta tag, cookie, hidden input) and attach.
   * Supports Laravel Blade and SPA setups. Handles 419 auto-refresh. Default: false
   */
  csrf?: boolean;
  /**
   * URL to fetch on 419 CSRF expiry to obtain a fresh token.
   * Default: '/sanctum/csrf-cookie'. Set to '' to disable.
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
   * Which actions to forward. Glob patterns supported: '*', 'cart*'.
   * Default: all actions.
   */
  actions?: string[];
};

function matchesActions(action: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some(p => matchesPattern(p, action));
}

/**
 * createHttpBridge — fetch-based transport plugin.
 *
 * Intercepts matching commands and forwards them to the backend as JSON.
 * The backend receives `{ command, target, payload }` and returns `{ ok, state, error }`.
 *
 * Features: multi-source CSRF (meta/cookie/input), 419 auto-refresh, session expiry
 * detection, Retry-After header, timeout, per-signal abort, jittered backoff.
 *
 * @example
 * const bus = createAsyncCommandBus()
 * bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true, retry: 2 }))
 *
 * await bus.dispatch('cartAdd', product, { quantity: 2 })
 */
export function createHttpBridge(options: HttpBridgeOptions): AsyncPlugin {
  const { endpoint, actions, csrf = false, csrfCookieUrl, headers = {}, timeout = 10_000, retry = 0, noRetry = [], signal, onSessionExpired } = options;

  return async (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => {
    if (!matchesActions(cmd.action, actions)) return next();

    const envelope: CommandEnvelope = { command: cmd.action, target: cmd.target, payload: cmd.payload };
    const effectiveRetry = noRetry.includes(cmd.action) ? 0 : retry;

    try {
      const res = await postCommand<BackendResponse>(endpoint, envelope, {
        csrf, csrfCookieUrl, headers, timeout, retry: effectiveRetry, signal, onSessionExpired,
      });

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

  const pending = new Map<string, PendingRequest>();
  const queue: Array<{ id: string; envelope: CommandEnvelope; timeout: number }> = [];

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
      queue.push({ id, envelope, timeout });
    }
  }

  function flushQueue(): void {
    const items = queue.splice(0);
    for (const { id, envelope } of items) {
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
      onDisconnect?.(event);
      if (!intentionalClose) scheduleReconnect();
    };

    ws.onerror = (event) => {
      onError?.(event);
    };
  }

  function disconnect(): void {
    intentionalClose = true;
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
    if (!matchesActions(cmd.action, actions)) {
      return next();
    }

    return new Promise<CommandResult>((resolve) => {
      const id = genId();

      const timeoutId = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: new Error(`WS request "${cmd.action}" timed out after ${wsTimeout}ms`) });
      }, wsTimeout);

      pending.set(id, { resolve, reject: (e) => resolve({ ok: false, error: e }), timeoutId });

      send(id, { command: cmd.action, target: cmd.target, payload: cmd.payload }, wsTimeout);
    });
  };

  return Object.assign(plugin, { connect, disconnect, isConnected });
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
