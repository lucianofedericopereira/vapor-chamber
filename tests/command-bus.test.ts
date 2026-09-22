import { describe, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, configureUid } from '../src/command-bus';
import { stubEnv, stubGlobal } from '../src/vitest-pure';
import { it } from '../src/vitest';

describe('createCommandBus', () => {
  describe('dispatch', () => {
    it('should return error when no handler registered', ({ bus }) => {
      const result = bus.dispatch('unknownAction', {});

      expect(result).toFailWith('VC_CORE_NO_HANDLER');
      expect(result.error?.message).toContain('No handler');
    });

    it('should execute registered handler', ({ bus }) => {
      bus.register('testAction', (cmd) => cmd.target.value * 2);

      const result = bus.dispatch('testAction', { value: 5 });

      expect(result).toSucceedWith(10);
    });

    it('should pass action, target, and payload to handler', ({ bus }) => {
      const handler = vi.fn((cmd) => cmd);

      bus.register('testAction', handler);
      bus.dispatch('testAction', { id: 1 }, { extra: 'data' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        action: 'testAction',
        target: { id: 1 },
        payload: { extra: 'data' },
      }));
    });

    it('should catch handler errors and return error result', ({ bus }) => {
      bus.register('testError', () => {
        throw new Error('Handler failed');
      });

      const result = bus.dispatch('testError', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Handler failed');
    });
  });

  describe('register', () => {
    it('should return unregister function', ({ bus }) => {
      const unregister = bus.register('testAction', () => 'result');

      expect(bus.dispatch('testAction', {}).ok).toBe(true);

      unregister();

      expect(bus.dispatch('testAction', {})).toFailWith('VC_CORE_NO_HANDLER');
    });

    it('should replace existing handler', () => {
      using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bus = createCommandBus();
      bus.register('testAction', () => 'first');
      bus.register('testAction', () => 'second');

      const result = bus.dispatch('testAction', {});

      expect(result.value).toBe('second');
    });
  });

  describe('use (plugins)', () => {
    it('should execute plugin before handler', ({ bus }) => {
      const order: string[] = [];

      bus.use((_cmd, next) => {
        order.push('plugin-before');
        const result = next();
        order.push('plugin-after');
        return result;
      });

      bus.register('testAction', () => {
        order.push('handler');
        return 'done';
      });

      bus.dispatch('testAction', {});

      expect(order).toEqual(['plugin-before', 'handler', 'plugin-after']);
    });

    it('should allow plugin to short-circuit', ({ bus }) => {
      const handler = vi.fn(() => 'handler-result');

      bus.use((_cmd, _next) => {
        return { ok: false, error: new Error('Blocked') };
      });

      bus.register('testAction', handler);

      const result = bus.dispatch('testAction', {});

      expect(result.ok).toBe(false);
      expect(result.error?.message).toBe('Blocked');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should execute plugins in order (first = outermost)', ({ bus }) => {
      const order: string[] = [];

      bus.use((_cmd, next) => {
        order.push('plugin1-before');
        const result = next();
        order.push('plugin1-after');
        return result;
      });

      bus.use((_cmd, next) => {
        order.push('plugin2-before');
        const result = next();
        order.push('plugin2-after');
        return result;
      });

      bus.register('testAction', () => {
        order.push('handler');
        return 'done';
      });

      bus.dispatch('testAction', {});

      expect(order).toEqual([
        'plugin1-before',
        'plugin2-before',
        'handler',
        'plugin2-after',
        'plugin1-after',
      ]);
    });

    it('should return unsubscribe function', ({ bus }) => {
      const plugin = vi.fn((_cmd, next) => next());

      const unsubscribe = bus.use(plugin);
      bus.register('testAction', () => 'result');

      bus.dispatch('testAction', {});
      expect(plugin).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.dispatch('testAction', {});
      expect(plugin).toHaveBeenCalledTimes(1);
    });
  });

  describe('onAfter (hooks)', () => {
    it('should run after hooks after dispatch', ({ bus }) => {
      const hook = vi.fn();

      bus.onAfter(hook);
      bus.register('testAction', () => 'result');

      bus.dispatch('testAction', { id: 1 });

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'testAction', target: { id: 1 }, payload: undefined }),
        { ok: true, value: 'result' }
      );
    });

    it('should run hook even on error', ({ bus }) => {
      const hook = vi.fn();

      bus.onAfter(hook);
      bus.register('testError', () => {
        throw new Error('Oops');
      });

      bus.dispatch('testError', {});

      expect(hook).toHaveBeenCalled();
      expect(hook.mock.calls[0][1].ok).toBe(false);
    });

    it('should catch hook errors silently', ({ bus }) => {
      using consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      bus.onAfter(() => {
        throw new Error('Hook error');
      });
      bus.register('testAction', () => 'result');

      const result = bus.dispatch('testAction', {});

      expect(result.ok).toBe(true);
      expect(consoleError).toHaveBeenCalled();
    });

    it('should return unsubscribe function', ({ bus }) => {
      const hook = vi.fn();

      const unsubscribe = bus.onAfter(hook);
      bus.register('testAction', () => 'result');

      bus.dispatch('testAction', {});
      expect(hook).toHaveBeenCalledTimes(1);

      unsubscribe();

      bus.dispatch('testAction', {});
      expect(hook).toHaveBeenCalledTimes(1);
    });
  });
});

