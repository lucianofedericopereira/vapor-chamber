/**
 * vapor-chamber - I/O plugins (async/storage/network)
 *
 * retry, persist, sync
 */

import { matchesPattern, RETRYABLE_CODES, _withOrigin, _errResult, abortedResult, type Command, type CommandResult, type AsyncPlugin, type Plugin } from './command-bus';
import { onSettled } from './settled';
import { MAX_TIMEOUT_MS, countOption } from './bounds';
import { DEV } from './dev';
// Type-only import from ./http inside, so this pulls no HTTP code into a bundle.
import { isRetryableStatus } from './http-errors';

// ---------------------------------------------------------------------------
// Retry plugin
// ---------------------------------------------------------------------------

export type RetryOptions = {
  /**
   * Maximum number of attempts (including the first). Default: 3.
   * Floored at 1, so an unusable value still dispatches once - see the note at
   * the clamp.
   */
  maxAttempts?: number;
  /**
   * Base delay in ms between retries. Default: 200. The computed delay is
   * capped at `setTimeout`'s 32-bit ceiling; past it the backoff inverts.
   */
  baseDelay?: number;
  /**
   * Backoff strategy:
   * - 'fixed'       - always wait baseDelay ms
   * - 'linear'      - baseDelay * attempt
   * - 'exponential' - baseDelay * 2^(attempt-1)
   * Default: 'exponential'
   */
  strategy?: 'fixed' | 'linear' | 'exponential';
  /**
   * Which actions to retry. Glob patterns supported: '*', 'cart*'.
   * Default: all actions.
   */
  actions?: string[];
  /**
   * Return true if the error is retryable.
   *
   * Default, three rules in order, after one exclusion: a user abort (an error
   * named 'AbortError', such as the DOMException `fetch` rejects with when the
   * dispatch's `signal` fires) is never retried. The caller cancelled; backing
   * off would only delay the answer (tests/retry-bridge-path.test.ts). A
   * timeout is a `TimeoutError`, not an abort, and stays retryable.
   *
   * - A BusError (a `.code` starting with 'VC_') is retried only when the code
   *   is transient per RETRYABLE_CODES (throttled, rate-limited, timeout,
   *   circuit-open, ...) - known-permanent codes (validation, sealed bus, max
   *   depth, ...) stop retrying immediately instead of wasting attempts.
   * - An error carrying an HTTP status (`error.status` or
   *   `error.response.status`, both set by the HTTP bridge and the http
   *   client) is retried only for 408, 429 and 5xx - the set the HTTP layer
   *   retries itself. NARROWED after v1.19.0: any status used to be retried,
   *   so retry() in front of `createHttpBridge` re-sent a 422 write
   *   `maxAttempts` times while `postCommand` refused to re-send it once
   *   (tests/retry-bridge-path.test.ts). A handler that throws a 4xx-status
   *   error and wants it re-run must now pass its own predicate.
   * - Every other error is retried. (Before v1.3 the default retried
   *   everything; behavior for plain Errors is unchanged.)
   *
   * HTTP retry belongs on the bridge's own `retry` option, which also
   * resends the same Idempotency-Key and honours Retry-After; keep this
   * plugin for non-HTTP async work.
   */
  isRetryable?: (error: Error, attempt: number) => boolean;
};

/**
 * `setTimeout` stores its delay in a signed 32-bit int. Node clamps anything
 * larger to 1ms AND warns; browsers wrap. Either way the backoff INVERTS -
 * the longest waits become the shortest - so the cap is on correctness, not
 * taste. Measured with the defaults (200ms, exponential, 30 attempts): delays
 * reached 53,687,091,200ms and five of them were over the ceiling, i.e. the
 * final five retries fired back-to-back at the exact point the remote was
 * least able to take them.
 *
 * Capping here rather than at some friendlier number like 30s on purpose: this
 * only changes cases that were already broken, and never shortens a wait a
 * caller could actually have received.
 */

function retryDelay(strategy: 'fixed' | 'linear' | 'exponential', base: number, attempt: number): number {
  if (strategy === 'fixed') return Math.min(base, MAX_TIMEOUT_MS);
  if (strategy === 'linear') return Math.min(base * attempt, MAX_TIMEOUT_MS);
  return Math.min(base * Math.pow(2, attempt - 1), MAX_TIMEOUT_MS);
}

