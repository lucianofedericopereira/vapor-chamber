/**
 * Tests for I/O plugins: retry, persist, createChannel
 */

import { describe, expect, beforeEach, vi } from 'vitest';
import { createAsyncCommandBus, resetCommandBus, retry, BusError } from '../src/index';
import { persist, createChannel } from '../src/plugins';
import { createFastLane } from '../src/fast-lane';
import { stubGlobal } from '../src/vitest-pure';
import { it } from '../src/vitest';

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

  it('saves state after each successful command', ({ bus }) => {
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

  it('does not save after failed commands', ({ bus }) => {
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

  it('filter prevents save for non-matching commands', ({ bus }) => {
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

  it('custom serialize/deserialize', ({ bus }) => {
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
    // No globalThis.localStorage in test env - should not throw
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
// createChannel (BroadcastChannel over an event channel)
// ---------------------------------------------------------------------------

describe('createChannel', () => {
  // A REAL BroadcastChannel and a REAL fast lane, not mocks. The suite that
  // stood here used a hand-written channel stub, and a stub cannot show what
  // this bridge exists to fix: the old plugin re-dispatched the command in the
  // receiving tab, so two tabs re-derived the outcome independently, and a
  // stub that records `postMessage` calls agrees with that shape whatever it
  // does. Node provides BroadcastChannel, two instances in one process talk to
  // each other, and a sender does not receive its own message - which is the
  // real contract worth testing against. Each test takes its own channel name
  // so the tests do not hear each other, and closes what it opens.
  let channelSeq = 0;
  const nextChannel = () => `vc:test:sync:${++channelSeq}`;
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5)); };

  /** One "tab": its own lane, its own bridge, applying facts to its own state. */
  function openTab(channel: string, events = ['cartAdded']) {
    const lane = createFastLane();
    const applied: unknown[] = [];
    for (const e of events) lane.on(e, (data: unknown) => { applied.push(data); });
    const bridge = createChannel({ channel, lane, events });
    return { lane, applied, bridge };
  }

  beforeEach(() => {
    resetCommandBus();
  });

  it('mirrors an emitted fact to another tab', async () => {
    const ch = nextChannel();
    const a = openTab(ch), b = openTab(ch);
    a.lane.emit('cartAdded', { count: 1, name: 'Coffee' });
    await flush();

    expect(a.applied).toEqual([{ count: 1, name: 'Coffee' }]);
    expect(b.applied).toEqual([{ count: 1, name: 'Coffee' }]);
    a.bridge.close(); b.bridge.close();
  });

  it('applies the sender\'s values instead of re-deriving them', async () => {
    // The reason the bridge carries facts rather than commands. Both tabs run
    // the same non-deterministic producer; only the sender's value may survive.
    const ch = nextChannel();
    const a = openTab(ch), b = openTab(ch);
    const mint = (tab: string) => ({ id: `${tab}-${Math.random()}` });
    a.lane.emit('cartAdded', mint('A'));
    await flush();

    expect(b.applied).toEqual(a.applied);
    expect((b.applied[0] as { id: string }).id.startsWith('A-')).toBe(true);
    a.bridge.close(); b.bridge.close();
  });

  it('does not echo a received fact back out', async () => {
    // Three tabs: one emit must produce exactly one apply each, not a storm.
    const ch = nextChannel();
    const a = openTab(ch), b = openTab(ch), c = openTab(ch);
    a.lane.emit('cartAdded', { count: 1 });
    await flush();

    expect(a.applied).toHaveLength(1);
    expect(b.applied).toHaveLength(1);
    expect(c.applied).toHaveLength(1);
    a.bridge.close(); b.bridge.close(); c.bridge.close();
  });

  it('only the named events cross', async () => {
    const ch = nextChannel();
    const a = openTab(ch, ['cartAdded']), b = openTab(ch, ['cartAdded']);
    // `cartRecalc` is emitted but never named, so it stays in the tab that
    // emitted it - which is how a derivation is kept local.
    const bSawRecalc: unknown[] = [];
    b.lane.on('cartRecalc', (d: unknown) => { bSawRecalc.push(d); });
    a.lane.emit('cartRecalc', { derived: true });
    a.lane.emit('cartAdded', { count: 1 });
    await flush();

    expect(b.applied).toEqual([{ count: 1 }]);
    expect(bSawRecalc).toEqual([]);
    a.bridge.close(); b.bridge.close();
  });

  it('onReceive returning false drops the fact', async () => {
    const ch = nextChannel();
    const a = openTab(ch);
    const lane = createFastLane();
    const applied: unknown[] = [];
    lane.on('cartAdded', (d: unknown) => { applied.push(d); });
    const seen: Array<[string, unknown]> = [];
    const bridge = createChannel({
      channel: ch, lane, events: ['cartAdded'],
      onReceive: (event, data) => { seen.push([event, data]); return false; },
    });

    a.lane.emit('cartAdded', { count: 1 });
    await flush();

    expect(seen).toEqual([['cartAdded', { count: 1 }]]);
    expect(applied).toEqual([]);
    a.bridge.close(); bridge.close();
  });

  it('onReceive returning a non-false value still applies the fact', async () => {
    const ch = nextChannel();
    const a = openTab(ch);
    const lane = createFastLane();
    const applied: unknown[] = [];
    lane.on('cartAdded', (d: unknown) => { applied.push(d); });
    const bridge = createChannel({ channel: ch, lane, events: ['cartAdded'], onReceive: () => undefined });

    a.lane.emit('cartAdded', { count: 2 });
    await flush();

    expect(applied).toEqual([{ count: 2 }]);
    a.bridge.close(); bridge.close();
  });

  it('ignores messages that are not ours', async () => {
    const ch = nextChannel();
    const b = openTab(ch);
    const foreign = new BroadcastChannel(ch);
    foreign.postMessage({ __vc: false, event: 'cartAdded', data: { evil: true } });
    foreign.postMessage(null);
    foreign.postMessage({});
    await flush();

    expect(b.applied).toEqual([]);
    foreign.close(); b.bridge.close();
  });

  it('close() stops the bridge and unsubscribes from the lane', async () => {
    const ch = nextChannel();
    const a = openTab(ch), b = openTab(ch);
    expect(b.bridge.isOpen()).toBe(true);
    b.bridge.close();
    expect(b.bridge.isOpen()).toBe(false);

    a.lane.emit('cartAdded', { count: 1 });
    await flush();
    expect(b.applied).toEqual([]);

    // The closed tab's own lane still works; only the bridge is gone, and its
    // send-side listener must be off the lane too or it would post on a
    // closed channel.
    b.lane.emit('cartAdded', { count: 99 });
    expect(b.applied).toEqual([{ count: 99 }]);
    a.bridge.close();
  });

  it('is a no-op when BroadcastChannel is not available', () => {
    using _bc = stubGlobal('BroadcastChannel', undefined);
    const lane = createFastLane();
    const applied: unknown[] = [];
    lane.on('cartAdded', (d: unknown) => { applied.push(d); });
    const bridge = createChannel({ channel: 'ssr', lane, events: ['cartAdded'] });

    expect(bridge.isOpen()).toBe(false);
    expect(() => { lane.emit('cartAdded', { count: 1 }); }).not.toThrow();
    expect(applied).toEqual([{ count: 1 }]);
    bridge.close();
  });

  it('a payload that cannot be cloned warns in DEV and leaves the local emit standing', () => {
    // DataCloneError is thrown synchronously by postMessage. The local
    // listeners registered after the bridge must still run.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ch = nextChannel();
    const lane = createFastLane();
    const bridge = createChannel({ channel: ch, lane, events: ['cartAdded'] });
    const after: unknown[] = [];
    lane.on('cartAdded', (d: unknown) => { after.push(d); });

    expect(() => { lane.emit('cartAdded', { fn: () => 'nope' }); }).not.toThrow();
    expect(after).toHaveLength(1);
    const said = warn.mock.calls.map((c) => String(c[0]));
    expect(said.some((m) => m.includes('did not cross'))).toBe(true);
    expect(said.some((m) => m.includes('cartAdded'))).toBe(true);

    warn.mockRestore();
    bridge.close();
  });

  it('...and says nothing in production', async () => {
    // `DEV` is a module-level const, so the env has to move BEFORE the module
    // is evaluated - stubbing it around an already-imported `sync` changes
    // nothing. Same shape as the directive plugin's production test.
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const { createChannel: prodChannel } = await import('../src/plugins-io');
      const { createFastLane: prodLane } = await import('../src/fast-lane');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const lane = prodLane();
      const bridge = prodChannel({ channel: nextChannel(), lane, events: ['cartAdded'] });

      expect(() => { lane.emit('cartAdded', { fn: () => 'nope' }); }).not.toThrow();
      const ours = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[vapor-chamber]'));
      expect(ours).toEqual([]);

      warn.mockRestore();
      bridge.close();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  it('is independent of any command bus, sync or async', async () => {
    // What "item 24 - createChannel() on an async bus does not loop" used to guard.
    // The bridge no longer touches the dispatch chain at all, so the async bus
    // cannot produce a loop: there is nothing for it to re-enter. Pinned by
    // running a real async dispatch alongside and counting the applies.
    const ch = nextChannel();
    const a = openTab(ch), b = openTab(ch);
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => { a.lane.emit('cartAdded', { count: 1 }); });

    await bus.dispatch('cartAdd', {});
    await flush();

    expect(a.applied).toHaveLength(1);
    expect(b.applied).toHaveLength(1);
    a.bridge.close(); b.bridge.close();
  });
});

// ---------------------------------------------------------------------------
// retry plugin
// ---------------------------------------------------------------------------

describe('retry plugin', () => {
  it('returns success immediately if first attempt succeeds', async ({ asyncBus: bus }) => {
    bus.use(retry({ maxAttempts: 3 }));

    let attempts = 0;
    bus.register('fetch', async () => {
      attempts++;
      return 'data';
    });

    const result = await bus.dispatch('fetch', {});
    expect(result).toSucceedWith('data');
    expect(attempts).toBe(1);
  });

  // `next()` is called only inside the retry loop, so a bound under 1 meant
  // the command never reached its handler: the plugin returned its own
  // placeholder and every matching action failed with "No attempts made",
  // which reads like an internal fault rather than a bad option. Measured at
  // 0, -1 and NaN - the handler ran zero times in each case.
  it('still dispatches once when maxAttempts is unusable', async () => {
    for (const bound of [0, -1, Number('nope')]) {
      const bus = createAsyncCommandBus();
      bus.use(retry({ maxAttempts: bound, baseDelay: 0 }));

      let attempts = 0;
      bus.register('fetch', async () => { attempts++; return 'data'; });

      const result = await bus.dispatch('fetch', {});
      expect(result.ok, `maxAttempts ${bound}`).toBe(true);
      expect(result.value).toBe('data');
      expect(attempts, `maxAttempts ${bound}`).toBe(1); // floored to a single attempt
    }
  });

  // setTimeout stores its delay in a signed 32-bit int; Node clamps anything
  // larger to 1ms, so an uncapped exponential backoff INVERTS - the longest
  // waits become the shortest, precisely when the remote is least able to take
  // them. Measured before the cap: delays reached 53,687,091,200ms and five of
  // thirty were over the ceiling.
  it('caps the computed backoff at the setTimeout ceiling', async () => {
    const MAX = 2_147_483_647;
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as any).setTimeout = ((fn: () => void, ms: number) => {
      delays.push(ms);
      return realSetTimeout(fn, 0);
    }) as unknown as typeof globalThis.setTimeout;

    try {
      const plugin = retry({ maxAttempts: 30, baseDelay: 200 });
      await plugin({ action: 'save', target: {}, meta: {} } as any, () =>
        ({ ok: false, error: new Error('boom') }) as any);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(delays.length).toBe(29); // one wait between each pair of attempts
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX);
    expect(delays[0]).toBe(200); // early backoff is untouched
    expect(delays[10]).toBe(204_800);
  });

  it('retries on failure and succeeds on 3rd attempt', async ({ asyncBus: bus }) => {
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

  it('returns last error after exhausting maxAttempts', async ({ asyncBus: bus }) => {
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

  it('respects actions filter - skips retry for unmatched actions', async ({ asyncBus: bus }) => {
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

  it('isRetryable can stop early', async ({ asyncBus: bus }) => {
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

  it('default predicate stops immediately on a non-retryable BusError', async ({ asyncBus: bus }) => {
    bus.use(retry({ maxAttempts: 4, baseDelay: 0 }));

    let attempts = 0;
    bus.register('save', async () => {
      attempts++;
      throw new BusError('VC_VALIDATION_FAILED', 'bad payload', { emitter: 'schema' });
    });

    const result = await bus.dispatch('save', {});
    expect(result).toFailWith('VC_VALIDATION_FAILED');
    expect(attempts).toBe(1); // permanent code - no retries wasted
  });

  it('default predicate keeps retrying retryable BusError codes', async ({ asyncBus: bus }) => {
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));

    let attempts = 0;
    bus.register('call', async () => {
      attempts++;
      throw new BusError('VC_CORE_REQUEST_TIMEOUT', 'timed out', { emitter: 'core' });
    });

    const result = await bus.dispatch('call', {});
    expect(result).toFailWith('VC_CORE_REQUEST_TIMEOUT');
    expect(attempts).toBe(3); // transient code - retried to maxAttempts
  });

  it('default predicate does not re-run a VC_PLUGIN_THREW (a plugin bug throws again)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 4, baseDelay: 0 }), { priority: 10 });
    let calls = 0;
    bus.use(() => { calls++; throw new Error('plugin bug'); }, { priority: 1 });
    bus.register('call', async () => 'never');

    const result = await bus.dispatch('call', {});
    expect((result.error as { code?: string }).code).toBe('VC_PLUGIN_THREW');
    expect(calls).toBe(1); // not in RETRYABLE_CODES - one attempt, no backoff
  });

  it('default predicate still retries plain (non-Bus) errors, even with a code field', async ({ asyncBus: bus }) => {
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));

    let attempts = 0;
    bus.register('read', async () => {
      attempts++;
      const err = new Error('no such file') as Error & { code: string };
      err.code = 'ENOENT'; // non-VC_ code - behaves like a plain error
      throw err;
    });

    const result = await bus.dispatch('read', {});
    expect(result).toFailWith('ENOENT');
    expect(attempts).toBe(3); // unchanged pre-v1.3 behavior for plain errors
  });

  // Every test above installs retry as the ONLY plugin, where re-invoking
  // `next()` lands on `execute()` and accidentally works. Composition is the
  // real contract: retry calls `next()` once per attempt, so every plugin
  // downstream of it must run on every attempt.
  it('runs downstream plugins on every attempt, not just the first', async ({ asyncBus: bus }) => {
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
    expect(seen).toHaveLength(3); // was 1 - attempts 2+ skipped the whole tail
  });

  it('reaches a downstream transport on the retried attempt', async ({ asyncBus: bus }) => {
    // The canonical pairing: retry() outer, createHttpBridge inner. With a
    // shared cursor, attempt 2 skipped the bridge and resolved against the
    // local handler instead - the retry reported an outcome the server never
    // saw. Modelled here with a mock bridge that never calls next().
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
