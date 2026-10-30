/**
 * freezeDeep and freezeCached (the dev-only deep freeze), and the cache() and idempotent() stores that must use it.
 * Why: a store hands the same object to later callers; if it is left unfrozen in dev, one caller's mutation silently rewrites what every later caller reads.
 * Shows: plain objects and arrays freeze at every depth, class instances and Maps freeze shallowly without descent, cycles and shared references terminate, production leaves values unfrozen, and cache() and idempotent() results reject mutation.
 * See: src/freeze.ts, tests/dev-flag.test.ts.
 */
import { afterEach, describe, expect, vi } from 'vitest';
import { FREEZE_IN_DEV, freezeCached, freezeDeep } from '../src/freeze';
import { cache, idempotent } from '../src/plugins-extra';
import { it } from '../src/vitest';

describe('freezeDeep', () => {
  it('freezes nested plain objects and arrays at every depth', () => {
    const value = { list: [{ id: 1 }, { id: 2 }], meta: { page: { n: 1 } } };
    freezeDeep(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.meta.page)).toBe(true);
  });

  it('ignores primitives and null without throwing', () => {
    expect(() => freezeDeep(null)).not.toThrow();
    expect(() => freezeDeep(42)).not.toThrow();
    expect(() => freezeDeep('cached')).not.toThrow();
    expect(() => freezeDeep(undefined)).not.toThrow();
  });

  it('terminates on cyclic graphs', () => {
    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    expect(() => freezeDeep(a)).not.toThrow();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('freezes class instances shallowly and does NOT descend into them', () => {
    class Row {
      cells = { a: 1 };
    }
    const row = new Row();
    const value = { row };
    freezeDeep(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
    // Foreign graphs may rely on internal mutation, so they are not descended.
    expect(Object.isFrozen(row.cells)).toBe(false);
    row.cells.a = 2;
    expect(row.cells.a).toBe(2);
  });

  it('does not descend into Maps (own prototype) but still freezes the reference shallowly', () => {
    const inner = { n: 1 };
    const m = new Map([['k', inner]]);
    freezeDeep({ m });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(inner)).toBe(false);
    m.set('k2', { n: 2 }); // Object.freeze does not seal Map internals
    expect(m.size).toBe(2);
  });

  it('descends into null-prototype objects (they are plain data, just headless)', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.child = { n: 1 };
    freezeDeep(bare);
    expect(Object.isFrozen(bare)).toBe(true);
    expect(Object.isFrozen(bare.child)).toBe(true);
  });

  it('revisiting an already-seen object is a no-op (diamond shape, no cycle)', () => {
    const shared = { n: 1 };
    const value = { left: shared, right: shared };
    expect(() => freezeDeep(value)).not.toThrow();
    expect(Object.isFrozen(shared)).toBe(true);
  });
});

describe('freezeCached', () => {
  it('returns the same reference (chaining contract)', () => {
    const value = { a: 1 };
    expect(freezeCached(value)).toBe(value);
  });

  it('freezes in this (dev) test environment - mutation of a cached value throws in strict mode', () => {
    expect(FREEZE_IN_DEV).toBe(true);
    const value = freezeCached({ items: [1, 2, 3] });
    // ES module code is strict, so assigning to a frozen property throws.
    expect(() => {
      (value as { items: number[] }).items = [];
    }).toThrow(TypeError);
  });

  it('passes primitives through untouched', () => {
    expect(freezeCached(7)).toBe(7);
    expect(freezeCached('x')).toBe('x');
    expect(freezeCached(null)).toBe(null);
  });
});

describe('stores that hand back a shared object freeze it', () => {
  it('cache() - a later hit cannot be rewritten through an earlier one', async ({ asyncBus: bus }) => {
    bus.use(cache({ ttl: 60_000 }));
    bus.register('load', async () => ({ items: [1, 2, 3] }));

    const first = await bus.dispatch('load', { id: 1 });
    expect(() => {
      (first.value as { items: number[] }).items.push(999);
    }).toThrow(TypeError);

    const second = await bus.dispatch('load', { id: 1 });
    expect((second.value as { items: number[] }).items).toEqual([1, 2, 3]);
  });

  it('idempotent() - a later duplicate cannot be rewritten through an earlier one', async ({ asyncBus: bus }) => {
    bus.use(idempotent());
    bus.register('load', async () => ({ items: [1, 2, 3] }));

    const first = await bus.dispatch('load', { id: 1 });
    expect(() => {
      (first.value as { items: number[] }).items.push(999);
    }).toThrow(TypeError);

    const second = await bus.dispatch('load', { id: 1 });
    expect((second.value as { items: number[] }).items).toEqual([1, 2, 3]);
  });

  it('idempotent() - concurrent duplicates share one frozen result', async ({ asyncBus: bus }) => {
    bus.use(idempotent());
    bus.register('load', async () => ({ items: [1] }));

    const [a, b] = await Promise.all([bus.dispatch('load', { id: 2 }), bus.dispatch('load', { id: 2 })]);
    expect(b.value).toBe(a.value);
    expect(Object.isFrozen(a.value)).toBe(true);
  });
});

describe('freezeCached in production', () => {
  // FREEZE_IN_DEV is fixed at module load, so re-import after stubbing NODE_ENV (as tests/dev-flag.test.ts does).
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('leaves the value unfrozen and still mutable when NODE_ENV=production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const prod = await import('../src/freeze');

    expect(prod.FREEZE_IN_DEV).toBe(false);

    const value = { items: [1, 2, 3] };
    expect(prod.freezeCached(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(false);
    expect(Object.isFrozen(value.items)).toBe(false);

    value.items = [];
    expect(value.items).toEqual([]);
  });
});
