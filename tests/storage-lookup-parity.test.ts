/**
 * persist and the outbox against the same four storage failures: none, quota, corrupt JSON, blocked.
 * Why: a storage that is missing, full, corrupt or blocked must never fail a dispatch or throw to the app; an unreadable `localStorage` getter would otherwise fail every dispatch that saves.
 * Shows: with a working storage both round-trip one state; under each failure the dispatch result, the loaded state and whether the console warned are the same for persist and the outbox (corrupt JSON dispatches nothing and loads nothing, silently).
 * See: log s35.207, s35.208, s36.F5
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { defineTransport } from '../src/transports';
import { defineChamberStore } from '../src/store/core';
import { saveTo } from '../src/store-persist';

const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.restoreAllMocks();
});

/** A working Storage over a Map; `quota` makes setItem throw as a full browser store does. */
function memoryStorage(quota = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (quota) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); },
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

type Case = 'working' | 'none' | 'quota' | 'blocked' | 'corrupt';
function install(c: Case) {
  if (c === 'blocked') {
    // Site data blocked: reading `localStorage` itself throws, which `typeof` does not guard.
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    return;
  }
  if (c === 'none') {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined, writable: true });
    return;
  }
  const s = memoryStorage(c === 'quota');
  if (c === 'corrupt') { s.m.set('vc:p', '{not json'); s.m.set('vc:o', '{not json'); }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: s, writable: true });
}

/** What an app sees from a store's persist: a write's result, then the state a new store reads. */
async function persistSees(c: Case) {
  install(c);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const useP = defineChamberStore('p', { state: () => ({ n: 0 }), reducers: { set: () => ({ n: 1 }) }, persist: saveTo({ key: 'vc:p' }) });
  const first = useP(createCommandBus());
  const r = c === 'corrupt' ? { ok: true } : (first.set() as { ok: boolean });
  await Promise.resolve();
  first.$dispose();
  const read = useP(createCommandBus());
  const loaded = { value: read.state.value.n === 1 ? read.state.value : null };
  read.$dispose();
  const out = { dispatchOk: r.ok, code: (r as { error?: { code?: string } }).error?.code, loaded, warned: warn.mock.calls.length > 0 };
  warn.mockRestore();
  return out;
}

/** What an app sees from the outbox: an offline dispatch's result, then what a fresh outbox loads at creation. */
async function outboxSees(c: Case) {
  install(c);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let r: { ok: boolean; error?: unknown } = { ok: true };
  if (c !== 'corrupt') {
    const outbox = createOutbox({ name: 'vc:o', isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus({ transport: defineTransport(async () => ({ ok: true, value: 1, error: undefined })), outbox });
    r = await bus.dispatch('set', {});
  }
  const fresh = createOutbox({ name: 'vc:o', autoFlush: false });
  const out = { dispatchOk: r.ok, code: (r.error as { code?: string } | undefined)?.code, loaded: { value: fresh.pending.value }, warned: warn.mock.calls.length > 0 };
  warn.mockRestore();
  return out;
}

describe('a working storage', () => {
  it('positive control: both round-trip one state', async () => {
    expect(await persistSees('working')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: { n: 1 } }, warned: false });
    expect(await outboxSees('working')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 1 }, warned: false });
  });
});

describe('the same failure, both side by side', () => {
  it('no localStorage (SSR): neither throws, nothing is stored, nothing is loaded', async () => {
    expect(await persistSees('none')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: null }, warned: false });
    expect(await outboxSees('none')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 0 }, warned: false });
  });

  it('setItem throws a quota error: the dispatch succeeds, both warn, nothing is loaded', async () => {
    expect(await persistSees('quota')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: null }, warned: true });
    expect(await outboxSees('quota')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 0 }, warned: true });
  });

  it('corrupt JSON on load: both load nothing, silently', async () => {
    expect(await persistSees('corrupt')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: null }, warned: false });
    expect(await outboxSees('corrupt')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 0 }, warned: false });
  });

  it('blocked storage (the getter throws): both warn and carry on', async () => {
    expect(await persistSees('blocked')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: null }, warned: true });
    expect(await outboxSees('blocked')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 0 }, warned: true });
  });

});
