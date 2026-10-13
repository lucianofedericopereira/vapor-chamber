// examples/feature-vite-hmr.ts, imported for real: the handler it shows must be the one that runs.
import { describe, expect, it, vi } from 'vitest';

describe('examples/feature-vite-hmr.ts', () => {
  it('runs its own handler, with no overwrite warning (FVH-4)', async () => {
    const logs: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warns.push(a.map(String).join(' ')); });
    const { cartState } = await import('../../examples/feature-vite-hmr');
    expect({
      ran: logs.filter((l) => l.includes('handler still registered after HMR')).length,
      overwritten: warns.filter((w) => w.includes('already exists and is being overwritten')),
    }).toEqual({ ran: 1, overwritten: [] });
    // Positive control: the state's own cartAdd reducer still runs.
    expect(cartState.value).toEqual({ items: ['T-Shirt'], count: 1 });
  });
});

/*
 * Why the real module: `useCommandState` registers one bus handler per
 * action in its map, so an action the example also registers by hand is
 * taken by whichever registers last. Only importing the example shows
 * which one a reader's copy would run. The example's imports resolve
 * through the package self-link to dist/, as an app's would. Row FVH-4 of
 * the 2026-10-12 release audit.
 */
