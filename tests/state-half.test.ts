/**
 * _stateHalf alone: one watcher on the cell feeds persist's save, share's send and the field events; dispose stops them.
 * Why: the library's own queues (the outbox) use a state half with no store and no bus, so persist, cross-tab share and field events must work from it alone, and `ready` must tell an outbox when an async stored queue has landed.
 * Shows: saves once per microtask and reloads the saved state, an async read resolves `ready`, another tab's state arrives and stops on dispose, an answer to another tab's ask is not taken, an uncloneable state stays in its tab (warning in development only).
 * See: log s36.F4, tests/store-one-watcher.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _stateHalf, type HalfOwner } from '../src/store-base';
import { _plainRuntime } from '../src/store/core';
import { saveTo } from '../src/store-persist';
import { _shareStates } from '../src/store-share';

type Q = { items: number[] };
const state = (): Q => ({ items: [] });
const microtask = () => Promise.resolve();
const settle = () => new Promise((r) => setTimeout(r, 30));

/** An owner that writes the cell itself, as the outbox does. */
function owner(cell: () => { value: Q }): HalfOwner<Q> {
  return { write: (_cmd, f) => (cell().value = f(cell().value, undefined)), land: () => {}, put: (next) => { cell().value = next; } };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a state half', () => {
  it('saves after a write, once per microtask, and reads the saved state at creation', async () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => { saved.set(k, v); } };
    let half!: ReturnType<typeof _stateHalf<Q>>;
    half = _stateHalf<Q>(_plainRuntime, { id: 'q', state, persist: saveTo({ key: 'q', storage }) }, owner(() => half.cell));
    half.cell.value = { items: [1] };
    half.cell.value = { items: [1, 2] };
    await microtask();
    expect(saved.get('q')).toBe('{"items":[1,2]}');
    let again!: ReturnType<typeof _stateHalf<Q>>;
    again = _stateHalf<Q>(_plainRuntime, { id: 'q', state, persist: saveTo({ key: 'q', storage }) }, owner(() => again.cell));
    expect(again.cell.value).toEqual({ items: [1, 2] });
    expect(again.ready).toBeNull();
    half.dispose();
    again.dispose();
  });

  it('fans field events out, and dispose stops the watcher and every subscriber', () => {
    let half!: ReturnType<typeof _stateHalf<Q>>;
    half = _stateHalf<Q>(_plainRuntime, { id: 'q', state }, owner(() => half.cell));
    const heard: number[][] = [];
    half.onField('items', (v) => { heard.push(v as number[]); });
    half.cell.value = { items: [1] };
    half.dispose();
    half.cell.value = { items: [2] };
    expect(heard).toEqual([[1]]);
  });

  it("shares with another tab's half, and stops on dispose", async () => {
    vi.stubGlobal('window', {});
    const name = `half-${Math.random().toString(36).slice(2)}`;
    let a!: ReturnType<typeof _stateHalf<Q>>;
    let b!: ReturnType<typeof _stateHalf<Q>>;
    a = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates(name) }, owner(() => a.cell));
    b = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates(name) }, owner(() => b.cell));
    a.cell.value = { items: [7] };
    await settle();
    expect(b.cell.value).toEqual({ items: [7] });
    b.dispose();
    a.cell.value = { items: [8] };
    await settle();
    expect(b.cell.value).toEqual({ items: [7] });
    a.dispose();
  });

  it('an async storage: `ready` resolves once the saved state is written', async () => {
    const storage = { getItem: async () => '{"items":[5]}', setItem: async () => {} };
    let half!: ReturnType<typeof _stateHalf<Q>>;
    half = _stateHalf<Q>(_plainRuntime, { id: 'q', state, persist: saveTo({ key: 'q', storage }) }, owner(() => half.cell));
    expect(half.cell.value).toEqual({ items: [] });
    await half.ready;
    expect(half.cell.value).toEqual({ items: [5] });
    half.dispose();
  });
});

describe('a state half shared by whole states (the outbox queue)', () => {
  it('outside a page nothing opens and writes stay local', () => {
    let half!: ReturnType<typeof _stateHalf<Q>>;
    half = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates('half-none') }, owner(() => half.cell));
    half.cell.value = { items: [1] };
    expect(half.cell.value).toEqual({ items: [1] });
    half.dispose();
  });

  it("an answer to another tab's ask is not taken here", async () => {
    vi.stubGlobal('window', {});
    const name = `half-${Math.random().toString(36).slice(2)}`;
    const puts: number[] = [];
    const counted = (cell: () => { value: Q }): HalfOwner<Q> => ({ ...owner(cell), put: (next) => { puts.push(next.items.length); cell().value = next; } });
    let a!: ReturnType<typeof _stateHalf<Q>>;
    let c!: ReturnType<typeof _stateHalf<Q>>;
    a = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates(name) }, owner(() => a.cell));
    c = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates(name) }, counted(() => c.cell));
    a.cell.value = { items: [7] };
    await settle();
    // a's write, and a's answer to c's own ask.
    expect(puts.length).toBeGreaterThan(0);
    const before = puts.length;
    let b!: ReturnType<typeof _stateHalf<Q>>;
    b = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates(name) }, owner(() => b.cell));
    await settle();
    expect(b.cell.value).toEqual({ items: [7] });
    expect(puts.length).toBe(before);
    a.dispose();
    b.dispose();
    c.dispose();
  });

  it('a state the structured clone cannot copy stays in its tab, with a warning in development', async () => {
    vi.stubGlobal('window', {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let half!: ReturnType<typeof _stateHalf<Q>>;
    half = _stateHalf<Q>(_plainRuntime, { id: 'q', state, share: _shareStates(`half-${Math.random()}`) }, owner(() => half.cell));
    half.cell.value = { items: [() => {}] as unknown as number[] };
    expect(warn.mock.calls.some((c) => String(c[0]).includes('Store "q": its state did not cross to the other tabs'))).toBe(true);
    half.dispose();
    warn.mockRestore();
  });

  it('in production that state stays in its tab with no warning', async () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = await import('../src/store-base');
      const core = await import('../src/store/core');
      const share = await import('../src/store-share');
      let half!: ReturnType<typeof _stateHalf<Q>>;
      half = base._stateHalf<Q>(core._plainRuntime, { id: 'q', state, share: share._shareStates(`half-${Math.random()}`) }, owner(() => half.cell));
      half.cell.value = { items: [() => {}] as unknown as number[] };
      expect(warn).not.toHaveBeenCalled();
      half.dispose();
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
