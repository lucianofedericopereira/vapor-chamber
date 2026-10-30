/**
 * `_configureClock` moves `meta.ts` and nothing else.
 * Why: every TTL, expiry and backoff reads `Date.now()` at its own call site, so a frozen clock cannot keep a cache entry, a circuit or a rate limit alive.
 * Shows: a frozen clock freezes meta.ts while meta.id stays unique; cache and idempotent still expire on system time; the default clock follows faked time.
 * See: tests/clock-source-ab.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _configureClock, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { cache, idempotent } from '../src/plugins-extra';

/** A deliberately FROZEN clock - the worst case for anything that expires. */
const FROZEN = 1_000_000;

/** Names, not tuned values: fake timers pass no real time, and real ones would make the hit right after the write flaky. */
const EXPIRY_TTL = 10;
const PAST_EXPIRY = EXPIRY_TTL * 3;

afterEach(() => {
  // No argument: `_configureClock(Date.now)` would pin the intrinsic, which vi.setSystemTime cannot reach.
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
    // ...but identity stays unique and ordered, which is what ordering relies on.
    expect(seen[0].id).not.toBe(seen[1].id);
  });

  it('does NOT freeze cache TTL expiry', async () => {
    // Fake timers move Date.now(), which cache() reads, while the injected clock stays frozen.
    vi.useFakeTimers();
    _configureClock(() => FROZEN);
    let calls = 0;
    const bus = createCommandBus();
    bus.register('read', () => ++calls);
    bus.use(cache({ ttl: EXPIRY_TTL }));

    expect(bus.query('read', { id: 1 }).value).toBe(1);
    expect(bus.query('read', { id: 1 }).value).toBe(1); // cached

    await vi.advanceTimersByTimeAsync(PAST_EXPIRY); // system time passes

    // If cache read the injectable clock, this would still be a hit forever.
    expect(bus.query('read', { id: 1 }).value).toBe(2);
  });

  it('does NOT freeze idempotent TTL expiry', async () => {
    // The handler settles on a microtask, which fake timers leave alone.
    vi.useFakeTimers();
    _configureClock(() => FROZEN);
    let calls = 0;
    const bus = createAsyncCommandBus();
    bus.register('write', async () => ++calls);
    bus.use(idempotent({ ttl: EXPIRY_TTL }));

    expect((await bus.dispatch('write', { id: 1 })).value).toBe(1);
    expect((await bus.dispatch('write', { id: 1 })).value).toBe(1); // deduped

    await vi.advanceTimersByTimeAsync(PAST_EXPIRY);

    expect((await bus.dispatch('write', { id: 1 })).value).toBe(2);
  });

  it('leaves meta.ts tracking faked system time by DEFAULT', () => {
    // Many files fake time and the default clock must follow it, which is why caching is opt-in.
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
