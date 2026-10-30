/**
 * Inside a hot update the Vite plugin marks, a handler registered again is the update, not a clash: no warning.
 * Why: Vite re-runs an edited module without a `hot.dispose`, so the app cannot unregister first; a warning per action on every edit would be a false alarm, while a real clash outside an update must still warn.
 * Shows: with `__VAPOR_CHAMBER_HOT__` set, re-registering on the sync bus, the async bus and a store warns nothing and the new handler runs; the re-run replaces the old registration; outside the mark an overwrite warns once with its code.
 * See: log s36.F22, tests/vite-hmr.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';

// The mark vaporChamberHMR's shim holds from `vite:beforeUpdate` to `vite:afterUpdate`.
const HOT = '__VAPOR_CHAMBER_HOT__';
const marked = <T>(fn: () => T): T => {
  (globalThis as Record<string, unknown>)[HOT] = new WeakMap();
  try { return fn(); } finally { delete (globalThis as Record<string, unknown>)[HOT]; }
};
const overwrites = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('core:already:handler'));

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HOT];
});

describe('register() inside a hot update', () => {
  it('a re-run registering its handler again warns nothing, and the new handler runs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('cartCheckout', () => 'old');
    marked(() => bus.register('cartCheckout', () => 'edited'));
    expect(overwrites(warn)).toEqual([]);
    expect(bus.dispatch('cartCheckout', {}).value).toBe('edited');
  });

  it('the async bus too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('cartCheckout', async () => 'old');
    marked(() => bus.register('cartCheckout', async () => 'edited'));
    expect(overwrites(warn)).toEqual([]);
    expect((await bus.dispatch('cartCheckout', {})).value).toBe('edited');
  });

  it('a store module re-run in the update takes over its actions with no warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const edit = () => defineChamberStore('cart', {
      state: () => ({ items: [] as string[] }),
      reducers: { add: (s, name: string) => ({ items: [...s.items, name] }) },
    });
    edit()(bus).add('Hat');
    const after = marked(() => edit()(bus));
    expect(overwrites(warn)).toEqual([]);
    expect(after.state.value.items).toEqual(['Hat']);
  });

  it('a re-run takes the old registration\'s place: removing the edited one leaves no handler behind', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('cartCheckout', () => 'old');
    const off = marked(() => bus.register('cartCheckout', () => 'edited'));
    off();
    expect(bus.hasHandler('cartCheckout')).toBe(false);
  });

  it('control: outside the mark, registering over a handler still warns once, with its code', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('cartCheckout', () => 'old');
    marked(() => {});
    bus.register('cartCheckout', () => 'clash');
    expect(overwrites(warn)).toEqual([expect.stringContaining('Handler for "cartCheckout" already exists')]);
  });

  it('control: a first registration inside the mark warns nothing either way', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    marked(() => createCommandBus().register('cartAdd', () => 1));
    expect(overwrites(warn)).toEqual([]);
  });
});
