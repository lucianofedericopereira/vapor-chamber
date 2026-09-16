/**
 * Supplemental coverage for src/ssr.ts - rehydrate on the wrong bus type, and
 * rehydrateAsync in full (it had no direct tests: statements 299-305 were all
 * red).
 *
 *  - rehydrate() handed an async bus: the thenable guard must warn
 *    once, absorb the pending promise (249, so no unhandled
 *    rejection), and report a per-command failure pointing at rehydrateAsync.
 *  - rehydrate() over a bus whose dispatch throws synchronously.
 *  - rehydrateAsync(): ordered replay, filter skip, unhandled skip
 *, and a rejecting dispatch becoming { ok:false }.
 */
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/index';
import { rehydrate, rehydrateAsync } from '../src/ssr';
import type { BaseBus } from '../src/command-bus';
import { it } from '../src/vitest';


describe('rehydrate - async bus misuse', () => {
  it('reports each pending dispatch as a failure and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 1);

    const results = rehydrate(bus, [
      { action: 'cartAdd', target: { id: 1 } },
      { action: 'cartAdd', target: { id: 2 } },
    ]);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.error?.message).toContain('rehydrateAsync');
    }
    // One-shot warning - the second pending dispatch must not warn again.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('rehydrateAsync');
  });

  it('captures a synchronously-throwing dispatch as { ok:false }', () => {
    const bus = {
      hasHandler: () => true,
      dispatch: () => { throw new Error('sync boom'); },
    } as unknown as BaseBus;

    const results = rehydrate(bus, [{ action: 'x', target: {} }]);
    expect(results).toEqual([{ ok: false, error: expect.objectContaining({ message: 'sync boom' }) }]);
  });
});

describe('rehydrateAsync', () => {
  it('replays commands in order and returns their results', async ({ asyncBus: bus }) => {
    const seen: number[] = [];
    bus.register('cartAdd', async (cmd: { target: { id: number } }) => { seen.push(cmd.target.id); return cmd.target.id; });

    const results = await rehydrateAsync(bus, [
      { action: 'cartAdd', target: { id: 1 } },
      { action: 'cartAdd', target: { id: 2 } },
    ]);

    expect(seen).toEqual([1, 2]);
    expect(results.map(r => r.ok)).toEqual([true, true]);
    expect(results.map(r => r.value)).toEqual([1, 2]);
  });

  it('skips commands rejected by the filter', async ({ asyncBus: bus }) => {
    const seen: string[] = [];
    bus.register('a', async () => { seen.push('a'); });
    bus.register('b', async () => { seen.push('b'); });

    const results = await rehydrateAsync(
      bus,
      [{ action: 'a', target: {} }, { action: 'b', target: {} }],
      { filter: (cmd) => cmd.action === 'b' },
    );

    expect(seen).toEqual(['b']);
    expect(results).toHaveLength(1);
  });

  it('skips unhandled commands by default and replays them with ignoreUnhandled:false', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    bus.register('known', async () => 1);

    const skipped = await rehydrateAsync(bus, [{ action: 'ghost', target: {} }, { action: 'known', target: {} }]);
    expect(skipped).toHaveLength(1);

    const forced = await rehydrateAsync(bus, [{ action: 'ghost', target: {} }], { ignoreUnhandled: false });
    expect(forced).toHaveLength(1);
  });

  it('turns a rejecting dispatch into { ok:false } instead of throwing', async () => {
    const bus = {
      hasHandler: () => true,
      dispatch: () => Promise.reject(new Error('async boom')),
    } as unknown as BaseBus;

    const results = await rehydrateAsync(bus, [{ action: 'x', target: {} }]);
    expect(results).toEqual([{ ok: false, error: expect.objectContaining({ message: 'async boom' }) }]);
  });
});