describe('re-entrant plugin chain', () => {
  // A plugin may call `next()` more than once per dispatch - retry() does it
  // once per attempt. Each call must replay the SAME tail of the chain, not
  // fall through to the handler because a shared cursor was already exhausted.
  it('replays every downstream plugin when an upstream plugin calls next() twice', ({ bus }) => {
    const order: string[] = [];

    bus.use((_cmd, next) => {
      order.push('outer:1');
      next();
      order.push('outer:2');
      return next();
    });
    bus.use((_cmd, next) => {
      order.push('inner');
      return next();
    });

    let handlerRuns = 0;
    bus.register('act', () => {
      handlerRuns++;
      return 'done';
    });

    const result = bus.dispatch('act', {});
    expect(result.ok).toBe(true);
    expect(handlerRuns).toBe(2);
    // 'inner' ran on both passes - it was skipped on the second before the fix.
    expect(order).toEqual(['outer:1', 'inner', 'outer:2', 'inner']);
  });

  // The reason the runner cannot use the cheaper save/restore cursor, which
  // benchmarks identically to the pre-fix shared cursor: a plugin may call
  // `next()` long AFTER it returned. debounce/throttle do exactly that from a
  // timer. With save/restore the deferred call re-enters the same plugin and
  // the handler never runs; the old shared cursor survived it only by accident
  // (its exhausted index happened to land on `execute()`).
  it('a plugin may call next() after it has already returned (deferred continuation)', async ({ bus }) => {
    const order: string[] = [];

    bus.use((_cmd, next) => {
      setTimeout(() => {
        order.push('deferred');
        next();
      }, 1);
      return { ok: true, value: 'queued' };
    });
    bus.use((_cmd, next) => {
      order.push('downstream');
      return next();
    });
    bus.register('act', () => {
      order.push('handler');
      return 'done';
    });

    expect(bus.dispatch('act', {}).value).toBe('queued');
    await new Promise((r) => setTimeout(r, 20));

    // The deferred call resumes at the SAME position it would have, not at
    // this plugin's own index and not past the rest of the chain.
    expect(order).toEqual(['deferred', 'downstream', 'handler']);
  });

  it('keeps concurrent dispatches on the async bus independent', async ({ asyncBus: bus }) => {
    const seen: string[] = [];
    bus.use(async (cmd, next) => {
      seen.push(`p1:${cmd.action}`);
      return next();
    });
    bus.use(async (cmd, next) => {
      seen.push(`p2:${cmd.action}`);
      return next();
    });
    bus.register('a', async () => 'a');
    bus.register('b', async () => 'b');

    await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);
    expect(seen.filter((s) => s.startsWith('p2:')).sort()).toEqual(['p2:a', 'p2:b']);
  });
});

