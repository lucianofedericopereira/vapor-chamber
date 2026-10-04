/**
 * vapor-chamber - fast lane.
 *
 * A minimal-allocation dispatch path for real-real-hot loops. NOT a
 * general-purpose command bus - it deliberately strips every feature that
 * costs per-call CPU or memory.
 *
 * Use when:
 *   - Per-frame game tick
 *   - Trading tick data (1k-100k+ msg/sec)
 *   - Audio buffer sample handling
 *   - Scroll / mousemove / pointer sampling
 *   - Physics or simulation step
 *
 * Do NOT use for general app dispatch (cart, form, navigation, analytics).
 * Use `createCommandBus()` for those - its ergonomics are correct for
 * those use cases. The fast lane intentionally drops:
 *   - Command envelope allocation (handler receives `data` directly)
 *   - CommandResult allocation (handler returns whatever)
 *   - Plugin chain, before/after hooks
 *   - Wildcard listeners
 *   - Schema validation, batch, request/response, AbortController
 *   - meta / id / correlation / causation tracing
 *   - Auto-cleanup hooks (no Vue scope integration)
 *
 * If you need any of the above on a per-call basis, use the regular bus.
 *
 * @example Single-handler hot dispatch
 * const lane = createFastLane();
 * const onTick = lane.compile('tick', (dt: number) => physicsStep(dt));
 * onTick(deltaSeconds);   // pure function call, no envelope
 *
 * @example Multi-subscriber pub/sub
 * lane.on('frame', (dt) => animate(dt));
 * lane.on('frame', (dt) => render(dt));
 * lane.emit('frame', dt);
 */

export type FastDispatcher<T = any, R = any> = (data: T) => R;
export type FastListener<T = any> = (data: T) => void;

/** A live-mode subscription: `off` is set when it is unsubscribed. */
type LiveEntry = { fn: FastListener<any>; off: boolean };

export type FastLane = {
  /**
   * Bind a handler to an action and return a pre-compiled dispatcher.
   * The returned callable invokes the handler with no envelope, no
   * result wrapping, no plugin chain.
   *
   * Calling `compile` twice for the same action overwrites the binding;
   * the previously-returned dispatcher will route to the new handler on
   * its next invocation (closures share the same lookup).
   */
  compile<T = any, R = any>(action: string, handler: (data: T) => R): FastDispatcher<T, R>;

  /** Remove an action's handler and any subscribers. */
  remove(action: string): void;

  /**
   * Subscribe to multi-listener fan-out for an action. Listeners run in
   * registration order via a tight indexed loop.
   */
  on<T = any>(action: string, listener: FastListener<T>): () => void;

  /**
   * Fan out an event to all subscribers. No envelope allocation; listeners
   * receive `data` directly.
   */
  emit<T = any>(action: string, data: T): void;

  /** Diagnostic: list registered actions. */
  registeredActions(): string[];

  /** Reset all bindings. */
  clear(): void;
};

export type FastLaneOptions = {
  /**
   * What a mid-emit unsubscribe means for the CURRENT emit. Chosen once at
   * factory time - the emit/unsub closures are built per mode, so the hot
   * path carries zero mode-branching.
   *
   * - `'live'` (default) - matches the main bus: an emit calls the listeners
   *   that existed when it started; one removed during it (by itself or a
   *   peer) does NOT run in that emit, and one added during it runs from the
   *   next. Costs one `off` read per listener call.
   * - `'snapshot'` - the emit fans out to the subscriber list as it was
   *   when the emit started; a listener removed mid-emit still runs once.
   *   Unsubscribe replaces the bucket array instead of splicing it (the
   *   same copy-on-write nanoevents uses), so the emit loop is one call
   *   per slot with no guards. Allocation moves to the cold unsub path;
   *   the hot path stays allocation-free either way.
   *
   * Opt into `'snapshot'` only when a measured fan-out hot loop says so -
   * see docs/performance.md Tuning.
   */
  removal?: 'live' | 'snapshot';
};

