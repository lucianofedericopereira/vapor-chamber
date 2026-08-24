/**
 * Tests for I/O plugins: retry, persist, sync
 */

import { describe, it, expect, beforeEach, vi, } from 'vitest';
import { createCommandBus, createAsyncCommandBus, resetCommandBus, retry, BusError } from '../src/index';
import { persist, sync } from '../src/plugins';

// ---------------------------------------------------------------------------
// persist plugin
// ---------------------------------------------------------------------------

describe('persist plugin', () => {
  let mockStorage: { data: Record<string, string> } & Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

  beforeEach(() => {
    resetCommandBus();
    mockStorage = {
      data: {},
      getItem: (key: string) => mockStorage.data[key] ?? null,
      setItem: (key: string, value: string) => { mockStorage.data[key] = value; },
      removeItem: (key: string) => { delete mockStorage.data[key]; },
    };
  });

  it('saves state after each successful command', () => {
    const bus = createCommandBus();
    let count = 0;

    bus.register('inc', () => { count++; });

    const p = persist({
      key: 'test',
      getState: () => ({ count }),
      storage: mockStorage,
    });
    bus.use(p);

    bus.dispatch('inc', {});
    expect(mockStorage.data.test).toBe(JSON.stringify({ count: 1 }));

    bus.dispatch('inc', {});
    expect(mockStorage.data.test).toBe(JSON.stringify({ count: 2 }));
  });

  it('does not save after failed commands', () => {
    const bus = createCommandBus();
    bus.register('fail', () => { throw new Error('boom'); });

    const p = persist({ key: 'test', getState: () => ({ x: 1 }), storage: mockStorage });
    bus.use(p);

    bus.dispatch('fail', {});
    expect(mockStorage.data.test).toBeUndefined();
  });

  it('load() returns null when nothing stored', () => {
    const p = persist({ key: 'empty', getState: () => ({}), storage: mockStorage });
    expect(p.load()).toBeNull();
  });

  it('load() returns deserialized state', () => {
    mockStorage.data.cart = JSON.stringify({ items: [1, 2], total: 50 });

    const p = persist({ key: 'cart', getState: () => ({}), storage: mockStorage });
    expect(p.load()).toEqual({ items: [1, 2], total: 50 });
  });

  it('load() returns null on invalid JSON', () => {
    mockStorage.data.bad = 'not valid json {{';
    const p = persist({ key: 'bad', getState: () => ({}), storage: mockStorage });
    expect(p.load()).toBeNull();
  });

  it('clear() removes the stored entry', () => {
    mockStorage.data.key = '{"x":1}';
    const p = persist({ key: 'key', getState: () => ({}), storage: mockStorage });
    p.clear();
    expect(mockStorage.data.key).toBeUndefined();
  });

  it('save() manually persists current state', () => {
    const val = 99;
    const p = persist({ key: 'manual', getState: () => ({ val }), storage: mockStorage });
    p.save();
    expect(JSON.parse(mockStorage.data.manual)).toEqual({ val: 99 });
  });

  it('filter prevents save for non-matching commands', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => {});
    bus.register('analyticsTrack', () => {});

    const p = persist({
      key: 'filtered',
      getState: () => ({ saved: true }),
      storage: mockStorage,
      filter: (cmd) => cmd.action.startsWith('cart'),
    });
    bus.use(p);

    bus.dispatch('analyticsTrack', {});
    expect(mockStorage.data.filtered).toBeUndefined();

    bus.dispatch('cartAdd', {});
    expect(mockStorage.data.filtered).toBeDefined();
  });

  it('custom serialize/deserialize', () => {
    const bus = createCommandBus();
    bus.register('cmd', () => {});

    const p = persist({
      key: 'custom',
      getState: () => ({ n: 42 }),
      storage: mockStorage,
      serialize: (v) => `CUSTOM:${JSON.stringify(v)}`,
      deserialize: (s) => JSON.parse(s.replace('CUSTOM:', '')),
    });
    bus.use(p);

    bus.dispatch('cmd', {});
    expect(mockStorage.data.custom).toBe('CUSTOM:{"n":42}');

    const loaded = p.load();
    expect(loaded).toEqual({ n: 42 });
  });

  it('save() is a no-op when storage is unavailable', () => {
    // No globalThis.localStorage in test env — should not throw
    const p = persist({ key: 'x', getState: () => ({}), storage: undefined });
    expect(() => p.save()).not.toThrow();
    expect(() => p.load()).not.toThrow();
    expect(() => p.clear()).not.toThrow();
  });

  it('validate option accepts valid state', () => {
    mockStorage.data.cart = JSON.stringify({ items: [1, 2], total: 50 });

    const p = persist({
      key: 'cart',
      getState: () => ({}),
      storage: mockStorage,
      validate: (state: any) => Array.isArray(state.items) && typeof state.total === 'number',
    });

    expect(p.load()).toEqual({ items: [1, 2], total: 50 });
  });

  it('validate option rejects invalid state and returns null', () => {
    // Stale shape: missing 'total' field after a deploy
    mockStorage.data.cart = JSON.stringify({ items: [1, 2] });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const p = persist({
      key: 'cart',
      getState: () => ({}),
      storage: mockStorage,
      validate: (state: any) => Array.isArray(state.items) && typeof state.total === 'number',
    });

    expect(p.load()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('validation failed for key "cart"'),
    );

    warnSpy.mockRestore();
  });

  it('validate option rejects completely wrong shape', () => {
    mockStorage.data.prefs = JSON.stringify('just a string');

    const p = persist({
      key: 'prefs',
      getState: () => ({}),
      storage: mockStorage,
      validate: (state: any) => typeof state === 'object' && state !== null && 'theme' in state,
    });

    expect(p.load()).toBeNull();
  });

  it('validate is not called when storage is empty', () => {
    const validateFn = vi.fn(() => true);

    const p = persist({
      key: 'empty',
      getState: () => ({}),
      storage: mockStorage,
      validate: validateFn,
    });

    expect(p.load()).toBeNull();
    expect(validateFn).not.toHaveBeenCalled();
  });

  it('validate is not called when deserialize returns null', () => {
    mockStorage.data.bad = 'not valid json';
    const validateFn = vi.fn(() => true);

    const p = persist({
      key: 'bad',
      getState: () => ({}),
      storage: mockStorage,
      validate: validateFn,
    });

    expect(p.load()).toBeNull();
    expect(validateFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// sync plugin (BroadcastChannel)
// ---------------------------------------------------------------------------

describe('sync plugin', () => {
  type BcMessage = { __vc: boolean; action: string; target: any; payload?: any };

  function makeMockBroadcastChannel() {
    const listeners: Array<(event: { data: any }) => void> = [];
    const posted: BcMessage[] = [];
    let closed = false;
    let _onmessage: ((event: { data: any }) => void) | null = null;

    const bc = {
      postMessage: vi.fn((data: BcMessage) => { posted.push(data); }),
      close: vi.fn(() => { closed = true; }),
      get onmessage() { return _onmessage; },
      set onmessage(fn: ((event: { data: any }) => void) | null) {
        _onmessage = fn;
        if (fn) listeners.push(fn);
      },
      // Test helper: simulate a message arriving from another tab
      simulateMessage(data: BcMessage) {
        listeners.forEach(fn => { fn({ data }); });
      },
      get isClosed() { return closed; },
      posted,
    };
    return bc;
  }

  // Constructor stub — `new BroadcastChannel(...)` returns the mock instance
  function makeBcConstructor(mockBc: ReturnType<typeof makeMockBroadcastChannel>) {
    return function MockBroadcastChannel(_channel: string) {
      return mockBc;
    } as unknown as typeof BroadcastChannel;
  }

  beforeEach(() => {
    resetCommandBus();
  });

  it('broadcasts successful dispatches to other tabs', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    bus.register('cartAdd', () => 'added');

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(mockBc.postMessage).toHaveBeenCalledWith({
      __vc: true,
      action: 'cartAdd',
      target: { id: 1 },
      payload: { qty: 2 },
    });

    vi.unstubAllGlobals();
  });

  it('does not broadcast failed dispatches', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    bus.register('fail', () => { throw new Error('nope'); });

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    bus.dispatch('fail', {});
    expect(mockBc.postMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not broadcast when an ASYNC dispatch rejects', async () => {
    // The async arm settles the promise before deciding to broadcast. Its
    // `.catch` had no coverage: a handler that throws resolves to
    // `{ ok: false }` (covered above), so only a REJECTED dispatch — a
    // downstream plugin or transport failing outright — reaches it. Without
    // the catch this would also surface as an unhandled rejection.
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 'added');

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync, { priority: 100 });
    // Lower priority = INSIDE sync, so this is what sync's `next()` returns.
    bus.use(() => Promise.reject(new Error('transport down')) as any, { priority: 50 });

    await expect(bus.dispatch('cartAdd', { id: 1 }, { qty: 2 })).rejects.toThrow('transport down');
    await Promise.resolve(); // let the plugin's own .then/.catch settle

    expect(mockBc.postMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('does not broadcast an ASYNC dispatch that settles ok:false', async () => {
    // The other half of `if (settled?.ok)`. On an async bus a throwing handler
    // RESOLVES to `{ ok: false }` rather than rejecting, so this is a distinct
    // path from the rejection test above — and the async counterpart of the
    // sync "does not broadcast failed dispatches" case.
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createAsyncCommandBus();
    bus.register('fail', async () => { throw new Error('nope'); });
    bus.register('work', async () => 'done');

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    const failed = await bus.dispatch('fail', {});
    expect(failed.ok).toBe(false);
    await Promise.resolve();
    expect(mockBc.postMessage).not.toHaveBeenCalled();

    // ...and the same bus still broadcasts a successful async dispatch, so the
    // silence above is the failure, not a dead plugin.
    await bus.dispatch('work', { id: 1 });
    await Promise.resolve();
    expect(mockBc.postMessage).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it('re-dispatches received messages locally', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    const received: string[] = [];
    bus.register('remoteAction', (cmd) => { received.push(cmd.target.data); });

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    // Simulate another tab sending a message
    mockBc.simulateMessage({ __vc: true, action: 'remoteAction', target: { data: 'from-tab-b' } });

    expect(received).toContain('from-tab-b');

    vi.unstubAllGlobals();
  });

  it('delivers a received payload untouched and attributes it via meta.origin', () => {
    // Was: asserted a shape-dependent normalization — objects spread with
    // `__origin: 'sync'`, primitives and arrays passed through bare. That
    // asymmetry WAS the echo bug: the shapes that could not carry the key
    // arrived unattributed and got re-broadcast. With `_withOrigin` the
    // marker is out-of-band, so every shape is attributed identically and the
    // payload reaches the handler exactly as the sending tab wrote it.
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    const seen: any[] = [];
    const origins: unknown[] = [];
    bus.register('remote', (cmd) => {
      seen.push(cmd.payload);
      origins.push(cmd.meta?.origin);
      return 1;
    });

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    mockBc.simulateMessage({ __vc: true, action: 'remote', target: {}, payload: { qty: 2 } });
    mockBc.simulateMessage({ __vc: true, action: 'remote', target: {}, payload: 42 });
    mockBc.simulateMessage({ __vc: true, action: 'remote', target: {}, payload: ['a', 'b'] });
    mockBc.simulateMessage({ __vc: true, action: 'remote', target: {} });

    // No marker key injected into user data, whatever the shape.
    expect(seen[0]).toEqual({ qty: 2 });
    expect(seen[1]).toBe(42);
    expect(seen[2]).toEqual(['a', 'b']);
    expect(seen[3]).toBeUndefined(); // absent stays absent — no synthetic object

    // ...and every one of them is attributed, which is what suppresses the echo.
    expect(origins).toEqual(['sync', 'sync', 'sync', 'sync']);

    vi.unstubAllGlobals();
  });

  it('suppresses the echo for EVERY payload shape, not just markable ones', () => {
    // Regression. `meta.origin` is derived by stampMeta from a `__origin` key
    // in the PAYLOAD, so it can only mark plain objects and the absent case.
    // Primitives and arrays reached the plugin unmarked and were re-broadcast:
    // two tabs ping-ponging forever, each hop a real dispatch through
    // handlers, plugins and transports. Measured before the fix — object and
    // absent were suppressed; number, string, boolean and array all echoed.
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    bus.register('remote', () => 1);

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    const receive = (payload: unknown, omit = false) => {
      mockBc.posted.length = 0;
      (mockBc.postMessage as any).mockClear?.();
      mockBc.simulateMessage({
        __vc: true,
        action: 'remote',
        target: {},
        ...(omit ? {} : { payload }),
      } as any);
      return mockBc.posted.length;
    };

    expect(receive({ qty: 2 })).toBe(0); // markable — was already suppressed
    expect(receive(undefined, true)).toBe(0); // markable
    expect(receive(42)).toBe(0); // was 1 (echo)
    expect(receive('hello')).toBe(0); // was 1 (echo)
    expect(receive(false)).toBe(0); // was 1 (echo)
    expect(receive(['a', 'b'])).toBe(0); // was 1 (echo)

    // The suppression must be scoped to received commands only — a genuine
    // LOCAL dispatch with a primitive payload still has to go out, or the fix
    // would have traded an echo loop for silent cross-tab breakage.
    mockBc.posted.length = 0;
    bus.dispatch('remote', { id: 1 }, 99);
    expect(mockBc.posted).toHaveLength(1);
    expect(mockBc.posted[0]).toMatchObject({ action: 'remote', payload: 99 });

    vi.unstubAllGlobals();
  });

  it('suppresses the echo for unmarkable payloads on an ASYNC bus too', async () => {
    // The async arm decides a microtask after next() settles, so the echo flag
    // must be captured synchronously at plugin entry — this is the case the
    // old `receiving = true` flag got wrong.
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createAsyncCommandBus();
    bus.register('remote', async () => 1);

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    mockBc.simulateMessage({ __vc: true, action: 'remote', target: {}, payload: 42 });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBc.posted).toHaveLength(0);

    mockBc.simulateMessage({ __vc: true, action: 'remote', target: {}, payload: ['a', 'b'] });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBc.posted).toHaveLength(0);

    // ...and a local async dispatch still broadcasts.
    await bus.dispatch('remote', { id: 1 }, 7);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockBc.posted).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('does not re-broadcast received messages (no echo)', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    bus.register('msg', () => {});

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    mockBc.simulateMessage({ __vc: true, action: 'msg', target: {} });

    // The re-dispatch of the received message should NOT be re-broadcast
    expect(mockBc.postMessage).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('filter limits which actions are broadcast', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    bus.register('cartAdd', () => {});
    bus.register('analyticsTrack', () => {});

    const tabSync = sync(
      { channel: 'test', filter: (cmd) => cmd.action.startsWith('cart') },
      { dispatch: bus.dispatch.bind(bus) }
    );
    bus.use(tabSync);

    bus.dispatch('analyticsTrack', {});
    expect(mockBc.postMessage).not.toHaveBeenCalled();

    bus.dispatch('cartAdd', { id: 1 });
    expect(mockBc.postMessage).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });

  it('close() closes the BroadcastChannel', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    tabSync.close();
    expect(mockBc.close).toHaveBeenCalled();
    expect(tabSync.isOpen()).toBe(false);

    vi.unstubAllGlobals();
  });

  it('ignores non-vc messages', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    const seen: string[] = [];
    bus.onAfter((cmd) => seen.push(cmd.action));

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    // Malformed / foreign message — should be ignored
    mockBc.simulateMessage({ __vc: false, action: 'evil', target: {} });
    mockBc.simulateMessage(null as any);
    mockBc.simulateMessage({} as any);

    expect(seen).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('is a no-op when BroadcastChannel is not available', () => {
    // Stub BroadcastChannel as undefined (e.g. SSR / Node)
    vi.stubGlobal('BroadcastChannel', undefined);

    const bus = createCommandBus();
    bus.register('cmd', () => {});

    const tabSync = sync({ channel: 'test' }, { dispatch: bus.dispatch.bind(bus) });
    bus.use(tabSync);

    expect(() => bus.dispatch('cmd', {})).not.toThrow();
    expect(tabSync.isOpen()).toBe(false);

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// retry plugin
// ---------------------------------------------------------------------------

describe('retry plugin', () => {
  it('returns success immediately if first attempt succeeds', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3 }));

    let attempts = 0;
    bus.register('fetch', async () => {
      attempts++;
      return 'data';
    });

    const result = await bus.dispatch('fetch', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('data');
    expect(attempts).toBe(1);
  });

  it('retries on failure and succeeds on 3rd attempt', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0, strategy: 'fixed' }));

    let attempts = 0;
    bus.register('flaky', async () => {
      attempts++;
      if (attempts < 3) throw new Error('not yet');
      return 'ok';
    });

    const result = await bus.dispatch('flaky', {});
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it('returns last error after exhausting maxAttempts', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 2, baseDelay: 0 }));

    let attempts = 0;
    bus.register('alwaysFail', async () => {
      attempts++;
      throw new Error('permanent');
    });

    const result = await bus.dispatch('alwaysFail', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('permanent');
    expect(attempts).toBe(2);
  });

  it('respects actions filter — skips retry for unmatched actions', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0, actions: ['api*'] }));

    let attempts = 0;
    bus.register('otherFail', async () => {
      attempts++;
      throw new Error('nope');
    });

    const result = await bus.dispatch('otherFail', {});
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1); // no retry
  });

  it('isRetryable can stop early', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({
      maxAttempts: 5,
      baseDelay: 0,
      isRetryable: (err) => err.message !== 'fatal',
    }));

    let attempts = 0;
    bus.register('cmd', async () => {
      attempts++;
      throw new Error('fatal');
    });

    const result = await bus.dispatch('cmd', {});
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it('exponential strategy increases delays', () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay: number) => {
      delays.push(delay);
      fn();
      return 0 as any;
    }) as typeof setTimeout);

    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 4, baseDelay: 100, strategy: 'exponential' }));

    let attempts = 0;
    bus.register('cmd', async () => {
      attempts++;
      if (attempts < 4) throw new Error('retry me');
      return 'done';
    });

    bus.dispatch('cmd', {}).then(() => {
      expect(delays.slice(0, 3)).toEqual([100, 200, 400]);
      vi.restoreAllMocks();
    });
  });

  it('default predicate stops immediately on a non-retryable BusError', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 4, baseDelay: 0 }));

    let attempts = 0;
    bus.register('save', async () => {
      attempts++;
      throw new BusError('VC_VALIDATION_FAILED', 'bad payload', { emitter: 'schema' });
    });

    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(attempts).toBe(1); // permanent code — no retries wasted
  });

  it('default predicate keeps retrying retryable BusError codes', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));

    let attempts = 0;
    bus.register('call', async () => {
      attempts++;
      throw new BusError('VC_CORE_REQUEST_TIMEOUT', 'timed out', { emitter: 'core' });
    });

    const result = await bus.dispatch('call', {});
    expect(result.ok).toBe(false);
    expect(attempts).toBe(3); // transient code — retried to maxAttempts
  });

  it('default predicate still retries plain (non-Bus) errors, even with a code field', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));

    let attempts = 0;
    bus.register('read', async () => {
      attempts++;
      const err = new Error('no such file') as Error & { code: string };
      err.code = 'ENOENT'; // non-VC_ code — behaves like a plain error
      throw err;
    });

    const result = await bus.dispatch('read', {});
    expect(result.ok).toBe(false);
    expect(attempts).toBe(3); // unchanged pre-v1.3 behavior for plain errors
  });

  // Every test above installs retry as the ONLY plugin, where re-invoking
  // `next()` lands on `execute()` and accidentally works. Composition is the
  // real contract: retry calls `next()` once per attempt, so every plugin
  // downstream of it must run on every attempt.
  it('runs downstream plugins on every attempt, not just the first', async () => {
    const bus = createAsyncCommandBus();
    const seen: number[] = [];
    bus.use(retry({ maxAttempts: 3, baseDelay: 0, strategy: 'fixed' }));
    bus.use(async (_cmd, next) => {
      seen.push(seen.length + 1);
      return next();
    });

    let attempts = 0;
    bus.register('flaky', async () => {
      attempts++;
      if (attempts < 3) throw new Error('not yet');
      return 'ok';
    });

    const result = await bus.dispatch('flaky', {});
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
    expect(seen).toHaveLength(3); // was 1 — attempts 2+ skipped the whole tail
  });

  it('reaches a downstream transport on the retried attempt', async () => {
    // The canonical pairing: retry() outer, createHttpBridge inner. With a
    // shared cursor, attempt 2 skipped the bridge and resolved against the
    // local handler instead — the retry reported an outcome the server never
    // saw. Modelled here with a mock bridge that never calls next().
    const bus = createAsyncCommandBus();
    let bridgeCalls = 0;
    bus.use(retry({ maxAttempts: 3, baseDelay: 0, strategy: 'fixed' }));
    bus.use(async () => {
      bridgeCalls++;
      if (bridgeCalls < 3) return { ok: false, error: new Error('502') };
      return { ok: true, value: 'from server' };
    });

    let localHandlerRuns = 0;
    bus.register('save', async () => {
      localHandlerRuns++;
      return 'from local handler';
    });

    const result = await bus.dispatch('save', {});
    expect(bridgeCalls).toBe(3);
    expect(result.value).toBe('from server');
    expect(localHandlerRuns).toBe(0); // the bridge terminates the chain, always
  });
});
