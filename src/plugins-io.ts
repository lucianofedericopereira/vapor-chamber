/**
 * vapor-chamber — I/O plugins (async/storage/network)
 *
 * retry, persist, sync
 */

import { matchesPattern, RETRYABLE_CODES, type Command, type CommandResult, type AsyncPlugin, type Plugin } from './command-bus';

// ---------------------------------------------------------------------------
// Retry plugin
// ---------------------------------------------------------------------------

export type RetryOptions = {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms between retries. Default: 200 */
  baseDelay?: number;
  /**
   * Backoff strategy:
   * - 'fixed'       — always wait baseDelay ms
   * - 'linear'      — baseDelay * attempt
   * - 'exponential' — baseDelay * 2^(attempt-1)
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
   * Default: BusErrors (a `.code` starting with 'VC_') are retried only when
   * the code is transient per RETRYABLE_CODES (throttled, rate-limited,
   * timeout, circuit-open, ...) — known-permanent codes (validation, sealed
   * bus, max depth, ...) stop retrying immediately instead of wasting
   * attempts. All other errors are always retried. (Before v1.3 the default
   * retried everything; behavior for plain Errors is unchanged.)
   */
  isRetryable?: (error: Error, attempt: number) => boolean;
};

function retryDelay(strategy: 'fixed' | 'linear' | 'exponential', base: number, attempt: number): number {
  if (strategy === 'fixed') return base;
  if (strategy === 'linear') return base * attempt;
  return base * Math.pow(2, attempt - 1);
}

/** Default isRetryable: consult RETRYABLE_CODES for BusErrors, retry everything else. */
function defaultIsRetryable(error: Error): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code !== 'string' || !code.startsWith('VC_') || RETRYABLE_CODES.has(code);
}

/**
 * retry — async plugin that retries failed dispatches with configurable backoff.
 *
 * By default, permanent BusError codes (e.g. validation failures) are not
 * retried — see RetryOptions.isRetryable to customize.
 *
 * @example
 * const bus = createAsyncCommandBus()
 * bus.use(retry({ maxAttempts: 3, strategy: 'exponential', baseDelay: 200 }))
 */
export function retry(options: RetryOptions = {}): AsyncPlugin {
  const {
    maxAttempts = 3,
    baseDelay = 200,
    strategy = 'exponential',
    actions,
    isRetryable = defaultIsRetryable,
  } = options;

  return async (cmd: Command, next: () => CommandResult | Promise<CommandResult>): Promise<CommandResult> => {
    if (actions?.length && !actions.some(p => matchesPattern(p, cmd.action))) return next();

    let lastResult: CommandResult = { ok: false, error: new Error('No attempts made') };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastResult = await Promise.resolve(next());

      if (lastResult.ok) return lastResult;

      const error = lastResult.error ?? new Error('Unknown error');
      if (attempt === maxAttempts || !isRetryable(error, attempt)) return lastResult;

      const delay = retryDelay(strategy, baseDelay, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    return lastResult;
  };
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
 * persist — auto-save state to localStorage (or custom storage) after each command.
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
        console.warn(`[vapor-chamber] persist: validation failed for key "${key}" — returning null. Persisted state may be stale after a deploy.`);
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

  // Coalesced save scheduling — flushes one save per microtask burst.
  let _saveScheduled = false;
  function scheduleSave(): void {
    if (_saveScheduled) return;
    _saveScheduled = true;
    queueMicrotask(() => { _saveScheduled = false; save(); });
  }

  const plugin: Plugin = coalesce
    ? (cmd, next) => {
        const result = next();
        if (result.ok && (!filter || filter(cmd))) scheduleSave();
        return result;
      }
    : (cmd, next) => {
        const result = next();
        if (result.ok && (!filter || filter(cmd))) save();
        return result;
      };

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
 * sync — broadcast successful commands to all other open tabs via BroadcastChannel.
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

  if (!busRef?.dispatch) {
    console.warn('[vapor-chamber] sync() called without busRef — received messages will not be re-dispatched locally. Pass { dispatch: bus.dispatch } as the second argument.');
  }

  let bc: BroadcastChannel | null = null;
  const localDispatch: ((action: string, target: any, payload?: any) => any) | null =
    busRef?.dispatch ?? null;

  let receiving = false;

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
        receiving = true;
        try { localDispatch(msg.action, msg.target, msg.payload); }
        finally { receiving = false; }
      }
    };
  }

  open();

  const plugin: Plugin = (cmd, next) => {
    const result = next();
    if (result.ok && !receiving && (!filter || filter(cmd))) {
      bc?.postMessage({ __vc: true, action: cmd.action, target: cmd.target, payload: cmd.payload } satisfies SyncMessage);
    }
    return result;
  };

  return Object.assign(plugin, {
    close(): void { bc?.close(); bc = null; },
    isOpen(): boolean { return bc !== null; },
  });
}
