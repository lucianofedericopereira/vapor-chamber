/** vapor-chamber/store/core: the same store with no Vue (S11, log s35.130). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { effect as alienEffect, signal as alienSignal } from 'alien-signals';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAlienSignals } from '../src/alien-signals';
import { createCommandBus } from '../src/command-bus';
import { configureSignal, type CreateSignal } from '../src/signal';
import { defineChamberStore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { history } from '../src/plugins-core';
import { listen, perTab, quiet } from './tabs-quiet';

type Cart = { items: string[]; count: number };
const reducers = {
  add: (s: Cart, item: string) => ({ items: [...s.items, item], count: s.count + 1 }),
};
const state = (): Cart => ({ items: [], count: 0 });

// Back to the plain `{ value }` cell after a test that configured alien-signals.
afterEach(() => { configureSignal(((v: unknown) => ({ value: v })) as CreateSignal); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


describe('the Vue-less store', () => {
  it('actions are commands; $reset, undo and $onField work as in the Vue store', () => {
    const bus = createCommandBus();
    const h = history({ bus });
    const heard: string[] = [];
    bus.on('*', (cmd) => heard.push(cmd.action));
    const useCart = defineChamberStore('cart', { state, reducers, undo: true });
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
    const useCart = defineChamberStore('cart', { state, reducers });
    const a = useCart(bus);
    const b = useCart(bus);
    expect(b).toBe(a);
    a.$dispose();
    expect(bus.hasHandler('cartAdd')).toBe(false);
  });

  it('shares across tabs', async () => {
    vi.stubGlobal('window', {}); // a page: shareTabs opens only where there are tabs
    const tab = () => {
      const cart = defineChamberStore('cart', { state, reducers, share: shareTabs('core-share') })(createCommandBus());
      return { cart, close: () => cart.$dispose() };
    };
    const wire = listen('core-share');
    const a = tab();
    const b = tab();
    a.cart.add('milk');
    await quiet(wire.heard);
    wire.close();
    expect(b.cart.state.value).toEqual({ items: ['milk'], count: 1 });
    a.close();
    b.close();
  });

  it('field events fire, and with another tab open each write goes out as its command', async () => {
    vi.stubGlobal('window', {}); // a page: shareTabs opens only where there are tabs
    const { heard, close } = listen('core-fields');
    const wire = { close };
    const peer = defineChamberStore('cart', { state, reducers, share: shareTabs('core-fields') })(createCommandBus());
    const cart = defineChamberStore('cart', { state, reducers, share: shareTabs('core-fields') })(createCommandBus());
    await quiet(heard);
    const counts: number[] = [];
    cart.$onField('count', (n) => counts.push(n));
    cart.add('milk');
    cart.add('milk'); // same items twice: count still moves
    await quiet(heard);
    expect(counts).toEqual([1, 2]);
    // Each write crosses as its command: from the tab that wrote it, and again
    // from the tab holding the lock, which runs every tab's command and posts it on.
    expect(perTab(heard.filter((m) => m.kind === 'cmd'))).toEqual([2, 2]);
    expect(peer.state.value.count).toBe(2);
    wire.close();
    cart.$dispose();
    peer.$dispose();
  });

  it('with alien-signals configured, an effect reading the state reruns on a write', () => {
    configureAlienSignals(alienSignal as never);
    const cart = defineChamberStore('cart', { state, reducers })(createCommandBus());
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
