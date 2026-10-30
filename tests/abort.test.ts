/**
 * AbortSignal on dispatch, request, dispatchBatch and the HTTP/WS bridges.
 * Why: a cancelled command must not run, or must stop waiting, and still report.
 * Shows: pre-abort skips the handler, mid-flight abort settles core:aborted:dispatch, after-hooks fire, sync ignores it.
 */
import { describe, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAsyncCommandBus, BusError, type Command } from '../src/command-bus';
import { httpTransport, wsTransport } from '../src/transports';
import { it } from '../src/vitest';

/** The WS bridge timeout; the mid-flight assertion is a fraction of it. */
const WS_TIMEOUT = 10_000;

describe('AbortController - async dispatch', () => {
  it('pre-aborted signal short-circuits with core:aborted:dispatch, handler is NOT called', async ({ asyncBus: bus }) => {
    const handler = vi.fn(async () => 'never');
    bus.register('hot', handler);

    const ac = new AbortController();
    ac.abort();

    const result = await bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(result).toFailWith('core:aborted:dispatch');
    expect(handler).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(BusError);
  });

  it('pre-aborted with custom reason surfaces the reason as the error', async ({ asyncBus: bus }) => {
    bus.register('hot', async () => 'ok');

    const ac = new AbortController();
    const reason = new Error('user cancelled');
    ac.abort(reason);

    const result = await bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(reason);
  });

  it('handler can observe cmd.signal mid-flight and react to abort', async ({ asyncBus: bus }) => {
    let observedSignal: AbortSignal | undefined;
    let abortObserved = false;
    // Abort once the handler says it started; a sleep loses the race under coverage.
    let handlerStarted!: () => void;
    const started = new Promise<void>((r) => { handlerStarted = r; });

    bus.register('long', async (cmd) => {
      observedSignal = cmd.signal;
      handlerStarted();
      // Simulate a handler that polls cmd.signal.aborted.
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          if (cmd.signal?.aborted) {
            abortObserved = true;
            clearInterval(t);
            resolve();
          }
        }, 1);
        // Safety net: never hang the test if the abort never fires.
        setTimeout(() => { clearInterval(t); resolve(); }, 200);
      });
      return 'completed';
    });

    const ac = new AbortController();
    const dispatchPromise = bus.dispatch('long', null, undefined, { signal: ac.signal });

    // The handler is provably running, so the abort cannot arrive before it.
    await started;
    ac.abort();

    await dispatchPromise;
    expect(observedSignal).toBeDefined();
    expect(abortObserved).toBe(true);
  });

  it('after-hooks fire for aborted dispatches (observability stays intact)', async ({ asyncBus: bus }) => {
    bus.register('hot', async () => 'ok');

    const afterHook = vi.fn();
    bus.onAfter(afterHook);

    const ac = new AbortController();
    ac.abort();

    await bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(afterHook).toHaveBeenCalledOnce();
    const [cmd, result] = afterHook.mock.calls[0]!;
    expect(cmd.action).toBe('hot');
    expect(result).toFailWith('core:aborted:dispatch');
  });

  it('cmd.signal is undefined when no options.signal is passed (no leak from prior dispatch)', async ({ asyncBus: bus }) => {
    let captured: Command | undefined;
    bus.register('plain', async (cmd) => { captured = cmd; return 'ok'; });

    await bus.dispatch('plain', null);
    expect(captured?.signal).toBeUndefined();

    // Now dispatch with a signal - make sure subsequent plain dispatch doesn't see it.
    const ac = new AbortController();
    await bus.dispatch('plain', null, undefined, { signal: ac.signal });
    expect(captured?.signal).toBe(ac.signal);

    await bus.dispatch('plain', null);
    expect(captured?.signal).toBeUndefined();
  });

  it('non-aborted dispatch with a signal completes normally', async ({ asyncBus: bus }) => {
    bus.register('hot', async (cmd) => cmd.target);

    const ac = new AbortController();
    const result = await bus.dispatch('hot', 42, undefined, { signal: ac.signal });

    expect(result).toSucceedWith(42);
  });
});

describe('AbortController - HTTP bridge auto-propagation', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('cmd.signal is forwarded to fetch when no bridge-level signal is configured', async () => {
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify({ state: { ok: true } }), { status: 200 });
    }) as any;

    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api' }) });

    const ac = new AbortController();
    await bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: ac.signal });

    expect(capturedInit?.signal).toBeDefined();
    // The forwarded signal may be the original signal or an AbortSignal.any
    // composition - both must be triggerable by aborting `ac`.
    const forwarded = capturedInit!.signal as AbortSignal;
    expect(forwarded.aborted).toBe(false);
    ac.abort();
    expect(forwarded.aborted).toBe(true);
  });
});

describe('AbortController - sync bus accepts but ignores signal', () => {
  it('sync dispatch with { signal } runs the handler regardless (signal is ignored)', ({ bus }) => {
    const handler = vi.fn(() => 'ok');
    bus.register('hot', handler);

    const ac = new AbortController();
    ac.abort();

    const result = bus.dispatch('hot', null, undefined, { signal: ac.signal });

    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });
});

