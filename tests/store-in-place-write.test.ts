/** In development an undo store's double run applies a reducer that returns its own state once, as production does. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';

type S = { items: number[] };
const state = (): S => ({ items: [] });
const inPlace = (s: S, t: number) => { s.items.push(t); return s; };
const fresh = (s: S, t: number) => ({ items: [...s.items, t] });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });

describe('the development double run of an undo store', () => {
  it('a reducer that changes and returns its state applies once, as in production', () => {
    const cart = defineChamberStore('cart', { state, reducers: { add: inPlace }, undo: true })(createCommandBus());
    cart.add(1);
    cart.add(2);
    expect(cart.state.value.items).toEqual([1, 2]);
    cart.$dispose();
  });

  it('control: production applies it once', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { createCommandBus: make } = await import('../src/command-bus');
    const { defineChamberStore: define } = await import('../src/store');
    const cart = define('cart', { state, reducers: { add: inPlace }, undo: true })(make());
    cart.add(1);
    cart.add(2);
    expect(cart.state.value.items).toEqual([1, 2]);
    cart.$dispose();
  });

  it('control: a reducer that mints a value still warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const cart = defineChamberStore('cart', { state, reducers: { add: (s: S) => ({ items: [...s.items, ++n] }) }, undo: true })(createCommandBus());
    cart.add();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('gave two different states'))).toBe(true);
    cart.$dispose();
  });

  it('control: a new-object reducer applies once', () => {
    const cart = defineChamberStore('cart', { state, reducers: { add: fresh }, undo: true })(createCommandBus());
    cart.add(1);
    cart.add(2);
    expect(cart.state.value.items).toEqual([1, 2]);
    cart.$dispose();
  });
});

/*
 * Found by the Pinia 4.1.0 harvest (.probes/pinia-4.1-harvest.md), 2026-10-20. In development
 * an `undo: true` store runs each reducer twice and compares the two states, to catch a
 * reducer that mints an id or a time (log s35.160). A reducer that changes its state in place
 * and returns it was run twice on that one object, so development held [1,1,2,2] where
 * production held [1,2]. A reducer that returns the state it was given has minted nothing, so
 * the second run is skipped: one identity comparison, in development only (log 35.211's rule,
 * no whole-state strings, holds). A write in place stays what docs/store.md says: no write.
 * Owner: only a clear bug lands, so no general in-place detector.
 */
