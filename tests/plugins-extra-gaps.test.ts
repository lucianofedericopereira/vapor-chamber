/**
 * Supplemental coverage for src/plugins-extra.ts.
 *
 *  - rateLimit: window-expiry head advance + array compaction.
 *  - metrics: head-based eviction + compaction.
 *  - serialize: a same-key lane survives a throwing command - the stored tail
 *    absorbs the rejection and the next command still runs.
 *  - idempotent: stampMeta:false, TTL expiry drop, and the
 *    rejection arm clearing inflight without caching.
 *  - supersede: merging a caller-supplied signal via AbortSignal.any
 *    and the ctrl-signal fallback when AbortSignal.any is unavailable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { rateLimit, metrics, serialize, idempotent, supersede } from '../src/plugins-extra';
import type { Command } from '../src/index';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function cmd(action: string, extra: Partial<Command> = {}): Command {
  return { action, target: {}, payload: undefined, meta: {} as any, ...extra } as Command;
}

// ---------------------------------------------------------------------------
// rateLimit - window compaction
// ---------------------------------------------------------------------------

describe('rateLimit window compaction', () => {
  it('advances past expired timestamps and compacts the backing array', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const bus = createCommandBus();
    bus.use(rateLimit({ max: 3, window: 100 }));
    bus.register('tap', () => 1);

    // Fill the window to the cap...
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(false); // over the limit

    // ...then let all three expire: head walks past them and, being more than
    // half the array, triggers the slice-compaction.
    vi.setSystemTime(1_000_200);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// metrics - eviction + compaction
// ---------------------------------------------------------------------------

describe('metrics eviction', () => {
  it('drops oldest entries past maxEntries and compacts', () => {
    const bus = createCommandBus();
    const m = metrics({ maxEntries: 2 });
    bus.use(m);
    bus.register('go', () => 1);

    for (let i = 0; i < 7; i++) bus.dispatch('go', {});

    const entries = m.entries();
    expect(entries).toHaveLength(2);
    expect(entries.every(e => e.action === 'go' && e.ok)).toBe(true);
    expect(m.summary().go.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// serialize - lane survives a rejection
// ---------------------------------------------------------------------------

describe('serialize lane resilience', () => {
  it('absorbs a throwing command and still runs the next same-key command', async () => {
    const plugin = serialize();
    const c = cmd('save');

    await expect(
      Promise.resolve(plugin(c, () => { throw new Error('lane poison'); })),
    ).rejects.toThrow('lane poison');

    // The stored tail swallowed the rejection - the lane is not deadlocked.
    const result = await plugin(cmd('save'), () => ({ ok: true, value: 'after' }) as any);
    expect(result).toEqual({ ok: true, value: 'after' });
  });
});

// ---------------------------------------------------------------------------
// idempotent - stampMeta, TTL expiry, rejection arm
// ---------------------------------------------------------------------------

describe('idempotent', () => {
  it('leaves cmd.meta untouched with stampMeta:false', async () => {
    const plugin = idempotent({ stampMeta: false });
    const c = cmd('orderCreate');
    await plugin(c, () => ({ ok: true, value: 1 }) as any);
    expect((c.meta as any).idempotencyKey).toBeUndefined();
  });

  it('drops an expired completed key so the handler runs again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    const plugin = idempotent({ ttl: 1000 });
    let runs = 0;
    const next = () => ({ ok: true, value: ++runs }) as any;

    await plugin(cmd('orderCreate'), next);
    // Within TTL -> cached result, no second run.
    const cached = await plugin(cmd('orderCreate'), next);
    expect(cached.value).toBe(1);
    expect(runs).toBe(1);

    // Past TTL -> the stale entry is deleted and the handler runs again.
    vi.setSystemTime(2_002_000);
    const fresh = await plugin(cmd('orderCreate'), next);
    expect(fresh.value).toBe(2);
    expect(runs).toBe(2);
  });

  it('maxKeys: 0 remembers nothing, matching cache({ maxSize: 0 })', async () => {
    // This used to assert the opposite - that the entry still landed and a
    // repeat was served from cache - because eviction removed ONE oldest key
    // before inserting, which on an empty map removed nothing. That made
    // `maxKeys: 0` a one-entry cache while `cache({ maxSize: 0 })` stored
    // nothing: the same word meaning opposite things in one module. Eviction
    // now runs down to the bound after the insert, as cache() does.
    const plugin = idempotent({ maxKeys: 0 });
    const first = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 1 }) as any);
    expect(first.value).toBe(1);
    const repeat = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 2 }) as any);
    expect(repeat.value).toBe(2); // nothing was retained, so the handler ran again
  });

  // NaN is the sharpest form of this class: it propagates through the clamp
  // and loses every comparison, so the bound is not merely wrong, it is
  // absent. In cache() the same value produced the opposite failure - the
  // eviction walk never broke, so it dropped everything and reported size 0.
  it('a NaN maxKeys remembers nothing instead of growing unbounded', async () => {
    const plugin = idempotent({ maxKeys: Number('nope'), ttl: 60_000 });
    const run = (target: number, value: number) =>
      plugin({ action: 'orderCreate', target, meta: {} } as any, () => ({ ok: true, value }) as any);

    for (let i = 0; i < 20; i++) await run(i, i);

    // Retention falls back to the documented 500, so the dedupe this plugin
    // exists to provide still works. The previous rule mapped NaN to 0 and
    // remembered nothing, which turned a bad option into DUPLICATE EXECUTION of
    // commands declared idempotent - the one outcome worse than an unbounded
    // key map.
    expect((await run(0, -1)).value).toBe(0);
    expect((await run(19, -1)).value).toBe(19);
  });

  it('a negative maxKeys is clamped, not treated as a one-entry cache', async () => {
    // Unclamped, `done.size >= -1` was always true, so every insert evicted the
    // previous key and the plugin quietly behaved as a 1-entry cache. cache()
    // clamps `maxSize` for the same class of reason (there, a negative bound
    // hung the eviction loop outright).
    const plugin = idempotent({ maxKeys: -5 });
    const first = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 1 }) as any);
    expect(first.value).toBe(1);
    const repeat = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 2 }) as any);
    expect(repeat.value).toBe(2);
  });

  it('evicts oldest first down to maxKeys', async () => {
    const plugin = idempotent({ maxKeys: 2 });
    const run = (target: string, value: number) =>
      plugin({ action: 'orderCreate', target, meta: {} } as any, () => ({ ok: true, value }) as any);

    await run('a', 1);
    await run('b', 2);
    await run('c', 3); // evicts 'a'

    // 'b' and 'c' are still cached; 'a' has to run again.
    expect((await run('b', 99)).value).toBe(2);
    expect((await run('c', 99)).value).toBe(3);
    expect((await run('a', 99)).value).toBe(99);
  });

  it('clears inflight on rejection and does not cache the failure', async () => {
    const plugin = idempotent();
    await expect(
      Promise.resolve(plugin(cmd('orderCreate'), () => Promise.reject(new Error('backend down')))),
    ).rejects.toThrow('backend down');

    // A genuine retry after the failure must run - nothing was cached.
    const retry = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 'recovered' }) as any);
    expect(retry).toEqual({ ok: true, value: 'recovered' });
  });
});

// ---------------------------------------------------------------------------
// supersede - signal merging
// ---------------------------------------------------------------------------

describe('supersede signal merging', () => {
  it('merges a caller-supplied signal with the per-key controller', async () => {
    const bus = createAsyncCommandBus();
    bus.use(supersede({ actions: ['search'] }));
    let observed: AbortSignal | undefined;
    bus.register('search', async (c: Command) => { observed = c.signal; return 1; });

    const user = new AbortController();
    await bus.dispatch('search', {}, undefined, { signal: user.signal });

    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(false);
    // The merged signal must respond to the user's controller too.
    user.abort();
    expect(observed!.aborted).toBe(true);
  });

  it('falls back to the controller signal when AbortSignal.any is unavailable', async () => {
    const origAny = AbortSignal.any;
    // @ts-expect-error deliberate removal to drive the fallback arm
    AbortSignal.any = undefined;
    try {
      const bus = createAsyncCommandBus();
      bus.use(supersede({ actions: ['search'] }));
      let observed: AbortSignal | undefined;
      bus.register('search', async (c: Command) => { observed = c.signal; return 1; });

      const user = new AbortController();
      const result = await bus.dispatch('search', {}, undefined, { signal: user.signal });
      expect(result.ok).toBe(true);
      expect(observed).toBeDefined();
      expect(observed!.aborted).toBe(false);
    } finally {
      AbortSignal.any = origAny;
    }
  });
});
