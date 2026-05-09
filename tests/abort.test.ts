/**
 * AbortController integration — async bus + HTTP bridge propagation.
 *
 * Locks v1.2.x behavior:
 *   • Pre-aborted signal → resolves immediately with VC_CORE_ABORTED, handler not invoked.
 *   • Mid-flight abort → handler observes `cmd.signal.aborted === true`.
 *   • HTTP bridge auto-propagates `cmd.signal` to fetch — no manual wiring required.
 *   • After-hooks fire even for aborted dispatches (observability stays intact).
 *
 * Out of scope (deferred to v1.3):
 *   - Sync bus signal propagation (sync dispatches are atomic; signal is ignored).
 *   - bus.request() / respond() integration.
 *   - bus.dispatchBatch() with per-command AbortSignal.any() composition.
 *   - Auto-derived child signals from parent dispatches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncCommandBus, createCommandBus, BusError, type Command } from '../src/command-bus';
import { createHttpBridge, createWsBridge } from '../src/transports';

describe('AbortController — async dispatch', () => {
  it('pre-aborted signal short-circuits with VC_CORE_ABORTED, handler is NOT called', async () => {
    const bus = createAsyncCommandBus();
    const handler = vi.fn(async () => 'never');
    bus.register('hot', handler);

    const ac = new AbortController();
    ac.abort();

    const result = await bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(BusError);
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
  });

  it('pre-aborted with custom reason surfaces the reason as the error', async () => {
    const bus = createAsyncCommandBus();
    bus.register('hot', async () => 'ok');

    const ac = new AbortController();
    const reason = new Error('user cancelled');
    ac.abort(reason);

    const result = await bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(reason);
  });

  it('handler can observe cmd.signal mid-flight and react to abort', async () => {
    const bus = createAsyncCommandBus();
    let observedSignal: AbortSignal | undefined;
    let abortObserved = false;

    bus.register('long', async (cmd) => {
      observedSignal = cmd.signal;
      // Simulate a handler that polls cmd.signal.aborted.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (cmd.signal?.aborted) {
            abortObserved = true;
            clearInterval(t);
            resolve();
          }
        }, 1);
        // Safety net — never hang the test if abort never fires.
        setTimeout(() => { clearInterval(t); resolve(); }, 200);
      });
      return 'completed';
    });

    const ac = new AbortController();
    const dispatchPromise = bus.dispatch('long', null, undefined, { signal: ac.signal });

    // Let the handler start, then abort.
    await new Promise(r => setTimeout(r, 5));
    ac.abort();

    await dispatchPromise;
    expect(observedSignal).toBeDefined();
    expect(abortObserved).toBe(true);
  });

  it('after-hooks fire for aborted dispatches (observability stays intact)', async () => {
    const bus = createAsyncCommandBus();
    bus.register('hot', async () => 'ok');

    const afterHook = vi.fn();
    bus.onAfter(afterHook);

    const ac = new AbortController();
    ac.abort();

    await bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(afterHook).toHaveBeenCalledOnce();
    const [cmd, result] = afterHook.mock.calls[0]!;
    expect(cmd.action).toBe('hot');
    expect(result.ok).toBe(false);
  });

  it('cmd.signal is undefined when no options.signal is passed (no leak from prior dispatch)', async () => {
    const bus = createAsyncCommandBus();
    let captured: Command | undefined;
    bus.register('plain', async (cmd) => { captured = cmd; return 'ok'; });

    await bus.dispatch('plain', null);
    expect(captured?.signal).toBeUndefined();

    // Now dispatch with a signal — make sure subsequent plain dispatch doesn't see it.
    const ac = new AbortController();
    await bus.dispatch('plain', null, undefined, { signal: ac.signal });
    expect(captured?.signal).toBe(ac.signal);

    await bus.dispatch('plain', null);
    expect(captured?.signal).toBeUndefined();
  });

  it('non-aborted dispatch with a signal completes normally', async () => {
    const bus = createAsyncCommandBus();
    bus.register('hot', async (cmd) => cmd.target);

    const ac = new AbortController();
    const result = await bus.dispatch('hot', 42, undefined, { signal: ac.signal });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
  });
});

describe('AbortController — HTTP bridge auto-propagation', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('cmd.signal is forwarded to fetch when no bridge-level signal is configured', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ state: { ok: true } }), { status: 200 });
    }) as any;

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api' }));

    const ac = new AbortController();
    await bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: ac.signal });

    expect(capturedInit?.signal).toBeDefined();
    // The forwarded signal may be the original signal or an AbortSignal.any
    // composition — both must be triggerable by aborting `ac`.
    const forwarded = capturedInit!.signal as AbortSignal;
    expect(forwarded.aborted).toBe(false);
    ac.abort();
    expect(forwarded.aborted).toBe(true);
  });
});

describe('AbortController — sync bus accepts but ignores signal', () => {
  it('sync dispatch with { signal } runs the handler regardless (signal is ignored)', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'ok');
    bus.register('hot', handler);

    const ac = new AbortController();
    ac.abort();

    // Cast through `any` only because TS infers the strict generic — at runtime
    // the BaseBus signature accepts the 4th arg; sync just discards the signal.
    const result = bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });
});

describe('AbortController — bus.request() with signal', () => {
  it('pre-aborted signal short-circuits with VC_CORE_ABORTED, responder NOT called', async () => {
    const bus = createAsyncCommandBus();
    const responder = vi.fn(async () => 'never');
    bus.respond('q', responder);

    const ac = new AbortController();
    ac.abort();

    const result = await bus.request('q', { id: 1 }, undefined, { signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(responder).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(BusError);
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
  });

  it('mid-flight abort wins the race against responder + timeout', async () => {
    const bus = createAsyncCommandBus();
    bus.respond('slow', async () => {
      await new Promise(r => setTimeout(r, 200));
      return 'too late';
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);

    const result = await bus.request('slow', null, undefined, { timeout: 5000, signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(BusError);
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
  });

  it('non-aborted request completes normally', async () => {
    const bus = createAsyncCommandBus();
    bus.respond('q', async (cmd) => cmd.target);

    const ac = new AbortController();
    const result = await bus.request('q', 'hello', undefined, { signal: ac.signal });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('hello');
  });
});

describe('AbortController — bus.dispatchBatch() with signal', () => {
  it('pre-aborted batch returns immediately with empty results', async () => {
    const bus = createAsyncCommandBus();
    const handler = vi.fn(async () => 'ok');
    bus.register('a', handler);
    bus.register('b', handler);

    const ac = new AbortController();
    ac.abort();

    const result = await bus.dispatchBatch(
      [{ action: 'a', target: 1 }, { action: 'b', target: 2 }],
      { signal: ac.signal },
    );

    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(BusError);
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
  });

  it('mid-batch abort stops further dispatches; partial results preserved', async () => {
    const bus = createAsyncCommandBus();
    let calls = 0;
    bus.register('step', async (cmd) => {
      calls++;
      // Simulate work — abort triggers between commands
      await new Promise(r => setTimeout(r, 5));
      return cmd.target;
    });

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 12);

    const result = await bus.dispatchBatch(
      [
        { action: 'step', target: 1 },
        { action: 'step', target: 2 },
        { action: 'step', target: 3 },
        { action: 'step', target: 4 },
      ],
      { continueOnError: true, signal: ac.signal },
    );

    expect(result.ok).toBe(false);
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
    // At least one command should have completed before abort fired.
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // Not all four should have run (abort stopped further dispatch).
    expect(calls).toBeLessThan(4);
  });

  it('non-aborted batch completes normally', async () => {
    const bus = createAsyncCommandBus();
    bus.register('a', async (cmd) => cmd.target);
    bus.register('b', async (cmd) => cmd.target);

    const result = await bus.dispatchBatch(
      [{ action: 'a', target: 1 }, { action: 'b', target: 2 }],
      { signal: new AbortController().signal },
    );

    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
  });
});

describe('AbortController — WS bridge propagation', () => {
  // Minimal fake WebSocket that the bridge can drive. We don't actually send
  // anything — the test is about whether cmd.signal cancels the *waiting*.
  class FakeWebSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: any = null;
    onmessage: any = null;
    onclose: any = null;
    onerror: any = null;
    sent: string[] = [];
    constructor(public url: string) {
      // Defer onopen so the bridge sees readyState=1 immediately on send().
      queueMicrotask(() => this.onopen?.());
    }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; }
  }

  let originalWS: any;
  beforeEach(() => { originalWS = (globalThis as any).WebSocket; (globalThis as any).WebSocket = FakeWebSocket; });
  afterEach(() => { (globalThis as any).WebSocket = originalWS; });

  it('pre-aborted signal short-circuits — message is NOT sent', async () => {
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://test' });
    ws.connect();
    bus.use(ws);
    await new Promise(r => queueMicrotask(() => r(null))); // let onopen fire

    const ac = new AbortController();
    ac.abort();

    const result = await bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: ac.signal });

    expect(result.ok).toBe(false);
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
    ws.disconnect();
  });

  it('mid-flight abort settles the pending request without waiting for server', async () => {
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://test', timeout: 10_000 });
    ws.connect();
    bus.use(ws);
    await new Promise(r => queueMicrotask(() => r(null)));

    const ac = new AbortController();
    const dispatchPromise = bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: ac.signal });

    // No server → without abort, this would wait the full 10s timeout.
    setTimeout(() => ac.abort(), 5);

    const start = Date.now();
    const result = await dispatchPromise;
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    expect(elapsed).toBeLessThan(500); // Way faster than the 10s timeout
    expect((result.error as BusError).code).toBe('VC_CORE_ABORTED');
    ws.disconnect();
  });
});

describe('AbortController — child signal propagation pattern', () => {
  it('handler can pass cmd.signal to nested dispatches for explicit propagation', async () => {
    const bus = createAsyncCommandBus();
    let childSawAbort = false;

    bus.register('child', async (cmd) => {
      // Wait long enough that parent abort can trigger
      await new Promise(r => setTimeout(r, 30));
      childSawAbort = cmd.signal?.aborted ?? false;
      return 'child done';
    });

    bus.register('parent', async (cmd) => {
      // Explicit propagation: parent threads cmd.signal to child
      return await bus.dispatch('child', null, undefined, { signal: cmd.signal });
    });

    const ac = new AbortController();
    const dispatchPromise = bus.dispatch('parent', null, undefined, { signal: ac.signal });

    setTimeout(() => ac.abort(), 5);
    await dispatchPromise;

    expect(childSawAbort).toBe(true);
  });
});
