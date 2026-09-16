/**
 * The numeric-option rule, and the four defects that forced it into one place.
 *
 * Comparison direction decides which way a bad number fails. Every comparison
 * against NaN is false, so a gate on RECORDING (`length < max`) fails safe by
 * recording nothing, while a gate on EVICTING (`length > max`) or REFUSING
 * (`count >= max`) fails OPEN - the bound silently ceases to exist. The two
 * that fail open are the two that are idiomatic to write, which is why this
 * kept happening.
 *
 * The four below were measured through the public API before ../src/bounds
 * existed, not reasoned about.
 */

import { describe, expect } from 'vitest';
import { MAX_TIMEOUT_MS, countOption } from '../src/bounds';
import { history } from '../src/plugins-core';
import { circuitBreaker, metrics } from '../src/plugins-extra';
import { StreamParser } from '../src/stream-parser';
import { it } from '../src/vitest';

const NAN = Number('nope');

describe('countOption', () => {
  it('sends a non-number to the documented default, not to zero', () => {
    expect(countOption(NAN, 50)).toBe(50);
    expect(countOption(undefined, 50)).toBe(50);
    expect(countOption('nope', 50)).toBe(50);
    expect(countOption({}, 50)).toBe(50);
    // A numeric STRING is a number - a config read that worked.
    expect(countOption('12', 50)).toBe(12);
  });

  it('preserves Infinity, which the `| 0` idiom mapped to zero', () => {
    // "No bound" is a real request. `Infinity | 0` is 0, so five hand-clamped
    // sites answered it with "store nothing".
    expect(countOption(Number.POSITIVE_INFINITY, 50)).toBe(Number.POSITIVE_INFINITY);
    expect(countOption(Number.NEGATIVE_INFINITY, 50)).toBe(0);
    expect(countOption(Number.NEGATIVE_INFINITY, 50, 1)).toBe(1);
  });

  it('does not truncate to 32 bits, which the `| 0` idiom did', () => {
    // `3_000_000_000 | 0` is -1294967296: a large cap silently went negative.
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
    const h = history({ maxSize: NAN });
    bus.use(h);
    for (let i = 0; i < 500; i++) bus.dispatch('x', {});
    expect(h.getState().past.length).toBe(50);
  });

  it('metrics keeps its cap under a NaN maxEntries (measured: 1500 kept against 1000)', ({ bus }) => {
    bus.register('x', () => 'ok');
    const m = metrics({ maxEntries: NAN });
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

/**
 * The TTL family, swept after the caps.
 *
 * Same rule, different consequence: a NaN window reaches `setTimeout` as 0
 * (loud) or defeats an expiry comparison (silent). Only the silent ones are
 * defects, and there were two.
 */
describe('windows that never closed', () => {
  it('an http cache entry with a NaN ttl is treated as expired, not eternal', async () => {
    const { createResponseCache } = await import('../src/http-cache');
    const cache = createResponseCache();

    // `now + NaN` is NaN, and `now >= NaN` is false - so the old `>=` said
    // "not expired" forever and served this entry for the life of the page.
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
    const plugin = idempotent({ ttl: Number('nope'), key: () => 'same' });
    let runs = 0;
    const run = () =>
      plugin({ action: 'orderCreate', target: 1, meta: {} } as never, () => {
        runs++;
        return { ok: true, value: runs } as never;
      });

    await run();
    await run();
    // `now - cached.at < ttl` gates COLLAPSING, so a NaN window collapsed
    // nothing and every duplicate re-executed - the guarantee this plugin
    // exists for, silently absent.
    expect(runs).toBe(1);
  });
});
