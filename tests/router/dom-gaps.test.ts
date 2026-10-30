// @vitest-environment happy-dom
/**
 * Edge arms of src/router/dom.ts: untaken links, hover cancel, preheatIdle early returns.
 * Why: a click on a non-router link would be hijacked, preheat would spend data on Save-Data or 2g
 * connections, and abort listeners would pile up on every bfcache re-arm. Also the only file reaching a link with
 * no string href and preheatIdle's inert cancels, so the 100% floor needs it.
 * Shows: a click on a link with no href, an unparsable href or no link is not taken and navigate
 * is not called; an SVG link is not stamped; a hover cancel with nothing armed does not throw;
 * preheatIdle skips its factories on Save-Data and slow-2g and cancel() removes the four abort listeners.
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
 * A real click on `target` through the installed document listener: true when the router took it.
 * Read on the window, which then cancels happy-dom's own navigation (it would move `location`).
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
    // A browser's `href` getter returns the raw attribute when it cannot parse it; `http://[` does not parse.
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

  // `a[href]` matches an SVG <a>, whose `href` is not a URL (SVGAnimatedString in a browser).
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

  // The router re-arms on every bfcache restore after cancelling; a cancel that kept its listeners would grow them per restore.
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

    // `{ once: true }` removes only the listener that fires, so cancel must remove all four.
    expect(removed.filter((t) => ABORT_EVENTS.includes(t)).sort()).toEqual([...ABORT_EVENTS].sort());
  });
});
