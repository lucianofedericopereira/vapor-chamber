/**
 * Tests for onMissing: 'buffer' — deferred dispatch (buffer-until-registered).
 * Built for lazy/async wiring (island hydration, code-split panels) where a
 * command can be dispatched before its handler exists: the command is queued
 * per-action and replayed, in order, the moment a handler registers.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("onMissing: 'buffer' — deferred dispatch", () => {
  it('replays commands dispatched before the handler exists, in FIFO order', () => {
    const bus = createCommandBus({ onMissing: 'buffer' });
    const seen: number[] = [];

    // dispatched with no handler yet → queued
    const r1 = bus.dispatch('open', 1);
    bus.dispatch('open', 2);
    bus.dispatch('open', 3);

    expect(seen).toEqual([]);            // nothing ran yet
    expect(r1.ok).toBe(true);           // accepted (deferred)
    expect(r1.value).toBeUndefined();

    // handler arrives → buffered commands replay in order
    bus.register('open', (cmd) => { seen.push(cmd.target as number); });
    expect(seen).toEqual([1, 2, 3]);
  });

  it('does NOT buffer once a handler exists — later dispatches run immediately', () => {
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
    bus.dispatch('q', 3); // overflow → drops oldest (1)
    const seen: number[] = [];
    bus.register('q', (cmd) => seen.push(cmd.target as number));
    warn.mockRestore();
    expect(seen).toEqual([2, 3]);
  });

  it('query never buffers — it falls back to error', () => {
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
});