/**
 * Default isRetryable - the three rules are stated on RetryOptions.isRetryable.
 *
 * The status rule is checked AFTER the `VC_` one on purpose: the bridge copies
 * the backend's body code onto the error, and a backend code is not ours to
 * interpret, while a `VC_` code is. A 4xx status is the HTTP layer's own
 * verdict that re-sending cannot help, so this plugin must not overrule it.
 */
function defaultIsRetryable(error: Error): boolean {
  const e = error as { name?: unknown; code?: unknown; status?: unknown; response?: { status?: unknown } };
  const code = e.code;
  if (typeof code === 'string' && code.startsWith('VC_')) return RETRYABLE_CODES.has(code);
  const status = e.status ?? e.response?.status;
  // An abort's `code` is the NUMBER 20 (DOMException), so it always lands here.
  return e.name !== 'AbortError' && (typeof status !== 'number' || isRetryableStatus(status));
}

/**
 * retry - async plugin that retries failed dispatches with configurable backoff.
 *
 * By default, permanent BusError codes (e.g. validation failures) are not
 * retried - see RetryOptions.isRetryable to customize.
 *
 * @example
 * const bus = createAsyncCommandBus()
 * bus.use(retry({ maxAttempts: 3, strategy: 'exponential', baseDelay: 200 }))
 */
export function retry(options: RetryOptions = {}): AsyncPlugin & { dispose(): void } {
  const {
    maxAttempts: rawMaxAttempts = 3,
    baseDelay = 200,
    strategy = 'exponential',
    actions,
    isRetryable = defaultIsRetryable,
  } = options;

  // At least one attempt, always. `next()` is called ONLY inside the loop
  // below, so a bound under 1 meant the command never reached its handler at
  // all: the plugin returned its `lastResult` placeholder and every matching
  // action failed with "No attempts made", which reads like an internal fault
  // rather than a bad option. Measured at 0, -1 and NaN - handler ran 0 times
  // in each case, silently disabling retry-covered actions.
  //
  // ../bounds owns the rule now: an unusable bound falls back to the documented
  // 3, and the floor of 1 keeps a deliberate `maxAttempts: 0` running the
  // command once rather than not at all.
  const maxAttempts = countOption(rawMaxAttempts, 3, 1);

  // The backoff sleeps pending right now, so dispose() - which the bus's own
  // dispose() runs since v1.20.0 - can end them. Until then these timers were
  // untracked: a disposed bus's retry kept re-calling a chain whose handlers
  // were gone, up to maxAttempts. Clearing a timer alone would leave that
  // dispatch's promise pending forever, so a sleep is woken with `false` and
  // the loop returns VC_CORE_ABORTED. A sleep that runs out removes itself.
  const sleeping = new Set<() => void>();

  const plugin = (async (cmd: Command, next: () => CommandResult | Promise<CommandResult>): Promise<CommandResult> => {
    if (actions?.length && !actions.some(p => matchesPattern(p, cmd.action))) return next();

    let lastResult: CommandResult = _errResult(new Error('No attempts made'));

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await Promise.resolve(next());

      if (lastResult.ok) return lastResult;

      const error = lastResult.error ?? new Error('Unknown error');
      if (attempt === maxAttempts || !isRetryable(error, attempt)) return lastResult;

      const delay = retryDelay(strategy, baseDelay, attempt);
      const slept = await new Promise<boolean>((resolve) => {
        const wake = (): void => { clearTimeout(timer); resolve(false); };
        const timer = setTimeout(() => { sleeping.delete(wake); resolve(true); }, delay);
        sleeping.add(wake);
      });
      if (!slept) return abortedResult(cmd.action);
    }

    return lastResult;
  }) as AsyncPlugin & { dispose(): void };
  plugin.dispose = (): void => { for (const wake of sleeping) wake(); sleeping.clear(); };
  return plugin;
}

// ---------------------------------------------------------------------------
// Persistence plugin
// ---------------------------------------------------------------------------

