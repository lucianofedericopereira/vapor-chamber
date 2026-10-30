/**
 * The bus's `buffer` (createBuffer): a command dispatched before its handler exists is queued per action and replayed in order on register.
 * Why: lazy wiring (island hydration, code-split panels) dispatches before a handler exists; a bad bound must neither throw nor unbound the queue.
 * Shows: FIFO replay through the full pipeline, per action; no buffering once a handler exists or for a query; maxSize, onDrop and ttl; 0, NaN and negative bounds are safe.
 * See: audit D7, tests/bounds.test.ts.
 */
import { describe, expect, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { createBuffer, type BufferOptions } from '../src/buffer';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const buffered = (opts?: BufferOptions) => createCommandBus({ buffer: createBuffer(opts) });

describe('buffer - deferred dispatch', () => {
  it('replays commands dispatched before the handler exists, in FIFO order', () => {
    const bus = buffered();
    const seen: number[] = [];

    // dispatched with no handler yet -> queued
    const r1 = bus.dispatch('open', 1);
    bus.dispatch('open', 2);
    bus.dispatch('open', 3);

    expect(seen).toEqual([]);            // nothing ran yet
    expect(r1.ok).toBe(true);
    expect(r1.value).toBeInstanceOf(Accepted); // held: done settles when it runs

    // handler arrives -> buffered commands replay in order
    bus.register('open', (cmd) => { seen.push(cmd.target as number); });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('does NOT buffer once a handler exists - later dispatches run immediately', () => {
    const bus = buffered();
    const seen: number[] = [];
    bus.register('go', (cmd) => { seen.push(cmd.target as number); });
    bus.dispatch('go', 1);
    expect(seen).toEqual([1]); // ran synchronously, not queued
  });

  it('buffers each action independently', () => {
    const bus = buffered();
    const a: number[] = [];
    const b: number[] = [];
    bus.dispatch('a', 1);
    bus.dispatch('b', 10);
    bus.dispatch('a', 2);

    bus.register('a', (cmd) => a.push(cmd.target as number));
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([]); // 'b' still queued

    bus.register('b', (cmd) => b.push(cmd.target as number));
    expect(b).toEqual([10]);
  });

  it('replays through the full pipeline (plugins + listeners fire)', () => {
    const bus = buffered();
    const order: string[] = [];
    bus.use({ started: (cmd) => { order.push(`plugin:${cmd.target}`); } });
    bus.on('save', (cmd) => order.push(`listener:${cmd.target}`));
    bus.dispatch('save', 'x');           // queued
    expect(order).toEqual([]);
    bus.register('save', (cmd) => order.push(`handler:${cmd.target}`));
    expect(order).toEqual(['plugin:x', 'handler:x', 'listener:x']);
  });

  it('maxSize drops the oldest and warns', () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = buffered({ maxSize: 2 });
    bus.dispatch('q', 1);
    bus.dispatch('q', 2);
    bus.dispatch('q', 3); // overflow -> drops oldest (1)
    const seen: number[] = [];
    bus.register('q', (cmd) => seen.push(cmd.target as number));
    expect(seen).toEqual([2, 3]);
  });

  it('query never buffers - it falls back to error', () => {
    const bus = buffered();
    const r = bus.query('missing', {});
    expect(r).toFailWith('core:missing:handler');
  });

  it('a bus with no buffer is unchanged (errors, no buffering)', ({ bus }) => {
    const r = bus.dispatch('nope', {});
    expect(r).toFailWith('core:missing:handler');
  });

  it('async bus buffers and replays on register', async () => {
    const bus = createAsyncCommandBus({ buffer: createBuffer() });
    const seen: number[] = [];
    bus.dispatch('load', 1);
    bus.dispatch('load', 2);
    expect(seen).toEqual([]);
    bus.register('load', async (cmd) => { seen.push(cmd.target as number); return cmd.target; });
    await tick(); // async handlers replay on the microtask/macrotask
    expect(seen).toEqual([1, 2]);
  });

  it('onDrop fires when maxSize drops the oldest', () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: Array<{ action: string; target: any }> = [];
    const bus = buffered({ maxSize: 2, onDrop: (action, d) => dropped.push({ action, target: d.target }) });
    bus.dispatch('q', 1);
    bus.dispatch('q', 2);
    bus.dispatch('q', 3); // drops 1
    expect(dropped).toEqual([{ action: 'q', target: 1 }]);
  });

  // A bound of 0 drops the arriving command; evicting before the push would shift an empty queue and throw.
  it('maxSize: 0 buffers nothing instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: Array<{ action: string; target: any }> = [];
    const bus = buffered({ maxSize: 0, onDrop: (action, d) => dropped.push({ action, target: d.target }) });

    const result = bus.dispatch('q', 1);
    warn.mockRestore();

    expect(result.ok).toBe(true);
    // Nothing retained, and the arriving command is the one reported dropped.
    expect(dropped).toEqual([{ action: 'q', target: 1 }]);

    // Registering later replays nothing, because nothing was buffered.
    const seen: unknown[] = [];
    bus.register('q', (cmd) => { seen.push(cmd.target); return { ok: true }; });
    expect(seen).toEqual([]);
  });

  // Every comparison with NaN is false, so a NaN bound would vanish silently.
  it('a NaN maxSize takes the default bound instead of unbounding the queue', () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = buffered({ maxSize: Number('not-a-number') });

    for (let i = 0; i < 300; i++) bus.dispatch('q', i);

    let replayed = 0;
    bus.register('q', () => { replayed++; return { ok: true }; });

    // countOption sends NaN to the default 256, as for every count in the library.
    expect(replayed).toBe(256);
  });

  it('a negative maxSize is clamped rather than draining into a crash', () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: unknown[] = [];
    const bus = buffered({ maxSize: -3, onDrop: (_a, d) => dropped.push(d.target) });

    expect(bus.dispatch('q', 1).ok).toBe(true);
    expect(bus.dispatch('q', 2).ok).toBe(true);

    expect(dropped).toEqual([1, 2]);
  });

  it('ttl reaps expired entries on push and skips them at flush', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const dropped: any[] = [];
      const bus = buffered({ ttl: 100, onDrop: (_a, d) => dropped.push(d.target) });
      bus.dispatch('save', 'stale'); // at t=0
      vi.setSystemTime(1_000_200);   // +200ms - past TTL
      bus.dispatch('save', 'fresh'); // push reaps 'stale'
      expect(dropped).toEqual(['stale']);

      vi.setSystemTime(1_000_400);   // 'fresh' now expired too (waited 200ms)
      const seen: string[] = [];
      bus.register('save', (cmd) => seen.push(cmd.target as string));
      expect(seen).toEqual([]);           // expired entry not replayed
      expect(dropped).toEqual(['stale', 'fresh']); // flush reported the expiry
    } finally {
      vi.useRealTimers();
    }
  });

  it('ttl keeps non-expired entries working as before', () => {
    const bus = buffered({ ttl: 60_000 });
    bus.dispatch('go', 'a');
    const seen: string[] = [];
    bus.register('go', (cmd) => seen.push(cmd.target as string));
    expect(seen).toEqual(['a']);
  });
});
