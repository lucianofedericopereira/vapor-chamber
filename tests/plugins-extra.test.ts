import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { cache, circuitBreaker, rateLimit, metrics } from '../src/plugins-extra';
import { stubEnv } from '../src/vitest-pure';
import { it } from '../src/vitest';

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

describe('cache', () => {
  it('calls handler on miss, returns cached result on hit', ({ bus }) => {
    const handler = vi.fn((cmd: any) => cmd.target.id * 10);
    bus.register('getUser', handler);
    bus.use(cache({ ttl: 60_000 }));

    const r1 = bus.query('getUser', { id: 1 });
    const r2 = bus.query('getUser', { id: 1 });

    expect(r1).toSucceedWith(10);
    expect(r2.value).toBe(10);
    expect(handler).toHaveBeenCalledTimes(1); // second call hit cache
  });

  it('misses cache for different targets', ({ bus }) => {
    const handler = vi.fn((cmd: any) => cmd.target.id);
    bus.register('getUser', handler);
    bus.use(cache({ ttl: 60_000 }));

    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 2 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed results', ({ bus }) => {
    let calls = 0;
    bus.register('flaky', () => { calls++; throw new Error('fail'); });
    bus.use(cache({ ttl: 60_000 }));

    bus.dispatch('flaky', {});
    bus.dispatch('flaky', {});

    expect(calls).toBe(2);
  });

  it('invalidate(action, target) removes specific entry', ({ bus }) => {
    const handler = vi.fn(() => 42);
    bus.register('get', handler);
    const c = cache({ ttl: 60_000 });
    bus.use(c);

    bus.query('get', { id: 1 });
    c.invalidate('get', { id: 1 });
    bus.query('get', { id: 1 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('invalidate(action) removes all entries for that action', ({ bus }) => {
    const handler = vi.fn(() => 1);
    bus.register('get', handler);
    const c = cache({ ttl: 60_000 });
    bus.use(c);

    bus.query('get', { id: 1 });
    bus.query('get', { id: 2 });
    c.invalidate('get');
    bus.query('get', { id: 1 });
    bus.query('get', { id: 2 });

    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('clear() empties the cache', ({ bus }) => {
    const handler = vi.fn(() => 1);
    bus.register('get', handler);
    const c = cache({ ttl: 60_000 });
    bus.use(c);

    bus.query('get', { id: 1 });
    expect(c.size()).toBe(1);
    c.clear();
    expect(c.size()).toBe(0);
    bus.query('get', { id: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('respects maxSize with LRU eviction', ({ bus }) => {
    const handler = vi.fn((cmd: any) => cmd.target.id);
    bus.register('get', handler);
    const c = cache({ ttl: 60_000, maxSize: 2 });
    bus.use(c);

    bus.query('get', { id: 1 });
    bus.query('get', { id: 2 });
    bus.query('get', { id: 3 }); // evicts id:1

    expect(c.size()).toBe(2);
  });

  it('does not hang on a negative maxSize, and caches nothing', ({ bus }) => {
    // Regression: `maxSize` was unvalidated. `evictIfNeeded` looped
    // `while (store.size > maxSize)` and only deleted when
    // `store.keys().next().value !== undefined` - so with a negative bound the
    // condition stayed true against an EMPTY store and the guard deleted
    // nothing: an infinite loop on the first eviction, from one bad option.
    // Measured before the fix: 500k iterations with store.size 0, no progress.
    let calls = 0;
    bus.register('getUser', (cmd: any) => { calls++; return cmd.target.id; });
    const c = cache({ ttl: 60_000, maxSize: -1 });
    bus.use(c);

    // If this hangs, the suite times out rather than failing - which is the
    // point: the old form could not fail fast.
    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 2 });

    expect(c.size()).toBe(0); // clamped to 0 - a cache that stores nothing
    expect(calls).toBe(2); // ...so every query really ran
  });

  // The clamp above was `Math.max(0, Math.trunc(raw))`, which PROPAGATES NaN -
  // and every comparison against NaN is false, so `store.size <= maxSize`
  // never broke the eviction walk and it dropped every entry it had just
  // inserted. Measured before the guard: size 0 after 300 inserts. A cache
  // that silently caches nothing is harder to notice than one that hangs.
  it('a NaN maxSize caches nothing rather than defeating the bound', ({ bus }) => {
    let calls = 0;
    bus.register('getUser', (cmd: any) => { calls++; return cmd.target.id; });
    const c = cache({ ttl: 60_000, maxSize: Number('not-a-number') });
    bus.use(c);

    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 1 }); // must be a cache hit

    // Falls back to the documented default rather than to 0: a bad option now
    // behaves like an absent one. Mapping NaN to 0 was bounded but disabled the
    // cache outright, which is the same silent-misconfiguration failure wearing
    // different clothes.
    expect(c.size()).toBe(1);
    expect(calls).toBe(1);
  });

  it('evicts oldest-first and honours the bound exactly', ({ bus }) => {
    bus.register('getUser', (cmd: any) => cmd.target.id);
    const c = cache({ ttl: 60_000, maxSize: 2 });
    bus.use(c);

    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 2 });
    bus.query('getUser', { id: 3 }); // pushes past the bound
    expect(c.size()).toBe(2);
  });

  it('filters actions when actions option is set', ({ bus }) => {
    const handler = vi.fn(() => 1);
    bus.register('getUser', handler);
    bus.register('getPost', handler);
    bus.use(cache({ ttl: 60_000, actions: ['getUser'] }));

    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 1 }); // hit
    bus.query('getPost', { id: 1 });
    bus.query('getPost', { id: 1 }); // not cached

    expect(handler).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// circuitBreaker
// ---------------------------------------------------------------------------

describe('circuitBreaker', () => {
  it('passes through when closed', ({ bus }) => {
    bus.register('op', () => 'ok');
    bus.use(circuitBreaker({ threshold: 3 }));

    const r = bus.dispatch('op', {});
    expect(r).toSucceedWith('ok');
  });

  it('opens after threshold consecutive failures', ({ bus }) => {
    bus.register('op', () => { throw new Error('fail'); });
    const cb = circuitBreaker({ threshold: 3 });
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {});
    bus.dispatch('op', {}); // trips

    expect(cb.getState('op')).toBe('open');
  });

  it('rejects fast when open', ({ bus }) => {
    const handler = vi.fn(() => { throw new Error('fail'); });
    bus.register('op', handler);
    const cb = circuitBreaker({ threshold: 2 });
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {}); // trips

    const r = bus.dispatch('op', {});
    expect(r).toFailWith('VC_PLUGIN_CIRCUIT_OPEN');
    expect(r.error?.message).toContain('Circuit breaker is open');
    expect(handler).toHaveBeenCalledTimes(2); // not called when open
  });

  it('resets to closed after manual reset', ({ bus }) => {
    bus.register('op', () => { throw new Error('fail'); });
    const cb = circuitBreaker({ threshold: 2 });
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {});
    cb.reset('op');

    expect(cb.getState('op')).toBe('closed');
  });

  it('calls onOpen when circuit trips', () => {
    const onOpen = vi.fn();
    const bus = createCommandBus();
    bus.register('op', () => { throw new Error('fail'); });
    bus.use(circuitBreaker({ threshold: 2, onOpen }));

    bus.dispatch('op', {});
    bus.dispatch('op', {});

    expect(onOpen).toHaveBeenCalledWith('op', 2);
  });

  it('calls onClose when half-open succeeds', () => {
    const onClose = vi.fn();
    const bus = createCommandBus();
    let shouldFail = true;
    bus.register('op', () => { if (shouldFail) throw new Error('fail'); return 'ok'; });
    const cb = circuitBreaker({ threshold: 2, resetTimeout: 0, onClose });
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {}); // opens

    // After resetTimeout=0, next call enters half-open
    shouldFail = false;
    bus.dispatch('op', {}); // half-open -> success -> closed

    expect(onClose).toHaveBeenCalledWith('op');
    expect(cb.getState('op')).toBe('closed');
  });

  it('recovers from half-open with no onClose callback configured', ({ bus }) => {
    // `if (onClose)` - the false arm. The test above always supplies the
    // callback, so the optional-callback path (the default configuration) was
    // never exercised: a breaker with no observer must still close.
    let shouldFail = true;
    bus.register('op', () => { if (shouldFail) throw new Error('fail'); return 'ok'; });
    const cb = circuitBreaker({ threshold: 2, resetTimeout: 0 }); // no onClose
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {}); // opens
    expect(cb.getState('op')).toBe('open');

    shouldFail = false;
    const result = bus.dispatch('op', {}); // half-open -> success -> closed

    expect(result.ok).toBe(true);
    expect(cb.getState('op')).toBe('closed');
  });

  it('filters by actions option', ({ bus }) => {
    bus.register('op', () => { throw new Error('fail'); });
    bus.register('safe', () => 'ok');
    const cb = circuitBreaker({ threshold: 1, actions: ['op'] });
    bus.use(cb);

    bus.dispatch('op', {});
    const r = bus.dispatch('safe', {});
    expect(r.ok).toBe(true); // circuit bypassed - 'safe' not in actions list
    expect(cb.getState('op')).toBe('open');
  });

  // VC_PLUGIN_THREW is a pipeline bug, not the server failing: three plugin
  // bugs must not lock an action out. It neither counts nor resets the
  // consecutive-failure run (tests/plugin-throw-fixture.test.ts has the
  // conversion itself).
  it('does not count a VC_PLUGIN_THREW from a plugin inside it', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('op', () => 'ok');
    const cb = circuitBreaker({ threshold: 2 });
    bus.use(cb, { priority: 10 });
    bus.use(() => { throw new Error('plugin bug'); }, { priority: 1 });

    for (let i = 0; i < 5; i++) expect((bus.dispatch('op', {}).error as { code?: string }).code).toBe('VC_PLUGIN_THREW');
    expect(cb.getState('op')).toBe('closed');
  });

  it('a VC_PLUGIN_THREW does not reset a run of real failures either', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('op', () => { throw new Error('server down'); });
    const cb = circuitBreaker({ threshold: 2 });
    bus.use(cb, { priority: 10 });
    let pluginBug = false;
    bus.use((_c, next) => { if (pluginBug) throw new Error('plugin bug'); return next(); }, { priority: 1 });

    bus.dispatch('op', {}); // real failure 1
    pluginBug = true;
    bus.dispatch('op', {}); // a plugin bug: neither counts nor resets
    pluginBug = false;
    expect(cb.getState('op')).toBe('closed');
    bus.dispatch('op', {}); // real failure 2 -> opens
    expect(cb.getState('op')).toBe('open');
  });

  it('async bus: a rejecting plugin inside it is not counted', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('op', async () => 'ok');
    const cb = circuitBreaker({ threshold: 2 });
    bus.use(cb as any, { priority: 10 });
    bus.use(() => Promise.reject(new Error('plugin bug')), { priority: 1 });

    for (let i = 0; i < 4; i++) expect(((await bus.dispatch('op', {})).error as { code?: string }).code).toBe('VC_PLUGIN_THREW');
    expect(cb.getState('op')).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
// rateLimit
// ---------------------------------------------------------------------------

describe('rateLimit', () => {
  it('allows dispatches under the limit', ({ bus }) => {
    bus.register('op', () => 'ok');
    bus.use(rateLimit({ max: 3, window: 1000 }));

    expect(bus.dispatch('op', {}).ok).toBe(true);
    expect(bus.dispatch('op', {}).ok).toBe(true);
    expect(bus.dispatch('op', {}).ok).toBe(true);
  });

  it('rejects when limit is exceeded', ({ bus }) => {
    bus.register('op', () => 'ok');
    bus.use(rateLimit({ max: 2, window: 1000 }));

    bus.dispatch('op', {});
    bus.dispatch('op', {});
    const r = bus.dispatch('op', {});

    expect(r).toFailWith('VC_PLUGIN_RATE_LIMITED');
    expect(r.error?.message).toContain('Rate limit exceeded');
  });

  it('tracks limits per action independently', ({ bus }) => {
    bus.register('a', () => 1);
    bus.register('b', () => 2);
    bus.use(rateLimit({ max: 1, window: 1000 }));

    expect(bus.dispatch('a', {}).ok).toBe(true);
    expect(bus.dispatch('a', {})).toFailWith('VC_PLUGIN_RATE_LIMITED'); // over limit
    expect(bus.dispatch('b', {}).ok).toBe(true);  // separate counter
  });

  it('filters by actions option', ({ bus }) => {
    bus.register('protected', () => 1);
    bus.register('free', () => 2);
    bus.use(rateLimit({ max: 1, window: 1000, actions: ['protected'] }));

    bus.dispatch('protected', {});
    expect(bus.dispatch('protected', {})).toFailWith('VC_PLUGIN_RATE_LIMITED');
    expect(bus.dispatch('free', {}).ok).toBe(true);
    expect(bus.dispatch('free', {}).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('records successful dispatch', ({ bus }) => {
    bus.register('op', () => 42);
    const m = metrics();
    bus.use(m);

    bus.dispatch('op', {});

    const entries = m.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('op');
    expect(entries[0].ok).toBe(true);
    expect(typeof entries[0].durationMs).toBe('number');
  });

  it('records failed dispatch', ({ bus }) => {
    bus.register('op', () => { throw new Error('fail'); });
    const m = metrics();
    bus.use(m);

    bus.dispatch('op', {});

    expect(m.entries()[0].ok).toBe(false);
  });

  it('summary aggregates count, avgMs, errorRate', ({ bus }) => {
    let fail = false;
    bus.register('op', () => { if (fail) throw new Error('x'); return 1; });
    const m = metrics();
    bus.use(m);

    bus.dispatch('op', {});
    bus.dispatch('op', {});
    fail = true;
    bus.dispatch('op', {});

    const s = m.summary();
    expect(s.op.count).toBe(3);
    expect(s.op.errorRate).toBeCloseTo(0.333, 2);
  });

  it('clear() resets all entries', ({ bus }) => {
    bus.register('op', () => 1);
    const m = metrics();
    bus.use(m);

    bus.dispatch('op', {});
    m.clear();

    expect(m.entries()).toHaveLength(0);
    expect(m.summary()).toEqual({});
  });

  it('respects maxEntries with O(1) eviction', ({ bus }) => {
    bus.register('op', () => 1);
    const m = metrics({ maxEntries: 3 });
    bus.use(m);

    for (let i = 0; i < 5; i++) bus.dispatch('op', {});

    expect(m.entries()).toHaveLength(3);
  });

  it('onEntry callback fires per dispatch', ({ bus }) => {
    bus.register('op', () => 1);
    const onEntry = vi.fn();
    bus.use(metrics({ onEntry }));

    bus.dispatch('op', {});
    bus.dispatch('op', {});

    expect(onEntry).toHaveBeenCalledTimes(2);
  });

  it('filters by actions option', ({ bus }) => {
    bus.register('tracked', () => 1);
    bus.register('ignored', () => 2);
    const m = metrics({ actions: ['tracked'] });
    bus.use(m);

    bus.dispatch('tracked', {});
    bus.dispatch('ignored', {});

    expect(m.entries()).toHaveLength(1);
    expect(m.entries()[0].action).toBe('tracked');
  });
});

// ---------------------------------------------------------------------------
// cache - custom key, async results, and invalidation edges
// ---------------------------------------------------------------------------

describe('cache - key derivation and invalidation', () => {
  it('uses a supplied key() instead of commandKey', ({ bus }) => {
    const handler = vi.fn((cmd: any) => cmd.target.id);
    bus.register('getUser', handler);
    // Keyed by id ONLY, so two different targets that share an id are one entry.
    bus.use(cache({ ttl: 60_000, key: (cmd: any) => `u:${cmd.target.id}` }));

    bus.query('getUser', { id: 1, extra: 'a' });
    bus.query('getUser', { id: 1, extra: 'b' });

    expect(handler).toHaveBeenCalledTimes(1); // second call hit the custom key
  });

  it('warns that invalidate(action, target) cannot address custom-key entries', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('getUser', (cmd: any) => cmd.target.id);
    const c = cache({ ttl: 60_000, key: (cmd: any) => `u:${cmd.target.id}` });
    bus.use(c);

    bus.query('getUser', { id: 1 });
    expect(c.size()).toBe(1);

    // A custom key may depend on the payload, so (action, target) is not enough
    // to recompute it. Saying so beats deleting nothing quietly.
    c.invalidate('getUser', { id: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot address entries stored'));

    // Action-wide invalidation is index-driven and still works for any key shape.
    c.invalidate('getUser');
    expect(c.size()).toBe(0);
  });

  it('stays silent about custom-key invalidation in production (DEV=false)', async () => {
    // The `if (DEV)` FALSE arm of the warning above. The diagnostic is a
    // build-time aid; in production the call must be a quiet no-op for the
    // targeted form while action-wide invalidation keeps working.
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { cache: prodCache } = await import('../src/plugins-extra');
    const { createCommandBus: prodBus } = await import('../src/command-bus');

    const bus = prodBus();
    bus.register('getUser', (cmd: any) => cmd.target.id);
    const c = prodCache({ ttl: 60_000, key: (cmd: any) => `u:${cmd.target.id}` });
    bus.use(c);

    bus.query('getUser', { id: 1 });
    expect(c.size()).toBe(1);

    c.invalidate('getUser', { id: 1 });
    expect(warn).not.toHaveBeenCalled(); // no diagnostic...
    expect(c.size()).toBe(1); // ...and, as in dev, nothing was removed

    c.invalidate('getUser'); // action-wide still works
    expect(c.size()).toBe(0);

    vi.resetModules();
  });

  it('invalidating an action with nothing cached is a no-op', () => {
    const c = cache({ ttl: 60_000 });
    expect(() => c.invalidate('neverCached')).not.toThrow();
    expect(c.size()).toBe(0);
  });

  it('drops the action index once its last key is invalidated', ({ bus }) => {
    bus.register('getUser', (cmd: any) => cmd.target.id);
    const c = cache({ ttl: 60_000 });
    bus.use(c);

    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 2 });
    expect(c.size()).toBe(2);

    c.invalidate('getUser', { id: 1 });
    expect(c.size()).toBe(1);
    // Removing the last one must also drop the empty action bucket, or the
    // index grows forever with sets nobody reads.
    c.invalidate('getUser', { id: 2 });
    expect(c.size()).toBe(0);
  });
});

describe('cache - async bus', () => {
  it('caches a resolved async result and serves the next call from it', async ({ asyncBus: bus }) => {
    const handler = vi.fn(async (cmd: any) => cmd.target.id * 2);
    bus.register('getUser', handler);
    bus.use(cache({ ttl: 60_000 }));

    const first = await bus.query('getUser', { id: 21 });
    expect(first.value).toBe(42);

    const second = await bus.query('getUser', { id: 21 });
    expect(second.value).toBe(42);
    // The plugin has to await the promise before storing, or the cache holds a
    // pending thenable and every later hit returns something unresolved.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected async result', async ({ asyncBus: bus }) => {
    let fail = true;
    const handler = vi.fn(async () => {
      if (fail) throw new Error('upstream down');
      return 'recovered';
    });
    bus.register('getUser', handler);
    bus.use(cache({ ttl: 60_000 }));

    const bad = await bus.query('getUser', { id: 1 });
    expect(bad.ok).toBe(false);

    // Caching a failure would pin the outage for the whole ttl.
    fail = false;
    const good = await bus.query('getUser', { id: 1 });
    expect(good).toSucceedWith('recovered');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
