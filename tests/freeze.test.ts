/**
 * Tests for freeze.ts — the dev-only deep freeze both caches share
 * (http-cache.ts response entries, plugins-extra cache() results).
 *
 * The walk rules under test, per the module header:
 *   - plain objects and arrays: frozen and descended into
 *   - class instances / Maps / anything with its own prototype: frozen
 *     SHALLOWLY, not descended — foreign object graphs are not our business
 *   - cycles terminate (WeakSet)
 *   - production: freezeCached is a pass-through no-op
 */

import { describe, expect, it } from 'vitest';
import { FREEZE_IN_DEV, freezeCached, freezeDeep } from '../src/freeze';

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
    a.b = b; // cycle
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
    expect(Object.isFrozen(row)).toBe(true); // shallow freeze applied
    // NOT descended: the instance's own nested state stays mutable —
    // deep-freezing a foreign graph could break types that rely on
    // internal mutation.
    expect(Object.isFrozen(row.cells)).toBe(false);
    row.cells.a = 2;
    expect(row.cells.a).toBe(2);
  });

  it('does not descend into Maps (own prototype) but still freezes the reference shallowly', () => {
    const inner = { n: 1 };
    const m = new Map([['k', inner]]);
    freezeDeep({ m });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(inner)).toBe(false); // reachable only through the Map — not walked
    m.set('k2', { n: 2 }); // Object.freeze does not seal Map internals — internal mutation still works
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

  it('freezes in this (dev) test environment — mutation of a cached value throws in strict mode', () => {
    // The test env is not production, so FREEZE_IN_DEV must be on — this
    // pins the gate itself, not just the walk.
    expect(FREEZE_IN_DEV).toBe(true);
    const value = freezeCached({ items: [1, 2, 3] });
    // No `'use strict'` directive: this is an ES module, so the body is already
    // strict and the directive was redundant (biome/noRedundantUseStrict). The
    // assertion is unchanged — assigning to a frozen property still throws
    // TypeError, which is precisely what strict mode buys and what is pinned
    // here.
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
