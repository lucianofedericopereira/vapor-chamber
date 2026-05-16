import { describe, it, expect, vi, } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { cache, circuitBreaker, rateLimit, metrics } from '../src/plugins-extra';

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

describe('cache', () => {
  it('calls handler on miss, returns cached result on hit', () => {
    const bus = createCommandBus();
    const handler = vi.fn((cmd: any) => cmd.target.id * 10);
    bus.register('getUser', handler);
    bus.use(cache({ ttl: 60_000 }));

    const r1 = bus.query('getUser', { id: 1 });
    const r2 = bus.query('getUser', { id: 1 });

    expect(r1.ok).toBe(true);
    expect(r1.value).toBe(10);
    expect(r2.value).toBe(10);
    expect(handler).toHaveBeenCalledTimes(1); // second call hit cache
  });

  it('misses cache for different targets', () => {
    const bus = createCommandBus();
    const handler = vi.fn((cmd: any) => cmd.target.id);
    bus.register('getUser', handler);
    bus.use(cache({ ttl: 60_000 }));

    bus.query('getUser', { id: 1 });
    bus.query('getUser', { id: 2 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed results', () => {
    const bus = createCommandBus();
    let calls = 0;
    bus.register('flaky', () => { calls++; throw new Error('fail'); });
    bus.use(cache({ ttl: 60_000 }));

    bus.dispatch('flaky', {});
    bus.dispatch('flaky', {});

    expect(calls).toBe(2);
  });

  it('invalidate(action, target) removes specific entry', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 42);
    bus.register('get', handler);
    const c = cache({ ttl: 60_000 });
    bus.use(c);

    bus.query('get', { id: 1 });
    c.invalidate('get', { id: 1 });
    bus.query('get', { id: 1 });

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('invalidate(action) removes all entries for that action', () => {
    const bus = createCommandBus();
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

  it('clear() empties the cache', () => {
    const bus = createCommandBus();
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

  it('respects maxSize with LRU eviction', () => {
    const bus = createCommandBus();
    const handler = vi.fn((cmd: any) => cmd.target.id);
    bus.register('get', handler);
    const c = cache({ ttl: 60_000, maxSize: 2 });
    bus.use(c);

    bus.query('get', { id: 1 });
    bus.query('get', { id: 2 });
    bus.query('get', { id: 3 }); // evicts id:1

    expect(c.size()).toBe(2);
  });

  it('filters actions when actions option is set', () => {
    const bus = createCommandBus();
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
  it('passes through when closed', () => {
    const bus = createCommandBus();
    bus.register('op', () => 'ok');
    bus.use(circuitBreaker({ threshold: 3 }));

    const r = bus.dispatch('op', {});
    expect(r.ok).toBe(true);
    expect(r.value).toBe('ok');
  });

  it('opens after threshold consecutive failures', () => {
    const bus = createCommandBus();
    bus.register('op', () => { throw new Error('fail'); });
    const cb = circuitBreaker({ threshold: 3 });
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {});
    bus.dispatch('op', {}); // trips

    expect(cb.getState('op')).toBe('open');
  });

  it('rejects fast when open', () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => { throw new Error('fail'); });
    bus.register('op', handler);
    const cb = circuitBreaker({ threshold: 2 });
    bus.use(cb);

    bus.dispatch('op', {});
    bus.dispatch('op', {}); // trips

    const r = bus.dispatch('op', {});
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('Circuit breaker is open');
    expect(handler).toHaveBeenCalledTimes(2); // not called when open
  });

  it('resets to closed after manual reset', () => {
    const bus = createCommandBus();
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
    bus.dispatch('op', {}); // half-open → success → closed

    expect(onClose).toHaveBeenCalledWith('op');
    expect(cb.getState('op')).toBe('closed');
  });

  it('filters by actions option', () => {
    const bus = createCommandBus();
    bus.register('op', () => { throw new Error('fail'); });
    bus.register('safe', () => 'ok');
    const cb = circuitBreaker({ threshold: 1, actions: ['op'] });
    bus.use(cb);

    bus.dispatch('op', {});
    const r = bus.dispatch('safe', {});
    expect(r.ok).toBe(true); // circuit bypassed — 'safe' not in actions list
    expect(cb.getState('op')).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// rateLimit
// ---------------------------------------------------------------------------

describe('rateLimit', () => {
  it('allows dispatches under the limit', () => {
    const bus = createCommandBus();
    bus.register('op', () => 'ok');
    bus.use(rateLimit({ max: 3, window: 1000 }));

    expect(bus.dispatch('op', {}).ok).toBe(true);
    expect(bus.dispatch('op', {}).ok).toBe(true);
    expect(bus.dispatch('op', {}).ok).toBe(true);
  });

  it('rejects when limit is exceeded', () => {
    const bus = createCommandBus();
    bus.register('op', () => 'ok');
    bus.use(rateLimit({ max: 2, window: 1000 }));

    bus.dispatch('op', {});
    bus.dispatch('op', {});
    const r = bus.dispatch('op', {});

    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('Rate limit exceeded');
  });

  it('tracks limits per action independently', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.register('b', () => 2);
    bus.use(rateLimit({ max: 1, window: 1000 }));

    expect(bus.dispatch('a', {}).ok).toBe(true);
    expect(bus.dispatch('a', {}).ok).toBe(false); // over limit
    expect(bus.dispatch('b', {}).ok).toBe(true);  // separate counter
  });

  it('filters by actions option', () => {
    const bus = createCommandBus();
    bus.register('protected', () => 1);
    bus.register('free', () => 2);
    bus.use(rateLimit({ max: 1, window: 1000, actions: ['protected'] }));

    bus.dispatch('protected', {});
    expect(bus.dispatch('protected', {}).ok).toBe(false);
    expect(bus.dispatch('free', {}).ok).toBe(true);
    expect(bus.dispatch('free', {}).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('metrics', () => {
  it('records successful dispatch', () => {
    const bus = createCommandBus();
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

  it('records failed dispatch', () => {
    const bus = createCommandBus();
    bus.register('op', () => { throw new Error('fail'); });
    const m = metrics();
    bus.use(m);

    bus.dispatch('op', {});

    expect(m.entries()[0].ok).toBe(false);
  });

  it('summary aggregates count, avgMs, errorRate', () => {
    const bus = createCommandBus();
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

  it('clear() resets all entries', () => {
    const bus = createCommandBus();
    bus.register('op', () => 1);
    const m = metrics();
    bus.use(m);

    bus.dispatch('op', {});
    m.clear();

    expect(m.entries()).toHaveLength(0);
    expect(m.summary()).toEqual({});
  });

  it('respects maxEntries with O(1) eviction', () => {
    const bus = createCommandBus();
    bus.register('op', () => 1);
    const m = metrics({ maxEntries: 3 });
    bus.use(m);

    for (let i = 0; i < 5; i++) bus.dispatch('op', {});

    expect(m.entries()).toHaveLength(3);
  });

  it('onEntry callback fires per dispatch', () => {
    const bus = createCommandBus();
    bus.register('op', () => 1);
    const onEntry = vi.fn();
    bus.use(metrics({ onEntry }));

    bus.dispatch('op', {});
    bus.dispatch('op', {});

    expect(onEntry).toHaveBeenCalledTimes(2);
  });

  it('filters by actions option', () => {
    const bus = createCommandBus();
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
