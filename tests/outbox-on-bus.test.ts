// @vitest-environment happy-dom
/**
 * The outbox as a bus option: a held command answers an `Accepted`, and the flush sends each record through its action's transport at the work step.
 * Why: if the replay were re-dispatched through the chain, `idempotent` outside the outbox would answer it from memory and nothing would be sent, and plugins and listeners would see replays.
 * Shows: done settles with the server answer (single and batching transport), a final refusal, a store answer and a local handler's answer; the flush sends once past `idempotent`, a debounced burst is held once, a replay carries an Idempotency-Key and is not heard by listeners; actions outside the scope are sent offline; the stored queue loads first and a stored record refused for good reaches `rejected`; window online/offline events drive hold and flush.
 * See: log s36.69
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import { queueStorage, storedRecord } from './outbox-storage';
import { pace } from '../src/pace';
import { idempotent } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';
import { defineTransport, httpTransport } from '../src/transports';

type List = { items: string[] };
const serverState = (item: string): List => ({ items: [`server:${item}`] });
const settle = () => new Promise((r) => setTimeout(r, 0));

/** An http client: every post answers `{ state }` for its target, or `status` with a problem. */
function client(status = 200) {
  const post = vi.fn(async (_url: string, body: { target: string }) =>
    status === 200
      ? { ok: true, status, data: { state: serverState(body.target) }, headers: {} }
      : { ok: false, status, data: { title: 'refused', status }, headers: { 'content-type': 'application/problem+json' } });
  return { post };
}

let online = false;
afterEach(() => { online = false; });

function world(opts: { status?: number; batch?: boolean; loaded?: OutboxRecord[] | null; actions?: string[] } = {}) {
  const http = client(opts.status);
  // Its own name: an outbox in a page opens tabs, and Node shares them across vitest's workers.
  const outbox = createOutbox({ name: 'vc:outbox:outbox-on-bus', storage: opts.loaded ? queueStorage(opts.loaded, { async: true, key: 'vc:outbox:outbox-on-bus' }) : null, isOnline: () => online, autoFlush: false, actions: opts.actions });
  const bus = createAsyncCommandBus({
    retry: false,
    transport: httpTransport({ endpoint: '/vc', httpClient: http as never, ...(opts.batch ? { batch: {} } : {}) }),
    outbox,
  } as never);
  return { bus, outbox, http };
}

describe('a held command', () => {
  it('answers an Accepted whose done settles with the server answer', async () => {
    const { bus, outbox, http } = world();
    const r = await bus.dispatch('cartAdd', 'milk');
    expect(r.ok).toBe(true);
    expect(r.value).toBeInstanceOf(Accepted);
    expect(http.post).not.toHaveBeenCalled();
    online = true;
    const summary = await outbox.flush();
    expect(summary).toEqual({ replayed: 1, failed: 0, rejected: 0 });
    const end = await (r.value as Accepted).done;
    expect(end).toMatchObject({ ok: true, value: serverState('milk') });
  });

  it('the same through a batching transport', async () => {
    const post = vi.fn(async (_url: string, body: { commands: Array<{ id: string; target: string }> }) =>
      ({ ok: true, status: 200, data: { results: body.commands.map((c) => ({ id: c.id, state: serverState(c.target) })) }, headers: {} }));
    const outbox = createOutbox({ storage: null, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: { post } as never, batch: {} }), outbox } as never);
    const r = await bus.dispatch('cartAdd', 'tea');
    online = true;
    await outbox.flush();
    expect(await (r.value as Accepted).done).toMatchObject({ ok: true, value: serverState('tea') });
  });

  it('a final refusal settles done with the failure', async () => {
    const { bus, outbox } = world({ status: 422 });
    const r = await bus.dispatch('cartAdd', 'milk');
    online = true;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 0, rejected: 1 });
    const end = (await (r.value as Accepted).done) as CommandResult;
    expect(end.ok).toBe(false);
    expect(outbox.rejected.value).toEqual([]);
  });

  it('a store action held offline takes its answer on replay', async () => {
    const { bus, outbox } = world();
    const cart = defineChamberStore('cart', { state: (): List => ({ items: [] }), reducers: { add: null }, answer: (_s, a) => a as List })(bus);
    await cart.add('milk');
    expect(cart.state.value).toEqual({ items: [] });
    online = true;
    await outbox.flush();
    expect(cart.state.value).toEqual(serverState('milk'));
    cart.$dispose();
  });
});