describe('AbortController - bus.request() with signal', () => {
  it('pre-aborted signal short-circuits with core:aborted:dispatch, responder NOT called', async ({ asyncBus: bus }) => {
    const responder = vi.fn(async () => 'never');
    bus.respond('q', responder);

    const ac = new AbortController();
    ac.abort();

    const result = await bus.request('q', { id: 1 }, undefined, { signal: ac.signal });

    expect(result).toFailWith('core:aborted:dispatch');
    expect(responder).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(BusError);
  });

  it('mid-flight abort wins the race against responder + timeout', async ({ asyncBus: bus }) => {
    // Abort once the responder is running; ordering a test asserts must be awaited, not timed.
    let responderStarted!: () => void;
    const started = new Promise<void>((r) => { responderStarted = r; });

    bus.respond('slow', async () => {
      responderStarted();
      await new Promise(r => setTimeout(r, 200));
      return 'too late';
    });

    const ac = new AbortController();
    const pending = bus.request('slow', null, undefined, { timeout: 5000, signal: ac.signal });
    await started;
    ac.abort();
    const result = await pending;

    expect(result).toFailWith('core:aborted:dispatch');
    expect(result.error).toBeInstanceOf(BusError);
  });

  it('non-aborted request completes normally', async ({ asyncBus: bus }) => {
    bus.respond('q', async (cmd) => cmd.target);

    const ac = new AbortController();
    const result = await bus.request('q', 'hello', undefined, { signal: ac.signal });

    expect(result).toSucceedWith('hello');
  });
});

describe('AbortController - bus.dispatchBatch() with signal', () => {
  it('pre-aborted batch returns immediately with empty results', async ({ asyncBus: bus }) => {
    const handler = vi.fn(async () => 'ok');
    bus.register('a', handler);
    bus.register('b', handler);

    const ac = new AbortController();
    ac.abort();

    const result = await bus.dispatchBatch(
      [{ action: 'a', target: 1 }, { action: 'b', target: 2 }],
      { signal: ac.signal },
    );

    expect(result).toFailWith('core:aborted:dispatch');
    expect(result.results).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    expect(result.error).toBeInstanceOf(BusError);
  });

  it('mid-batch abort stops further dispatches; partial results preserved', async ({ asyncBus: bus }) => {
    let calls = 0;
    // Abort after the first command completes and before the fourth starts.
    let firstDone!: () => void;
    const afterFirst = new Promise<void>((r) => { firstDone = r; });

    bus.register('step', async (cmd) => {
      calls++;
      // Simulate work - abort triggers between commands
      await new Promise(r => setTimeout(r, 5));
      if (calls === 1) firstDone();
      return cmd.target;
    });

    const ac = new AbortController();
    const pending = bus.dispatchBatch(
      [
        { action: 'step', target: 1 },
        { action: 'step', target: 2 },
        { action: 'step', target: 3 },
        { action: 'step', target: 4 },
      ],
      { continueOnError: true, signal: ac.signal },
    );
    await afterFirst;
    ac.abort();
    const result = await pending;

    expect(result).toFailWith('core:aborted:dispatch');
    // At least one command should have completed before abort fired.
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    // Not all four should have run (abort stopped further dispatch).
    expect(calls).toBeLessThan(4);
  });

  it('non-aborted batch completes normally', async ({ asyncBus: bus }) => {
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

describe('AbortController - WS bridge propagation', () => {
  // Minimal fake WebSocket that the bridge can drive. We don't actually send
  // anything - the test is about whether cmd.signal cancels the *waiting*.
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

  it('pre-aborted signal short-circuits - message is NOT sent', async () => {
    const ws = wsTransport({ url: 'ws://test' });
    const bus = createAsyncCommandBus({ transport: ws });
    ws.connect();
    await new Promise(r => queueMicrotask(() => r(null))); // let onopen fire

    const ac = new AbortController();
    ac.abort();

    const result = await bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: ac.signal });

    expect(result).toFailWith('core:aborted:dispatch');
    ws.disconnect();
  });

  it('mid-flight abort settles the pending request without waiting for server', async () => {
    const ws = wsTransport({ url: 'ws://test', timeout: WS_TIMEOUT });
    const bus = createAsyncCommandBus({ transport: ws });
    ws.connect();
    await new Promise(r => queueMicrotask(() => r(null)));

    const ac = new AbortController();
    const dispatchPromise = bus.dispatch('cartAdd', { id: 1 }, undefined, { signal: ac.signal });

    // A timer on purpose: nothing answers, so there is no event to await (5 ms vs 10 s).
    setTimeout(() => ac.abort(), 5);

    const start = Date.now();
    const result = await dispatchPromise;
    const elapsed = Date.now() - start;

    expect(result).toFailWith('core:aborted:dispatch');
    // A quarter of the timeout proves the short-circuit on any machine.
    expect(elapsed).toBeLessThan(WS_TIMEOUT / 4);
    ws.disconnect();
  });
});

describe('AbortController - child signal propagation pattern', () => {
  it('handler can pass cmd.signal to nested dispatches for explicit propagation', async ({ asyncBus: bus }) => {
    let childSawAbort = false;

    // Abort once the child is running, not after a timed guess.
    let childStarted!: () => void;
    const started = new Promise<void>((r) => { childStarted = r; });

    bus.register('child', async (cmd) => {
      childStarted();
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

    await started;
    ac.abort();
    await dispatchPromise;

    expect(childSawAbort).toBe(true);
  });
});
