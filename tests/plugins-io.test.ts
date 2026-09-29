/**
 * Tests for I/O plugins: persist, createChannel
 */

import { describe, expect, beforeEach, vi } from 'vitest';
import { createAsyncCommandBus, resetCommandBus } from '../src/index';
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
