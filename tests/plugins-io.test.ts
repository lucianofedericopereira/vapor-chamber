/**
 * Tests for I/O plugins: retry, persist, sync
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, resetCommandBus, setCommandBus, retry } from '../src/index';
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
    expect(mockStorage.data['test']).toBe(JSON.stringify({ count: 1 }));

    bus.dispatch('inc', {});
    expect(mockStorage.data['test']).toBe(JSON.stringify({ count: 2 }));
  });

  it('does not save after failed commands', () => {
    const bus = createCommandBus();
    bus.register('fail', () => { throw new Error('boom'); });

    const p = persist({ key: 'test', getState: () => ({ x: 1 }), storage: mockStorage });
    bus.use(p);

    bus.dispatch('fail', {});
    expect(mockStorage.data['test']).toBeUndefined();
  });

  it('load() returns null when nothing stored', () => {
    const p = persist({ key: 'empty', getState: () => ({}), storage: mockStorage });
    expect(p.load()).toBeNull();
  });

  it('load() returns deserialized state', () => {
    mockStorage.data['cart'] = JSON.stringify({ items: [1, 2], total: 50 });

    const p = persist({ key: 'cart', getState: () => ({}), storage: mockStorage });
    expect(p.load()).toEqual({ items: [1, 2], total: 50 });
  });

  it('load() returns null on invalid JSON', () => {
    mockStorage.data['bad'] = 'not valid json {{';
    const p = persist({ key: 'bad', getState: () => ({}), storage: mockStorage });
    expect(p.load()).toBeNull();
  });

  it('clear() removes the stored entry', () => {
    mockStorage.data['key'] = '{"x":1}';
    const p = persist({ key: 'key', getState: () => ({}), storage: mockStorage });
    p.clear();
    expect(mockStorage.data['key']).toBeUndefined();
  });

  it('save() manually persists current state', () => {
    let val = 99;
    const p = persist({ key: 'manual', getState: () => ({ val }), storage: mockStorage });
    p.save();
    expect(JSON.parse(mockStorage.data['manual'])).toEqual({ val: 99 });
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
    expect(mockStorage.data['filtered']).toBeUndefined();

    bus.dispatch('cartAdd', {});
    expect(mockStorage.data['filtered']).toBeDefined();
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
    expect(mockStorage.data['custom']).toBe('CUSTOM:{"n":42}');

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
        listeners.forEach(fn => fn({ data }));
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
});
