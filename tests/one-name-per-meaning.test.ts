/**
 * One name for a cap on retained entries, `maxSize`, and one for teardown, `dispose`.
 * Why: a cap or a teardown spelled differently per module (`maxKeys`, `maxQueue`, `teardown`, `close`) would make an option silently ignored or a resource leaked when a caller guesses the wrong name; `dispose` is the ECMA-262 method name.
 * Shows: `maxSize` caps idempotent, metrics, the outbox, both error composables and the buffer, with no-option controls and a cache control; `dispose` closes the SSE EventSource, leaves the Echo channels, and stops createChannel; the WebSocket transport keeps `connect` and `disconnect` as functions.
 * See: log s35.188, s35.189.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandError, useSharedCommandState } from '../src/chamber';
import { createBuffer } from '../src/buffer';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { queueStorage } from './outbox-storage';
import { cache, idempotent, metrics } from '../src/plugins-extra';
import { createChannel } from '../src/plugins-io';
import { createEchoBridge, createSseBridge, defineTransport, wsTransport } from '../src/transports';

afterEach(() => { resetCommandBus(); vi.restoreAllMocks(); });

/** How many of three distinct `op` commands idempotent still collapses after all three ran (newest asked first). */
async function remembered(opts: { maxSize?: number }) {
  const bus = createAsyncCommandBus({ retry: false });
  let runs = 0;
  bus.register('op', async () => { runs++; });
  bus.use(idempotent(opts));
  for (const id of ['a', 'b', 'c']) await bus.dispatch('op', { id });
  const before = runs;
  for (const id of ['c', 'b', 'a']) await bus.dispatch('op', { id });
  return 3 - (runs - before);
}

/** Errors kept after five failures, by a composable on the shared bus. */
function errorsKept(make: () => { errors: { readonly value: readonly unknown[] } }) {
  const bus = createCommandBus();
  setCommandBus(bus);
  const { errors } = make();
  for (let i = 0; i < 5; i++) bus.dispatch(`missing${i}`, {});
  return errors.value.length;
}

describe('maxSize caps what each one keeps', () => {
  it('idempotent: the completed keys it remembers', async () => {
    expect(await remembered({ maxSize: 1 })).toBe(1);
  });

  it('metrics: the entries it keeps', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    const m = metrics({ maxSize: 2 });
    bus.use(m);
    for (let i = 0; i < 5; i++) bus.dispatch('a', {});
    expect(m.entries()).toHaveLength(2);
  });

  it('the outbox: the records it queues', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = queueStorage();
    const outbox = createOutbox({ storage, isOnline: () => false, autoFlush: false, maxSize: 1 });
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: true, value: 1, error: undefined })), outbox });
    for (let i = 0; i < 3; i++) await bus.dispatch('cartAdd', { i });
    await Promise.resolve();
    expect([outbox.pending.value, storage.rows().length]).toEqual([1, 1]);
  });

  it('useCommandError and useSharedCommandState: the errors they keep', () => {
    expect(errorsKept(() => useCommandError({ maxSize: 2 }))).toBe(2);
    expect(errorsKept(() => useSharedCommandState({ maxSize: 2 }))).toBe(2);
  });

  it("the buffer's maxSize: the commands held per action", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: unknown[] = [];
    const bus = createCommandBus({ buffer: createBuffer({ maxSize: 1, onDrop: (_a, d) => dropped.push(d.target) }) });
    for (let i = 0; i < 3; i++) bus.dispatch('later', i);
    expect(dropped).toEqual([0, 1]);
  });
});

describe('controls', () => {
  it('no option: each keeps its default', async () => {
    expect(await remembered({})).toBe(3);
    expect(errorsKept(() => useCommandError())).toBe(5);
    expect(errorsKept(() => useSharedCommandState())).toBe(5);
    const bus = createCommandBus({ buffer: createBuffer({ onDrop: () => { throw new Error('dropped'); } }) });
    for (let i = 0; i < 3; i++) bus.dispatch('later', i);
  });

  it('cache keeps its maxSize', () => {
    const bus = createCommandBus();
    bus.register('get', (cmd) => cmd.target);
    const c = cache({ maxSize: 1 });
    bus.use(c);
    bus.dispatch('get', 1);
    bus.dispatch('get', 2);
    expect(c.size()).toBe(1);
  });
});

describe('dispose releases what each one took', () => {
  it('createSseBridge: closes its EventSource', () => {
    const closed: string[] = [];
    vi.stubGlobal('EventSource', class { static OPEN = 1; readyState = 1; constructor(public url: string) {} close() { closed.push(this.url); } });
    const sse = createSseBridge({ url: '/events', onEvent: () => {} });
    sse.install(createCommandBus());
    sse.dispose();
    expect([closed, sse.isConnected()]).toEqual([['/events'], false]);
  });

  it('createEchoBridge: leaves its channels', () => {
    const left: string[] = [];
    const channel = { listen: () => channel };
    const echo = { channel: () => channel, private: () => channel, join: () => channel, leave: (name: string) => left.push(name) };
    const realtime = createEchoBridge({ echo, channels: [{ name: 'orders', events: ['OrderShipped'] }] });
    realtime.install(createCommandBus());
    realtime.dispose();
    expect(left).toEqual(['orders']);
  });

  it('createChannel: stops mirroring and closes its BroadcastChannel', () => {
    let subscribed = 0;
    const lane = { on: () => { subscribed++; return () => { subscribed--; }; }, emit: () => {} };
    const ch = createChannel({ channel: 'n8-dispose', lane, events: ['a', 'b'] });
    expect([subscribed, ch.isOpen()]).toEqual([2, true]);
    ch.dispose();
    expect([subscribed, ch.isOpen()]).toEqual([0, false]);
  });

  it('control: the WebSocket transport keeps connect() and disconnect(), a pair', () => {
    const ws = wsTransport({ url: 'ws://x' });
    expect([typeof ws.connect, typeof ws.disconnect]).toEqual(['function', 'function']);
  });
});
