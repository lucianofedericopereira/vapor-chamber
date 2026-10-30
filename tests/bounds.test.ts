/**
 * countOption, the one numeric-option rule, and the caps and windows that rely on it.
 * Why: every comparison with NaN is false, so a gate on evicting or refusing (`length > max`, `count >= max`) fails open and the bound silently vanishes.
 * Shows: non-numbers take the default, Infinity and large caps survive, zero is kept; history, metrics, circuitBreaker, StreamParser, the http cache and idempotent hold under NaN.
 */

import { describe, expect } from 'vitest';
import { MAX_TIMEOUT_MS, countOption } from '../src/bounds';
import { circuitBreaker, metrics } from '../src/plugins-extra';
import { StreamParser } from '../src/stream-parser';
import { it } from '../src/vitest';
import { history } from '../src/plugins-core';

const NAN = Number('nope');

describe('countOption', () => {
  it('sends a non-number to the documented default, not to zero', () => {
    expect(countOption(NAN, 50)).toBe(50);
    expect(countOption(undefined, 50)).toBe(50);
    expect(countOption('nope', 50)).toBe(50);
    expect(countOption({}, 50)).toBe(50);
    // A numeric STRING is a number - a config read that worked.
    expect(countOption('12', 50)).toBe(12);
    // `Number(null)` and `Number(false)` are 0, so they take the floor, not the default.
    expect(countOption(null, 50)).toBe(0);
    expect(countOption(false, 50, 1)).toBe(1);
  });

  it('preserves Infinity, which the `| 0` idiom mapped to zero', () => {
    // "No bound" is a real request; `Infinity | 0` is 0, which stores nothing.
    expect(countOption(Number.POSITIVE_INFINITY, 50)).toBe(Number.POSITIVE_INFINITY);
    expect(countOption(Number.NEGATIVE_INFINITY, 50)).toBe(0);
    expect(countOption(Number.NEGATIVE_INFINITY, 50, 1)).toBe(1);
  });

  it('does not truncate to 32 bits, which the `| 0` idiom did', () => {
    // `3_000_000_000 | 0` is -1294967296: a large cap goes negative.
    expect(countOption(3_000_000_000, 50)).toBe(3_000_000_000);
  });

  it('floors, truncates and caps', () => {
    expect(countOption(-1, 50)).toBe(0);
    expect(countOption(-1, 50, 1)).toBe(1);
    expect(countOption(7.9, 50)).toBe(7);
    expect(countOption(-7.9, 50, -100)).toBe(-7);
    expect(countOption(9e9, 1000, 0, MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS);
  });

  it('keeps a deliberate zero, which is not the same as a missing option', () => {
    expect(countOption(0, 50)).toBe(0);
    expect(countOption(0, 50, 1)).toBe(1);
  });
});

describe('the bounds that had silently ceased to exist', () => {
  it('history keeps its cap under a NaN maxSize (measured: 500 kept against 50)', ({ bus }) => {
    bus.register('x', () => 'ok');
    const h = history({ bus, maxSize: NAN });
    for (let i = 0; i < 500; i++) bus.dispatch('x', {});
    expect(h.getState().past.length).toBe(50);
  });

  it('metrics keeps its cap under a NaN maxSize (measured: 1500 kept against 1000)', ({ bus }) => {
    bus.register('x', () => 'ok');
    const m = metrics({ maxSize: NAN });
    bus.use(m);
    for (let i = 0; i < 1500; i++) bus.dispatch('x', {});
    expect(m.entries().length).toBe(1000);
  });

  it('circuitBreaker still trips under a NaN threshold (measured: closed through 20 failures)', ({ bus }) => {
    bus.register('fail', () => {
      throw new Error('nope');
    });
    const cb = circuitBreaker({ threshold: NAN, actions: ['fail'] });
    bus.use(cb);
    for (let i = 0; i < 20; i++) bus.dispatch('fail', {});
    expect(cb.getState('fail')).toBe('open');
  });

  it('StreamParser still refuses depth under a NaN maxDepth (measured: 5,000 levels accepted)', () => {
    let errored = false;
    const p = new StreamParser({ onError: () => { errored = true; } }, { maxDepth: NAN });
    p.write('['.repeat(5000));
    expect(errored).toBe(true);
  });
});

/** Windows: a NaN reaches `setTimeout` as 0 (loud) or defeats an expiry comparison (silent); these are the silent ones. */
describe('windows that never closed', () => {
  it('an http cache entry with a NaN ttl is treated as expired, not eternal', async () => {
    const { createResponseCache } = await import('../src/http-cache');
    const cache = createResponseCache();

    // `now + NaN` is NaN and `now >= NaN` is false, so a `>=` check would serve it forever.
    cache.set('k', { data: 'stale-forever' } as never, Number('nope'));
    expect(cache.get('k')).toBeNull();

    // A NaN stale window poisons `staleUntil` the same way, even with a good ttl.
    cache.set('k2', { data: 'x' } as never, 30_000, Number('nope'));
    expect(cache.get('k2')).toBeNull();

    // The ordinary path is untouched.
    cache.set('k3', { data: 'ok' } as never, 30_000);
    expect(cache.get('k3')?.data).toEqual({ data: 'ok' });
  });

  it('idempotent still collapses a repeat under a NaN ttl', async () => {
    const { idempotent } = await import('../src/plugins-extra');
    const { createAsyncCommandBus } = await import('../src/command-bus');
    const bus = createAsyncCommandBus({ retry: false });
    let runs = 0;
    bus.register('orderCreate', async () => ++runs);
    bus.use(idempotent({ ttl: Number('nope'), key: () => 'same' }));

    await bus.dispatch('orderCreate', 1);
    await bus.dispatch('orderCreate', 1);
    // `now - cached.at < ttl` gates collapsing, so a NaN window would re-run every duplicate.
    expect(runs).toBe(1);
  });
});
