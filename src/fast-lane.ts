/**
 * vapor-chamber — fast lane.
 *
 * A minimal-allocation dispatch path for real-real-hot loops. NOT a
 * general-purpose command bus — it deliberately strips every feature that
 * costs per-call CPU or memory.
 *
 * Use when:
 *   • Per-frame game tick
 *   • Trading tick data (1k–100k+ msg/sec)
 *   • Audio buffer sample handling
 *   • Scroll / mousemove / pointer sampling
 *   • Physics or simulation step
 *
 * Do NOT use for general app dispatch (cart, form, navigation, analytics).
 * Use `createCommandBus()` for those — its ergonomics are correct for
 * those use cases. The fast lane intentionally drops:
 *   • Command envelope allocation (handler receives `data` directly)
 *   • CommandResult allocation (handler returns whatever)
 *   • Plugin chain, before/after hooks
 *   • Wildcard listeners
 *   • Schema validation, batch, request/response, AbortController
 *   • meta / id / correlation / causation tracing
 *   • Auto-cleanup hooks (no Vue scope integration)
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
   * factory time — the emit/unsub closures are built per mode, so the hot
   * path carries zero mode-branching.
   *
   * - `'live'` (default) — matches the main bus: a listener removed during
   *   an emit (by itself or a peer) does NOT run in that emit. Costs an
   *   identity guard per listener call.
   * - `'snapshot'` — the emit fans out to the subscriber list as it was
   *   when the emit started; a listener removed mid-emit still runs once.
   *   Unsubscribe replaces the bucket array instead of splicing it (the
   *   same copy-on-write nanoevents uses), so the emit loop is one call
   *   per slot with no guards. Allocation moves to the cold unsub path;
   *   the hot path stays allocation-free either way.
   *
   * Opt into `'snapshot'` only when a measured fan-out hot loop says so —
   * see docs/performance.md §Tuning.
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
  const listeners = new Map<string, FastListener<any>[]>();

  function compile<T, R>(action: string, handler: (data: T) => R): FastDispatcher<T, R> {
    handlers.set(action, handler as any);
    // The dispatcher closes over `handlers` and `action`, not over `handler`
    // directly — so re-compiling the same action re-routes the existing
    // dispatcher to the new handler without forcing callers to re-acquire
    // the dispatcher. Tiny indirection: one Map.get + one call per dispatch.
    return ((data: T): R => {
      const h = handlers.get(action);
      return h !== undefined ? (h(data) as R) : (undefined as unknown as R);
    });
  }

  function remove(action: string): void {
    handlers.delete(action);
    listeners.delete(action);
  }

  function on<T>(action: string, listener: FastListener<T>): () => void {
    let bucket = listeners.get(action);
    if (bucket === undefined) { bucket = []; listeners.set(action, bucket); }
    bucket.push(listener);
    return snapshot
      ? () => {
          // Copy-on-write (nanoevents-style): replace the array, never splice
          // it. An emit that started earlier keeps iterating the array it
          // captured — that is what makes snapshot-emit guard-free. Allocation
          // here is fine: unsubscribe is the cold path.
          const b = listeners.get(action);
          if (b === undefined) return;
          const next = b.filter((l) => l !== listener);
          if (next.length === 0) listeners.delete(action);
          else if (next.length !== b.length) listeners.set(action, next);
        }
      : () => {
          const b = listeners.get(action);
          if (b === undefined) return;
          const i = b.indexOf(listener);
          if (i !== -1) b.splice(i, 1);
          if (b.length === 0) listeners.delete(action);
        };
  }

  // Two emit implementations, selected once at factory time — the hot path
  // never branches on mode. Both share the single-listener fast path: with
  // one listener there is no neighbour to skip or double-invoke, so the
  // guard question is moot and the loop machinery is pure overhead.
  const emit: <T>(action: string, data: T) => void = snapshot
    ? (action, data) => {
        // SNAPSHOT mode: unsub replaces arrays (see on() above), so the ref
        // captured here is never mutated mid-flight — one call per slot, no
        // guards. Contract: a listener removed during this emit still runs
        // once; a listener added during it does not run until the next.
        const bucket = listeners.get(action);
        if (bucket === undefined) return;
        if (bucket.length === 1) { bucket[0](data); return; }
        for (let i = 0, len = bucket.length; i < len; i++) bucket[i](data);
      }
    : (action, data) => {
        const bucket = listeners.get(action);
        if (bucket === undefined) return;
        if (bucket.length === 1) { bucket[0](data); return; }
        // LIVE mode (default, bus parity): a listener may unsubscribe itself
        // (the once-pattern) or a peer during its own call, and `on()`'s
        // unsub closure splices this live array — so the next listener shifts
        // into the index just consumed and is silently skipped for this emit.
        // Same identity guard the main bus uses in notifyListeners. This
        // module drops envelope, results, plugins, wildcards and tracing on
        // purpose; it does not drop correctness, and the guard is
        // allocation-free, which is this file's only currency. (The guard's
        // per-call cost is why `removal: 'snapshot'` exists — see
        // FastLaneOptions.)
        for (let i = 0; i < bucket.length; i++) {
          const lenBefore = bucket.length;
          const listener = bucket[i];
          listener(data);
          // Only removals at or BEFORE the cursor shift it. Testing the length
          // alone over-corrects: a listener that removes a LATER peer shrinks
          // the array without moving anything at `i`, and decrementing would
          // re-invoke the listener that just ran. `bucket[i] !== listener` is
          // the exact signal, and holds for multi-removal too.
          if (bucket.length < lenBefore && bucket[i] !== listener) i -= lenBefore - bucket.length;
        }
      };

  function registeredActions(): string[] {
    return Array.from(handlers.keys());
  }

  function clear(): void {
    handlers.clear();
    listeners.clear();
  }

  return { compile, remove, on, emit, registeredActions, clear };
}
