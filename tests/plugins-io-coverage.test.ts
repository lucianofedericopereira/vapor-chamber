/**
 * Coverage-focused tests for I/O plugins (retry, persist, sync).
 *
 * Targets previously-uncovered lines in src/plugins-io.ts:
 *   159        — getStorage() falling back to globalThis.localStorage
 *   168        — save() catch branch (storage.setItem throws)
 *   185-186    — load() catch branch (storage.getItem / deserialize throws)
 *   194        — clear() catch branch (storage.removeItem throws)
 *   200-202    — scheduleSave() coalescing (microtask flush + early return)
 *   207-209    — coalesce plugin branch (schedules a single save per burst)
 *   259        — sync() called without a busRef (warning path)
 *   279-280    — sync onReceive returning false suppresses re-dispatch
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createCommandBus, resetCommandBus } from '../src/index';
import { persist, sync } from '../src/plugins';

// ---------------------------------------------------------------------------
// persist plugin — storage fallback, error handling, coalescing
// ---------------------------------------------------------------------------

describe('persist plugin — coverage', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetCommandBus();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('falls back to globalThis.localStorage when no storage option is given (line 159)', () => {
    const data: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => { data[k] = v; },
      removeItem: (k: string) => { delete data[k]; },
    };
    // Drive getStorage() into the globalThis.localStorage branch (line 159).
    vi.stubGlobal('localStorage', fakeLocalStorage);

    const p = persist({ key: 'fallback', getState: () => ({ n: 7 }) });

    p.save();
    expect(data.fallback).toBe(JSON.stringify({ n: 7 }));

    // load() goes through the same global-storage branch and round-trips.
    expect(p.load()).toEqual({ n: 7 });

    // clear() too.
    p.clear();
    expect(data.fallback).toBeUndefined();
  });

  it('save() swallows and warns when storage.setItem throws (line 168)', () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => {},
    };

    const p = persist({ key: 'quota', getState: () => ({ big: true }), storage: throwingStorage });

    expect(() => p.save()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to save key "quota"'),
      expect.any(Error),
    );
  });

  it('load() swallows and warns when storage.getItem throws (lines 185-186)', () => {
    const throwingStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => {},
      removeItem: () => {},
    };

    const p = persist({ key: 'blocked', getState: () => ({}), storage: throwingStorage });

    let result: unknown;
    expect(() => { result = p.load(); }).not.toThrow();
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to load key "blocked"'),
      expect.any(Error),
    );
  });

  it('load() swallows and warns when deserialize throws (lines 185-186)', () => {
    const data: Record<string, string> = { weird: 'raw-value' };
    const storage = {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => { data[k] = v; },
      removeItem: (k: string) => { delete data[k]; },
    };

    const p = persist({
      key: 'weird',
      getState: () => ({}),
      storage,
      // A deserialize that throws (rather than returning null) reaches the
      // outer try/catch in load().
      deserialize: () => { throw new Error('bad shape'); },
    });

    expect(p.load()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to load key "weird"'),
      expect.any(Error),
    );
  });

  it('clear() swallows and warns when storage.removeItem throws (line 194)', () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { throw new Error('cannot remove'); },
    };

    const p = persist({ key: 'stuck', getState: () => ({}), storage: throwingStorage });

    expect(() => p.clear()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to clear key "stuck"'),
      expect.any(Error),
    );
  });

  it('coalesce collapses a burst of saves into a single setItem (lines 200-209)', async () => {
    const bus = createCommandBus();
    let count = 0;
    bus.register('inc', () => { count++; });

    let setCalls = 0;
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => { setCalls++; data[k] = v; },
      removeItem: (k: string) => { delete data[k]; },
    };

    const p = persist({
      key: 'coalesced',
      getState: () => ({ count }),
      storage,
      coalesce: true,
    });
    bus.use(p);

    // Three rapid dispatches in the same microtask burst. Each goes through
    // the coalesce plugin branch (lines 207-209) and calls scheduleSave().
    // The first sets _saveScheduled = true (lines 200-202); the next two hit
    // the early return at line 200.
    bus.dispatch('inc', {});
    bus.dispatch('inc', {});
    bus.dispatch('inc', {});

    // Nothing written yet — the flush is deferred to a microtask.
    expect(setCalls).toBe(0);

    // Let the queued microtask run.
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one setItem for the whole burst, capturing the latest state.
    expect(setCalls).toBe(1);
    expect(data.coalesced).toBe(JSON.stringify({ count: 3 }));

    // A second, separate burst schedules and flushes again (re-arms the flag).
    bus.dispatch('inc', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(setCalls).toBe(2);
    expect(data.coalesced).toBe(JSON.stringify({ count: 4 }));
  });

  it('coalesce respects filter (line 208) — non-matching command schedules no save', async () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => {});
    bus.register('analyticsTrack', () => {});

    let setCalls = 0;
    const data: Record<string, string> = {};
    const storage = {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem: (k: string, v: string) => { setCalls++; data[k] = v; },
      removeItem: (k: string) => { delete data[k]; },
    };

    const p = persist({
      key: 'coalesced-filtered',
      getState: () => ({ ok: true }),
      storage,
      coalesce: true,
      filter: (cmd) => cmd.action.startsWith('cart'),
    });
    bus.use(p);

    bus.dispatch('analyticsTrack', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(setCalls).toBe(0);

    bus.dispatch('cartAdd', {});
    await Promise.resolve();
    await Promise.resolve();
    expect(setCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sync plugin — busRef-less warning + onReceive suppression
// ---------------------------------------------------------------------------

describe('sync plugin — coverage', () => {
  type BcMessage = { __vc: boolean; action: string; target: any; payload?: any };

  function makeMockBroadcastChannel() {
    const listeners: Array<(event: { data: any }) => void> = [];
    const posted: BcMessage[] = [];
    let _onmessage: ((event: { data: any }) => void) | null = null;

    const bc = {
      postMessage: vi.fn((data: BcMessage) => { posted.push(data); }),
      close: vi.fn(),
      get onmessage() { return _onmessage; },
      set onmessage(fn: ((event: { data: any }) => void) | null) {
        _onmessage = fn;
        if (fn) listeners.push(fn);
      },
      simulateMessage(data: BcMessage) {
        listeners.forEach(fn => { fn({ data }); });
      },
      posted,
    };
    return bc;
  }

  function makeBcConstructor(mockBc: ReturnType<typeof makeMockBroadcastChannel>) {
    return function MockBroadcastChannel(_channel: string) {
      return mockBc;
    } as unknown as typeof BroadcastChannel;
  }

  beforeEach(() => {
    resetCommandBus();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warns when called without a busRef (line 259)', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // No second argument → busRef?.dispatch is falsy → warning path (line 259).
    const tabSync = sync({ channel: 'no-busref' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sync() called without busRef'),
    );

    // Without a localDispatch, a received message is not re-dispatched and
    // must not throw.
    expect(() => {
      mockBc.simulateMessage({ __vc: true, action: 'whatever', target: {} });
    }).not.toThrow();

    warnSpy.mockRestore();
  });

  it('onReceive returning false suppresses re-dispatch (lines 279-280)', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    const dispatched: string[] = [];
    bus.register('remoteAction', (cmd) => { dispatched.push(cmd.target?.data); });

    const seen: string[] = [];
    const tabSync = sync(
      {
        channel: 'gated',
        onReceive: (cmd) => {
          seen.push(cmd.action);
          return false; // veto re-dispatch (line 280 early return)
        },
      },
      { dispatch: bus.dispatch.bind(bus) },
    );
    bus.use(tabSync);

    mockBc.simulateMessage({ __vc: true, action: 'remoteAction', target: { data: 'blocked' } });

    // onReceive ran and saw the command...
    expect(seen).toEqual(['remoteAction']);
    // ...but the veto prevented local re-dispatch.
    expect(dispatched).toHaveLength(0);
  });

  it('onReceive returning a non-false value still re-dispatches (line 279 truthy branch)', () => {
    const mockBc = makeMockBroadcastChannel();
    vi.stubGlobal('BroadcastChannel', makeBcConstructor(mockBc));

    const bus = createCommandBus();
    const dispatched: string[] = [];
    bus.register('remoteAction', (cmd) => { dispatched.push(cmd.target?.data); });

    const tabSync = sync(
      {
        channel: 'allowed',
        // Returning undefined (no explicit false) lets the message through.
        onReceive: () => undefined,
      },
      { dispatch: bus.dispatch.bind(bus) },
    );
    bus.use(tabSync);

    mockBc.simulateMessage({ __vc: true, action: 'remoteAction', target: { data: 'allowed-through' } });

    expect(dispatched).toContain('allowed-through');
  });
});
