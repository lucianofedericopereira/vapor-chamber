// @vitest-environment happy-dom
/**
 * examples/exo-astro/src/directives — the declarative directive scanner the
 * Astro example ships (and that the README tells readers to copy into their
 * own project). It is example code, but it is *published* example code, so it
 * gets the same treatment as the library: the contract is pinned by tests.
 *
 * Covered here: the four directives, scope resolution (local vs. atmosphere),
 * scan idempotence across a client-side page swap, and the example's headline
 * claim — clicks dispatched before handlers hydrate are replayed in order.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  reactive,
  addEffect,
  busState,
  scan,
  scopeOf,
  mountExo,
} from '../../examples/exo-astro/src/directives/index';
import { createCommandBus } from '../../src/command-bus';

/** busState is a module singleton — wipe it between tests. */
function resetBusState(): void {
  for (const key of Object.keys(busState)) delete busState[key];
}

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<div id="root">${html}</div>`;
  return document.getElementById('root') as HTMLElement;
}

const $ = (root: ParentNode, sel: string) => root.querySelector(sel) as HTMLElement;

beforeEach(() => {
  resetBusState();
  document.body.innerHTML = '';
});

describe('reactive + addEffect', () => {
  it('runs the effect immediately and again on every mutation', () => {
    const state = reactive<Record<string, any>>({ n: 1 });
    const seen: number[] = [];
    addEffect(state, () => seen.push(state.n));

    expect(seen).toEqual([1]);
    state.n = 2;
    state.n = 3;
    expect(seen).toEqual([1, 2, 3]);
  });

  it('re-runs every effect of the object — a flat set, no dependency graph', () => {
    const state = reactive<Record<string, any>>({ a: 0, b: 0 });
    const hits: string[] = [];
    addEffect(state, () => hits.push('one'));
    addEffect(state, () => hits.push('two'));
    hits.length = 0;

    state.a = 1; // touches `a` only — both effects still re-run, by design
    expect(hits).toEqual(['one', 'two']);
  });

  it('addEffect on a plain (non-reactive) object still runs once, never again', () => {
    const plain: Record<string, any> = { n: 1 };
    const seen: number[] = [];
    addEffect(plain, () => seen.push(plain.n));
    plain.n = 2;
    expect(seen).toEqual([1]);
  });

  it('nested writes re-run the root effects — what keeps dot-path bindings live', () => {
    const state = reactive<Record<string, any>>({ cart: { count: 0, tags: ['new'] } });
    const seen: number[] = [];
    addEffect(state, () => seen.push(state.cart.count));

    state.cart.count = 2; // one level down
    state.cart.tags.push('sale'); // and inside an array
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen[1]).toBe(2);
  });

  it('objects assigned after construction become reactive too', () => {
    const state = reactive<Record<string, any>>({});
    const seen: any[] = [];
    addEffect(state, () => seen.push(state.cart?.count));

    state.cart = { count: 1 }; // plain object in…
    seen.length = 0;
    state.cart.count = 4; // …reactive out
    expect(seen).toEqual([4]);
  });

  it('leaves exotic values alone — a Date/Map is stored, never proxied', () => {
    const when = new Date(0);
    const state = reactive<Record<string, any>>({ when });
    expect(state.when).toBe(when);
    expect(() => state.when.getTime()).not.toThrow();
  });

  it('survives a cyclic object graph', () => {
    const cyclic: any = { n: 1 };
    cyclic.self = cyclic;
    expect(() => reactive(cyclic)).not.toThrow();
  });
});

describe('v-bind-text', () => {
  it('renders the initial value and tracks mutations through a dot-path', () => {
    busState.cart = { count: 0 };
    const root = mount('<strong v-bind-text="cart.count"></strong>');
    scan(createCommandBus(), root);

    expect($(root, 'strong').textContent).toBe('0');
    busState.cart.count = 7;
    expect($(root, 'strong').textContent).toBe('7');
  });

  it('renders an empty string for null/undefined instead of "undefined"', () => {
    busState.missing = null;
    const root = mount('<span v-bind-text="missing"></span><b v-bind-text="nope.deep"></b>');
    scan(createCommandBus(), root);

    expect($(root, 'span').textContent).toBe('');
    expect($(root, 'b').textContent).toBe('');
  });
});

describe('v-show', () => {
  it('toggles display on truthiness of the bound path', () => {
    busState.empty = true;
    const root = mount('<p v-show="empty">nothing here</p>');
    scan(createCommandBus(), root);

    expect($(root, 'p').style.display).toBe('');
    busState.empty = false;
    expect($(root, 'p').style.display).toBe('none');
  });
});

describe('v-command', () => {
  it('dispatches the named command with v-target and v-payload as JSON', () => {
    const bus = createCommandBus();
    const seen: Array<{ target: any; payload: any }> = [];
    bus.register('cart.add', (cmd) => { seen.push({ target: cmd.target, payload: cmd.payload }); });

    const root = mount(
      `<button v-command="cart.add" v-target='{"name":"Tea","price":3}' v-payload='{"qty":2}'>Add</button>`,
    );
    scan(bus, root);
    $(root, 'button').click();

    expect(seen).toEqual([{ target: { name: 'Tea', price: 3 }, payload: { qty: 2 } }]);
  });

  it('defaults target to {} and payload to undefined when the attrs are absent', () => {
    const bus = createCommandBus();
    const seen: Array<{ target: any; payload: any }> = [];
    bus.register('cart.clear', (cmd) => { seen.push({ target: cmd.target, payload: cmd.payload }); });

    const root = mount('<button v-command="cart.clear">Clear</button>');
    scan(bus, root);
    $(root, 'button').click();

    expect(seen).toEqual([{ target: {}, payload: undefined }]);
  });

  it('treats malformed JSON as absent rather than throwing at click time', () => {
    const bus = createCommandBus();
    const seen: any[] = [];
    bus.register('x', (cmd) => { seen.push(cmd.target); });

    const root = mount(`<button v-command="x" v-target="{oops">go</button>`);
    scan(bus, root);
    expect(() => $(root, 'button').click()).not.toThrow();
    expect(seen).toEqual([{}]);
  });
});

describe('v-scope', () => {
  it('reads local state from the nearest scope that declared the key', () => {
    const root = mount(`
      <div v-scope='{"open":false}'>
        <span v-bind-text="open"></span>
      </div>
    `);
    scan(createCommandBus(), root);

    expect($(root, 'span').textContent).toBe('false');
    scopeOf($(root, 'div')).open = true;
    expect($(root, 'span').textContent).toBe('true');
  });

  it('falls through to busState for a key the scope never declared', () => {
    busState.cartCount = 2;
    const root = mount(`
      <div v-scope='{"open":true}'>
        <span v-bind-text="cartCount"></span>
      </div>
    `);
    scan(createCommandBus(), root);

    // Mixed subtree: `open` is local, `cartCount` comes from the atmosphere.
    expect($(root, 'span').textContent).toBe('2');
    busState.cartCount = 5;
    expect($(root, 'span').textContent).toBe('5');
  });

  it('resolves the nearest declaring ancestor when scopes nest', () => {
    const root = mount(`
      <div v-scope='{"label":"outer","only":"outer"}'>
        <div id="inner" v-scope='{"label":"inner"}'>
          <span id="near" v-bind-text="label"></span>
          <span id="far" v-bind-text="only"></span>
        </div>
      </div>
    `);
    scan(createCommandBus(), root);

    expect($(root, '#near').textContent).toBe('inner');
    expect($(root, '#far').textContent).toBe('outer'); // inner never declared `only`
  });

  it('treats malformed v-scope JSON as an empty scope', () => {
    busState.n = 9;
    const root = mount(`<div v-scope="{nope"><span v-bind-text="n"></span></div>`);
    scan(createCommandBus(), root);

    expect(scopeOf($(root, 'div'))).toEqual({});
    expect($(root, 'span').textContent).toBe('9'); // nothing declared ⇒ atmosphere
  });

  it('a bus handler writes local scope state through scopeOf — the click site never does', () => {
    const bus = createCommandBus();
    const root = mount(`
      <div id="panel" v-scope='{"open":false}'>
        <button v-command="ui.toggle">Details</button>
        <div id="body" v-show="open">details</div>
      </div>
    `);
    scan(bus, root);
    const panel = $(root, '#panel');
    bus.register('ui.toggle', () => { scopeOf(panel).open = !scopeOf(panel).open; });

    expect($(root, '#body').style.display).toBe('none');
    $(root, 'button').click();
    expect($(root, '#body').style.display).toBe('');
  });
});

describe('v-each', () => {
  // Prototype-as-first-child form — the one that survives every table parser.
  const list = `
    <table><tbody v-each="items">
      <tr><td v-bind-text="name"></td><td v-bind-text="price"></td></tr>
    </tbody></table>
  `;
  const rows = (root: ParentNode) =>
    Array.from(root.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent),
    );

  it('renders one scoped clone per entry and re-renders on mutation', () => {
    busState.items = [{ name: 'Tea', price: '$3.00' }];
    const root = mount(list);
    scan(createCommandBus(), root);

    expect(rows(root)).toEqual([['Tea', '$3.00']]);

    busState.items.push({ name: 'Coffee', price: '$4.00' });
    expect(rows(root)).toEqual([
      ['Tea', '$3.00'],
      ['Coffee', '$4.00'],
    ]);

    busState.items = []; // whole-array replacement
    expect(rows(root)).toEqual([]);
  });

  it('detaches a first-child prototype so it can never render as a row', () => {
    busState.items = [{ name: 'Tea', price: '$3.00' }];
    const root = mount(list);
    scan(createCommandBus(), root);

    expect(rows(root)).toHaveLength(1); // the prototype itself is not a row

    busState.items = [];
    expect(rows(root)).toEqual([]); // and it is gone, not left behind blank
  });

  it('uses a <template> child as the prototype when one is present', () => {
    busState.items = [{ name: 'Tea' }, { name: 'Coffee' }];
    const root = mount(`
      <ul v-each="items"><template><li v-bind-text="name"></li></template></ul>
    `);
    scan(createCommandBus(), root);

    expect(Array.from(root.querySelectorAll('li')).map((li) => li.textContent)).toEqual([
      'Tea',
      'Coffee',
    ]);
    expect(root.querySelector('template')).not.toBeNull(); // kept, inert
  });

  it('a row reads its own item, not a sibling — scope is per clone', () => {
    busState.items = [{ name: 'A', price: '$1.00' }, { name: 'B', price: '$2.00' }];
    const root = mount(list);
    scan(createCommandBus(), root);

    expect(rows(root)).toEqual([
      ['A', '$1.00'],
      ['B', '$2.00'],
    ]);
  });

  it('falls through to the enclosing scope for keys the item lacks', () => {
    busState.currency = 'USD';
    busState.items = [{ name: 'Tea' }];
    const root = mount(`<ul v-each="items"><li v-bind-text="currency"></li></ul>`);
    scan(createCommandBus(), root);

    expect($(root, 'li').textContent).toBe('USD');
  });

  it('renders nothing (and does not throw) for a missing or non-array path', () => {
    const root = mount(list);
    expect(() => scan(createCommandBus(), root)).not.toThrow();
    expect(rows(root)).toEqual([]);

    busState.items = 'not an array';
    expect(rows(root)).toEqual([]);
  });

  it('wires v-command inside a row, dispatching that row\'s data', () => {
    const bus = createCommandBus();
    const removed: any[] = [];
    bus.register('cart.remove', (cmd) => { removed.push(cmd.target); });
    busState.items = [{ name: 'Tea' }, { name: 'Coffee' }];

    const root = mount(`
      <ul v-each="items">
        <li><button v-command="cart.remove" v-target='{"row":1}'>x</button></li>
      </ul>
    `);
    scan(bus, root);
    Array.from(root.querySelectorAll('button')).at(-1)?.dispatchEvent(new Event('click'));

    expect(removed).toEqual([{ row: 1 }]);
  });

  it('re-renders when an existing row is mutated in place, not replaced', () => {
    // The aggregating-cart case: a repeat "Add" bumps qty on the row that is
    // already in the array. That write is one level deep — it only reaches the
    // bindings because reactivity is deep.
    busState.items = [{ name: 'Tea', price: '$3.00' }];
    const root = mount(list);
    scan(createCommandBus(), root);

    busState.items[0].price = '$6.00';
    expect(rows(root)).toEqual([['Tea', '$6.00']]);
  });

  it('re-scanning does not duplicate the list', () => {
    busState.items = [{ name: 'Tea', price: '$3.00' }];
    const root = mount(list);
    const bus = createCommandBus();
    scan(bus, root);
    scan(bus, root);

    expect(rows(root)).toEqual([['Tea', '$3.00']]);
  });
});

describe('scan idempotence (client-side page swaps)', () => {
  it('re-scanning does not double-bind clicks or stack duplicate effects', () => {
    const bus = createCommandBus();
    const dispatches: any[] = [];
    bus.register('cart.add', (cmd) => { dispatches.push(cmd.target); });
    busState.count = 0;

    const root = mount(`
      <button v-command="cart.add" v-target='{"name":"Tea"}'>Add</button>
      <span v-bind-text="count"></span>
    `);
    scan(bus, root);

    let renders = 0;
    addEffect(busState, () => { renders++; });
    renders = 0;

    scan(bus, root); // e.g. astro:page-load fires again
    scan(bus, root);

    $(root, 'button').click();
    expect(dispatches).toHaveLength(1); // one listener, not three

    busState.count = 1;
    expect(renders).toBe(1); // one text effect + this counter would be 2 if stacked
    expect($(root, 'span').textContent).toBe('1');
  });

  it('keeps live scope state across a re-scan instead of resetting it to the JSON', () => {
    const root = mount(`<div v-scope='{"open":false}'><span v-bind-text="open"></span></div>`);
    scan(createCommandBus(), root);
    scopeOf($(root, 'div')).open = true;

    scan(createCommandBus(), root);

    expect(scopeOf($(root, 'div')).open).toBe(true);
    expect($(root, 'span').textContent).toBe('true');
  });
});

describe('the headline: dispatch before hydration', () => {
  it('buffers clicks made before handlers register and replays them in order', () => {
    const bus = createCommandBus({ onMissing: 'buffer', bufferTTL: 30_000 });
    const root = mount(`
      <button id="tea" v-command="cart.add" v-target='{"name":"Tea"}'>Add</button>
      <button id="espresso" v-command="cart.add" v-target='{"name":"Espresso"}'>Add</button>
    `);
    scan(bus, root);

    // Nothing is registered yet — this is the first 2s of the demo page.
    $(root, '#tea').click();
    $(root, '#espresso').click();
    $(root, '#tea').click();

    const added: string[] = [];
    bus.register('cart.add', (cmd) => { added.push((cmd.target as { name: string }).name); });

    expect(added).toEqual(['Tea', 'Espresso', 'Tea']); // FIFO, nothing lost
  });

  it('reports drops through onBufferOverflow once bufferTTL has elapsed', () => {
    vi.useFakeTimers();
    try {
      const dropped: string[] = [];
      const bus = createCommandBus({
        onMissing: 'buffer',
        bufferTTL: 1000,
        onBufferOverflow: (action) => { dropped.push(action); },
      });
      const root = mount(`<button v-command="cart.add" v-target='{"name":"Tea"}'>Add</button>`);
      scan(bus, root);
      $(root, 'button').click();

      vi.advanceTimersByTime(5000); // the section never hydrated

      const added: string[] = [];
      bus.register('cart.add', (cmd) => { added.push((cmd.target as { name: string }).name); });

      expect(added).toEqual([]); // stale click reaped, not replayed
      expect(dropped).toEqual(['cart.add']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mountExo', () => {
  it('scans immediately when the document is already interactive', () => {
    const bus = createCommandBus();
    const seen: any[] = [];
    bus.register('go', (cmd) => { seen.push(cmd.target); });
    const root = mount('<button v-command="go">go</button>');

    const state = mountExo(bus, root);
    $(root, 'button').click();

    expect(seen).toHaveLength(1);
    expect(state).toBe(busState);
  });

  it('defers the scan to DOMContentLoaded while the document is still loading', () => {
    const bus = createCommandBus();
    const seen: any[] = [];
    bus.register('go', (cmd) => { seen.push(cmd.target); });
    const root = mount('<button v-command="go">go</button>');

    const readyState = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    mountExo(bus, root);
    readyState.mockRestore();

    $(root, 'button').click();
    expect(seen).toHaveLength(0); // not wired yet

    document.dispatchEvent(new Event('DOMContentLoaded'));
    $(root, 'button').click();
    expect(seen).toHaveLength(1);
  });
});
