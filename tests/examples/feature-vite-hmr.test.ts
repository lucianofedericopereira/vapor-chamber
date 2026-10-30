/**
 * examples/feature-vite-hmr.ts imported for real, through the package self-link to dist/: its handler runs, and a hot re-run keeps the cart.
 * Why: the store registers one handler per action, so one the example also registered by hand would be taken by whichever came last; a hot update must keep state.
 * Shows: its own handler runs with no overwrite warning; a re-run inside a marked update takes the cart with its items; outside one it starts empty; the bus is kept either way.
 * See: audit FVH-4.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// The mark vaporChamberHMR's shim sets from `vite:beforeUpdate` to `vite:afterUpdate`.
const HOT = '__VAPOR_CHAMBER_HOT__';
const example = '../../examples/feature-vite-hmr.ts';

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HOT];
});

describe('examples/feature-vite-hmr.ts', () => {
  it('runs its own handler, with no overwrite warning (FVH-4)', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    const { bus, cart } = await import(example);
    expect(bus.dispatch('cartCheckout', { id: 1 }).ok).toBe(true);
    expect({
      ran: logs.filter((l) => l.includes('cartCheckout runs')).length,
      overwritten: warns.filter((w) => w.includes('already exists and is being overwritten')),
    }).toEqual({ ran: 1, overwritten: [] });
    // Positive control: the store's own cartAdd reducer still runs.
    cart.add({ name: 'T-Shirt' });
    expect(cart.state.value).toEqual({ items: ['T-Shirt'], count: 1 });
  });

  it('a hot re-run takes the cart over with its items, and only inside a marked update', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const first = await import(example);
    first.cart.add({ name: 'Hat' });
    const held = first.cart.state.value.items.length;

    (globalThis as Record<string, unknown>)[HOT] = new WeakMap();
    const marked = await import(`${example}?hot=1`);
    expect(marked.bus).toBe(first.bus);
    expect(marked.cart.state.value.items).toHaveLength(held);

    // Control: the same re-run outside a marked update starts from nothing.
    delete (globalThis as Record<string, unknown>)[HOT];
    const unmarked = await import(`${example}?hot=2`);
    expect(unmarked.cart.state.value).toEqual({ items: [], count: 0 });
    // The shared bus lives in the library's module, so a re-run with no plugin keeps it too.
    expect(unmarked.bus).toBe(first.bus);
  });
});
