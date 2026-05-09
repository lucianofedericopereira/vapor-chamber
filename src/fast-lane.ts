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

export function createFastLane(): FastLane {
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
    return () => {
      const b = listeners.get(action);
      if (b === undefined) return;
      const i = b.indexOf(listener);
      if (i !== -1) b.splice(i, 1);
      if (b.length === 0) listeners.delete(action);
    };
  }

  function emit<T>(action: string, data: T): void {
    const bucket = listeners.get(action);
    if (bucket === undefined) return;
    for (let i = 0; i < bucket.length; i++) bucket[i](data);
  }

  function registeredActions(): string[] {
    return Array.from(handlers.keys());
  }

  function clear(): void {
    handlers.clear();
    listeners.clear();
  }

  return { compile, remove, on, emit, registeredActions, clear };
}
