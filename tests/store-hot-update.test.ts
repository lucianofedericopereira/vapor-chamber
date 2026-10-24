/** A store replaced inside a hot update the Vite plugin marks starts from the state of the one it replaces. Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';

const edit = (factor: number) =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    reducers: { add: (s, n: number) => ({ items: [...s.items, n * factor] }) },
  });

// The mark vaporChamberHMR's shim sets from `vite:beforeUpdate` to `vite:afterUpdate`.
const HOT = '__VAPOR_CHAMBER_HOT__';
const marked = <T>(fn: () => T): T => {
  (globalThis as Record<string, unknown>)[HOT] = new WeakMap();
  try { return fn(); } finally { delete (globalThis as Record<string, unknown>)[HOT]; }
};

describe('a hot update carries the state (the plugin marks it)', () => {
  it('a store its scope disposed in the update: the next one keeps the state', () => {
    const bus = createCommandBus();
    const page = effectScope();
    const before = page.run(() => edit(1)(bus))!;
    before.add(1);
    const after = marked(() => { page.stop(); return edit(10)(bus); });
    after.add(3);
    expect(after.state.value.items).toEqual([1, 30]);
    after.$dispose();
    bus.dispose();
  });

  it('a store created at module load: the re-run module keeps the state', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const before = edit(1)(bus);
    before.add(1);
    const after = marked(() => edit(10)(bus));
    after.add(3);
    expect(after.state.value.items).toEqual([1, 30]);
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });

  it('matched by key: a key the new state() adds starts fresh, a key it drops goes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const before = defineChamberStore('cart', { state: () => ({ items: [] as number[], old: 'x' }), reducers: { add: (s, n: number) => ({ ...s, items: [...s.items, n] }) } })(bus);
    before.add(1);
    const after = marked(() => defineChamberStore('cart', { state: () => ({ items: [] as number[], added: 7 }), reducers: { add: (s, n: number) => ({ ...s, items: [...s.items, n] }) } })(bus));
    expect(after.state.value).toEqual({ items: [1], added: 7 });
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });

  it('a state with no keys to match carries as it is: an array, a null, an edit to an array', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    const list = (f: number) => defineChamberStore('list', { state: () => [] as number[], reducers: { add: (s: number[], n: number) => [...s, n * f] } });
    const a = list(1)(bus);
    a.add(1);
    const b = marked(() => list(10)(bus));
    expect(b.state.value).toEqual([1]);
    const objOld = defineChamberStore('obj2', { state: () => ({ n: 1 }), reducers: {} })(bus);
    const objNew = marked(() => defineChamberStore('obj2', { state: () => [] as unknown as { n: number }, reducers: {} })(bus));
    expect(objNew.state.value).toEqual({ n: 1 });
    const broken = defineChamberStore('nul', { state: () => ({ n: 1 }), reducers: { wipe: () => null as unknown as { n: number } } })(bus);
    broken.wipe();
    const after = marked(() => defineChamberStore('nul', { state: () => ({ n: 2 }), reducers: {} })(bus));
    expect(after.state.value).toBeNull();
    for (const s of [a, b, objOld, objNew, broken, after]) s.$dispose();
    bus.dispose();
  });

  it("another bus's store of the id is not carried", () => {
    const a = createCommandBus();
    const b = createCommandBus();
    const onA = edit(1)(a);
    onA.add(1);
    const onB = marked(() => { onA.$dispose(); return edit(10)(b); });
    expect(onB.state.value.items).toEqual([]);
    onB.$dispose();
    a.dispose();
    b.dispose();
  });

  it('control: unmarked, a takeover builds from state()', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const before = edit(1)(bus);
    before.add(1);
    const after = edit(10)(bus);
    expect(after.state.value.items).toEqual([]);
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });

  it('in production the mark carries nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const { defineChamberStore: define } = await import('../src/store');
      const { createCommandBus: create } = await import('../src/command-bus');
      const bus = create();
      const make = (f: number) => define('cart', { state: () => ({ items: [] as number[] }), reducers: { add: (s, n: number) => ({ items: [...s.items, n * f] }) } });
      const before = make(1)(bus);
      before.add(1);
      const after = marked(() => make(10)(bus));
      expect(after.state.value.items).toEqual([]);
      before.$dispose();
      after.$dispose();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('a hot update matches nested keys too', () => {
  const profileStore = (state: () => object) => defineChamberStore('form', { state: state as () => { profile: { name: string } }, reducers: { rename: (s, name: string) => ({ ...s, profile: { ...s.profile, name } }) } });

  it('a nested key the edit adds starts from its declared value; one both have keeps its value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const before = profileStore(() => ({ profile: { name: '' } }))(bus);
    before.rename('Ada');
    const after = marked(() => profileStore(() => ({ profile: { name: '', age: 0 } }))(bus));
    expect(after.state.value).toEqual({ profile: { name: 'Ada', age: 0 } });
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });

  it('a nested key the edit drops goes; one the app added keeps its value', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const before = defineChamberStore('form', {
      state: () => ({ profile: { name: '', old: 'x' } as Record<string, string> }),
      reducers: { set: (s, [k, v]: [string, string]) => ({ ...s, profile: { ...s.profile, [k]: v } }) },
    })(bus);
    before.set(['nick', 'A']);
    const after = marked(() => defineChamberStore('form', {
      state: () => ({ profile: { name: '' } as Record<string, string> }),
      reducers: { set: (s, [k, v]: [string, string]) => ({ ...s, profile: { ...s.profile, [k]: v } }) },
    })(bus));
    expect(after.state.value).toEqual({ profile: { name: '', nick: 'A' } });
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });

  it('a dictionary declared empty keeps the entries the app added, nested or the whole state', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const put = (s: Record<string, unknown>, [k, v]: [string, number]) => ({ ...s, [k]: v });
    const nested = (extra: object) => defineChamberStore('rows', {
      state: () => ({ byId: {} as Record<string, number>, ...extra }),
      reducers: { put: (s, [k, v]: [string, number]) => ({ ...s, byId: { ...s.byId, [k]: v } }) },
    });
    const a = nested({})(bus);
    a.put(['r1', 1]);
    const b = marked(() => nested({ total: 0 })(bus));
    expect(b.state.value).toEqual({ byId: { r1: 1 }, total: 0 });
    const flat = () => defineChamberStore('dict', { state: () => ({}) as Record<string, number>, reducers: { put } as never });
    const c = flat()(bus) as unknown as { put: (e: [string, number]) => void; $dispose(): void };
    c.put(['k', 1]);
    const d = marked(() => flat()(bus)) as unknown as { state: { value: unknown }; $dispose(): void };
    expect(d.state.value).toEqual({ k: 1 });
    for (const s of [a, b, c, d]) s.$dispose();
    bus.dispose();
  });

  it('a null-prototype object matches as a plain one; a key declared null keeps what the app put there', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const dict = () => Object.assign(Object.create(null) as Record<string, number>, { a: 0 });
    const put = (s: { byId: Record<string, number>; meta: Record<string, string> | null }, [k, v]: [string, number]) => ({ ...s, byId: Object.assign(Object.create(null), s.byId, { [k]: v }), meta: { ...(s.meta ?? {}), at: 'now' } });
    const before = defineChamberStore('rows', { state: () => ({ byId: dict(), meta: null as Record<string, string> | null }), reducers: { put } })(bus);
    before.put(['r1', 1]);
    const after = marked(() => defineChamberStore('rows', {
      state: () => ({ byId: Object.assign(dict(), { b: 2 }), meta: { at: '', by: 'me' } as Record<string, string> | null }),
      reducers: { put },
    })(bus));
    expect({ ...after.state.value.byId }).toEqual({ a: 0, r1: 1, b: 2 });
    expect(after.state.value.meta).toEqual({ at: 'now', by: 'me' });
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });

  it('a store its scope disposed in the update matches nested keys the same way', () => {
    const bus = createCommandBus();
    const page = effectScope();
    const before = page.run(() => profileStore(() => ({ profile: { name: '' } }))(bus))!;
    before.rename('Ada');
    const after = marked(() => { page.stop(); return profileStore(() => ({ profile: { name: '', age: 0 } }))(bus); });
    expect(after.state.value).toEqual({ profile: { name: 'Ada', age: 0 } });
    after.$dispose();
    bus.dispose();
  });
});

/*
 * Nested keys (log 36.77, Pinia 4.1.0's hot update, owner 2026-10-20: "a hot update should
 * give a new nested key its declared value, as it does for a top-level key"). The carry
 * matched the top level only, so an edit adding `profile.age` left it undefined until a
 * reload. It now matches every level of plain objects. A key both have keeps the app's value,
 * a key the edit adds gets its declared one, a key the edit removes goes, and a key the app
 * added at runtime stays: telling the last two apart needs the old `state()`, which the store
 * keeps. Without that last rule a dictionary declared `{}` lost every entry on an edit.
 */

/*
 * A store module edited under Vite re-runs, and the store it defines replaces
 * the old one: by takeover when the old one was created at module load, or
 * after its component disposed it when a component held it. Both built from
 * `state()`, so every edit lost the state. vaporChamberHMR()'s shim marks the
 * update, from `vite:beforeUpdate` to `vite:afterUpdate` (Vite 8's client runs
 * dispose, the re-run and the accept callbacks between them), and a store
 * built inside the mark starts from the state of the one it replaces, matched
 * by key as Pinia's hotUpdate does. The mark exists only under the dev server,
 * and the store reads it in DEV only, so a build folds it away. The component
 * case under the real Vue HMR runtime is in tests/vapor/store-hmr.test.ts.
 */
