/**
 * vapor-chamber - Testing utilities
 *
 * createTestBus() creates a command bus that records all dispatched commands
 * without executing real handlers. Useful for unit-testing components that
 * use useCommand() without wiring up the full application logic.
 *
 * @example
 * const bus = createTestBus();
 * setCommandBus(bus);
 *
 * // Dispatch something under test
 * bus.dispatch('cartAdd', cart, { id: 1 });
 *
 * // Assert
 * expect(bus.wasDispatched('cartAdd')).toBe(true);
 * expect(bus.getDispatched('cartAdd')[0].cmd.payload).toEqual({ id: 1 });
 *
 * // Snapshot: get a serializable copy of recorded dispatches
 * const snap = bus.snapshot();
 *
 * // Time-travel: replay dispatches up to (and including) index N
 * const state = bus.travelTo(2);
 */

import type {
  Command, CommandResult, Handler, Hook, Facts,
  PluginParts, Rules, Steps, BatchCommand, BatchOptions, BatchResult, CommandBus,
  Listener, RegisterOptions, BusInspection, AsyncCommandBusOptions,
} from './command-bus';

// The double stands in for the bus, so its failures are core's: a test must
// read the same code it will meet in production.
const testFail = _failures('core');
import { matchesPattern } from './pattern';
import { abortedResult, _failures, _errResult, _inspectPlugins, _okResult, _stampMeta, _syncBatch, _UNSEAL, _FACTS, _tryCatchHandler, _declaredTransports, _attachTransports, _send, _assertPlugin, _checkHandler, _composeFacts, _rulesOf, _stepsOf, _stepped, _refusal } from './command-bus';
import { isThenable } from './settled';
import { _hotUpdate } from './applied-remotely';
import { _report } from './report';
import { _isLibraryAction, _isLibraryRegister, _registersLocal } from './library-names';

export interface RecordedDispatch {
  cmd: Command;
  result: CommandResult;
}

export interface TestBus extends CommandBus<any> {
  /** All dispatched commands in order */
  readonly recorded: RecordedDispatch[];
  /** True if any command with this action was dispatched */
  wasDispatched(action: string): boolean;
  /** All recorded dispatches for a given action */
  getDispatched(action: string): RecordedDispatch[];
  /** Clear the recorded list and listeners */
  clear(): void;
  /** Read-only dispatch - runs the rules, the steps and the handler, fires afterHooks. */
  query(action: string, target: any, payload?: any): CommandResult;
  /** Fire a domain event - notifies on() listeners, no handler required, no result. */
  emit(event: string, data?: any): void;
  /** As the async bus: `null` declares the options of an action a transport sends. */
  register<A extends string>(action: A, handler: ((cmd: Command<A, any, any>) => any) | null, options?: RegisterOptions): () => void;
  /** Returns all registered action names. */
  registeredActions(): string[];
  /**
   * Snapshot - returns a deep-cloned, serializable copy of the recorded list.
   * Safe to compare with `toEqual` in any test framework.
   */
  snapshot(): RecordedDispatch[];
  /**
   * travelTo - returns the ordered list of commands from dispatch index 0
   * through `index` (inclusive). Useful for asserting the sequence of events
   * that led to a particular state.
   *
   * @param index 0-based index into recorded[]. Clamped to valid range.
   */
  travelTo(index: number): Command[];
  /**
   * travelToAction - returns all commands dispatched up to and including
   * the last occurrence of `action`. Useful for "what happened before this action".
   */
  travelToAction(action: string): Command[];
  /** Full topology snapshot - actions, plugins, hooks, listeners, seal state. */
  inspect(): BusInspection;
}

/**
 * Creates a test bus that stubs all handlers (returning `{ ok: true }`) unless
 * you register your own via `bus.register()`. All dispatches are recorded.
 */
