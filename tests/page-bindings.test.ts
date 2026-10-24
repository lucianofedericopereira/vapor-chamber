// @vitest-environment happy-dom
// `bindDisplay`: display bindings on plain HTML follow a store's fields and the bus's command state; rationale at the end.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindDisplay } from '../src/page-bindings';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store/core';

type Cart = { count: number; items: Array<{ name: string; qty: number }>; note: string | null };
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ count: 0, items: [], note: null }),
  reducers: {
    add: (s: Cart, name: string) => ({ ...s, count: s.count + 1, items: [...s.items, { name, qty: 1 }] }),
    clear: (s: Cart) => ({ ...s, count: 0, items: [] }),
  },
});

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('data-vc-text and data-vc-show', () => {
  it('render the store at bind time and follow each write of their field', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('milk');
    const root = page('<span data-vc-text="cart.count">9</span><p data-vc-show="cart.items">items</p><p data-vc-show="cart.note">note</p>');
    bindDisplay(root, { bus });
    const [count, items, note] = [root.querySelector('span')!, ...root.querySelectorAll('p')];
    const before = { count: count.textContent, items: items.hidden, note: note.hidden };
    cart.clear();
    expect({ before, count: count.textContent, items: items.hidden }).toEqual({
      before: { count: '1', items: false, note: true },
      count: '0',
      items: true,
    });
    cart.$dispose();
  });

  it('a deeper path reads through the field, and an inherited name reads nothing', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('tea');
    const root = page('<b data-vc-text="cart.items.length"></b><i data-vc-text="cart.constructor">kept</i><u data-vc-text="cart.items.constructor"></u>');
    bindDisplay(root, { bus });
    expect([root.querySelector('b')!.textContent, root.querySelector('i')!.textContent, root.querySelector('u')!.textContent]).toEqual(['1', '', '']);
    cart.$dispose();
  });

  it('a store missing at bind time leaves the markup and says so in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const root = page('<span data-vc-text="nowhere.count">server</span>');
    bindDisplay(root, { bus });
    expect({ text: root.querySelector('span')!.textContent, warned: warn.mock.calls.some((c) => String(c[0]).includes('nowhere')) })
      .toEqual({ text: 'server', warned: true });
  });

  it('unbind stops following the store', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    const root = page('<span data-vc-text="cart.count"></span>');
    const unbind = bindDisplay(root, { bus });
    unbind();
    cart.add('milk');
    expect(root.querySelector('span')!.textContent).toBe('0');
    cart.$dispose();
  });
});

describe('data-vc-each', () => {
  it('renders its template per entry, rows read their item, and rebuilds on a write', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('milk');
    const root = page('<ul data-vc-each="cart.items"><template><li><span data-vc-text="name"></span> x<span data-vc-text="qty"></span><em data-vc-show="gone"></em></li></template></ul>');
    bindDisplay(root, { bus });
    const rows = () => [...root.querySelectorAll('li')].map((li) => li.textContent);
    const first = rows();
    cart.add('tea');
    const second = rows();
    cart.clear();
    expect([...root.querySelectorAll('em')].every((em) => (em as HTMLElement).hidden)).toBe(true);
    expect({ first, second, third: rows() }).toEqual({ first: ['milk x1'], second: ['milk x1', 'tea x1'], third: [] });
    cart.$dispose();
  });

  it('a command inside a row is bound, and a rebuild unbinds the old row', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('milk');
    const removed: unknown[] = [];
    bus.register('cartRemove', (cmd) => { removed.push(cmd.target); });
    const root = page(`<ul data-vc-each="cart.items"><template><li><button data-vc-command="cartRemove" data-vc-target='{"at":0}'>x</button></li></template></ul>`);
    bindDisplay(root, { bus });
    const old = root.querySelector('button')!;
    old.click();
    cart.add('tea');
    old.click();
    root.querySelector('button')!.click();
    expect(removed).toEqual([{ at: 0 }, { at: 0 }]);
    cart.$dispose();
  });
});

