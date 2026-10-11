/**
 * idempotent() - each caller's abort is its own.
 *
 * A concurrent duplicate joined the first dispatch's promise, so when the
 * first caller aborted, the handler was cancelled with its signal and the
 * duplicate - which never aborted - settled core:aborted:dispatch too. The
 * HTTP client's joined GETs already keep each caller's signal its own (1.29);
 * this is the same rule: a caller's abort settles that caller, and the shared
 * work is cancelled only once every caller holding it has aborted. A caller
 * with no signal holds it until it lands.
 */
import { describe, expect, it } from 'vitest';
import { type BusError, createAsyncCommandBus, idempotent } from '../src/index';
import type { CommandResult } from '../src/command-bus';

function setup() {
  const bus = createAsyncCommandBus({ retry: false });
  bus.use(idempotent({ actions: ['*'] }), { priority: 100 });
  let runs = 0;
  let cancelled = 0;
  bus.register('save', (cmd) => new Promise((resolve, reject) => {
    runs++;
    const t = setTimeout(() => resolve({ saved: true }), 40);
    cmd.signal?.addEventListener('abort', () => { cancelled++; clearTimeout(t); reject(cmd.signal!.reason); });
  }));
  return { bus, runs: () => runs, cancelled: () => cancelled };
}
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);
const codeOf = (r: CommandResult) => (r.ok ? 'ok' : (r.error as BusError).code);

describe('idempotent() - abort per caller', () => {
  it('the first caller aborting does not cancel a duplicate that did not', async () => {
    const { bus, runs, cancelled } = setup();
    const first = new AbortController();
    const p1 = bus.dispatch('save', { id: 1 }, undefined, { signal: first.signal });
    const p2 = bus.dispatch('save', { id: 1 });
    later(10, () => first.abort());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(codeOf(r1)).toBe('core:aborted:dispatch');
    expect(r2).toMatchObject({ ok: true, value: { saved: true } });
    expect(runs()).toBe(1);
    expect(cancelled()).toBe(0);
  });

  it('a duplicate aborting does not cancel the first caller', async () => {
    const { bus } = setup();
    const dup = new AbortController();
    const p1 = bus.dispatch('save', { id: 1 });
    const p2 = bus.dispatch('save', { id: 1 }, undefined, { signal: dup.signal });
    later(10, () => dup.abort());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ ok: true });
    expect(codeOf(r2)).toBe('core:aborted:dispatch');
  });

  it('the work is cancelled once every caller holding it has aborted', async () => {
    const { bus, cancelled } = setup();
    const a = new AbortController();
    const b = new AbortController();
    const p1 = bus.dispatch('save', { id: 1 }, undefined, { signal: a.signal });
    const p2 = bus.dispatch('save', { id: 1 }, undefined, { signal: b.signal });
    later(5, () => a.abort());
    later(10, () => b.abort());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([codeOf(r1), codeOf(r2)]).toEqual(['core:aborted:dispatch', 'core:aborted:dispatch']);
    expect(cancelled()).toBe(1);
  });

  it('a lone caller aborting still cancels its handler', async () => {
    const { bus, cancelled } = setup();
    const a = new AbortController();
    const p = bus.dispatch('save', { id: 1 }, undefined, { signal: a.signal });
    later(5, () => a.abort());
    expect(codeOf(await p)).toBe('core:aborted:dispatch');
    expect(cancelled()).toBe(1);
  });
});

describe('idempotent() - a duplicate whose signal aborted on the way in', () => {
  it('settles that caller aborted at once, and the first run lands', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    // An outer plugin that awaits: the dispatch's pre-flight abort check has
    // already passed when the signal aborts, so idempotent sees it aborted.
    bus.use(async (_cmd, next) => { await Promise.resolve(); return next(); }, { priority: 200 });
    bus.use(idempotent({ actions: ['*'] }), { priority: 100 });
    let runs = 0;
    bus.register('save', () => new Promise((r) => { runs++; setTimeout(() => r({ saved: true }), 20); }));
    const p1 = bus.dispatch('save', { id: 1 });
    await Promise.resolve(); await Promise.resolve();
    const late = new AbortController();
    const p2 = bus.dispatch('save', { id: 1 }, undefined, { signal: late.signal });
    late.abort();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toMatchObject({ ok: true });
    expect(codeOf(r2)).toBe('core:aborted:dispatch');
    expect(runs).toBe(1);
  });
});
