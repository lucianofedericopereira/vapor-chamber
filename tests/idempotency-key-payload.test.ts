/** An idempotency key names one request payload: idempotent keys the payload, the outbox keys each record (plan 1.27 section 10.5). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandKey, createAsyncCommandBus } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import { idempotent } from '../src/plugins-extra';
import { createHttpBridge } from '../src/transports';

afterEach(() => { vi.unstubAllGlobals(); });

/** A bus with idempotent outermost; records each run's payload and key. */
function keyed(opts: Parameters<typeof idempotent>[0] = {}) {
  const bus = createAsyncCommandBus({ retry: false });
  const runs: Array<{ payload: unknown; key: unknown }> = [];
  bus.register('orderCreate', async (cmd) => { runs.push({ payload: cmd.payload, key: cmd.meta?.idempotencyKey }); return cmd.payload; });
  bus.use(idempotent(opts), { priority: 100 });
  return { bus, runs };
}

describe('idempotent', () => {
  it('two payloads on one target are two requests with two keys', async () => {
    const { bus, runs } = keyed();
    const a = await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    const b = await bus.dispatch('orderCreate', { sku: 1 }, { qty: 5 });
    expect([a.value, b.value]).toEqual([{ qty: 1 }, { qty: 5 }]);
    expect(runs).toHaveLength(2);
    expect(runs[0].key).not.toBe(runs[1].key);
  });

  it('control: the same payload twice collapses to one run', async () => {
    const { bus, runs } = keyed();
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    expect(runs).toHaveLength(1);
  });

  it('control: with no payload the key is the released one', async () => {
    const { bus, runs } = keyed();
    await bus.dispatch('orderCreate', { sku: 1 });
    expect(runs[0].key).toBe(commandKey('orderCreate', { sku: 1 }));
  });

  it('control: a custom key is untouched', async () => {
    const { bus, runs } = keyed({ key: (cmd) => `order:${cmd.target.sku}` });
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 1 });
    await bus.dispatch('orderCreate', { sku: 1 }, { qty: 5 });
    expect(runs).toHaveLength(1);
    expect(runs[0].key).toBe('order:1');
  });
});

describe('the outbox', () => {
  /** An offline outbox over memory storage, the HTTP bridge behind it; returns the keys each flush sent. */
  function offline(stored: OutboxRecord[] | null = null, key?: (cmd: { target: unknown }) => string) {
    let online = false;
    const mem = { v: stored, load() { return this.v; }, save(r: OutboxRecord[]) { this.v = r; }, clear() { this.v = null; } };
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: { headers: Record<string, string> }) => {
      sent.push(init.headers['Idempotency-Key']);
      return new Response(JSON.stringify({ state: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const bus = createAsyncCommandBus({ retry: false });
    const ob = createOutbox({ storage: mem, isOnline: () => online, autoFlush: false, key: key as never });
    ob.install(bus);
    bus.use(createHttpBridge({ endpoint: '/vc' }));
    return { bus, ob, sent, goOnline: () => { online = true; } };
  }

  it('two offline writes on one target are sent under two keys', async () => {
    const o = offline();
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 3 });
    o.goOnline();
    await o.ob.flush();
    expect(o.sent).toHaveLength(2);
    expect(o.sent[0]).not.toBe(o.sent[1]);
  });

  it('control: a record stored by 1.26 replays with its own key', async () => {
    const old: OutboxRecord = { id: 'r1', action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 }, key: commandKey('cartAdd', { id: 1 }), queuedAt: '2026-10-04T00:00:00.000Z' };
    const o = offline([old]);
    await o.ob.hydrate();
    o.goOnline();
    await o.ob.flush();
    expect(o.sent).toEqual([`"${encodeURIComponent(old.key)}"`]);
  });

  it('control: a custom key is untouched', async () => {
    const o = offline(null, (cmd) => `cart:${(cmd.target as { id: number }).id}`);
    await o.bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    o.goOnline();
    await o.ob.flush();
    expect(o.sent).toEqual([`"${encodeURIComponent('cart:1')}"`]);
  });
});

/*
 * draft-ietf-httpapi-idempotency-key-header-07: "The idempotency key MUST be
 * unique and MUST NOT be reused with another request with a different
 * request payload." `idempotent()` stamps its key as the Idempotency-Key
 * header and keyed on the action and target only, so a second order with
 * another quantity was answered with the first's result (audit B8). The
 * outbox keyed each record the same way, so two offline writes on one target
 * went out under one key, and a backend that honours the draft applied the
 * first and dropped the second (B9). Now idempotent adds the payload when
 * one is given (a payload-less key is the released one), and the outbox adds
 * the record's id after the readable prefix. A double-click with the same
 * payload still collapses. A custom `key` and a stored record's key are
 * untouched. Log s35.166.
 */