describe('edges of the paths and the rows', () => {
  it('binds the root itself; a path with no store part warns and is left alone', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('milk');
    const root = page('');
    const self = document.createElement('span');
    self.setAttribute('data-vc-text', 'cart.count');
    const bare = document.createElement('i');
    bare.setAttribute('data-vc-text', 'count');
    bare.textContent = 'kept';
    root.append(self);
    self.append(bare);
    bindDisplay(self, { bus });
    expect({ self: self.firstChild?.textContent ?? self.textContent, bare: warn.mock.calls.some((c) => String(c[0]).includes('"count"')) })
      .toEqual({ self: '1', bare: true });
    cart.$dispose();
  });

  it('a data-vc-each with no template, or on a field that is not a list, renders no row', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('milk');
    const root = page('<ul data-vc-each="cart.items"></ul><ol data-vc-each="cart.count"><template><li>x</li></template></ol>');
    bindDisplay(root, { bus });
    expect(root.querySelectorAll('li').length).toBe(0);
    cart.$dispose();
  });

  it('a row whose root is the command is unbound on the rebuild and on unbind', () => {
    const bus = createCommandBus();
    const cart = useCart(bus);
    cart.add('milk');
    let runs = 0;
    bus.register('cartRemove', () => { runs++; });
    const root = page('<div data-vc-each="cart.items"><template><button data-vc-command="cartRemove">x</button></template></div>');
    const unbind = bindDisplay(root, { bus });
    const old = root.querySelector('button')!;
    cart.add('tea');
    old.click();
    const kept = root.querySelector('button')!;
    unbind();
    kept.click();
    expect(runs).toBe(0);
    cart.$dispose();
  });

  it('a pending binding with a target that is not JSON reads the default key', async () => {
    const bus = createAsyncCommandBus();
    let open!: () => void;
    bus.register('cartSave', () => new Promise<void>((r) => { open = r; }));
    const root = page(`<span data-vc-pending="cartSave" data-vc-target="{nope">saving</span><b data-vc-pending="cartSave" data-vc-target="null">saving</b>`);
    bindDisplay(root, { bus });
    const p = bus.dispatch('cartSave', {});
    await settle();
    const during = [root.querySelector('span')!.classList.contains('vc-loading'), root.querySelector('b')!.classList.contains('vc-loading')];
    open();
    await p;
    expect(during).toEqual([true, true]);
  });

  it('in production the missing-store warning is not written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('__VC_DEV__', false);
    vi.resetModules();
    try {
      const fresh = await import('../src/page-bindings');
      const bus = createCommandBus();
      fresh.bindDisplay(page('<span data-vc-text="nowhere.count">server</span>'), { bus });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('data-vc-pending', () => {
  it('sets vc-loading while the action is in flight on the bus, from any caller', async () => {
    const bus = createAsyncCommandBus();
    let open!: () => void;
    bus.register('cartSave', () => new Promise<void>((r) => { open = r; }));
    const root = page(`<span data-vc-pending="cartSave" data-vc-target='{"id":1}'>saving</span><span data-vc-pending="cartSave" data-vc-target='{"id":2}'>other</span>`);
    bindDisplay(root, { bus });
    const [one, two] = root.querySelectorAll('span');
    const p = bus.dispatch('cartSave', { id: 1 });
    await settle();
    const during = [one.classList.contains('vc-loading'), two.classList.contains('vc-loading')];
    open();
    await p;
    await settle();
    expect({ during, after: one.classList.contains('vc-loading') }).toEqual({ during: [true, false], after: false });
  });

  it('control: unbound, nothing follows the bus', async () => {
    const bus = createAsyncCommandBus();
    bus.register('cartSave', async () => {});
    const root = page('<span data-vc-pending="cartSave">saving</span>');
    bindDisplay(root, { bus })();
    const p = bus.dispatch('cartSave', undefined);
    await settle();
    const during = root.querySelector('span')!.classList.contains('vc-loading');
    await p;
    expect(during).toBe(false);
  });
});

// Plan 1.32 4.5: display bindings on a store's field events, no second reactivity system.
// A path is `<store id>.<field>[.<more>]`: the store comes from the bus's registry, one
// `$onField` subscription per element, the rest of the path read from the field's value.
// The store is the truth, so a bound element renders at bind time and on each write.
// `data-vc-show` shows a truthy value that is not an empty array. `data-vc-each` clones
// its `<template>` per entry, and a row's paths read its item (exo-astro's rule).
// `data-vc-pending` sets the `vc-loading` class the command binding sets, from the bus's
// command state (step 5), so the owner's CSS recipe for a delayed busy display works on
// both. Each path segment is an own property: `constructor` reads nothing (src/dict.ts).
