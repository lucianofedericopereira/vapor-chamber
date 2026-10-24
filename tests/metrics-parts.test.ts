/** metrics times every outcome as a `started` and a `settled` part, wherever it is installed. The note is at the end. */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { validator } from '../src/plugins-core';
import { metrics } from '../src/plugins-extra';

describe('metrics as parts', () => {
  it('counts a rule refusal installed after it, and before it', async () => {
    for (const order of ['metrics first', 'validator first']) {
      const bus = createAsyncCommandBus({ retry: false });
      bus.register('save', async () => 1);
      const m = metrics();
      if (order === 'metrics first') { bus.use(m); bus.use(validator({ save: () => 'bad' })); }
      else { bus.use(validator({ save: () => 'bad' })); bus.use(m); }
      await bus.dispatch('save', null);
      expect([order, m.entries().map((e) => [e.action, e.ok])]).toEqual([order, [['save', false]]]);
    }
  });

  it('times a query and a dispatch, the work inside the window', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('load', () => new Promise((r) => setTimeout(() => r(1), 20)));
    const m = metrics();
    bus.use(m);
    await bus.query('load', null);
    await bus.dispatch('load', null);
    const [q, d] = m.entries();
    expect(q.durationMs).toBeGreaterThanOrEqual(15);
    expect(d.durationMs).toBeGreaterThanOrEqual(15);
  });

  it('records 0 ms for a command aborted before it started', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    const m = metrics();
    bus.use(m);
    const ac = new AbortController();
    ac.abort();
    await bus.dispatch('save', null, undefined, { signal: ac.signal });
    expect(m.entries().map((e) => [e.ok, e.durationMs])).toEqual([[false, 0]]);
  });

  it('control: on the sync bus, a success and a throw', () => {
    const bus = createCommandBus();
    bus.register('ok', () => 1);
    bus.register('boom', () => { throw new Error('x'); });
    const m = metrics({ actions: ['ok', 'boom'] });
    bus.use(m);
    bus.dispatch('ok', null);
    bus.dispatch('boom', null);
    bus.dispatch('other', null);
    expect(m.summary()).toEqual({ ok: { count: 1, avgMs: expect.any(Number), errorRate: 0 }, boom: { count: 1, avgMs: expect.any(Number), errorRate: 1 } });
  });
});

/*
 * Plan 1.32 step 8b (log 36.105). `metrics` was a chain plugin: it timed
 * `next()`, so a rule's refusal (answered before the chain) and a before-hook's
 * cancel never reached it, and the pair "metrics with validator" in
 * tests/same-in-any-order.test.ts failed in both orders. As a `started` part
 * it records the start in a Map from the command to `performance.now()`, and
 * its `settled` part records the entry and deletes the start. A query starts
 * through `Facts.queried`, so it is timed too. An abort before the start
 * settles with no start: 0 ms, never a stale start.
 */
