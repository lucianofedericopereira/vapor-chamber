/** persist and the outbox against the same four storage failures. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createOutbox, localStorageOutbox } from '../src/outbox';
import { persist } from '../src/plugins-io';

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
    // A browser with site data blocked: reading `localStorage` itself throws.
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

const settle = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { threw: (e as Error).name }; } };

/** What an app sees from persist: a dispatch's result, then load(). */
async function persistSees(c: Case) {
  install(c);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bus = createCommandBus();
  const p = persist({ key: 'vc:p', getState: () => ({ n: 1 }) });
  bus.use(p);
  bus.register('set', () => 1);
  const r = c === 'corrupt' ? { ok: true } : bus.dispatch('set', {});
  const loaded = await settle(() => p.load());
  const out = { dispatchOk: r.ok, code: (r as { error?: { code?: string } }).error?.code, loaded, warned: warn.mock.calls.length > 0 };
  warn.mockRestore();
  return out;
}

/** What an app sees from the outbox: an offline dispatch's result, then a fresh outbox's hydrate. */
async function outboxSees(c: Case) {
  install(c);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let r: { ok: boolean; error?: unknown } = { ok: true };
  if (c !== 'corrupt') {
    const outbox = createOutbox({ storage: localStorageOutbox('vc:o'), isOnline: () => false, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);
    bus.register('set', async () => 1);
    r = await bus.dispatch('set', {});
  }
  const fresh = createOutbox({ storage: localStorageOutbox('vc:o'), autoFlush: false });
  const hydrated = await settle(() => fresh.hydrate());
  const out = { dispatchOk: r.ok, code: (r.error as { code?: string } | undefined)?.code, loaded: 'threw' in hydrated ? hydrated : { value: fresh.pending.value }, warned: warn.mock.calls.length > 0 };
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

  it('corrupt JSON on load: both load nothing; the outbox warns, persist is silent', async () => {
    expect(await persistSees('corrupt')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: null }, warned: false });
    expect(await outboxSees('corrupt')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 0 }, warned: true });
  });

  it('blocked storage (the getter throws): both warn and carry on', async () => {
    expect(await persistSees('blocked')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: null }, warned: true });
    expect(await outboxSees('blocked')).toEqual({ dispatchOk: true, code: undefined, loaded: { value: 0 }, warned: true });
  });

  it('blocked storage: persist clear() warns, never throws', async () => {
    install('blocked');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = persist({ key: 'vc:p', getState: () => 1 });
    expect({ cleared: await settle(() => p.clear()), warned: warn.mock.calls.length }).toEqual({ cleared: { value: undefined }, warned: 1 });
  });
});

/*
 * Plan 1.28 item 7 (log s35.207). `persist` (src/plugins-io.ts) and the
 * outbox's `localStorageOutbox` (src/outbox.ts) each look up `localStorage`
 * with `typeof globalThis.localStorage`. The probe gives both the same four
 * failures and records what an app sees: the dispatch's result, what a later
 * load returns, and whether the console was warned.
 *
 * No storage, a quota error: the same answer. Corrupt JSON: both load
 * nothing, and only the outbox warns (persist's default `deserialize`
 * swallows the parse error). Blocked storage, where reading `localStorage`
 * itself throws a SecurityError (a browser with site data blocked): `typeof`
 * guards an undeclared name, not a getter that throws, so the lookup throws.
 * The outbox calls its storage inside a try (`saveQueue`, `hydrate`) and
 * carries on with a warning. `persist` looked up before its try, in `save()`,
 * `load()` and `clear()`: the save after every successful dispatch threw
 * inside the plugin, so every dispatch answered `persist:failed:plugin`
 * though its handler ran, and `load()` threw to the app. The lookup now sits
 * inside each try (log s35.208), and blocked storage warns as a quota error
 * does.
 */
