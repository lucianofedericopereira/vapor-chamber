// @vitest-environment happy-dom
/**
 * Supplemental coverage for src/router/dom.ts.
 *
 *  - routableTarget: empty/invalid hrefs (45, 49-50) — reached through the
 *    non-composedPath ancestor walk (82-84), which requires an event without
 *    composedPath (older browsers; simulated by shadowing the method).
 *  - onMouseout with no pending hover timer (117).
 *  - preheatIdle's early-return arms: no factories (175), Save-Data (178),
 *    and 2g connections (179).
 *
 * onMouseover's `!preheat` guard (108) is NOT tested here: the mouseover
 * listener is only attached when `preheat` is set (128-129), so the guard is
 * unreachable through installDomIntegration — defensive only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomIntegration, preheatIdle } from '../../src/router/dom';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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
 * Click without composedPath — forces the ancestor walk (82-84). happy-dom's
 * own dispatcher requires composedPath, so the captured listener is invoked
 * directly with a synthetic event, the way a legacy browser would deliver it.
 */
function legacyClick(listeners: Map<string, EventListener>, target: Element) {
  const event = {
    defaultPrevented: false,
    button: 0,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: undefined,
    target,
    preventDefault() { this.defaultPrevented = true; },
  };
  listeners.get('click')!(event as unknown as Event);
  return event;
}

describe('ancestor-walk fallback + routableTarget rejects', () => {
  it('walks up to the anchor when composedPath is unavailable (82-84)', () => {
    const { navigate, listeners } = install();
    document.body.innerHTML = '<a href="/shop"><span id="inner">shop</span></a>';

    const event = legacyClick(listeners, document.getElementById('inner')!);
    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/shop', false);
  });

  it('ignores an anchor with an empty href (45)', () => {
    const { navigate, listeners } = install();
    document.body.innerHTML = '<a id="bare"><span id="inner">no href</span></a>';

    const event = legacyClick(listeners, document.getElementById('inner')!);
    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores an anchor whose href cannot parse as a URL (49-50)', () => {
    const { navigate, listeners } = install();
    document.body.innerHTML = '<a id="bad">broken</a>';
    const anchor = document.getElementById('bad') as HTMLAnchorElement;
    // `http://[` is an unparsable URL; shadow the resolved-href accessor to
    // hand routableTarget the raw string the way a broken resolver would.
    Object.defineProperty(anchor, 'href', { value: 'http://[', configurable: true });

    const event = legacyClick(listeners, anchor);
    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('gives up when the walk reaches the root without an anchor (86)', () => {
    const { navigate, listeners } = install();
    document.body.innerHTML = '<div id="plain">not a link</div>';

    const event = legacyClick(listeners, document.getElementById('plain')!);
    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('hover preheat teardown', () => {
  it('onMouseout without a pending hover timer is a no-op (117)', () => {
    const preheat = vi.fn();
    const { listeners } = install({ preheat });

    // No mouseover happened — the timer slot is empty.
    expect(() => listeners.get('mouseout')!(new MouseEvent('mouseout'))).not.toThrow();
    expect(preheat).not.toHaveBeenCalled();
  });
});

describe('preheatIdle early returns', () => {
  it('returns an inert cancel for an empty factory list (175)', () => {
    const cancel = preheatIdle([]);
    expect(cancel).toBeTypeOf('function');
    expect(() => cancel()).not.toThrow();
  });

  it('skips preheating when Save-Data is on (178)', () => {
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

  it('skips preheating on 2g connections (179)', () => {
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
});
