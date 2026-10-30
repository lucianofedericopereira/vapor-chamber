/**
 * The window, bound and signal rules of rateLimit, metrics, idempotent and supersede in src/plugins-extra.ts.
 * Why: a rate-limit window must reopen once its entries expire; metrics and idempotent must keep to their size bounds without duplicating a command declared idempotent; supersede must still abort when the caller's own signal aborts. Also the only file reaching rateLimit's window expiry and compaction and idempotent's `stampMeta: false`, so the 100% floor needs it.
 * Shows: rateLimit admits again after the window passes; metrics keeps only `maxSize` entries; idempotent leaves `meta` alone with `stampMeta: false`, drops an expired key, keeps nothing at `maxSize: 0` or a negative one, keeps the default retention for a NaN one, evicts oldest first, and caches nothing after a failure; supersede merges a caller's signal with `AbortSignal.any` (aborting with it) and without it (not aborted yet).
 * See: tests/combine-signals.test.ts.
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { rateLimit, metrics, idempotent, supersede } from '../src/plugins-extra';
import type { Command } from '../src/index';
import { it } from '../src/vitest';

afterEach(() => {
  vi.useRealTimers();
});

describe('rateLimit window compaction', () => {
  it('advances past expired timestamps and compacts the backing array', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const bus = createCommandBus();
    bus.use(rateLimit({ max: 3, window: 100 }));
    bus.register('tap', () => 1);

    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {})).toFailWith('rateLimit:limited:action');

    // All three entries expire.
    vi.setSystemTime(1_000_200);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
    expect(bus.dispatch('tap', {}).ok).toBe(true);
  });
});

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
    // Within the TTL the result is cached.
    const cached = await run({}, next);
    expect(cached.value).toBe(1);
    expect(runs).toBe(1);

    vi.setSystemTime(2_002_000);
    const fresh = await run({}, next);
    expect(fresh.value).toBe(2);
    expect(runs).toBe(2);
  });

  it('maxSize: 0 remembers nothing, matching cache({ maxSize: 0 })', async () => {
    // Eviction runs down to the bound after the insert, as cache() does.
    const run = idem({ maxSize: 0 });
    expect((await run({}, () => 1)).value).toBe(1);
    expect((await run({}, () => 2)).value).toBe(2); // nothing was retained, so the handler ran again
  });

  it('a NaN maxSize remembers nothing instead of growing unbounded', async () => {
    const run = idem({ maxSize: Number('nope'), ttl: 60_000 });
    for (let i = 0; i < 20; i++) await run(i, () => i);

    // NaN falls back to the default retention (500), so dedupe still works: forgetting would run an idempotent command twice.
    expect((await run(0, () => -1)).value).toBe(0);
    expect((await run(19, () => -1)).value).toBe(19);
  });

  it('a negative maxSize is clamped, not treated as a one-entry cache', async () => {
    // A negative bound clamps to 0: the same key runs again (a one-entry cache would return 1).
    const run = idem({ maxSize: -5 });
    expect((await run({}, () => 1)).value).toBe(1);
    expect((await run({}, () => 2)).value).toBe(2);
  });

  it('evicts oldest first down to maxSize', async () => {
    const run = idem({ maxSize: 2 });
    await run('a', () => 1);
    await run('b', () => 2);
    await run('c', () => 3); // evicts 'a'

    expect((await run('b', () => 99)).value).toBe(2);
    expect((await run('c', () => 99)).value).toBe(3);
    expect((await run('a', () => 99)).value).toBe(99);
  });

  it('clears inflight on a failure and does not cache it', async () => {
    const run = idem();
    const failed = await run({}, () => { throw new Error('backend down'); });
    expect(failed.ok).toBe(false);

    const retry = await run({}, () => 'recovered');
    expect(retry).toMatchObject({ ok: true, value: 'recovered' });
  });
});

describe('supersede signal merging', () => {
  it('merges a caller-supplied signal with the per-key controller', async ({ asyncBus: bus }) => {
    bus.use(supersede({ actions: ['search'] }));
    let observed: AbortSignal | undefined;
    bus.register('search', async (c: Command) => { observed = c.signal; return 1; });

    const user = new AbortController();
    await bus.dispatch('search', {}, undefined, { signal: user.signal });

    expect(observed).toBeDefined();
    expect(observed!.aborted).toBe(false);
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