describe('listener fan-out with in-flight unsubscribe', () => {
  // The self-removal case the lenBefore/i-- guard was written for.
  it('a listener that removes itself does not skip its neighbour', ({ bus }) => {
    bus.register('act', () => 1);
    const seen: string[] = [];

    bus.on('act', () => seen.push('first'));
    const off = bus.on('act', () => {
      seen.push('second');
      off();
    });
    bus.on('act', () => seen.push('third'));

    bus.dispatch('act', {});
    expect(seen).toEqual(['first', 'second', 'third']);
  });

  // The case that guard got WRONG: removing a peer that has not run yet
  // shrinks the array without moving the cursor, so decrementing re-invoked
  // the listener that had just finished.
  it('a listener that removes a LATER peer does not re-run itself', ({ bus }) => {
    bus.register('act', () => 1);
    const seen: string[] = [];

    let offSecond = () => {};
    bus.on('act', () => {
      seen.push('first');
      offSecond();
    });
    offSecond = bus.on('act', () => seen.push('second'));
    bus.on('act', () => seen.push('third'));

    bus.dispatch('act', {});
    expect(seen).toEqual(['first', 'third']); // was ['first', 'first', 'third']
  });

  it('the same holds for wildcard listeners', ({ bus }) => {
    bus.register('cartAdd', () => 1);
    const seen: string[] = [];

    let offSecond = () => {};
    bus.on('cart*', () => {
      seen.push('first');
      offSecond();
    });
    offSecond = bus.on('cart*', () => seen.push('second'));
    bus.on('cart*', () => seen.push('third'));

    bus.dispatch('cartAdd', {});
    expect(seen).toEqual(['first', 'third']);
  });

  it('a listener removing several later peers still advances correctly', ({ bus }) => {
    bus.register('act', () => 1);
    const seen: string[] = [];

    const offs: Array<() => void> = [];
    bus.on('act', () => {
      seen.push('first');
      for (const off of offs) off();
    });
    offs.push(bus.on('act', () => seen.push('second')));
    offs.push(bus.on('act', () => seen.push('third')));
    bus.on('act', () => seen.push('fourth'));

    bus.dispatch('act', {});
    expect(seen).toEqual(['first', 'fourth']);
  });

  // The exact-match catch (fanOutListeners' first loop) is covered by
  // tests/echo-bridge.test.ts; the wildcard loop has its own try/catch and
  // was never exercised with a throwing listener.
  it('a throwing wildcard listener is caught and logged, and its neighbour still runs', ({ bus }) => {
    bus.register('cartAdd', () => 1);
    using consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];

    bus.on('cart*', () => { throw new Error('wildcard listener blew up'); });
    bus.on('cart*', () => seen.push('second'));

    const result = bus.dispatch('cartAdd', {});

    expect(result.ok).toBe(true); // a listener throwing does not fail dispatch
    expect(seen).toEqual(['second']);
    expect(consoleError).toHaveBeenCalledWith('[vapor-chamber] Listener error:', expect.any(Error));
  });
});

describe('on()/once() convenience: AbortSignal + Symbol.dispose', () => {
  it('unsubscribes when the signal aborts', ({ bus }) => {
    bus.register('act', () => 1);
    const ac = new AbortController();
    const seen: string[] = [];
    bus.on('act', () => seen.push('heard'), { signal: ac.signal });

    bus.dispatch('act', {});
    ac.abort();
    bus.dispatch('act', {});

    expect(seen).toEqual(['heard']);
  });

  it('an already-aborted signal never subscribes', ({ bus }) => {
    bus.register('act', () => 1);
    const ac = new AbortController();
    ac.abort();
    const seen: string[] = [];
    bus.on('act', () => seen.push('heard'), { signal: ac.signal });

    bus.dispatch('act', {});
    expect(seen).toEqual([]);
  });

  it('calling off() manually detaches the abort listener (no leak, no double-call)', ({ bus }) => {
    bus.register('act', () => 1);
    const ac = new AbortController();
    const seen: string[] = [];
    const off = bus.on('act', () => seen.push('heard'), { signal: ac.signal });

    off();
    off(); // idempotent
    ac.abort(); // must not throw or double-invoke anything post-unsubscribe

    bus.dispatch('act', {});
    expect(seen).toEqual([]);
  });

  it('once() forwards the signal option', ({ bus }) => {
    bus.register('act', () => 1);
    const ac = new AbortController();
    const seen: string[] = [];
    bus.once('act', () => seen.push('heard'), { signal: ac.signal });

    ac.abort();
    bus.dispatch('act', {});
    expect(seen).toEqual([]);
  });

  it('the returned unsubscribe fn is tagged with Symbol.dispose for `using`', ({ bus }) => {
    bus.register('act', () => 1);
    const seen: string[] = [];
    const off = bus.on('act', () => seen.push('heard')) as unknown as { [Symbol.dispose]: () => void };

    expect(typeof off[Symbol.dispose]).toBe('function');

    {
      using _off = off as unknown as Disposable;
      bus.dispatch('act', {});
    }
    bus.dispatch('act', {});

    expect(seen).toEqual(['heard']); // second dispatch: `using` already disposed it
  });
});

