/**
 * vapor-chamber - I/O plugins (async/storage/network)
 *
 * retry, persist, sync
 */

import { matchesPattern, RETRYABLE_CODES, _errResult, abortedResult, type Command, type CommandResult, type AsyncPlugin, type Plugin } from './command-bus';
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
// Cross-tab sync bridge (BroadcastChannel over an event channel)
// ---------------------------------------------------------------------------

/**
 * The event channel `sync` bridges. Structural on purpose: this module imports
 * nothing from `./fast-lane`, so a consumer who never syncs pays no bytes for
 * it, and anything with the same two methods can be bridged.
 */
export type SyncLane = {
  on(event: string, listener: (data: any) => void): () => void;
  emit(event: string, data: any): void;
};

export type SyncOptions = {
  /**
   * BroadcastChannel name. All tabs using the same name receive each other's facts.
   * @example 'vapor-chamber:app'
   */
  channel: string;
  /** The event channel to bridge - `createFastLane()`, or anything of that shape. */
  lane: SyncLane;
  /**
   * Which events cross to the other tabs. Named rather than inferred: the fast
   * lane has no wildcard subscription by design, and naming them is the point
   * - the wire contract is declared, not guessed at from an action prefix.
   */
  events: string[];
  /**
   * Called when a fact arrives from another tab, before it is re-emitted
   * locally. Return false to drop it.
   */
  onReceive?: (event: string, data: unknown) => boolean | void;
};

type SyncMessage = { __vc: true; event: string; data: any };

/**
 * sync - mirror emitted FACTS to every other open tab over a BroadcastChannel.
 *
 * WHAT CROSSES THE WIRE IS A FACT, NOT A COMMAND, and that is the whole design.
 * Until v1.22.0 this was a bus PLUGIN that re-broadcast every successful
 * dispatch and re-dispatched it in the receiving tab. That shape replicates
 * INTENT: each tab re-runs the handler and re-derives the outcome. Three things
 * fall out of it, all measured before this was rewritten:
 *
 *   - A handler that is not deterministic does not mirror. Two tabs running
 *     the same `cartAdd` minted `A-line-1-936891` and `B-line-1-675288` and
 *     stayed different forever.
 *   - A tab seeded differently stays different: A ended at 1, B at 6.
 *   - A handler that dispatches a nested command applied that derivation
 *     TWICE per tab, because each tab derived its own and then received the
 *     peer's. Suppressing the receive side alone did not fix it (6 runs became
 *     5, not 4): the ORIGINATING tab was still broadcasting its derivations.
 *     Fixing that by inference needs the core to distinguish a root dispatch
 *     from a derived one, which it does not, and adding a counter to do so
 *     would tax every dispatch on the bus.
 *
 * Emitting the fact removes the question instead of answering it. The app says
 * what crosses by emitting it; a derivation is not a fact unless the app says
 * so, so there is nothing to infer and no counter to pay for. The receiving tab
 * APPLIES the values the sender computed rather than recomputing them, which is
 * the ordinary CQRS split - a command is intent, an event is something that
 * already happened - and it is what makes a non-deterministic handler a
 * non-issue.
 *
 * IT ALSO LEAVES THE DISPATCH CHAIN. As a plugin this cost more than half the
 * bus's dispatch throughput, on every dispatch of every action, whether or not
 * it synced. Measured over 11 shuffled rounds of 200,000 dispatches with
 * `gc()` per round, against a byte-identical self-control arm: bare bus 1.000,
 * as a plugin 0.459 (control 0.454), as an `onAfter` listener 0.538, and on the
 * fast lane 0.867. The correctness fix and the performance fix are the same
 * change.
 *
 * WHAT IT STILL DOES NOT DO. Facts mirror, seeds do not: a tab that starts from
 * different state stays different unless the facts are absolute ("the count is
 * 2") rather than relative ("add one"). And a payload crosses through the
 * structured clone algorithm, so it cannot carry functions - see the DEV
 * warning below.
 *
 * @example
 * const lane = createFastLane()
 * lane.on('cartAdded', (fact) => applyToCart(fact))   // local AND remote land here
 *
 * bus.register('cartAdd', (cmd) => {
 *   const fact = computeAdd(cmd.target)
 *   applyToCart(fact)
 *   lane.emit('cartAdded', fact)                      // this is what crosses tabs
 * })
 *
 * const tabSync = sync({ channel: 'vapor-chamber:app', lane, events: ['cartAdded'] })
 * tabSync.close() // on teardown
 */
export function sync(options: SyncOptions): {
  close(): void;
  isOpen(): boolean;
} {
  const { channel, lane, events, onReceive } = options;

  let bc: BroadcastChannel | null = null;

  // Echo suppression is a plain boolean, and it is airtight here in a way it
  // was not on the bus. The old plugin needed `_withOrigin` because a flag
  // cleared in a `finally` holds only on a SYNC bus - on an async one the
  // dispatch returns a pending promise and the chain runs a microtask later,
  // after the flag is already back down. A lane `emit` has no such window: it
  // is a tight indexed loop over the subscriber list with no promise, no
  // plugin chain and no envelope, so it completes inside the `try`. The core's
  // origin machinery is no longer involved at all.
  let applying = false;

  function open(): void {
    if (typeof BroadcastChannel === 'undefined') return;
    bc = new BroadcastChannel(channel);

    bc.onmessage = (event: MessageEvent<SyncMessage>) => {
      const msg = event.data;
      if (!msg?.__vc) return;
      if (onReceive && onReceive(msg.event, msg.data) === false) return;
      applying = true;
      try { lane.emit(msg.event, msg.data); }
      finally { applying = false; }
    };
  }

  open();

  const offs: Array<() => void> = [];
  for (const name of events) {
    offs.push(lane.on(name, (data: unknown) => {
      if (applying) return;
      try {
        bc?.postMessage({ __vc: true, event: name, data } satisfies SyncMessage);
      } catch (e) {
        // A payload that cannot be structured-cloned (a function, a class
        // instance with methods, a DOM node) throws DataCloneError here. The
        // local tab has already applied its own fact by now, so this is a
        // remote-only failure and must not take the local emit down with it -
        // a listener that throws would stop the rest of the lane's fan-out.
        // DEV-gated like the call-site warnings above and unlike persist's
        // storage warnings: a non-cloneable payload is an authoring mistake
        // fixed at build time, not a condition a deployed app runs into.
        if (DEV) {
          console.warn(`[vapor-chamber] sync: "${name}" did not cross to other tabs - its payload is not structured-cloneable (no functions, class instances or DOM nodes):`, e);
        }
      }
    }));
  }

  return {
    close(): void {
      for (const off of offs) off();
      offs.length = 0;
      bc?.close();
      bc = null;
    },
    isOpen(): boolean { return bc !== null; },
  };
}
