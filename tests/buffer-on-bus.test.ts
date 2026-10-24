/** `createBuffer` as a bus option: a dispatch before its handler answers an `Accepted` that settles with the handler's result. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { createBuffer } from '../src/buffer';
import { type BaseBus, type Command, type CommandResult, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { defineTransport } from '../src/transports';

const BUSES = [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const;
const doneOf = async (r: CommandResult | Promise<CommandResult>): Promise<CommandResult> => ((await r).value as Accepted).done;

afterEach(() => { vi.useRealTimers(); });

describe.each(BUSES)('a buffered dispatch on the %s bus', (_name, make) => {
  const busWith = (opts: Parameters<typeof createBuffer>[0] = {}) => {
    const buffer = createBuffer(opts);
    const bus: BaseBus = make({ buffer } as never);
    return { bus, buffer };
  };

  it('answers an Accepted whose done settles with the handler result', async () => {
    const { bus, buffer } = busWith();
    const r = await bus.dispatch('cartAdd', 2);
    expect(r.ok).toBe(true);
    expect(r.value).toBeInstanceOf(Accepted);
    expect(buffer.pending.value).toBe(1);
    bus.register('cartAdd', (cmd: Command) => (cmd.target as number) * 10);
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 20 });
    expect(buffer.pending.value).toBe(0);
  });

  it('replays in order, through the hooks and listeners', async () => {
    const { bus } = busWith();
    const heard: number[] = [];
    bus.on('cartAdd', (cmd) => { heard.push(cmd.target as number); });
    const a = await bus.dispatch('cartAdd', 1);
    const b = await bus.dispatch('cartAdd', 2);
    expect(heard).toEqual([]);
    bus.register('cartAdd', (cmd: Command) => cmd.target);
    await Promise.all([doneOf(a), doneOf(b)]);
    expect(heard).toEqual([1, 2]);
  });

  it('maxSize drops the oldest: its done settles coded and onDrop hears it', async () => {
    const onDrop = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus } = busWith({ maxSize: 1, onDrop });
    const first = await bus.dispatch('cartAdd', 1);
    await bus.dispatch('cartAdd', 2);
    expect(await doneOf(first)).toFailWith('buffer:exceeded:queue');
    expect(onDrop).toHaveBeenCalledWith('cartAdd', { target: 1, payload: undefined });
  });

  it('ttl reaps an old command: its done settles coded and onDrop hears it', async () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    const { bus } = busWith({ ttl: 1000, onDrop });
    const old = await bus.dispatch('cartAdd', 1);
    vi.advanceTimersByTime(1001);
    bus.register('cartAdd', (cmd: Command) => cmd.target);
    expect(await doneOf(old)).toFailWith('buffer:timeout:queue');
    expect(onDrop).toHaveBeenCalledWith('cartAdd', { target: 1, payload: undefined });
  });

  it("the bus's clear() settles a waiting caller", async () => {
    const { bus, buffer } = busWith();
    const r = await bus.dispatch('cartAdd', 1);
    bus.clear();
    expect(await doneOf(r)).toFailWith('buffer:aborted:clear');
    expect(buffer.pending.value).toBe(0);
  });

  it('a query never buffers', async () => {
    const { bus } = busWith();
    expect(await bus.query('cartRead', 1)).toFailWith('core:missing:handler');
  });

  it('control: a bus without a buffer answers a missing handler as before', async () => {
    const bus: BaseBus = make();
    expect(await bus.dispatch('cartAdd', 1)).toFailWith('core:missing:handler');
  });
});

describe('a transport wins over buffering', () => {
  it('an action with a transport is sent, not held', async () => {
    const buffer = createBuffer();
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: true, value: 'sent', error: undefined })), buffer } as never);
    expect(await bus.dispatch('cartAdd', 1)).toSucceedWith('sent');
    expect(buffer.pending.value).toBe(0);
  });
});

/*
 * Plan 1.32 step 4i, owner Q7 (the store owns the buffer queue; the outbox's shape) and the
 * owner's "both", 2026-10-20. Before, `onMissing: 'buffer'` queued inside the bus and answered
 * `{ ok: true, value: undefined }` at once, so the caller never heard the handler's result,
 * and a drop reached only `onBufferOverflow`. Now the queue is its own module given to the bus,
 * a held dispatch answers an `Accepted` like a held outbox command, and every drop settles the
 * caller's `done` with a coded failure; `onDrop` keeps one place to observe them.
 */