export type PersistOptions<T = any> = {
  /**
   * Storage key. Use a unique prefix per feature to avoid collisions.
   * @example 'vc:cart', 'vc:user-prefs'
   */
  key: string;
  /** Function that returns the current state to be saved after each command. */
  getState: () => T;
  /** Serializer. Default: JSON.stringify */
  serialize?: (state: T) => string;
  /**
   * Deserializer. Return null/undefined to skip rehydration.
   * Default: JSON.parse
   */
  deserialize?: (raw: string) => T | null;
  /**
   * Validate deserialized state before returning from load().
   * Return true to accept, false to reject (load() returns null).
   * Use this to reject stale or structurally invalid persisted state
   * after deploys that change the shape of persisted data.
   *
   * @example
   * persist({
   *   key: 'vc:cart',
   *   getState: () => cart.value,
   *   validate: (state) => Array.isArray(state.items) && typeof state.total === 'number',
   * })
   */
  validate?: (state: T) => boolean;
  /** Which actions trigger a save. Default: all successful dispatches. */
  filter?: (cmd: Command) => boolean;
  /**
   * Storage backend. Default: globalThis.localStorage
   * Pass `sessionStorage` for session-scoped persistence.
   */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /**
   * When true, collapse back-to-back saves within the same microtask into one.
   * Trades 1 microtask of latency for one `getState()` + `JSON.stringify()` +
   * `setItem()` cycle per burst, regardless of how many dispatches triggered it.
   *
   * Use when the same state is touched by many rapid commands (form input,
   * scroll tracking, batched cart updates). Default: false (every successful
   * dispatch saves immediately, matching pre-v1.2 behavior).
   *
   * @example
   * persist({ key: 'vc:cart', getState: () => cart.value, coalesce: true })
   */
  coalesce?: boolean;
};

/**
 * persist - auto-save state to localStorage (or custom storage) after each command.
 *
 * @example
 * const cartPersist = persist({ key: 'vc:cart', getState: () => cartState.value })
 * bus.use(cartPersist)
 * const saved = cartPersist.load()
 */
export function persist<T>(options: PersistOptions<T>): Plugin & {
  load(): T | null;
  save(): void;
  clear(): void;
} {
  const {
    key,
    getState,
    serialize = (v) => JSON.stringify(v),
    deserialize = (s) => { try { return JSON.parse(s) as T; } catch { return null; } },
    validate,
    filter,
    coalesce = false,
  } = options;

  function getStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
    if (options.storage) return options.storage;
    if (typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined') {
      return (globalThis as any).localStorage as Storage;
    }
    return null;
  }

  function save(): void {
    const store = getStorage();
    if (!store) return;
    try { store.setItem(key, serialize(getState())); }
    catch (e) { console.warn(`[vapor-chamber] persist: failed to save key "${key}":`, e); }
  }

  function load(): T | null {
    const store = getStorage();
    if (!store) return null;
    try {
      const raw = store.getItem(key);
      if (raw === null) return null;
      const state = deserialize(raw);
      if (state == null) return null;
      if (validate && !validate(state)) {
        console.warn(`[vapor-chamber] persist: validation failed for key "${key}" - returning null. Persisted state may be stale after a deploy.`);
        return null;
      }
      return state;
    } catch (e) {
      console.warn(`[vapor-chamber] persist: failed to load key "${key}":`, e);
      return null;
    }
  }

  function clear(): void {
    const store = getStorage();
    if (!store) return;
    try { store.removeItem(key); }
    catch (e) { console.warn(`[vapor-chamber] persist: failed to clear key "${key}":`, e); }
  }

  // Coalesced save scheduling - flushes one save per microtask burst.
  let _saveScheduled = false;
  function scheduleSave(): void {
    if (_saveScheduled) return;
    _saveScheduled = true;
    queueMicrotask(() => { _saveScheduled = false; save(); });
  }

  const plugin: Plugin = (coalesce
    ? (cmd: Command, next: () => CommandResult) => onSettled(next(), (result) => {
        if (result.ok && (!filter || filter(cmd))) scheduleSave();
        return result;
      })
    : (cmd: Command, next: () => CommandResult) => onSettled(next(), (result) => {
        if (result.ok && (!filter || filter(cmd))) save();
        return result;
      })) as unknown as Plugin;

  return Object.assign(plugin, { load, save, clear });
}

// ---------------------------------------------------------------------------
// Cross-tab sync plugin (BroadcastChannel)
// ---------------------------------------------------------------------------

export type SyncOptions = {
  /**
   * BroadcastChannel name. All tabs using the same name receive each other's commands.
   * @example 'vapor-chamber:app'
   */
  channel: string;
  /** Which actions to broadcast to other tabs. Default: all successful dispatches. */
  filter?: (cmd: Command) => boolean;
  /**
   * Called when a command arrives from another tab, before re-dispatching it.
   * Return false to suppress re-dispatch.
   */
  onReceive?: (cmd: Command) => boolean | void;
};

