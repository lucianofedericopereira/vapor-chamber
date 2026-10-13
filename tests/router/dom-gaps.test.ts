// @vitest-environment happy-dom
/**
 * Supplemental coverage for src/router/dom.ts.
 *
 *  - links the click handler does not take: no href, an href that does
 *    not parse, no link at all (real clicks, through composedPath), and
 *    an SVG link left unstamped.
 *  - a hover cancel with nothing armed.
 *  - preheatIdle's early-return arms: no factories, Save-Data,
 *    and 2g connections.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomIntegration, preheatIdle, stampActiveLinks } from '@router/dom';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.innerHTML = '';
});

function install(overrides: Partial<Parameters<typeof installDomIntegration>[0]> = {}) {
  const listeners = new Map<string, EventListener>();
  const spy = vi.spyOn(document, 'addEventListener');
  spy.mockImplementation(((type: string, cb: EventListener) => { listeners.set(type, cb); }) as any);
  const navigate = vi.fn();
  const teardown = installDomIntegration({
    base: '',
    canHandle: () => true,
    navigate,
    ...overrides,
  } as any);
  spy.mockRestore();
  cleanups.push(teardown);
  return { navigate, listeners };
}

/**
 * A real click dispatched on `target`, through the listener installed on the
 * document: true when the router took it. Read on the window, after the
 * document, which then cancels happy-dom's own link navigation: a navigation
 * left running moves `location` for the tests after it.
 */
function click(target: Element): boolean {
  let taken = false;
  const read = (e: Event) => {
    taken = e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener('click', read, { once: true });
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  return taken;
}

/** The integration on the real document, so a click carries its composed path. */
function installLive() {
  const navigate = vi.fn();
  cleanups.push(installDomIntegration({ base: '', canHandle: () => true, navigate }));
  return navigate;
}

describe('links the click handler does not take', () => {
  it('an anchor with no href', () => {
    const navigate = installLive();
    document.body.innerHTML = '<a id="bare"><span id="inner">no href</span></a>';

    expect(click(document.getElementById('inner')!)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('an anchor whose href cannot parse as a URL', () => {
    const navigate = installLive();
    document.body.innerHTML = '<a id="bad">broken</a>';
    const anchor = document.getElementById('bad') as HTMLAnchorElement;
    // `http://[` is an unparsable URL; a browser's `href` getter returns the
    // raw attribute when it cannot parse it, which this shadow hands over.
    Object.defineProperty(anchor, 'href', { value: 'http://[', configurable: true });

    expect(click(anchor)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('a click on no link at all', () => {
    const navigate = installLive();
    document.body.innerHTML = '<div id="plain">not a link</div>';

    expect(click(document.getElementById('plain')!)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  // `a[href]` matches an SVG <a> too, whose `href` is an SVGAnimatedString in
  // a browser (undefined in happy-dom): not a URL, so not the router's.
  it('an SVG link is never stamped active', () => {
    document.body.innerHTML = '<a id="html" href="/shop">shop</a><svg><a id="svg" href="/shop"><text>shop</text></a></svg>';
    stampActiveLinks('', '/shop');
    const marks = (id: string) => ['data-active', 'data-exact-active', 'aria-current'].map((n) => document.getElementById(id)!.hasAttribute(n));
    expect([marks('html'), marks('svg')]).toEqual([[true, true, true], [false, false, false]]);
  });

  it('control: a link around the clicked element is taken', () => {
    const navigate = installLive();
    document.body.innerHTML = '<a href="/shop"><span id="inner">shop</span></a>';

    expect(click(document.getElementById('inner')!)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/shop', false);
  });
});

describe('hover preheat cancel', () => {
  it('a cancel with nothing armed is a no-op', () => {
    const preheat = vi.fn();
    const { listeners } = install({ preheat });

    // No mouseover happened - the timer slot is empty.
    expect(() => listeners.get('mouseout')!(new MouseEvent('mouseout'))).not.toThrow();
    expect(preheat).not.toHaveBeenCalled();
  });
});

describe('preheatIdle early returns', () => {
  it('returns an inert cancel for an empty factory list', () => {
    const cancel = preheatIdle([]);
    expect(cancel).toBeTypeOf('function');
    expect(() => cancel()).not.toThrow();
  });

  it('skips preheating when Save-Data is on', () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    try {
      const factory = vi.fn(() => Promise.resolve());
      const cancel = preheatIdle([factory]);
      cancel();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      delete (navigator as any).connection;
    }
  });

  it('skips preheating on 2g connections', () => {
    Object.defineProperty(navigator, 'connection', { value: { effectiveType: 'slow-2g' }, configurable: true });
    try {
      const factory = vi.fn(() => Promise.resolve());
      const cancel = preheatIdle([factory]);
      cancel();
      expect(factory).not.toHaveBeenCalled();
    } finally {
      delete (navigator as any).connection;
    }
  });

  // The router RE-ARMS this on every bfcache restore (`armIdlePreheat` in
  // src/router/index.ts), cancelling the previous run first, so a cancel that
  // leaves its own listeners attached would grow them by one set per bfcache
  // restore.
  it('cancel() detaches the abort listeners it attached', () => {
    const added: string[] = [];
    const removed: string[] = [];
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    addSpy.mockImplementation(((type: string) => { added.push(type); }) as never);
    removeSpy.mockImplementation(((type: string) => { removed.push(type); }) as never);

    const cancel = preheatIdle([() => Promise.resolve()]);
    const ABORT_EVENTS = ['scroll', 'click', 'keydown', 'pointerdown'];
    expect(added.filter((t) => ABORT_EVENTS.includes(t)).sort()).toEqual([...ABORT_EVENTS].sort());

    cancel();

    // `{ once: true }` only removes the ONE listener that actually fires. A user
    // who never scrolls or clicks leaves all four attached for the life of the
    // page, once per arming.
    expect(removed.filter((t) => ABORT_EVENTS.includes(t)).sort()).toEqual([...ABORT_EVENTS].sort());
  });
});
