// @vitest-environment happy-dom
// The command binding's edges in the node suite: keyboard, form controls, teardown, owners, DEV off (audit B4). Rationale at the end.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAnnouncer } from '../src/a11y';
import { bindCommands } from '../src/command-binding';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { resetCommandBus, setCommandBus } from '../src/chamber';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';

const settle = () => new Promise((r) => setTimeout(r, 0));

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

/** A sync bus whose `act` counts its runs. */
function counted() {
  const bus = createCommandBus();
  let runs = 0;
  bus.register('act', () => ++runs);
  return { bus, runs: () => runs };
}

const key = (el: Element, type: 'keydown' | 'keyup', k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...init }));

afterEach(() => {
  document.body.innerHTML = '';
  setAnnouncer(null);
  resetCommandBus();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a role="button" element gets a button\'s keyboard', () => {
  it('Enter presses on key down, a repeat does not; Space presses on key up after its own key down', () => {
    const { bus, runs } = counted();
    const root = page('<div role="button" data-vc-command="act">Go</div>');
    bindCommands(root, { bus });
    const el = root.querySelector('div')!;
    expect(el.getAttribute('tabindex')).toBe('0');
    key(el, 'keydown', 'Enter');
    key(el, 'keydown', 'Enter', { repeat: true });
    expect(runs()).toBe(1);
    key(el, 'keyup', ' ');
    expect(runs()).toBe(1);
    key(el, 'keydown', ' ');
    expect(runs()).toBe(1);
    key(el, 'keyup', ' ');
    expect(runs()).toBe(2);
    // Another key, down or up, presses nothing.
    key(el, 'keydown', 'a');
    key(el, 'keyup', 'Enter');
    expect(runs()).toBe(2);
  });

  it('a key the app handled, or one from an element inside, is left alone', () => {
    const { bus, runs } = counted();
    const root = page('<div role="button" data-vc-command="act"><span>x</span></div>');
    bindCommands(root, { bus });
    const el = root.querySelector('div')!;
    key(root.querySelector('span')!, 'keydown', 'Enter');
    const handled = (event: Event) => event.preventDefault();
    root.addEventListener('keydown', handled, true);
    key(el, 'keydown', 'Enter');
    root.removeEventListener('keydown', handled, true);
    key(el, 'keydown', ' ');
    root.addEventListener('keyup', handled, true);
    key(el, 'keyup', ' ');
    expect(runs()).toBe(0);
  });

  it('unbind takes the keys and the added tabindex back; a tabindex the page set stays', () => {
    const { bus, runs } = counted();
    const root = page('<div id="a" role="button" data-vc-command="act"></div><div id="b" role="button" tabindex="-1" data-vc-command="act"></div>');
    const unbind = bindCommands(root, { bus });
    unbind();
    const a = root.querySelector('#a')!;
    key(a, 'keydown', 'Enter');
    expect({ a: a.getAttribute('tabindex'), b: root.querySelector('#b')!.getAttribute('tabindex'), runs: runs() }).toEqual({ a: null, b: '-1', runs: 0 });
  });

  it('a native control or a link with href keeps its own keyboard; a link without href or an SVG element as said', () => {
    const { bus } = counted();
    const root = page([
      '<button role="button" data-vc-command="act"></button>',
      '<input type="button" role="button" data-vc-command="act">',
      '<a href="#x" role="button" data-vc-command="act"></a>',
      '<details><summary role="button" data-vc-command="act"></summary></details>',
      '<a id="bare" role="button" data-vc-command="act"></a>',
      '<svg><g role="button" data-vc-command="act"></g></svg>',
    ].join(''));
    bindCommands(root, { bus });
    const tabbed = [...root.querySelectorAll('[data-vc-command]')].map((el) => el.getAttribute('tabindex'));
    expect(tabbed).toEqual([null, null, null, null, '0', null]);
  });

  it('with no HTMLElement global (no DOM classes), nothing is wired', () => {
    const { bus } = counted();
    const root = page('<div role="button" data-vc-command="act"></div>');
    vi.stubGlobal('HTMLElement', undefined);
    bindCommands(root, { bus });
    vi.unstubAllGlobals();
    expect(root.querySelector('div')!.hasAttribute('tabindex')).toBe(false);
  });
});

describe('form controls', () => {
  it('a select sends on change, its value as the payload', () => {
    const bus = createCommandBus();
    const seen: unknown[] = [];
    bus.register('pick', (cmd) => seen.push(cmd.payload));
    const root = page('<select data-vc-command="pick"><option value="a">a</option><option value="b">b</option></select>');
    bindCommands(root, { bus });
    const select = root.querySelector('select')!;
    select.value = 'b';
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(seen).toEqual(['b']);
  });

  it('a textarea sends on input, its value as the payload', () => {
    const bus = createCommandBus();
    const seen: unknown[] = [];
    bus.register('note', (cmd) => seen.push(cmd.payload));
    const root = page('<textarea data-vc-command="note"></textarea>');
    bindCommands(root, { bus });
    const area = root.querySelector('textarea')!;
    area.value = 'hi';
    area.dispatchEvent(new Event('change', { bubbles: true }));
    area.dispatchEvent(new Event('input', { bubbles: true }));
    expect(seen).toEqual(['hi']);
  });

  it('a compositionend with no composition before it sends nothing; unbind takes the composition listeners off', () => {
    const bus = createCommandBus();
    const seen: unknown[] = [];
    bus.register('type', (cmd) => seen.push(cmd.payload));
    const root = page('<input data-vc-command="type">');
    const unbind = bindCommands(root, { bus });
    const input = root.querySelector('input')!;
    input.dispatchEvent(new Event('compositionend'));
    expect(seen).toEqual([]);
    unbind();
    input.dispatchEvent(new Event('compositionstart'));
    input.value = 'x';
    input.dispatchEvent(new Event('compositionend'));
    input.dispatchEvent(new Event('input'));
    expect(seen).toEqual([]);
  });
});

describe('a press', () => {
  it('restores an aria-disabled the page set once the dispatch lands', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let finish!: () => void;
    bus.register('save', () => new Promise<void>((r) => { finish = r; }));
    const root = page('<button aria-disabled="false" data-vc-command="save"></button>');
    bindCommands(root, { bus });
    const button = root.querySelector('button')!;
    button.click();
    const during = button.getAttribute('aria-disabled');
    finish();
    await settle();
    expect([during, button.getAttribute('aria-disabled')]).toEqual(['true', 'false']);
  });

  it('a failure with an empty message sets vc-error and announces nothing; control: a message is announced', async () => {
    const said: string[] = [];
    setAnnouncer((message) => said.push(message));
    const bus = createCommandBus();
    bus.register('quiet', () => { throw new Error(''); });
    bus.register('loud', () => { throw new Error('No stock'); });
    const root = page('<button id="q" data-vc-command="quiet"></button><button id="l" data-vc-command="loud"></button>');
    bindCommands(root, { bus });
    (root.querySelector('#q') as HTMLButtonElement).click();
    (root.querySelector('#l') as HTMLButtonElement).click();
    await settle();
    expect({ error: root.querySelector('#q')!.classList.contains('vc-error'), said }).toEqual({ error: true, said: ['No stock'] });
  });

  it('a press its pace refuses takes its optimistic change back', async () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('save', () => ++runs);
    setCommandBus(bus);
    const dirs = new Map<string, any>();
    createDirectivePlugin().install({ directive: (n: string, d: any) => dirs.set(n, d) });
    const button = document.createElement('button');
    button.setAttribute('data-vc-throttle', '60000');
    document.body.append(button);
    let undone = 0;
    dirs.get('vc-optimistic').mounted(button, { value: () => () => { undone++; } });
    dirs.get('vc-command').mounted(button, { value: 'save', modifiers: {} });
    button.click();
    await settle();
    button.click();
    await settle();
    expect({ runs, undone }).toEqual({ runs: 1, undone: 1 });
  });
});