type SyncMessage = { __vc: true; action: string; target: any; payload?: any };

/**
 * sync - broadcast successful commands to all other open tabs via BroadcastChannel.
 *
 * @example
 * const tabSync = sync({ channel: 'vapor-chamber:app' })
 * bus.use(tabSync)
 * tabSync.close() // on teardown
 */
export function sync(
  options: SyncOptions,
  busRef?: { dispatch: (action: string, target: any, payload?: any) => any }
): Plugin & {
  close(): void;
  isOpen(): boolean;
} {
  const { channel, filter, onReceive } = options;

  // DEV-gated: a missing busRef is a call-site mistake fixed at build time, not
  // a runtime condition the deployed app can recover from. Unlike the persist
  // validation warning above - which fires on real production state (a stale
  // payload after a deploy) and therefore stays unconditional.
  if (DEV && !busRef?.dispatch) {
    console.warn('[vapor-chamber] sync() called without busRef - received messages will not be re-dispatched locally. Pass { dispatch: bus.dispatch } as the second argument.');
  }

  let bc: BroadcastChannel | null = null;
  const localDispatch: ((action: string, target: any, payload?: any) => any) | null =
    busRef?.dispatch ?? null;


  function open(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    bc = new BroadcastChannel(channel);

    bc.onmessage = (event: MessageEvent<SyncMessage>) => {
      const msg = event.data;
      if (!msg?.__vc) return;

      const cmd: Command = { action: msg.action, target: msg.target, payload: msg.payload };

      if (onReceive) {
        const allow = onReceive(cmd);
        if (allow === false) return;
      }

      if (localDispatch) {
        // Echo suppression rides ON the dispatch, not beside it. It used to be
        // a `receiving = true` flag cleared in a `finally`, which holds only on
        // a sync bus (the dispatch completes inside the try). On an async bus
        // `localDispatch` returns a pending promise and the plugin chain runs a
        // microtask later - after `finally` already cleared the flag.
        //
        // MEASURED, and worth recording because it is not what you would
        // predict: on an async bus that flag never actually mattered, because
        // the plugin below never broadcast anything at all (it read `.ok` off a
        // promise). Fixing that no-op is what makes the flag's race reachable -
        // with the broadcast working and the flag still in place, two tabs
        // ping-pong forever, every hop a real dispatch through handlers,
        // plugins and transports. So the marker is a PREREQUISITE for the
        // no-op fix, not an independent cleanup.
        //
        // `_withOrigin` sets `meta.origin = 'sync'` for EVERY payload shape,
        // including the primitives and arrays a `__origin` key cannot ride on
        // - those used to arrive unmarked and get re-broadcast, ping-ponging
        // between tabs forever. The payload now reaches handlers exactly as
        // the sending tab wrote it: no spread, no allocation, no injected key.
        _withOrigin('sync', () => localDispatch(msg.action, msg.target, msg.payload));
      }
    };
  }

  open();

  function broadcast(cmd: Command): void {
    // A command that arrived FROM another tab must not be sent back out.
    // `meta.origin` is stamped by the core via `_withOrigin` on the receive
    // path, so it is already set by the time any plugin runs - on a sync bus
    // and an async one alike, and for every payload shape.
    if (cmd.meta?.origin === 'sync') return;
    if (filter && !filter(cmd)) return;
    bc?.postMessage({ __vc: true, action: cmd.action, target: cmd.target, payload: cmd.payload } satisfies SyncMessage);
  }

  const plugin: Plugin = (cmd, next) => {
    const result = next();
    // `sync()` is typed as a sync Plugin and installs happily on an
    // AsyncCommandBus - where `next()` returns a PENDING PROMISE. Reading
    // `result.ok` on it yields `undefined`, so this plugin used to broadcast
    // nothing at all on an async bus: cross-tab sync was silently dead, with
    // no warning, for every setup whose handlers are async. Decide after it
    // settles instead.
    if (result !== null && typeof (result as { then?: unknown })?.then === 'function') {
      (result as unknown as Promise<CommandResult>)
        .then((settled) => {
          if (settled?.ok) broadcast(cmd);
        })
        .catch(() => {
          /* a rejected dispatch is not a broadcast-worthy success */
        });
      return result;
    }
    if (result.ok) broadcast(cmd);
    return result;
  };

  return Object.assign(plugin, {
    close(): void { bc?.close(); bc = null; },
    isOpen(): boolean { return bc !== null; },
  });
}
