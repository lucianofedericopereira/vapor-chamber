/**
 * Supplemental coverage for src/plugins-extra.ts.
 *
 *  - rateLimit: window-expiry head advance + array compaction (298, 301-303).
 *  - metrics: head-based eviction + compaction (361-363, 383).
 *  - serialize: a same-key lane survives a throwing command — the stored tail
 *    absorbs the rejection (493) and the next command still runs.
 *  - idempotent: stampMeta:false (585), TTL expiry drop (593-594), and the
 *    rejection arm clearing inflight without caching (610-613).
 *  - supersede: merging a caller-supplied signal via AbortSignal.any (687-688)
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
// rateLimit — window compaction (296-304)
// ---------------------------------------------------------------------------

describe('rateLimit window compaction', () => {
  it('advances past expired timestamps and compacts the backing array (298, 301-303)', () => {
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
// metrics — eviction + compaction (361-363, 383)
// ---------------------------------------------------------------------------

describe('metrics eviction', () => {
  it('drops oldest entries past maxEntries and compacts (361-363, 383)', () => {
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
// serialize — lane survives a rejection (487-497)
// ---------------------------------------------------------------------------

describe('serialize lane resilience', () => {
  it('absorbs a throwing command and still runs the next same-key command (491-496)', async () => {
    const plugin = serialize();
    const c = cmd('save');

    await expect(
      Promise.resolve(plugin(c, () => { throw new Error('lane poison'); })),
    ).rejects.toThrow('lane poison');

    // The stored tail swallowed the rejection — the lane is not deadlocked.
    const result = await plugin(cmd('save'), () => ({ ok: true, value: 'after' }) as any);
    expect(result).toEqual({ ok: true, value: 'after' });
  });
});

// ---------------------------------------------------------------------------
// idempotent — stampMeta, TTL expiry, rejection arm
// ---------------------------------------------------------------------------

describe('idempotent', () => {
  it('leaves cmd.meta untouched with stampMeta:false (585)', async () => {
    const plugin = idempotent({ stampMeta: false });
    const c = cmd('orderCreate');
    await plugin(c, () => ({ ok: true, value: 1 }) as any);
    expect((c.meta as any).idempotencyKey).toBeUndefined();
  });

  it('drops an expired completed key so the handler runs again (593-594)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    const plugin = idempotent({ ttl: 1000 });
    let runs = 0;
    const next = () => ({ ok: true, value: ++runs }) as any;

    await plugin(cmd('orderCreate'), next);
    // Within TTL → cached result, no second run.
    const cached = await plugin(cmd('orderCreate'), next);
    expect(cached.value).toBe(1);
    expect(runs).toBe(1);

    // Past TTL → the stale entry is deleted and the handler runs again.
    vi.setSystemTime(2_002_000);
    const fresh = await plugin(cmd('orderCreate'), next);
    expect(fresh.value).toBe(2);
    expect(runs).toBe(2);
  });

  it('maxKeys: 0 hits the empty-map eviction arm without evicting (603-605)', async () => {
    // Not a dead guard: with maxKeys 0 the eviction runs on an EMPTY map, so
    // `done.keys().next().value` is undefined and the guard's false arm fires.
    const plugin = idempotent({ maxKeys: 0 });
    const first = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 1 }) as any);
    expect(first.value).toBe(1);
    // The entry still lands; a repeat within TTL is served from cache.
    const repeat = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 2 }) as any);
    expect(repeat.value).toBe(1);
  });

  it('clears inflight on rejection and does not cache the failure (610-613)', async () => {
    const plugin = idempotent();
    await expect(
      Promise.resolve(plugin(cmd('orderCreate'), () => Promise.reject(new Error('backend down')))),
    ).rejects.toThrow('backend down');

    // A genuine retry after the failure must run — nothing was cached.
    const retry = await plugin(cmd('orderCreate'), () => ({ ok: true, value: 'recovered' }) as any);
    expect(retry).toEqual({ ok: true, value: 'recovered' });
  });
});

// ---------------------------------------------------------------------------
// supersede — signal merging (685-689)
// ---------------------------------------------------------------------------

describe('supersede signal merging', () => {
  it('merges a caller-supplied signal with the per-key controller (687-688)', async () => {
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

  it('falls back to the controller signal when AbortSignal.any is unavailable (688)', async () => {
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
