/** vapor-chamber/store/core: the same store with no Vue (S11, log s35.130). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { effect as alienEffect, signal as alienSignal } from 'alien-signals';
import { afterEach, describe, expect, it } from 'vitest';
import { configureAlienSignals } from '../src/alien-signals';
import { createCommandBus } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { history } from '../src/plugins-core';
import { createChannel } from '../src/plugins-io';
import { configureSignal } from '../src/signal';
import { defineChamberStore } from '../src/store/core';

type Cart = { items: string[]; count: number };
const actions = {
  add: (s: Cart, item: string) => ({ items: [...s.items, item], count: s.count + 1 }),
};
const state = (): Cart => ({ items: [], count: 0 });

// Back to the plain `{ value }` cell after a test that configured alien-signals.
afterEach(() => configureSignal((v) => ({ value: v })));

describe('the Vue-less store', () => {
  it('actions are commands; $reset, undo and $onField work as in the Vue store', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    bus.use(h);
    const heard: string[] = [];
    bus.on('*', (cmd) => heard.push(cmd.action));
    const useCart = defineChamberStore('cart', { state, actions, undo: true });
    const cart = useCart(bus);
    const counts: number[] = [];
    cart.$onField('count', (n) => counts.push(n));
    cart.add('milk');
    cart.add('bread');
    h.undo();
    expect(cart.state.value).toEqual({ items: ['milk'], count: 1 });
    cart.$reset();
    expect(cart.state.value).toEqual({ items: [], count: 0 });
    expect(counts).toEqual([1, 2, 1, 0]);
    expect(heard.filter((a) => !a.endsWith('$undo'))).toEqual(['cartAdd', 'cartAdd', 'cart$reset']);
    cart.$dispose();
  });

  it('no scope: the store lives until its caller disposes it', () => {
    const bus = createCommandBus();
    const useCart = defineChamberStore('cart', { state, actions });
    const a = useCart(bus);
    const b = useCart(bus);
    expect(b).toBe(a);
    a.$dispose();
    expect(bus.hasHandler('cartAdd')).toBe(false);
  });

  it('shares across tabs', async () => {
    const tab = () => {
      const lane = createFastLane();
      const ch = createChannel({ channel: 'core-share', lane, events: ['cart$state'] });
      const cart = defineChamberStore('cart', { state, actions, share: lane })(createCommandBus());
      return { cart, close: () => { cart.$dispose(); ch.close(); } };
    };
    const a = tab();
    const b = tab();
    a.cart.add('milk');
    await new Promise((r) => setTimeout(r, 20));
    expect(b.cart.state.value).toEqual({ items: ['milk'], count: 1 });
    a.close();
    b.close();
  });

  it('field events and sharing watch the same state together', async () => {
    const lane = createFastLane();
    const sent: unknown[] = [];
    lane.on('cart$state', (m) => sent.push(m));
    const cart = defineChamberStore('cart', { state, actions, share: lane })(createCommandBus());
    const counts: number[] = [];
    cart.$onField('count', (n) => counts.push(n));
    cart.add('milk');
    cart.add('milk'); // same items twice: count still moves
    expect(counts).toEqual([1, 2]);
    expect(sent).toHaveLength(2);
    cart.$dispose();
  });

  it('with alien-signals configured, an effect reading the state reruns on a write', () => {
    configureAlienSignals(alienSignal as never);
    const cart = defineChamberStore('cart', { state, actions })(createCommandBus());
    const seen: number[] = [];
    const stop = alienEffect(() => { seen.push(cart.state.value.count); });
    cart.add('milk');
    expect(seen).toEqual([0, 1]);
    stop();
    cart.$dispose();
  });
});

describe('its built entry', () => {
  it('imports no vue', () => {
    const built = resolve(process.cwd(), 'dist/store/core.js');
    if (!existsSync(built)) return; // needs dist/, as the other boundary tests
    const imports = [...readFileSync(built, 'utf8').matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.some((i) => i === 'vue' || i.startsWith('@vue'))).toBe(false);
    expect(imports.some((i) => /chamber/.test(i))).toBe(false);
  });
});