export function createTestBus(opts: { passthroughHandlers?: boolean; transport?: AsyncCommandBusOptions['transport'] } = {}): TestBus {
  // The bus's own rule and send: an action a transport covers is sent, and its
  // dispatch answers a Promise, as on the async bus.
  const { transports, transportFor } = _declaredTransports(opts.transport);
  const handlers = new Map<string, Handler>();
  // The library's own actions an app names (a form's, history's trigger): local, as on the async bus.
  const locals = new Map<string, Handler>();
  const undoHandlers = new Map<string, Handler>();
  const undoChecks = new Map<string, (cmd: Command) => boolean>();
  // Each action's live registration, and the live ones a newer one covers.
  const owners = new Map<string, Array<{ own(): void; release(): void }>>();
  const responders = new Map<string, (cmd: Command) => any>();
  const plugins: PluginParts[] = [];
  // Hooks by the real buses' rule (addHook in command-bus.ts): marked off and
  // replaced on removal, never spliced, so a dispatch walking them keeps its array.
  let afterHooks: Array<{ fn: Hook; off: boolean }> = [];
  const dropHooks = (list: Array<{ off: boolean }>): never[] => { for (const h of list) h.off = true; return []; };
  // Replaced, never spliced, so a fan-out walking it keeps its array (see fanOut).
  let patternListeners: Array<{ pattern: string; listener: Listener; off: boolean }> = [];
  const recorded: RecordedDispatch[] = [];
  let sealed = false;
  let dispatchDepth = 0;
  const MAX_DISPATCH_DEPTH = 16;
  // The facts slot, as a real bus's (_composeFacts): the command state's observer, set
  // through `[_FACTS]` (`_factsSetter`), with the plugins' started and settled parts.
  let own: Facts | null = null;
  let facts: Facts | null = null;

  // Each action's rules and work steps, by the real buses' readers (`_rulesOf`,
  // `_stepsOf`), null while none is installed.
  let rules: Rules = null;
  let steps: Steps = null;

  // The rules' refusal, else the steps and the work: as a real bus, the first refusal answers.
  function ruled(cmd: Command, run: () => CommandResult): CommandResult {
    const list = rules === null ? null : rules(cmd.action);
    const refused = list === null ? undefined : _refusal(list, cmd);
    if (refused === undefined) return run();
    if (!isThenable(refused)) return refused;
    return (refused as Promise<CommandResult | undefined>).then((r) => r ?? run()) as unknown as CommandResult;
  }

  // The work behind the action's steps, by the real buses' runner (`_stepped`).
  function stepped(cmd: Command, run: () => CommandResult): CommandResult {
    const list = steps === null ? null : steps(cmd.action);
    return list === null ? run() : _stepped(list, cmd, run) as CommandResult;
  }

  function runAfterHooksAndListeners(cmd: Command, result: CommandResult): void {
    const ah = afterHooks;
    for (let i = 0, len = ah.length; i < len; i++) {
      const h = ah[i];
      if (h.off) continue;
      try { h.fn(cmd, result); } catch (e) {
        _report('error', 'test:failed:hook', `an onAfter hook threw on "${cmd.action}"`, e, { action: cmd.action });
      }
    }
    if (facts !== null) facts.settled(cmd, result);
    fanOut(cmd, result, cmd.action);
  }

  /**
   * Listener fan-out by the rule `fanOutListeners` in command-bus.ts states:
   * the listeners that existed when it started; one removed during it is
   * marked off and skipped, one added during it is past `n`.
   *
   * It must match the real buses exactly. It once kept an older cursor
   * correction after they were fixed: a test asserting "called once" failed
   * against behaviour the production bus does not have, and one merely
   * counting calls recorded a phantom and passed.
   */
  function fanOut(cmd: Command, result: CommandResult, matchAgainst: string): void {
    const pl = patternListeners;
    for (let i = 0, n = pl.length; i < n; i++) {
      const entry = pl[i];
      if (!entry.off && matchesPattern(entry.pattern, matchAgainst)) {
        try { entry.listener(cmd, result); } catch (e) {
          _report('error', 'test:failed:listener', `a listener threw on "${cmd.action}"`, e, { action: cmd.action });
        }
      }
    }
  }

  function dispatch(action: string, target: any, payload?: any): CommandResult {
    // Stamped exactly like the real buses. Without meta, every meta consumer
    // takes its defensive no-op branch under test and NOTHING FAILS - the
    // `idempotent` plugin never stamps a key, the outbox never sets its replay
    // key, the HTTP transport never forwards `Idempotency-Key`. A test wiring
    // those plugins to a TestBus exercised the degraded path and passed,
    // verifying nothing about the behaviour it named.
    return dispatchCommand({ action, target, payload, meta: _stampMeta(payload), signal: undefined });
  }

  // Runs a built Command: a batch keeps the one it dispatched, to undo it.
  function dispatchCommand(cmd: Command): CommandResult {
    if (dispatchDepth >= MAX_DISPATCH_DEPTH) {
      return _errResult(testFail('exceeded:depth', `Maximum dispatch depth (${MAX_DISPATCH_DEPTH}) exceeded for "${cmd.action}".`, { action: cmd.action, context: { depth: MAX_DISPATCH_DEPTH } }));
    }
    dispatchDepth++;
    try { return _dispatchInner(cmd); }
    finally { dispatchDepth--; }
  }

  function _dispatchInner(cmd: Command): CommandResult {
    if (facts !== null) facts.started(cmd);
    return settle(cmd, ruled(cmd, () => stepped(cmd, () => work(cmd))));
  }

  // `_tryCatchHandler` is the bus's OWN wrapper, not a copy of it: a copy is
  // how a double ends up answering differently from the thing it doubles.
  function local(cmd: Command): CommandResult {
    const handler = handlers.get(cmd.action);
    return handler && opts.passthroughHandlers ? _tryCatchHandler(handler, cmd) : _okResult(undefined);
  }

  // The action's transport, else its local handler, by the bus's own rule.
  function work(cmd: Command): CommandResult {
    const transport = transportFor === null || locals.has(cmd.action) ? undefined : transportFor(cmd.action);
    if (transport === undefined) return local(cmd);
    const fallback = (): Promise<CommandResult> => {
      const r = local(cmd);
      return r.ok && isThenable(r.value) ? Promise.resolve(r.value).then(_okResult, _errResult) : Promise.resolve(r);
    };
    return _send(transport, cmd, fallback) as unknown as CommandResult;
  }

  // Recorded and heard once settled: a sent command's result is a Promise.
  function settle(cmd: Command, result: CommandResult): CommandResult {
    if (!isThenable(result)) {
      recorded.push({ cmd, result });
      runAfterHooksAndListeners(cmd, result);
      return result;
    }
    return (result as unknown as Promise<CommandResult>).then((r) => settle(cmd, r)) as unknown as CommandResult;
  }

  function query(action: string, target: any, payload?: any): CommandResult {
    const cmd: Command = { action, target, payload, meta: _stampMeta(payload), signal: undefined };
    // A query's start, which the command state does not count. The rules still answer.
    if (facts !== null) facts.queried(cmd);
    return settle(cmd, ruled(cmd, () => stepped(cmd, () => work(cmd))));
  }

  function emit(event: string, data?: any): void {
    const cmd: Command = { action: event, target: data };
    const result: CommandResult = _okResult(undefined);
    // Same fan-out, same cursor rule - this carried its own copy of the
    // length-based bug and had to be fixed twice before it was one function.
    fanOut(cmd, result, event);
  }

  // The bus's own batch rule, not a copy (tests/testbus-batch.test.ts).
  function dispatchBatch(commands: BatchCommand[], options: BatchOptions = {}): BatchResult {
    return _syncBatch(commands, options, dispatchCommand, (action) => undoHandlers.has(action), dispatch);
  }

  function register(action: string, handler: Handler | null, regOpts: RegisterOptions = {}): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call register() on a sealed bus.`);
    // As the real bus: a `$` name is the library's, and an undo is `<action>$undo`.
    if (_isLibraryAction(action) && !_isLibraryRegister()) throw testFail('invalid:name', `Action "${action}": a name with "$" is the library's.`, { context: { action } });
    // The real bus's one rule for a handler and the action's transport.
    const local = _registersLocal();
    _checkHandler(action, handler, regOpts, transportFor === null || local ? undefined : transportFor(action));
    // As the sync bus: an optimistic action's throw runs its undo, then goes on.
    const run: Handler | null = regOpts.optimistic
      ? (cmd: Command) => {
          try { return (handler as Handler)(cmd); }
          catch (e) { dispatch(action + '$undo', cmd); throw e; }
        }
      : handler;
    const undoKey = action + '$undo';
    const undoH = regOpts.undo && ((c: Command) => (regOpts.undo as Handler)(c.target));
    const { undo, canUndo } = regOpts;
    const reg = {
      own(): void {
        if (run === null) handlers.delete(action);
        else handlers.set(action, run);
        if (local) locals.set(action, run as Handler);
        else locals.delete(action);
        if (undoH) {
          undoHandlers.set(action, undo as Handler);
          handlers.set(undoKey, undoH);
        }
        if (canUndo) undoChecks.set(action, canUndo);
      },
      release(): void {
        handlers.delete(action);
        if (local) locals.delete(action);
        if (undoH) { undoHandlers.delete(action); handlers.delete(undoKey); }
        if (canUndo) undoChecks.delete(action);
      },
    };
    // The real bus's rule (tests/register-ownership.test.ts), a double must not
    // diverge: the newest registration still live, a covered one kept in the list.
    const list = owners.get(action);
    if (list === undefined) owners.set(action, [reg]);
    else {
      list[list.length - 1].release();
      if (_hotUpdate() === undefined) list.push(reg);
      else list[list.length - 1] = reg;
    }
    reg.own();
    return () => {
      const list = owners.get(action) ?? [];
      const at = list.lastIndexOf(reg);
      if (at === -1) return;
      list.splice(at, 1);
      if (at < list.length) return;
      reg.release();
      if (at === 0) owners.delete(action);
      else list[at - 1].own();
    };
  }

  function use(plugin: PluginParts): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call use() on a sealed bus.`);
    _assertPlugin(plugin, plugins);
    // As `bus.use()`: attach before the plugin is placed, so a throw refuses the install.
    const detach = plugin.attach?.(bus as never);
    plugins.push(plugin);
    // As `bus.use()` does: `started` and `settled` parts in the facts slot,
    // rule parts in the rules, step parts in the steps, and the plugin gets
    // this bus (PluginParts.attach).
    const observes = plugin.started !== undefined || plugin.settled !== undefined;
    const ruledBy = plugin.authorize !== undefined || plugin.validate !== undefined;
    const stepsOf = plugin.reuse !== undefined || plugin.admit !== undefined || plugin.begin !== undefined;
    const place = (): void => {
      if (observes) facts = _composeFacts(own, plugins);
      if (ruledBy) rules = _rulesOf(plugins);
      if (stepsOf) steps = _stepsOf(plugins);
    };
    place();
    return () => {
      const i = plugins.indexOf(plugin);
      if (i !== -1) { plugins.splice(i, 1); place(); detach?.(); }
    };
  }

  function onAfter(hook: Hook): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call onAfter() on a sealed bus.`);
    const entry = { fn: hook, off: false };
    afterHooks.push(entry);
    return () => {
      if (entry.off) return;
      entry.off = true;
      afterHooks = afterHooks.filter((e) => e !== entry);
    };
  }

  function on(pattern: string, listener: Listener): () => void {
    const entry = { pattern, listener, off: false };
    patternListeners.push(entry);
    return () => {
      if (entry.off) return;
      entry.off = true;
      patternListeners = patternListeners.filter((e) => e !== entry);
    };
  }

  function once(pattern: string, listener: Listener): () => void {
    const unsub = on(pattern, (cmd, result) => { unsub(); listener(cmd, result); });
    return unsub;
  }

  function offAll(pattern?: string): void {
    for (const e of patternListeners) if (pattern === undefined || e.pattern === pattern) e.off = true;
    patternListeners = patternListeners.filter((e) => !e.off);
  }

  /**
   * As on a real bus: a responder answers behind the rules and the steps, then the after-hooks, its value
   * is awaited when it is a thenable, an already-aborted signal settles
   * core:aborted:dispatch before the responder runs, and no responder falls back to
   * dispatch(). Not mirrored: the timeout and dispose() settling a waiting
   * request - a double records, it does not wait.
   */
  function request(action: string, target: any, payload?: any, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
    if (opts.signal?.aborted) return Promise.resolve(abortedResult(action, opts.signal));
    const responder = responders.get(action);
    if (!responder) return Promise.resolve(dispatch(action, target, payload));
    const cmd: Command = { action, target, payload, meta: _stampMeta(payload), signal: undefined };
    if (facts !== null) facts.queried(cmd);
    const result = ruled(cmd, () => stepped(cmd, () => {
      try { return _okResult(responder(cmd)); }
      catch (e) { return _errResult(e as Error); }
    }));
    recorded.push({ cmd, result });
    runAfterHooksAndListeners(cmd, result);
    const v = result.value;
    // `isThenable` narrows to PromiseLike, which is the honest type for a
    // handler's return value - a user handler may return any thenable, not
    // only a real Promise. `respond()` is declared to return a Promise, so the
    // thenable is adopted through one here rather than handed straight back.
    if (result.ok && isThenable(v)) return Promise.resolve(v).then(_okResult, _errResult);
    return Promise.resolve(result);
  }

  function respond(action: string, handler: (cmd: Command) => any): () => void {
    if (sealed) throw testFail('refused:bus', `Cannot call respond() on a sealed bus.`);
    responders.set(action, handler);
    return () => { responders.delete(action); };
  }

  function getUndoHandler(action: string): Handler | undefined {
    return undoHandlers.get(action);
  }

  function snapshot(): RecordedDispatch[] {
    return JSON.parse(JSON.stringify(recorded)) as RecordedDispatch[];
  }

  function travelTo(index: number): Command[] {
    const clamped = Math.max(0, Math.min(index, recorded.length - 1));
    return recorded.slice(0, clamped + 1).map(r => r.cmd);
  }

  function travelToAction(action: string): Command[] {
    let lastIdx = -1;
    for (let i = 0; i < recorded.length; i++) {
      if (recorded[i].cmd.action === action) lastIdx = i;
    }
    if (lastIdx === -1) return [];
    return recorded.slice(0, lastIdx + 1).map(r => r.cmd);
  }

  const bus = {
    dispatch,
    query,
    emit,
    dispatchBatch,
    register,
    use,
    onAfter,
    on,
    once,
    offAll,
    request,
    respond,
    hasHandler: (action: string) => handlers.has(action),
    registeredActions: () => Array.from(handlers.keys()),
    getUndoHandler,
    getUndoCheck: (action: string) => undoChecks.get(action),
    recorded,
    wasDispatched: (action: string) => recorded.some(r => r.cmd.action === action),
    getDispatched: (action: string) => recorded.filter(r => r.cmd.action === action),
    // A sealed bus refuses clear() and dispose() leaves it sealed, as on the
    // real buses; unsealBus() reopens it through the same symbol. A double
    // that reset `sealed` would pass a test the real bus fails.
    clear: () => {
      if (sealed) throw testFail('refused:bus', `Cannot call clear() on a sealed bus.`);
      recorded.splice(0); offAll();
    },
    dispose: () => {
      // Plugin dispose() first, as a real bus's dispose() does.
      for (let i = plugins.length - 1; i >= 0; i--) plugins[i].dispose?.();
      for (const t of new Set(transports.map((e) => e.transport))) t.dispose?.();
      recorded.splice(0); offAll(); afterHooks = dropHooks(afterHooks); handlers.clear(); owners.clear(); locals.clear(); undoHandlers.clear(); undoChecks.clear(); responders.clear(); plugins.length = 0; rules = null; steps = null; facts = own;
    },
    seal: () => { sealed = true; },
    isSealed: () => sealed,
    [_UNSEAL]: () => { sealed = false; },
    [_FACTS]: (f: Facts | null) => { own = f; facts = _composeFacts(own, plugins); },
    inspect: (): BusInspection => ({
      actions: Array.from(handlers.keys()),
      undoActions: Array.from(undoHandlers.keys()),
      // Its own responders, as the real bus's inspect() lists them.
      responderActions: Array.from(responders.keys()),
      pluginCount: plugins.length,
      plugins: _inspectPlugins(plugins),
      transports: transports.map((e) => ({ pattern: e.pattern, id: e.transport.id ?? 'transport' })),
      afterHookCount: afterHooks.length,
      listenerPatterns: patternListeners.map(e => e.pattern),
      sealed,
      dispatchDepth,
    }),
    snapshot,
    travelTo,
    travelToAction,
  } as unknown as TestBus;
  _attachTransports(bus, transports);
  return bus;
}

