/**
 * The idempotent() plugin: collapsing duplicate commands and stamping meta.idempotencyKey.
 * Why: a double click or repeated submit must run its handler once, while a failed run must stay retryable and different keys must stay independent.
 * Shows: concurrent duplicates and repeats inside the TTL run the handler once, failures are not cached, the key defaults to the dispatch id, a custom key or null key is honoured, the actions filter scopes dedup, and maxSize evicts the oldest done entry.
 */
import { describe, expect } from 'vitest';
import { idempotent } from '../src/plugins-extra';
import { createAsyncCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('idempotent plugin', () => {
  it('collapses concurrent duplicates - handler runs once', async ({ asyncBus: bus }) => {
    let runs = 0;
    bus.use(idempotent());
    bus.register('order', async (cmd) => {
      runs++;
      await tick(5);
      return (cmd.target as any).id;
    });
    const [a, b, c] = await Promise.all([
      bus.dispatch('order', { id: 1 }),
      bus.dispatch('order', { id: 1 }),
      bus.dispatch('order', { id: 1 }),
    ]);
    expect(runs).toBe(1);
    expect([a.value, b.value, c.value]).toEqual([1, 1, 1]);
  });

  it('collapses sequential repeats within the TTL window', async ({ asyncBus: bus }) => {
    let runs = 0;
    bus.use(idempotent({ ttl: 10_000 }));
    bus.register('pay', async () => { runs++; return 'ok'; });
    await bus.dispatch('pay', { invoice: 7 });
    await bus.dispatch('pay', { invoice: 7 });
    expect(runs).toBe(1);
  });

  it('different keys are independent', async ({ asyncBus: bus }) => {
    let runs = 0;
    bus.use(idempotent());
    bus.register('order', async () => { runs++; return 1; });
    await Promise.all([
      bus.dispatch('order', { id: 1 }),
      bus.dispatch('order', { id: 2 }),
    ]);
    expect(runs).toBe(2);
  });

  it("stamps cmd.meta.idempotencyKey (default: the dispatch's id)", async ({ asyncBus: bus }) => {
    let stamped: string | undefined;
    let id: string | undefined;
    bus.use(idempotent());
    bus.register('save', async (cmd) => { stamped = cmd.meta?.idempotencyKey; id = cmd.meta?.id; return 1; });
    await bus.dispatch('save', { a: 1, b: 2 });
    expect(stamped).toBe(id);
  });

  it('honors a custom key and skips on null', async ({ asyncBus: bus }) => {
    let runs = 0;
    bus.use(idempotent({ key: (cmd) => (cmd.target as any).requestId ?? null }));
    bus.register('act', async () => { runs++; return 1; });
    await Promise.all([
      bus.dispatch('act', { requestId: 'r1' }),
      bus.dispatch('act', { requestId: 'r1' }),
      bus.dispatch('act', { requestId: null }),
      bus.dispatch('act', { requestId: null }),
    ]);
    expect(runs).toBe(3);
  });

  it('actions filter scopes dedup', async ({ asyncBus: bus }) => {
    let runs = 0;
    bus.use(idempotent({ actions: ['order*'] }));
    bus.register('ping', async () => { runs++; return 1; });
    await Promise.all([bus.dispatch('ping', {}), bus.dispatch('ping', {})]);
    expect(runs).toBe(2);
  });
});

describe('idempotent - done-cache eviction and rejection', () => {
  it('evicts the oldest done entry past maxSize, so the evicted command re-runs', async ({ asyncBus: bus }) => {
    bus.use(idempotent({ maxSize: 1 }));
    let runs = 0;
    bus.register('op', async (cmd) => { runs++; return cmd.target.id; });

    await bus.dispatch('op', { id: 'a' });
    await bus.dispatch('op', { id: 'b' });
    await bus.dispatch('op', { id: 'a' });

    expect(runs).toBe(3);

    await bus.dispatch('op', { id: 'a' });
    expect(runs).toBe(3);
  });

  it('a thrown/rejected dispatch is not cached - the retry genuinely re-runs', async () => {
    // retry is off so the second dispatch is the only re-run.
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent());
    let attempts = 0;
    bus.register('flaky', async () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return 'ok';
    });

    const first = await bus.dispatch('flaky', { id: 1 });
    expect(first.ok).toBe(false);

    const second = await bus.dispatch('flaky', { id: 1 });
    expect(second.ok).toBe(true);
    expect(attempts).toBe(2);
  });
});
