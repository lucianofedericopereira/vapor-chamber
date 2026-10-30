/**
 * Tabs sharing one outbox queue: each tab sends its own records, a closed tab's records go to another tab, none twice.
 * Why: if every tab flushed the stored queue, a record would be sent twice (only the server's Idempotency-Key would dedupe it), and a closed tab's records would wait for a reload; a merge that is not per-tab authority would lose an add made at the same moment in another tab.
 * Shows: a stored record from a gone tab is sent once by two tabs; a live tab's caller gets its own done and the other tab does not send it; the first waiter takes a closed tab's records; a clear() in any tab aborts every held caller; crossing writes keep both tabs' records; foreign locks and a pending lock grant do not count as an open tab.
 * See: log s36.F5, s36.F18
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { type Command, createAsyncCommandBus } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import type { PersistStorage } from '../src/store-persist';
import { defineTransport } from '../src/transports';

const closers: Array<() => void> = [];
// `window` marks a page; navigator.locks and BroadcastChannel are Node's own.
beforeEach(() => { vi.stubGlobal('window', {}); });
afterEach(() => { while (closers.length) closers.pop()!(); vi.unstubAllGlobals(); });

/** One origin's localStorage, shared by every tab of a test. */
function origin(saved?: OutboxRecord[]): PersistStorage {
  const items = new Map<string, string>();
  if (saved) items.set(name, JSON.stringify({ records: saved, clears: 0 }));
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => { items.set(k, v); } };
}

let name = '';
let n = 0;
beforeEach(() => { name = `vc:outbox-tabs-${n++}`; });

/** The keys every tab sent, in order. */
const sent: string[] = [];
beforeEach(() => { sent.length = 0; });

/** One tab: its own bus and outbox on the shared storage; `online` is the tab's own flag. */
function tab(storage: PersistStorage, onSend?: (cmd: Command) => Promise<void>) {
  const state = { online: false };
  const outbox = createOutbox({ name, storage, isOnline: () => state.online });
  const send = async (cmd: Command) => {
    sent.push(cmd.meta!.idempotencyKey as string);
    if (onSend) await onSend(cmd);
    return { ok: true as const, value: cmd.target, error: undefined };
  };
  const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(send as never), outbox });
  let closed = false;
  const close = (): void => { if (!closed) { closed = true; bus.dispose(); } };
  closers.push(close);
  return { bus, outbox, state, close };
}

/** BroadcastChannel and a lock grant deliver on later tasks. */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const record = (id: string, tabId: string): OutboxRecord => ({ id, tab: tabId, action: 'cartAdd', target: id, key: `k-${id}`, queuedAt: '2026-10-21T00:00:00.000Z' });

