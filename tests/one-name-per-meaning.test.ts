/** One name for a cap on retained entries, `maxSize`, and one for teardown, `dispose` (plan 1.27 D4.N8). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandError, useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import { cache, idempotent, metrics } from '../src/plugins-extra';
import { createChannel } from '../src/plugins-io';
import { createSSRPlugin } from '../src/ssr';
import { createEchoBridge, createSseBridge, createWsBridge } from '../src/transports';

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
function errorsKept(make: () => { errors: { value: unknown[] } }) {
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
    let saved: OutboxRecord[] = [];
    const storage = { load: () => null, save: (r: OutboxRecord[]) => { saved = r; }, clear: () => {} };
    const outbox = createOutbox({ storage, isOnline: () => false, autoFlush: false, maxSize: 1 });
    const bus = createAsyncCommandBus({ retry: false });
    outbox.install(bus);
    for (let i = 0; i < 3; i++) await bus.dispatch('cartAdd', { i });
    expect([outbox.pending.value, saved.length]).toEqual([1, 1]);
  });

  it('createSSRPlugin: the commands it records', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('cmd', () => 'ok');
    const ssr = createSSRPlugin({ maxSize: 1 });
    bus.use(ssr.plugin);
    for (let i = 0; i < 3; i++) bus.dispatch('cmd', { i });
    expect([ssr.size(), ssr.dropped()]).toEqual([1, 2]);
  });

  it('useCommandError and useSharedCommandState: the errors they keep', () => {
    expect(errorsKept(() => useCommandError({ maxSize: 2 }))).toBe(2);
    expect(errorsKept(() => useSharedCommandState({ maxSize: 2 }))).toBe(2);
  });

  it("the bus's maxBufferSize: the commands buffered per action", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropped: unknown[] = [];
    const bus = createCommandBus({ onMissing: 'buffer', maxBufferSize: 1, onBufferOverflow: (_a, d) => dropped.push(d.target) });
    for (let i = 0; i < 3; i++) bus.dispatch('later', i);
    expect(dropped).toEqual([0, 1]);
  });
});

describe('controls', () => {
  it('no option: each keeps its default', async () => {
    expect(await remembered({})).toBe(3);
    expect(errorsKept(() => useCommandError())).toBe(5);
    expect(errorsKept(() => useSharedCommandState())).toBe(5);
    const bus = createCommandBus({ onMissing: 'buffer', onBufferOverflow: () => { throw new Error('dropped'); } });
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

  it('control: the WebSocket bridge keeps connect() and disconnect(), a pair', () => {
    const ws = createWsBridge({ url: 'ws://x' });
    expect([typeof ws.connect, typeof ws.disconnect]).toEqual(['function', 'function']);
  });
});

/*
 * Audit N8: eight names meant "the most entries this keeps" (`maxSize`,
 * `maxKeys`, `maxEntries`, `maxQueue`, `maxQueueSize`, `maxCommands`,
 * `errorCap`, `bufferLimit`). ECMA-262's `size` counts a Map's entries, and
 * W3C Resource Timing sets its buffer's limit through `maxSize`; the library's
 * own `size()` already counted entries and `maxSize` was its most used name.
 * Where the options configure more than the collection, its name sits inside:
 * the bus's `maxBufferSize` beside `bufferTTL`, the WebSocket bridge's
 * `maxQueueSize` beside its connection. The old names are gone, with no
 * fallback (no deprecations). Log s35.188.
 *
 * Teardown had five names: `dispose` (the buses, plugins, composables, the
 * outbox), `teardown` (the SSE and Echo bridges), `close` (createChannel,
 * the Vitest MCP server), `destroy` (the router and its history) and the
 * docs' `stop` for serveMcpStdio's returned function. ECMA-262 names the
 * method `dispose` (`Symbol.dispose`, `DisposableStack.prototype.dispose`),
 * and `disposeAsync` for an async one. The WebSocket bridge's `disconnect()`
 * stays: a later `connect()` opens a new socket, so it is not a teardown.
 * The router's dispose is pinned by the router suite. Log s35.189.
 */