describe('owners', () => {
  it("an unbind leaves an element another call bound later, and one already unbound", () => {
    const a = counted();
    const b = counted();
    const root = page('<button data-vc-command="act"></button>');
    const unbindA = bindCommands(root, { bus: a.bus });
    const unbindB = bindCommands(root, { bus: b.bus });
    unbindA();
    root.querySelector('button')!.click();
    expect([a.runs(), b.runs()]).toEqual([0, 1]);
    const unbindC = bindCommands(root, { bus: a.bus });
    unbindC();
    unbindB();
    root.querySelector('button')!.click();
    expect([a.runs(), b.runs()]).toEqual([0, 1]);
  });
});

describe('the Vapor directive with no value (`<button v-vc-command>`)', () => {
  it('mounts nothing and warns in development; a press dispatches nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus, runs } = counted();
    setCommandBus(bus);
    const button = document.createElement('button');
    document.body.append(button);
    const teardown = vcCommandVapor(button, undefined);
    button.click();
    expect({ teardown, runs: runs(), warned: warn.mock.calls.length }).toEqual({ teardown: undefined, runs: 0, warned: 1 });
  });

  it('control: with a value it mounts, and its teardown detaches', () => {
    const { bus, runs } = counted();
    setCommandBus(bus);
    const button = document.createElement('button');
    document.body.append(button);
    const teardown = vcCommandVapor(button, () => 'act');
    button.click();
    teardown!();
    button.click();
    expect(runs()).toBe(1);
  });
});

describe('DEV off', () => {
  it('the Vapor directive with no value warns nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    vi.stubGlobal('__VC_DEV__', false);
    const prod = await import('../src/directives');
    prod.vcCommandVapor(document.createElement('button'), undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a press with no action warns nothing; control: in development it warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { bus } = counted();
    const root = page('<button id="d" data-vc-command=""></button>');
    bindCommands(root, { bus });
    (root.querySelector('#d') as HTMLButtonElement).click();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.resetModules();
    vi.stubGlobal('__VC_DEV__', false);
    const prod = await import('../src/command-binding');
    const prodBus = (await import('../src/command-bus')).createCommandBus();
    const quiet = page('<button id="p" data-vc-command=""></button>');
    prod.bindCommands(quiet, { bus: prodBus });
    (quiet.querySelector('#p') as HTMLButtonElement).click();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/*
 * src/command-binding.ts was excluded from coverage by the directives.ts ruling that moved
 * with the code in 1.32 step 6b: its keyboard and delegation paths ran only in the browser
 * suite (tests/browser/*), which the v8 gate does not count. Audit B4 brings it under the
 * gate, 100 on all four axes, with no exclusion.
 *
 * These cases reach in happy-dom what the browser suite proves in real Chromium: the
 * keyboard of a role="button" element (WCAG 2.1.1, the ARIA button pattern), the
 * controls that keep their own keyboard, a select's change, a stray compositionend,
 * teardown, an aria-disabled the page set, a failure with no message, a paced refusal
 * with an optimistic change, and an unbind that leaves another owner's binding.
 *
 * The guards no API reaches became the invariants they stood for: teardown reads the
 * delegated document it recorded, the delegated count is there while an element is
 * mounted, a failed CommandResult carries its error, the handler slot holds a function
 * from the literal on, and `_mountAttribute` passes no action because the press reads it.
 */