describe('two tabs on one outbox', () => {
  it("never send the same record twice: a previous session's record goes once", async () => {
    const storage = origin([record('r1', 'gone')]);
    const a = tab(storage);
    const b = tab(storage);
    a.state.online = true;
    b.state.online = true;
    await Promise.all([a.outbox.flush(), b.outbox.flush()]);
    await settle();
    await Promise.all([a.outbox.flush(), b.outbox.flush()]);
    await settle();
    expect(sent).toEqual(['k-r1']);
  });

  it('a record whose tab closed is sent by the other tab, with no reload', async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    const held = await a.bus.dispatch('cartAdd', 'milk');
    expect(held.value).toBeInstanceOf(Accepted);
    await settle();
    expect(b.outbox.pending.value).toBe(1);
    b.state.online = true;
    await b.outbox.flush();
    expect(sent).toEqual([]);
    a.close();
    await settle();
    expect(sent.length).toBe(1);
    expect(b.outbox.pending.value).toBe(0);
  });

  it("a live tab's caller gets its own done; the other tab does not send it", async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    const held = await a.bus.dispatch('cartAdd', 'tea');
    await settle();
    b.state.online = true;
    await b.outbox.flush();
    expect(sent).toEqual([]);
    a.state.online = true;
    await a.outbox.flush();
    expect(sent.length).toBe(1);
    expect(await (held.value as Accepted).done).toMatchObject({ ok: true, value: 'tea' });
  });

  it("another tab's clear() settles a held caller's done with outbox:aborted:clear, and nothing is sent", async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    const held = await a.bus.dispatch('cartAdd', 'tea');
    await settle();
    b.outbox.clear();
    const done = await (held.value as Accepted).done;
    a.state.online = true;
    await a.outbox.flush();
    expect({ ok: done.ok, code: (done.error as { code?: string } | undefined)?.code, sent }).toEqual({ ok: false, code: 'outbox:aborted:clear', sent: [] });
  });

  it("a sent record another tab's older queue brings back is not sent again", async () => {
    const storage = origin();
    let b!: ReturnType<typeof tab>;
    let once = true;
    // While A sends its record, B writes twice from its older queue (the record still in it),
    // so B's state outranks A's removal by sequence number.
    const a = tab(storage, async () => {
      if (!once) return;
      once = false;
      await b.bus.dispatch('cartAdd', 'b1');
      await b.bus.dispatch('cartAdd', 'b2');
    });
    b = tab(storage);
    await a.bus.dispatch('cartAdd', 'tea');
    await settle();
    a.state.online = true;
    await a.outbox.flush();
    await settle(100);
    await a.outbox.flush();
    await settle(100);
    // B is offline and its records are its own: every send is A's one record, and the queue holds B's two.
    expect({ sends: sent.length, queued: [a.outbox.pending.value, b.outbox.pending.value] }).toEqual({ sends: 1, queued: [2, 2] });
  });

  it('two tabs holding a command at once both keep it: no caller hears aborted:clear', async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    await settle();
    // In one tick, before either write reaches the other tab; B writes twice, so its queue outranks A's.
    const [tea] = await Promise.all([a.bus.dispatch('cartAdd', 'tea'), b.bus.dispatch('cartAdd', 'b1'), b.bus.dispatch('cartAdd', 'b2')]);
    let heard: unknown = 'nothing';
    void (tea.value as Accepted).done.then((r) => { heard = r; });
    await settle(100);
    a.state.online = true;
    await a.outbox.flush();
    await settle();
    expect({ heard: heard === 'nothing' ? heard : (heard as { ok: boolean }).ok, sent: sent.length, queued: [a.outbox.pending.value, b.outbox.pending.value] })
      .toEqual({ heard: true, sent: 1, queued: [2, 2] });
  });

  it('a queue the sender wrote before an older record of this tab reached it keeps both of this tab\'s records', async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    await a.bus.dispatch('cartAdd', 'a1');
    await settle();
    await Promise.all([a.bus.dispatch('cartAdd', 'a2'), b.bus.dispatch('cartAdd', 'b1'), b.bus.dispatch('cartAdd', 'b2')]);
    await settle(100);
    expect([a.outbox.pending.value, b.outbox.pending.value]).toEqual([4, 4]);
  });

  it('a clear() crossing another tab\'s add: the queue written before the clear is not taken, and both tabs end empty', async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    await a.bus.dispatch('cartAdd', 'a1');
    await settle();
    // B writes, then A clears in the same task: neither has the other's write yet.
    const late = await b.bus.dispatch('cartAdd', 'b1');
    void a.outbox.clear();
    await settle(100);
    const done = await (late.value as Accepted).done;
    expect({ queued: [a.outbox.pending.value, b.outbox.pending.value], code: (done.error as { code?: string } | undefined)?.code }).toEqual({ queued: [0, 0], code: 'outbox:aborted:clear' });
  });

  it("control: a real clear() in one tab drops both tabs' records", async () => {
    const storage = origin();
    const a = tab(storage);
    const b = tab(storage);
    await a.bus.dispatch('cartAdd', 'tea');
    await settle();
    await b.bus.dispatch('cartAdd', 'b1');
    await settle();
    void b.outbox.clear();
    await settle(100);
    expect([a.outbox.pending.value, b.outbox.pending.value]).toEqual([0, 0]);
  });

  it('a lock that is not a tab of this outbox, held during a flush, is not an open tab', async () => {
    let release!: () => void;
    void navigator.locks.request('not-an-outbox-tab', () => new Promise<void>((r) => { release = r; }));
    await settle();
    const a = tab(origin([record('r1', 'gone')]));
    a.state.online = true;
    await a.outbox.flush();
    await settle();
    await a.outbox.flush();
    release();
    expect(sent).toEqual(['k-r1']);
  });

  it("a closed tab's lock free but this tab's wait not yet granted: the flush waits for the grant, then sends", async () => {
    const storage = origin([record('r1', 'gone')]);
    let release!: () => void;
    // The closed tab's lock, held here; `query()` reports it free, the moment between its release and the grant.
    void navigator.locks.request(`vapor-chamber:outbox:${name}:tab:gone`, () => new Promise<void>((r) => { release = r; }));
    await settle();
    const real = navigator.locks;
    vi.stubGlobal('navigator', { onLine: true, locks: { request: real.request.bind(real), query: async () => ({ held: [], pending: [] }) } });
    const a = tab(storage);
    a.state.online = true;
    let settled = false;
    const flushed = a.outbox.flush().then(() => { settled = true; });
    await settle();
    const before = { settled, sent: [...sent] };
    release();
    await flushed;
    expect({ before, after: sent }).toEqual({ before: { settled: false, sent: [] }, after: ['k-r1'] });
  });

  it('control: one tab sends its own record', async () => {
    const a = tab(origin());
    const held = await a.bus.dispatch('cartAdd', 'jam');
    a.state.online = true;
    await a.outbox.flush();
    expect(sent.length).toBe(1);
    expect(await (held.value as Accepted).done).toMatchObject({ ok: true, value: 'jam' });
  });
});
