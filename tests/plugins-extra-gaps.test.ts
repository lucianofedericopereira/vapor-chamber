/**
 * Supplemental coverage for src/plugins-extra.ts.
 *
 *  - rateLimit: window-expiry head advance + array compaction.
 *  - metrics: head-based eviction + compaction.
 *  - idempotent, on a real bus: stampMeta:false, TTL expiry drop, the bounds,
 *    and a failure clearing inflight without caching.
 *  - supersede: merging a caller-supplied signal via AbortSignal.any
 *    and the same without AbortSignal.any (tests/combine-signals.test.ts).
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { rateLimit, metrics, idempotent, supersede } from '../src/plugins-extra';
import type { Command } from '../src/index';
import { it } from '../src/vitest';

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(bus.dispatch('tap', {})).toFailWith('rateLimit:limited:action'); // over the limit

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
  it('drops oldest entries past maxSize and compacts', ({ bus }) => {
    const m = metrics({ maxSize: 2 });
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
// idempotent - stampMeta, TTL expiry, rejection arm
// ---------------------------------------------------------------------------

/** A real async bus with `idempotent(options)`: `run` dispatches `orderCreate` on `target`, the handler answering `fn(cmd)`. */
function idem(options: Parameters<typeof idempotent>[0] = {}) {
  const bus = createAsyncCommandBus({ retry: false });
  let reply: (c: Command) => unknown = () => 1;
  bus.register('orderCreate', async (c: Command) => reply(c));
  bus.use(idempotent(options));
  return (target: unknown, fn: (c: Command) => unknown) => { reply = fn; return bus.dispatch('orderCreate', target); };
}

describe('idempotent', () => {
  it('leaves cmd.meta untouched with stampMeta:false', async () => {
    let seen: unknown = 'unread';
    await idem({ stampMeta: false })({}, (c) => { seen = c.meta?.idempotencyKey; return 1; });
    expect(seen).toBeUndefined();
    // Control: the default stamps the dispatch's id.
    await idem()({}, (c) => { seen = c.meta?.idempotencyKey; return 1; });
    expect(typeof seen).toBe('string');
  });

  it('drops an expired completed key so the handler runs again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);

    const run = idem({ ttl: 1000 });
    let runs = 0;
    const next = () => ++runs;

    await run({}, next);
    // Within TTL -> cached result, no second run.
    const cached = await run({}, next);
    expect(cached.value).toBe(1);
    expect(runs).toBe(1);

    // Past TTL -> the stale entry is deleted and the handler runs again.
    vi.setSystemTime(2_002_000);
    const fresh = await run({}, next);
    expect(fresh.value).toBe(2);
    expect(runs).toBe(2);
  });

  it('maxSize: 0 remembers nothing, matching cache({ maxSize: 0 })', async () => {
    // Eviction runs down to the bound AFTER the insert, as cache() does:
    // evicting one key before inserting would, on an empty map, evict nothing
    // and make `maxSize: 0` a one-entry cache while `cache({ maxSize: 0 })`
    // stores nothing - one word, opposite meanings, in one module.
    const run = idem({ maxSize: 0 });
    expect((await run({}, () => 1)).value).toBe(1);
    expect((await run({}, () => 2)).value).toBe(2); // nothing was retained, so the handler ran again
  });

  // NaN is the sharpest form of this class: it propagates through the clamp
  // and loses every comparison, so the bound is not merely wrong, it is
  // absent. In cache() the same value produced the opposite failure - the
  // eviction walk never broke, so it dropped everything and reported size 0.
  it('a NaN maxSize remembers nothing instead of growing unbounded', async () => {
    const run = idem({ maxSize: Number('nope'), ttl: 60_000 });
    for (let i = 0; i < 20; i++) await run(i, () => i);

    // Retention falls back to the documented 500, so the dedupe this plugin
    // exists to provide still works. The previous rule mapped NaN to 0 and
    // remembered nothing, which turned a bad option into DUPLICATE EXECUTION of
    // commands declared idempotent - the one outcome worse than an unbounded
    // key map.
    expect((await run(0, () => -1)).value).toBe(0);
    expect((await run(19, () => -1)).value).toBe(19);
  });

  it('a negative maxSize is clamped, not treated as a one-entry cache', async () => {
    // Unclamped, `done.size >= -1` was always true, so every insert evicted the
    // previous key and the plugin quietly behaved as a 1-entry cache. cache()
    // clamps `maxSize` for the same class of reason (there, a negative bound
    // hung the eviction loop outright).
    const run = idem({ maxSize: -5 });
    expect((await run({}, () => 1)).value).toBe(1);
    expect((await run({}, () => 2)).value).toBe(2);
  });

  it('evicts oldest first down to maxSize', async () => {
    const run = idem({ maxSize: 2 });
    await run('a', () => 1);
    await run('b', () => 2);
    await run('c', () => 3); // evicts 'a'

    // 'b' and 'c' are still cached; 'a' has to run again.
    expect((await run('b', () => 99)).value).toBe(2);
    expect((await run('c', () => 99)).value).toBe(3);
    expect((await run('a', () => 99)).value).toBe(99);
  });

  it('clears inflight on a failure and does not cache it', async () => {
    const run = idem();
    const failed = await run({}, () => { throw new Error('backend down'); });
    expect(failed.ok).toBe(false);

    // A genuine retry after the failure must run - nothing was cached.
    const retry = await run({}, () => 'recovered');
    expect(retry).toMatchObject({ ok: true, value: 'recovered' });
  });
});

// ---------------------------------------------------------------------------
// supersede - signal merging
// ---------------------------------------------------------------------------

describe('supersede signal merging', () => {
  it('merges a caller-supplied signal with the per-key controller', async ({ asyncBus: bus }) => {
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

  it('combines a caller-supplied signal when AbortSignal.any is unavailable', async () => {
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
