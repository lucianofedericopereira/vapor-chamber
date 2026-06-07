/**
 * Tests for the `idempotent` plugin — collapse duplicate commands (the
 * client-side half of exactly-once) and stamp an idempotency key that the HTTP
 * bridge forwards as an `Idempotency-Key` header (the wire half).
 */
import { describe, it, expect } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { idempotent } from '../src/plugins-extra';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('idempotent plugin', () => {
  it('collapses concurrent duplicates — handler runs once', async () => {
    const bus = createAsyncCommandBus();
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
    expect(runs).toBe(1);            // only one handler invocation
    expect([a.value, b.value, c.value]).toEqual([1, 1, 1]); // all share the result
  });

  it('collapses sequential repeats within the TTL window', async () => {
    const bus = createAsyncCommandBus();
    let runs = 0;
    bus.use(idempotent({ ttl: 10_000 }));
    bus.register('pay', async () => { runs++; return 'ok'; });
    await bus.dispatch('pay', { invoice: 7 });
    await bus.dispatch('pay', { invoice: 7 }); // duplicate within TTL → cached
    expect(runs).toBe(1);
  });

  it('different keys are independent', async () => {
    const bus = createAsyncCommandBus();
    let runs = 0;
    bus.use(idempotent());
    bus.register('order', async () => { runs++; return 1; });
    await Promise.all([
      bus.dispatch('order', { id: 1 }),
      bus.dispatch('order', { id: 2 }),
    ]);
    expect(runs).toBe(2);
  });

  it('does NOT cache failures — a retry after error runs again', async () => {
    const bus = createAsyncCommandBus();
    let n = 0;
    bus.use(idempotent());
    bus.register('flaky', async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return 'ok';
    });
    const r1 = await bus.dispatch('flaky', { id: 1 }); // fails
    const r2 = await bus.dispatch('flaky', { id: 1 }); // same key, retried (not cached)
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('stamps cmd.meta.idempotencyKey (default: action + stable target)', async () => {
    const bus = createAsyncCommandBus();
    let stamped: string | undefined;
    bus.use(idempotent());
    bus.register('save', async (cmd) => { stamped = cmd.meta?.idempotencyKey; return 1; });
    await bus.dispatch('save', { a: 1, b: 2 });
    expect(stamped).toBe('save:{"a":1,"b":2}');
  });

  it('honors a custom key and skips on null', async () => {
    const bus = createAsyncCommandBus();
    let runs = 0;
    bus.use(idempotent({ key: (cmd) => (cmd.target as any).requestId ?? null }));
    bus.register('act', async () => { runs++; return 1; });
    await Promise.all([
      bus.dispatch('act', { requestId: 'r1' }),
      bus.dispatch('act', { requestId: 'r1' }), // same key → collapsed
      bus.dispatch('act', { requestId: null }), // null key → never collapsed
      bus.dispatch('act', { requestId: null }),
    ]);
    expect(runs).toBe(3); // r1 once + two un-keyed
  });

  it('actions filter scopes dedup', async () => {
    const bus = createAsyncCommandBus();
    let runs = 0;
    bus.use(idempotent({ actions: ['order*'] }));
    bus.register('ping', async () => { runs++; return 1; });
    await Promise.all([bus.dispatch('ping', {}), bus.dispatch('ping', {})]);
    expect(runs).toBe(2); // 'ping' not in scope → not deduped
  });
});