describe('the flush sends at the work step', () => {
  it('idempotent installed outside the outbox does not answer the replay from memory', async () => {
    const { bus, outbox, http } = world();
    bus.use(idempotent());
    await bus.dispatch('cartAdd', 'milk');
    online = true;
    await outbox.flush();
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('a debounced sender: an offline burst is held once, its latest call', async () => {
    vi.useFakeTimers();
    try {
      const { bus, outbox } = world();
      const send = pace(bus.dispatch, { debounce: 20 });
      for (const q of [1, 2, 3]) void send('cartAdd', 'milk', { q });
      await vi.advanceTimersByTimeAsync(60);
      expect(outbox.pending.value).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a replay carries its record key and origin replay; no listener hears it', async () => {
    const { bus, outbox, http } = world();
    const heard: string[] = [];
    bus.on('*', (cmd) => { heard.push(`${cmd.action}:${cmd.meta?.origin}`); });
    await bus.dispatch('cartAdd', 'milk');
    online = true;
    await outbox.flush();
    expect(heard).toEqual(['cartAdd:undefined']);
    const sent = http.post.mock.calls[0] as unknown as [string, unknown, { headers?: Record<string, string> }?];
    expect(JSON.stringify(sent)).toContain('Idempotency-Key');
  });
});

describe('scope and load', () => {
  it('an action outside the outbox is sent even offline', async () => {
    const { bus, http } = world({ actions: ['cart*'] });
    const r = await bus.dispatch('noteAdd', 'x');
    expect(r.value).toEqual(serverState('x'));
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it("a previous session's record refused for good reaches `rejected`", async () => {
    const loaded: OutboxRecord[] = [storedRecord({ id: 'r1', action: 'cartAdd', target: 'old', key: 'r1' })];
    const { outbox } = world({ status: 422, loaded });
    await settle();
    expect(outbox.pending.value).toBe(1);
    online = true;
    await outbox.flush();
    expect(outbox.rejected.value.map((x) => x.record.id)).toEqual(['r1']);
    expect(outbox.pending.value).toBe(0);
  });

  it('the stored queue loads at creation and goes first', async () => {
    const loaded: OutboxRecord[] = [storedRecord({ id: 'r1', action: 'cartAdd', target: 'old', key: 'r1' })];
    const { bus, outbox, http } = world({ loaded });
    online = true;
    const r = await bus.dispatch('cartAdd', 'new'); // held: the loaded record is ahead of it
    expect(r.value).toBeInstanceOf(Accepted);
    await outbox.flush();
    expect(http.post.mock.calls.map((c) => (c[1] as { target: string }).target)).toEqual(['old', 'new']);
  });
});

describe('online is a flag the window events keep', () => {
  it('offline holds, online flushes', async () => {
    const http = client();
    const outbox = createOutbox({ storage: null });
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: http as never }), outbox } as never);
    window.dispatchEvent(new Event('offline'));
    const r = await bus.dispatch('cartAdd', 'milk');
    expect(r.value).toBeInstanceOf(Accepted);
    window.dispatchEvent(new Event('online'));
    expect(await (r.value as Accepted).done).toMatchObject({ ok: true });
    expect(http.post).toHaveBeenCalledTimes(1);
    outbox.dispose();
  });
});

describe("a replay through a transport that runs the action's local handler", () => {
  it('the local handler answers the replay', async () => {
    let online = false;
    const outbox = createOutbox({ storage: null, isOnline: () => online, autoFlush: false });
    const offline = defineTransport(async (_cmd: unknown, local: () => Promise<CommandResult>) => local(), { localFallback: true });
    const bus = createAsyncCommandBus({ retry: false, transport: offline, outbox });
    bus.register('cartAdd', async () => 'local');
    const r = await bus.dispatch('cartAdd', 1);
    online = true;
    await outbox.flush();
    expect(await (r.value as Accepted).done).toMatchObject({ ok: true, value: 'local' });
    outbox.dispose();
  });
});