describe('createAsyncCommandBus', () => {
  it('should handle async handlers', async ({ asyncBus: bus }) => {

    bus.register('asyncAction', async (cmd) => {
      await new Promise((r) => setTimeout(r, 10));
      return cmd.target.value * 2;
    });

    const result = await bus.dispatch('asyncAction', { value: 5 });

    expect(result).toSucceedWith(10);
  });

  it('should catch async errors', async ({ asyncBus: bus }) => {

    bus.register('asyncError', async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('Async error');
    });

    const result = await bus.dispatch('asyncError', {});

    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('Async error');
  });

  it('should support async plugins', async ({ asyncBus: bus }) => {
    const order: string[] = [];

    bus.use(async (_cmd, next) => {
      order.push('plugin-before');
      await new Promise((r) => setTimeout(r, 5));
      const result = await next();
      order.push('plugin-after');
      return result;
    });

    bus.register('asyncAction', async () => {
      order.push('handler');
      return 'done';
    });

    await bus.dispatch('asyncAction', {});

    expect(order).toEqual(['plugin-before', 'handler', 'plugin-after']);
  });

  it('should support async hooks', async ({ asyncBus: bus }) => {
    const hookCalled = vi.fn();

    bus.onAfter(async (_cmd, result) => {
      await new Promise((r) => setTimeout(r, 5));
      hookCalled(result);
    });

    bus.register('asyncAction', async () => 'result');

    await bus.dispatch('asyncAction', {});

    expect(hookCalled).toHaveBeenCalledWith({ ok: true, value: 'result' });
  });

  it('catches a synchronously-throwing after-hook without failing dispatch', async ({ asyncBus: bus }) => {
    using consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.onAfter(() => { throw new Error('sync hook-boom'); });
    bus.register('asyncAction', async () => 'result');

    const result = await bus.dispatch('asyncAction', {});

    expect(result).toEqual({ ok: true, value: 'result' });
    expect(consoleError).toHaveBeenCalled();
  });

  it('catches a rejecting after-hook without failing dispatch', async ({ asyncBus: bus }) => {
    using consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.onAfter(async () => { throw new Error('async hook-boom'); });
    bus.register('asyncAction', async () => 'result');

    const result = await bus.dispatch('asyncAction', {});

    expect(result).toEqual({ ok: true, value: 'result' });
    expect(consoleError).toHaveBeenCalled();
  });

  it('on()/once() forward the signal option (same shared implementation as the sync bus)', async ({ asyncBus: bus }) => {
    bus.register('act', async () => 1);
    const ac = new AbortController();
    const seen: string[] = [];
    bus.on('act', () => seen.push('heard'), { signal: ac.signal });

    ac.abort();
    await bus.dispatch('act', {});
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// configureUid
// ---------------------------------------------------------------------------

describe('configureUid', () => {
  it('replaces the id generator used by stampMeta', () => {
    let counter = 0;
    configureUid(() => `test-${++counter}`);

    const bus = createCommandBus();
    bus.register('op', (cmd) => cmd.meta?.id);
    const r1 = bus.dispatch('op', {});
    const r2 = bus.dispatch('op', {});

    // restore default before asserting so other tests are not affected
    configureUid(() => `restored-${Math.random()}`);

    expect(r1.value).toBe('test-1');
    expect(r2.value).toBe('test-2');
  });
});

// ---------------------------------------------------------------------------
// syncQuery bare-bus fast path (no plugins/hooks/listeners)
// ---------------------------------------------------------------------------

describe('syncQuery bare-bus fast path', () => {
  it('returns handler result with no plugins installed', ({ bus }) => {
    bus.register('getCount', () => 42);
    // No plugins, hooks, or listeners - exercises the bare-bus branch
    const r = bus.query('getCount', {});
    expect(r).toSucceedWith(42);
  });

  it('returns handleMissing when no handler on bare bus', ({ bus }) => {
    const r = bus.query('missing', {});
    expect(r).toFailWith('VC_CORE_NO_HANDLER');
    expect(r.error?.message).toContain('No handler');
  });

  it('uses full runner path when a plugin is installed', ({ bus }) => {
    bus.register('get', () => 1);
    const pluginSpy = vi.fn((_cmd: any, next: any) => next());
    bus.use(pluginSpy);
    bus.query('get', {});
    expect(pluginSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listenerOffAll with wildcard pattern
// ---------------------------------------------------------------------------

describe('listenerOffAll with wildcard pattern', () => {
  it('removes only the matching wildcard listener', ({ bus }) => {
    bus.register('cartAdd', () => 1);
    const cartListener = vi.fn();
    const allListener  = vi.fn();
    bus.on('cart*', cartListener);
    bus.on('*',     allListener);

    bus.offAll('cart*');
    bus.dispatch('cartAdd', {});

    expect(cartListener).not.toHaveBeenCalled();
    expect(allListener).toHaveBeenCalled(); // untouched
  });

  it('removes exact-match listener via offAll', ({ bus }) => {
    bus.register('op', () => 1);
    const listener = vi.fn();
    bus.on('op', listener);

    bus.offAll('op');
    bus.dispatch('op', {});

    expect(listener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// asyncDispatchBatch mid-flight abort with transactional rollback
// ---------------------------------------------------------------------------

describe('asyncDispatchBatch mid-flight abort', () => {
  // Assertions here are derived from the DOCUMENTED BatchOptions contract, not
  // from what the implementation happens to do:
  //   transactional - "All-or-nothing semantics: if any command fails,
  //     automatically run the registered undo handler for every command that
  //     already succeeded (in reverse order) ... Commands without an undo
  //     handler are skipped during rollback."
  //   signal - "aborting mid-flight stops further commands from dispatching
  //     (the in-flight one runs to completion) and the batch result is
  //     { ok: false, error: BusError('VC_CORE_ABORTED'), results: [...partial] }".
  //     (That doc line said `AbortError` until this pass - `abortedResult`
  //     deliberately substitutes a BusError so the code is queryable, and the
  //     doc had never been corrected to match. Fixed with this rewrite.)
  //
  // The previous version of this block passed `transactional: false` and
  // asserted only that 'c' never ran, so the branch its title named was never
  // entered; and its 'undoA' was registered as a plain ACTION, while rollback
  // only ever consults handlers registered with `{ undo }` - so even flipped
  // to true it would have proved nothing.
  it('rolls back every succeeded command, in reverse order, when the signal aborts mid-batch', async ({ asyncBus: bus }) => {
    const log: string[] = [];
    const ac = new AbortController();

    bus.register('a', async () => { log.push('a'); return 1; }, { undo: () => { log.push('undoA'); } });
    bus.register('b', async () => {
      log.push('b');
      ac.abort(); // abort mid-flight, after b has committed
      return 2;
    }, { undo: () => { log.push('undoB'); } });
    bus.register('c', async () => { log.push('c'); return 3; }, { undo: () => { log.push('undoC'); } });

    const result = await bus.dispatchBatch(
      [
        { action: 'a', target: {} },
        { action: 'b', target: {} },
        { action: 'c', target: {} },
      ],
      { signal: ac.signal, transactional: true },
    );

    expect(result).toFailWith('VC_CORE_ABORTED');
    expect(log).toEqual(['a', 'b', 'undoB', 'undoA']); // reverse order; c never dispatched
    expect(result.results).toHaveLength(2); // partial results kept for inspection
    expect(result.rollbacks).toHaveLength(2);
    expect(result.rollbacks?.every((r) => r.ok)).toBe(true);
    expect(result.successCount).toBe(0); // all-or-nothing: nothing stands
  });

  it('skips commands with no undo handler, and reports the rollbacks it did run', async ({ asyncBus: bus }) => {
    // The documented skip behaviour - the honest caveat in BatchOptions.
    const log: string[] = [];
    const ac = new AbortController();

    bus.register('withUndo', async () => { log.push('withUndo'); return 1; }, { undo: () => { log.push('undoWithUndo'); } });
    bus.register('noUndo', async () => {
      log.push('noUndo');
      ac.abort();
      return 2;
    }); // deliberately no { undo }

    const result = await bus.dispatchBatch(
      [
        { action: 'withUndo', target: {} },
        { action: 'noUndo', target: {} },
        { action: 'withUndo', target: {} },
      ],
      { signal: ac.signal, transactional: true },
    );

    expect(result).toFailWith('VC_CORE_ABORTED');
    // 'noUndo' left its side effect in place - that is the contract, not a bug.
    expect(log).toEqual(['withUndo', 'noUndo', 'undoWithUndo']);
    expect(result.rollbacks).toHaveLength(1);
    expect(result.successCount).toBe(0);
  });

  it('a mid-flight abort with NO undo handlers at all reports an empty rollback list', async ({ asyncBus: bus }) => {
    const log: string[] = [];
    const ac = new AbortController();

    bus.register('a', async () => { log.push('a'); return 1; });
    bus.register('b', async () => { log.push('b'); ac.abort(); return 2; });

    const result = await bus.dispatchBatch(
      [
        { action: 'a', target: {} },
        { action: 'b', target: {} },
        { action: 'c', target: {} },
      ],
      { signal: ac.signal, transactional: true },
    );

    expect(result).toFailWith('VC_CORE_ABORTED');
    expect(result.rollbacks).toEqual([]);
    expect(log).toEqual(['a', 'b']); // side effects persist, nothing undone
  });

  it('without transactional, an abort keeps what succeeded and runs no rollback', async ({ asyncBus: bus }) => {
    const log: string[] = [];
    const ac = new AbortController();

    bus.register('a', async () => { log.push('a'); return 1; }, { undo: () => { log.push('undoA'); } });
    bus.register('b', async () => { log.push('b'); ac.abort(); return 2; }, { undo: () => { log.push('undoB'); } });

    const result = await bus.dispatchBatch(
      [
        { action: 'a', target: {} },
        { action: 'b', target: {} },
        { action: 'c', target: {} },
      ],
      { signal: ac.signal, transactional: false },
    );

    expect(result).toFailWith('VC_CORE_ABORTED');
    expect(result.rollbacks).toBeUndefined();
    expect(result.successCount).toBe(2); // both committed and stay committed
    expect(log).toEqual(['a', 'b']); // no undo ran; 'c' never dispatched
  });

  it('dev-warns when transactional and continueOnError are both set', async () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('a', async () => 1);

    await bus.dispatchBatch([{ action: 'a', target: {} }], {
      transactional: true,
      continueOnError: true,
    });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mutually exclusive'));
  });

  // The test above only proves the warning FIRES when DEV is true (the
  // vitest default). It never proves silence in production, on either of
  // DEV's two resolution paths - same gap class devWarnThenableResult and
  // the onMissing:'buffer' overflow warning had. Closing both here.

  it('warnBatchOptionConflict is silent when __VC_DEV__=false (IIFE build path)', async () => {
    using _VC_DEV = stubGlobal('__VC_DEV__', false);
    vi.resetModules();
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createAsyncCommandBus: freshCreateAsyncCommandBus } = await import('../src/command-bus');
    const bus = freshCreateAsyncCommandBus();
    bus.register('a', async () => 1);

    await bus.dispatchBatch([{ action: 'a', target: {} }], {
      transactional: true,
      continueOnError: true,
    });

    expect(warn).not.toHaveBeenCalled();
    vi.resetModules();
  });

  it('warnBatchOptionConflict is silent when NODE_ENV=production (ESM consumer path)', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createAsyncCommandBus: freshCreateAsyncCommandBus } = await import('../src/command-bus');
    const bus = freshCreateAsyncCommandBus();
    bus.register('a', async () => 1);

    await bus.dispatchBatch([{ action: 'a', target: {} }], {
      transactional: true,
      continueOnError: true,
    });

    expect(warn).not.toHaveBeenCalled();
    vi.resetModules();
  });
});

describe('per-instance throttle timers - async bus', () => {
  it('dispose clears a pending throttle timer (mirrors the sync-bus test above)', async () => {
    const bus1 = createAsyncCommandBus();
    const bus2 = createAsyncCommandBus();

    bus1.register('a', async () => 1, { throttle: 10000 });
    bus2.register('a', async () => 2, { throttle: 10000 });

    // First dispatch on each - goes through, parks a timer in each bus's own
    // s.throttleTimers.
    const r1 = await bus1.dispatch('a', {});
    const r2 = await bus2.dispatch('a', {});
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Dispose bus1 while its timer is still pending - asyncDispose() must
    // clear it, not just clear listeners/handlers.
    bus1.dispose();

    // Bus2 is untouched - still throttled.
    const r3 = await bus2.dispatch('a', {});
    expect(r3).toFailWith('VC_CORE_THROTTLED');
    expect(r3.error?.message).toContain('throttled');

    bus2.dispose();
  });
});

describe('async before-hook: plain synchronous throw + after-hooks registered', () => {
  // tests/command-bus-features.test.ts:2521 covers `onBefore(async () => { throw })`
  // - an async function's synchronous throw is actually a REJECTED PROMISE, so
  // that test exercises the thenable/await branch, not a plain sync hook. It
  // also registers no onAfter, so the "await the after-hooks promise from
  // inside the catch" branch never runs either. This test is the mirror image
  // of both, and also proves the documented contract that after-hooks still
  // fire when a before-hook cancels the dispatch (observability is intact).
  it('a plain (non-async) onBefore hook that throws still runs after-hooks', async ({ asyncBus: bus }) => {
    let handlerRan = false;
    const afterCalls: Array<{ action: string; ok: boolean }> = [];

    bus.register('act', async () => { handlerRan = true; return 1; });
    bus.onBefore((_cmd) => { throw new Error('sync-blocked'); }); // not async - no Promise involved
    bus.onAfter((cmd, result) => { afterCalls.push({ action: cmd.action, ok: result.ok }); });

    const result = await bus.dispatch('act', {});

    expect(result).toFailWith('VC_CORE_BEFORE_CANCEL');
    expect(result.error?.message).toBe('sync-blocked');
    expect(handlerRan).toBe(false);
    expect(afterCalls).toEqual([{ action: 'act', ok: false }]); // after-hook still fired
  });
});

describe('devWarnThenableResult - folds away in production, both DEV paths', () => {
  // DEV is a module-level const captured at import time (see src/dev.ts and
  // tests/dev-flag.test.ts), so flipping it means stubbing the build-time
  // global (or the NODE_ENV fallback) and re-importing fresh - vitest
  // supplies no __VC_DEV__ define, so every other test in this file runs
  // with the runtime fallback (DEV: true).
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('a sync bus with a thenable-returning plugin does not warn when __VC_DEV__=false (IIFE build path)', async () => {
    vi.stubGlobal('__VC_DEV__', false);
    vi.resetModules(); // command-bus.ts is already cached from this file's top-level import
    using consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createCommandBus: freshCreateCommandBus } = await import('../src/command-bus');
    const bus = freshCreateCommandBus();
    // A plain (non-`async`) function that returns a thenable - isAsyncFn()
    // only catches literal `async` functions at use()-time (an unconditional,
    // non-DEV-gated warning); this shape reaches devWarnThenableResult's
    // dispatch-time behavioral check instead, which IS the one gated by DEV.
    bus.use(((_cmd: unknown, next: () => unknown) => Promise.resolve(next())) as never); // thenable result on a SYNC bus - the warning under test
    bus.register('act', () => 1);

    bus.dispatch('act', {});

    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('the same does not warn when NODE_ENV=production (ESM consumer path, no __VC_DEV__ define)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    using consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { createCommandBus: freshCreateCommandBus } = await import('../src/command-bus');
    const bus = freshCreateCommandBus();
    bus.use(((_cmd: unknown, next: () => unknown) => Promise.resolve(next())) as never); // thenable result on a SYNC bus - the warning under test
    bus.register('act', () => 1);

    bus.dispatch('act', {});

    expect(consoleWarn).not.toHaveBeenCalled();
  });
});
