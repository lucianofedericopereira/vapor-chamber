/**
 * Async request(): identical in-flight requests share one responder run, each caller keeps its own timeout and signal, the responder gets the chain's command.
 * Why: if the dedupe key ignored the payload, two different requests would get one answer; if a joined caller inherited the first caller's timeout or signal, one caller's abort would settle another; if the responder got a fresh Command, plugin stamps and the dispatch id would never reach it. The dispatch runs under the bus's own controller, aborted once every caller holding it has aborted.
 * Shows: different payloads are two runs, identical ones one; a joined caller's abort or shorter timeout settles only that caller; a lone caller's abort reaches cmd.signal with its reason; an abort by only some callers does not; a fresh identical request starts afresh after all aborted; dispose() settles every waiting caller.
 * See: log s35.167, log s35.202
 */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, type Command } from '../src/command-bus';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A responder's wait that the test ends with `release()`: a caller that settles before it settled on its own abort or timeout, whatever the load, so no test compares wall time. */
function held() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
}
/** `p`'s outcome, or `'held'` if it waits on the held responder (1 s cap). */
async function settle(p: Promise<{ ok: boolean; value?: unknown; error?: unknown }>) {
  const r = await Promise.race([p, tick(1000).then(() => 'held' as const)]);
  return r === 'held' ? r : { ok: r.ok, value: r.value, code: r.ok ? undefined : (r.error as { code?: string }).code };
}

describe('async request()', () => {
  it('two requests that differ in payload are two requests', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.respond('price', async (cmd) => { runs++; await tick(5); return (cmd.payload as { qty: number }).qty * 10; });
    const [a, b] = await Promise.all([bus.request('price', { id: 1 }, { qty: 1 }), bus.request('price', { id: 1 }, { qty: 5 })]);
    expect([a.value, b.value]).toEqual([10, 50]);
    expect(runs).toBe(2);
  });

  it('the responder receives the command the plugins saw', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let seen: unknown;
    bus.use({ started: (cmd) => { cmd.meta!.idempotencyKey = 'K1'; seen = cmd.meta!.id; } });
    let got: { id?: unknown; key?: unknown } = {};
    bus.respond('q', async (cmd: Command) => { got = { id: cmd.meta?.id, key: cmd.meta?.idempotencyKey }; return 1; });
    await bus.request('q', {});
    expect(got).toEqual({ id: seen, key: 'K1' });
  });

  it('a joined caller that aborts settles at once; the first still gets its answer', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const { gate, release } = held();
    bus.respond('price', async () => { await gate; return 1; });
    const ac = new AbortController();
    const first = bus.request('price', { id: 1 });
    const joined = bus.request('price', { id: 1 }, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(await settle(joined)).toMatchObject({ ok: false, code: 'core:aborted:dispatch' });
    release();
    expect(await settle(first)).toMatchObject({ ok: true, value: 1 });
  });

  it('a joined caller with a shorter timeout times out on its own', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const { gate, release } = held();
    bus.respond('price', async () => { await gate; return 1; });
    const slow = bus.request('price', { id: 3 }, undefined, { timeout: 5000 });
    const quick = bus.request('price', { id: 3 }, undefined, { timeout: 20 });
    expect(await settle(quick)).toMatchObject({ ok: false, code: 'core:timeout:request' });
    release();
    expect(await settle(slow)).toMatchObject({ ok: true, value: 1 });
  });
});

describe('controls', () => {
  it('identical requests share one responder run', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.respond('price', async () => { runs++; await tick(5); return 7; });
    const [a, b] = await Promise.all([bus.request('price', { id: 1 }, { qty: 1 }), bus.request('price', { id: 1 }, { qty: 1 })]);
    expect([a.value, b.value, runs]).toEqual([7, 7, 1]);
  });

  it("the first caller's abort does not settle a joined caller", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const { gate, release } = held();
    bus.respond('price', async () => { await gate; return 1; });
    const ac = new AbortController();
    const first = bus.request('price', { id: 1 }, undefined, { signal: ac.signal });
    const joined = bus.request('price', { id: 1 });
    setTimeout(() => ac.abort(), 10);
    expect(await settle(first)).toMatchObject({ ok: false, code: 'core:aborted:dispatch' });
    release();
    expect(await settle(joined)).toMatchObject({ ok: true, value: 1 });
  });

  it("a lone caller's abort reaches the responder on cmd.signal, with its reason", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let reason: unknown;
    bus.respond('slow', (cmd: Command) => new Promise((resolve) => {
      cmd.signal?.addEventListener('abort', () => { reason = cmd.signal?.reason; resolve(0); });
    }));
    const ac = new AbortController();
    const p = bus.request('slow', {}, undefined, { signal: ac.signal });
    const why = new Error('left the page');
    setTimeout(() => ac.abort(why), 5);
    const r = await p;
    expect(r.error).toBe(why);
    expect(reason).toBe(why);
  });

  it('when every caller aborts, the responder is told', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let aborted = false;
    bus.respond('slow', (cmd: Command) => new Promise((resolve) => {
      cmd.signal?.addEventListener('abort', () => { aborted = true; resolve(0); });
    }));
    const a = new AbortController();
    const b = new AbortController();
    const pa = bus.request('slow', {}, undefined, { signal: a.signal });
    const pb = bus.request('slow', {}, undefined, { signal: b.signal });
    a.abort();
    await tick(5);
    expect(aborted).toBe(false);
    b.abort();
    await Promise.all([pa, pb]);
    await tick(0);
    expect(aborted).toBe(true);
  });

  it('after every caller aborted, an identical request starts afresh; the old one settling leaves it in place', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.respond('slow', async () => { const n = ++runs; await tick(n === 1 ? 20 : 60); return n; });
    const a = new AbortController();
    const pa = bus.request('slow', {}, undefined, { signal: a.signal });
    a.abort();
    await pa;
    const c = bus.request('slow', {});
    await tick(30); // the aborted run settles while c is still in flight
    const d = bus.request('slow', {});
    expect([(await c).value, (await d).value, runs]).toEqual([2, 2, 2]);
  });

  it('dispose() settles every waiting caller', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.respond('slow', () => new Promise(() => {}));
    const a = bus.request('slow', {});
    const b = bus.request('slow', {});
    bus.dispose();
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(false);
  });
});
