/** A bus's stores record and its registry entries each have one hidden class, whoever made them. Rationale at the end. */
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

// Rationale.
// docs/V8-RULES.md rule 1: a read-many object comes from one literal or one
// factory. The V8 audit of the 1-7 fix-up (2026-10-21) found the stores
// record built by two literals (createAsyncCommandBus, _storesOf) and the
// registry entry by two (useStore, seedStores). Their keys were in one order,
// so V8 gave each pair one map already (this test is green at 1d065eb too):
// the second literal was a copy of the field order a later edit could break.
// The entry now has one factory (src/applied-remotely.ts). The record keeps
// its two literals: a factory cost the Blade consumer 13 B brotli (log 36.F3),
// and this test catches a drift in the field order.
// The control shows the check tells two orders apart. `sameMap` is V8's own
// %HaveSameMap (tests/v8.ts).