export function createFastLane(options: FastLaneOptions = {}): FastLane {
  const snapshot = options.removal === 'snapshot';
  // Two parallel maps: one for compile()-style single dispatch, one for
  // emit()-style multi-listener fan-out. Kept separate so compile()'s
  // returned closure can reference a single function via Map lookup, not
  // an array iteration.
  const handlers = new Map<string, (data: any) => any>();
  // Snapshot mode keeps the listeners themselves; live mode keeps LiveEntry
  // records, whose `off` an emit already walking them reads.
  const listeners = new Map<string, Array<FastListener<any> | LiveEntry>>();

  function compile<T, R>(action: string, handler: (data: T) => R): FastDispatcher<T, R> {
    handlers.set(action, handler as any);
    // The dispatcher closes over `handlers` and `action`, not over `handler`
    // directly - so re-compiling the same action re-routes the existing
    // dispatcher to the new handler without forcing callers to re-acquire
    // the dispatcher. Tiny indirection: one Map.get + one call per dispatch.
    return ((data: T): R => {
      const h = handlers.get(action);
      return h !== undefined ? (h(data) as R) : (undefined as unknown as R);
    });
  }

  /** Live mode: mark a bucket's entries off, so an emit walking it stops calling them. */
  function markOff(bucket: Array<FastListener<any> | LiveEntry> | undefined): void {
    if (!snapshot && bucket !== undefined) for (const e of bucket) (e as LiveEntry).off = true;
  }

  function remove(action: string): void {
    handlers.delete(action);
    markOff(listeners.get(action));
    listeners.delete(action);
  }

  function on<T>(action: string, listener: FastListener<T>): () => void {
    let bucket = listeners.get(action);
    if (bucket === undefined) { bucket = []; listeners.set(action, bucket); }
    // Both modes unsubscribe copy-on-write: replace the array, never splice
    // it, so an emit that started earlier keeps walking the array it
    // captured, to the length it started with. Allocation here is fine:
    // unsubscribe is the cold path. Live mode also marks the entry off, so
    // that emit does not call it.
    if (snapshot) {
      bucket.push(listener);
      return () => {
        const b = listeners.get(action);
        if (b === undefined) return;
        const next = b.filter((l) => l !== listener);
        if (next.length === 0) listeners.delete(action);
        else if (next.length !== b.length) listeners.set(action, next);
      };
    }
    const entry: LiveEntry = { fn: listener, off: false };
    bucket.push(entry);
    return () => {
      if (entry.off) return;
      entry.off = true;
      // Present: remove() and clear() mark their entries off before dropping a bucket.
      const next = listeners.get(action)!.filter((e) => e !== entry);
      if (next.length === 0) listeners.delete(action);
      else listeners.set(action, next);
    };
  }

  // Two emit implementations, selected once at factory time - the hot path
  // never branches on mode. Both share the single-listener fast path: with
  // one listener there is no neighbour to skip or double-invoke, so the
  // guard question is moot and the loop machinery is pure overhead.
  const emit: <T>(action: string, data: T) => void = snapshot
    ? (action, data) => {
        // SNAPSHOT mode: unsub replaces arrays (see on() above), so the ref
        // captured here is never mutated mid-flight - one call per slot, no
        // guards. Contract: a listener removed during this emit still runs
        // once; a listener added during it does not run until the next.
        const bucket = listeners.get(action) as FastListener<any>[] | undefined;
        if (bucket === undefined) return;
        if (bucket.length === 1) { bucket[0](data); return; }
        for (let i = 0, len = bucket.length; i < len; i++) bucket[i](data);
      }
    : (action, data) => {
        const bucket = listeners.get(action) as LiveEntry[] | undefined;
        if (bucket === undefined) return;
        // One listener: nothing it does can affect another in this emit.
        if (bucket.length === 1) { bucket[0].fn(data); return; }
        // LIVE mode (default, bus parity, the rule fanOutListeners states):
        // the listeners that existed when the emit started; one removed
        // during it is marked off and skipped, one added during it is past
        // `len`. Nothing a listener does moves the cursor. The length-based
        // cursor correction this replaced skipped or re-ran a listener when
        // one removed several peers on both sides of itself (log s35.67).
        // Allocation-free, which is this file's only currency.
        for (let i = 0, len = bucket.length; i < len; i++) {
          const e = bucket[i];
          if (!e.off) e.fn(data);
        }
      };

  function registeredActions(): string[] {
    return Array.from(handlers.keys());
  }

  function clear(): void {
    handlers.clear();
    for (const b of listeners.values()) markOff(b);
    listeners.clear();
  }

  return { compile, remove, on, emit, registeredActions, clear };
}
