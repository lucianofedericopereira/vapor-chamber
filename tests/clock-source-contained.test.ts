/**
 * `_configureClock` must move `meta.ts` and NOTHING else.
 *
 * The swappable clock exists so a dispatch-bound consumer can trade exact
 * per-command timestamps for ~15-17ns (see clock-source-ab.test.ts). That trade
 * is only acceptable if it is contained: every TTL / expiry / backoff decision
 * in this library reads `Date.now()` DIRECTLY, never through `stampMeta`, so a
 * frozen or coarse clock cannot silently extend a cache entry, hold a circuit
 * breaker open, or defeat a rate limiter.
 *
 * That containment is currently true by construction rather than by design -
 * `cache`, `idempotent`, `circuitBreaker`, `rateLimit`, `throttle`, the
 * transport queues, the CSRF cache and the outbox all call `Date.now()` at their
 * own call sites. This file pins it, so a future refactor that routes any of
 * them through the injectable clock fails here instead of in production, where
 * the symptom would be an entry that never expires.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _configureClock, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { cache, idempotent } from '../src/plugins-extra';

/** A deliberately FROZEN clock - the worst case for anything that expires. */
const FROZEN = 1_000_000;

afterEach(() => {
  // `_configureClock()` with no argument restores the default. Restoring with
  // `_configureClock(Date.now)` looks equivalent and is not: it pins the
  // intrinsic captured at that moment, so a later `vi.setSystemTime` cannot
  // reach it. The first version of this teardown did exactly that and made the
  // fake-timer test below fail for a reason that had nothing to do with it.
  _configureClock();
  vi.useRealTimers();
});

describe('_configureClock - containment', () => {
  it('changes meta.ts and leaves meta.id monotonic', () => {
    _configureClock(() => FROZEN);
    const bus = createCommandBus();
    bus.register('t', () => 1);

    const seen: Array<{ ts: number; id: string }> = [];
    bus.onAfter((cmd) => seen.push({ ts: cmd.meta!.ts, id: cmd.meta!.id }));
    bus.dispatch('t', 1);
    bus.dispatch('t', 2);

    // Both commands share the frozen timestamp - the documented trade.
    expect(seen[0].ts).toBe(FROZEN);
    expect(seen[1].ts).toBe(FROZEN);
    // ...but identity is still unique and ordered, which is what ordering must
    // rely on. This is the reason the trade is defensible at all.
    expect(seen[0].id).not.toBe(seen[1].id);
  });

  it('does NOT freeze cache TTL expiry', async () => {
    _configureClock(() => FROZEN);
    let calls = 0;
    const bus = createCommandBus();
    bus.register('read', () => ++calls);
    bus.use(cache({ ttl: 10 }));

    expect(bus.query('read', { id: 1 }).value).toBe(1);
    expect(bus.query('read', { id: 1 }).value).toBe(1); // cached

    await new Promise((r) => setTimeout(r, 25)); // real time passes

    // If cache read the injectable clock, this would still be a hit forever.
    expect(bus.query('read', { id: 1 }).value).toBe(2);
  });

  it('does NOT freeze idempotent TTL expiry', async () => {
    _configureClock(() => FROZEN);
    let calls = 0;
    const bus = createAsyncCommandBus();
    bus.register('write', async () => ++calls);
    bus.use(idempotent({ ttl: 10 }));

    expect((await bus.dispatch('write', { id: 1 })).value).toBe(1);
    expect((await bus.dispatch('write', { id: 1 })).value).toBe(1); // deduped

    await new Promise((r) => setTimeout(r, 25));

    expect((await bus.dispatch('write', { id: 1 })).value).toBe(2);
  });

  it('leaves meta.ts tracking faked system time by DEFAULT', () => {
    // 12+ files in this suite fake time. With the default clock, meta.ts must
    // follow it - this is precisely what a cached clock would break, and why
    // caching is opt-in rather than the default.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    const bus = createCommandBus();
    bus.register('t', () => 1);
    let ts = 0;
    bus.onAfter((cmd) => { ts = cmd.meta!.ts; });
    bus.dispatch('t', 1);

    expect(ts).toBe(Date.parse('2026-01-01T00:00:00Z'));
  });
});
