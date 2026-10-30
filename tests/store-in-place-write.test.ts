/**
 * In development an undo store's double run applies a reducer that returns its own state once, as production does.
 * Why: a reducer that changes its state in place and returns it would be run twice on one object in development, so development would hold [1,1,2,2] where production holds [1,2].
 * Shows: an in-place reducer applies once in development and in production, a reducer that mints a value still warns, and a new-object reducer applies once.
 * See: log s35.160, s35.211, docs/store.md.
 */
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
