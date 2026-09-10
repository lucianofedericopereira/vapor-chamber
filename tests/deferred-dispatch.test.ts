/**
 * Tests for onMissing: 'buffer' - deferred dispatch (buffer-until-registered).
 * Built for lazy/async wiring (island hydration, code-split panels) where a
 * command can be dispatched before its handler exists: the command is queued
 * per-action and replayed, in order, the moment a handler registers.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("onMissing: 'buffer' - deferred dispatch", () => {
  it('replays commands dispatched before the handler exists, in FIFO order', () => {
    const bus = createCommandBus({ onMissing: 'buffer' });
    const seen: number[] = [];

    // dispatched with no handler yet -> queued
    const r1 = bus.dispatch('open', 1);
    bus.dispatch('open', 2);
    bus.dispatch('open', 3);

    expect(seen).toEqual([]);            // nothing ran yet
    expect(r1.ok).toBe(true);           // accepted (deferred)
    expect(r1.value).toBeUndefined();

    // handler arrives -> buffered commands replay in order
    bus.register('open', (cmd) => { seen.push(cmd.target as number); });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('does NOT buffer once a handler exists - later dispatches run immediately', () => {
    const bus = createCommandBus({ onMissing: 'buffer' });
    const seen: number[] = [];
    bus.register('go', (cmd) => { seen.push(cmd.target as number); });
    bus.dispatch('go', 1);
    expect(seen).toEqual([1]); // ran synchronously, not queued
  });

  it('buffers each action independently', () => {
    const bus = createCommandBus({ onMissing: 'buffer' });
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
    const bus = createCommandBus({ onMissing: 'buffer' });
    const order: string[] = [];
    bus.use((cmd, next) => { order.push(`plugin:${cmd.target}`); return next(); });
    bus.on('save', (cmd) => order.push(`listener:${cmd.target}`));
    bus.dispatch('save', 'x');           // queued
    expect(order).toEqual([]);
    bus.register('save', (cmd) => order.push(`handler:${cmd.target}`));
    expect(order).toEqual(['plugin:x', 'handler:x', 'listener:x']);
  });

  it('bufferLimit drops the oldest and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'buffer', bufferLimit: 2 });
    bus.dispatch('q', 1);
    bus.dispatch('q', 2);
    bus.dispatch('q', 3); // overflow -> drops oldest (1)
    const seen: number[] = [];
    bus.register('q', (cmd) => seen.push(cmd.target as number));
    warn.mockRestore();
    expect(seen).toEqual([2, 3]);
  });

  it('query never buffers - it falls back to error', () => {
    const bus = createCommandBus({ onMissing: 'buffer' });
    const r = bus.query('missing', {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('VC_CORE_NO_HANDLER');
  });

  it('default onMissing is unchanged (errors, no buffering)', () => {
    const bus = createCommandBus();
    const r = bus.dispatch('nope', {});
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('VC_CORE_NO_HANDLER');
  });

  it('async bus buffers and replays on register', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'buffer' });
    const seen: number[] = [];
    bus.dispatch('load', 1);
    bus.dispatch('load', 2);
    expect(seen).toEqual([]);
    bus.register('load', async (cmd) => { seen.push(cmd.target as number); return cmd.target; });
    await tick(); // async handlers replay on the microtask/macrotask
    expect(seen).toEqual([1, 2]);
  });

  it('onBufferOverflow fires when bufferLimit drops the oldest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: Array<{ action: string; target: any }> = [];
    const bus = createCommandBus({
      onMissing: 'buffer',
      bufferLimit: 2,
      onBufferOverflow: (action, d) => dropped.push({ action, target: d.target }),
    });
    bus.dispatch('q', 1);
    bus.dispatch('q', 2);
    bus.dispatch('q', 3); // drops 1
    warn.mockRestore();
    expect(dropped).toEqual([{ action: 'q', target: 1 }]);
  });

  // The eviction used to run BEFORE the push, so an empty queue still
  // satisfied `q.length >= limit` at a bound of 0: `shift()` returned
  // undefined and the overflow callback dereferenced it, throwing out of
  // `bus.dispatch()`. It was invisible without `onBufferOverflow`, because
  // optional-chaining a call skips evaluating its arguments - so adding the
  // observability hook was what made the bus throw.
  it('bufferLimit: 0 buffers nothing instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: Array<{ action: string; target: any }> = [];
    const bus = createCommandBus({
      onMissing: 'buffer',
      bufferLimit: 0,
      onBufferOverflow: (action, d) => dropped.push({ action, target: d.target }),
    });

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

  // Math.trunc and Math.max both propagate NaN, and every comparison against
  // NaN is false - so `q.length > limit` never fired and the bound silently
  // vanished. A `bufferLimit: Number(badConfigValue)` is all it takes.
  it('a NaN bufferLimit buffers nothing instead of unbounding the queue', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus({ onMissing: 'buffer', bufferLimit: Number('not-a-number') });

    for (let i = 0; i < 300; i++) bus.dispatch('q', i);

    let replayed = 0;
    bus.register('q', () => { replayed++; return { ok: true }; });
    warn.mockRestore();

    // Measured at 300 buffered before the guard - unbounded growth. `| 0` maps
    // NaN to 0, so a bad bound now buffers nothing: still bounded, and loud,
    // because a misconfigured buffer that replays NOTHING is noticed at once
    // where one silently running on the default is not.
    expect(replayed).toBe(0);
  });

  it('a negative bufferLimit is clamped rather than draining into a crash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: unknown[] = [];
    const bus = createCommandBus({
      onMissing: 'buffer',
      bufferLimit: -3,
      onBufferOverflow: (_a, d) => dropped.push(d.target),
    });

    expect(bus.dispatch('q', 1).ok).toBe(true);
    expect(bus.dispatch('q', 2).ok).toBe(true);
    warn.mockRestore();

    expect(dropped).toEqual([1, 2]);
  });

  it('bufferTTL reaps expired entries on push and skips them at flush', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const dropped: any[] = [];
      const bus = createCommandBus({
        onMissing: 'buffer',
        bufferTTL: 100,
        onBufferOverflow: (_a, d) => dropped.push(d.target),
      });
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

  it('bufferTTL keeps non-expired entries working as before', () => {
    const bus = createCommandBus({ onMissing: 'buffer', bufferTTL: 60_000 });
    bus.dispatch('go', 'a');
    const seen: string[] = [];
    bus.register('go', (cmd) => seen.push(cmd.target as string));
    expect(seen).toEqual(['a']);
  });
});
