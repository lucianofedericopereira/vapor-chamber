/**
 * idempotent(): each caller's abort settles only that caller.
 * Why: a duplicate that joined a shared dispatch must not be aborted by another caller's signal; the shared work is cancelled only once every caller holding it has aborted, and a caller with no signal holds it until it lands.
 * Shows: aborting the first or the duplicate caller settles only that caller with core:aborted:dispatch, the handler runs once and is cancelled only when all signals abort, a lone abort cancels its handler, and a duplicate aborted before joining settles aborted while the first run lands.
 */
import { describe, expect, it } from 'vitest';
import { type BusError, createAsyncCommandBus, idempotent } from '../src/index';
import type { CommandResult } from '../src/command-bus';

function setup() {
  const bus = createAsyncCommandBus({ retry: false });
  bus.use(idempotent({ actions: ['*'] }));
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
    // An awaiting rule lets the pre-flight abort check pass before the signal aborts, so idempotent sees it aborted.
    bus.use({ validate: () => async () => { await Promise.resolve(); return undefined; } });
    bus.use(idempotent({ actions: ['*'] }));
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
