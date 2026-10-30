/**
 * A bus's stores record and its registry entries each have one hidden class, whoever made them.
 * Why: a read-many object must come from one literal or factory; two literals with the same field order are a copy that a later edit could break, silently splitting the map.
 * Shows: the record from createAsyncCommandBus and from _storesOf on first use share a map; a store's entry and a seeded id's placeholder share a map; the control tells two field orders apart.
 * See: docs/V8-RULES.md, log s36.F3, tests/v8.ts
 */
import { describe, expect, it } from 'vitest';
import { _busStores, _storesOf, type RegistryEntry } from '../src/applied-remotely';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { seedStores } from '../src/ssr';
import { defineChamberStore } from '../src/store/core';
import { sameMap } from './v8';

const store = () => defineChamberStore('s', { state: () => ({ n: 0 }), reducers: {} });

describe("a bus's stores", () => {
  it('control: the same fields in another order are another map', () => {
    const stores = _storesOf(createCommandBus());
    expect(sameMap(stores, { lane: stores.lane, entries: stores.entries })).toBe(false);
  });

  it('the record: one map, from the async bus at creation and from a sync bus on first use', () => {
    const atCreation = _busStores.get(createAsyncCommandBus())!;
    const onFirstUse = _storesOf(createCommandBus());
    expect(sameMap(atCreation, onFirstUse)).toBe(true);
  });

  it("an entry: one map, a store's and a seeded id's placeholder", () => {
    const bus = createCommandBus();
    seedStores(bus, { seeded: { n: 1 } });
    store()(bus);
    const entries = _storesOf(bus).entries;
    const placeholder = entries.get('seeded') as RegistryEntry;
    const live = entries.get('s') as RegistryEntry;
    expect(placeholder.store).toBeNull();
    expect(sameMap(placeholder, live)).toBe(true);
  });
});
