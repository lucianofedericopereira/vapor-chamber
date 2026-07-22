// @vitest-environment happy-dom
/**
 * Tests for src/dom.ts — installDomIntegration / stampActiveLinks.
 *
 * dom.ts is otherwise excluded from this project's node-environment vitest
 * run (see vitest.config.ts) and was, until now, covered only by a browser
 * playground that doesn't exist in this checkout. This file closes that gap
 * for the click-interception/active-stamping core and — the reason it was
 * added — the bfcache (`pageshow`/`persisted`) restore wiring, which had no
 * verification at all beyond code review.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomIntegration, preheatIdle, stampActiveLinks } from '../../src/router/dom';

function clickAnchor(anchor: HTMLAnchorElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  anchor.dispatchEvent(event);
  return event;
}

function pageshow(persisted: boolean): void {
  const event = new Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
}

afterEach(() => {
  document.body.innerHTML = '';
  // The cross-origin/external-target click tests dispatch a real click on an
  // anchor that dom.ts deliberately never preventDefault()s — happy-dom then
  // follows it for real, mutating window.location (and so window.location.origin)
  // for every test that runs after. Reset it so later tests' own origin-based
  // routability checks aren't polluted by an earlier test's "let the browser
  // handle it" case.
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL('http://localhost:3000/');
});

describe('installDomIntegration — click interception', () => {
  it('intercepts an in-base link and calls navigate', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({
      base: '/admin',
      canHandle: () => true,
      navigate,
    });

    const event = clickAnchor(anchor);

    expect(navigate).toHaveBeenCalledWith('/products', false);
    expect(event.defaultPrevented).toBe(true);
    teardown();
  });

  it('passes data-replace through as the replace flag', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    anchor.setAttribute('data-replace', '');
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    clickAnchor(anchor);

    expect(navigate).toHaveBeenCalledWith('/products', true);
    teardown();
  });

  it('ignores canHandle()-rejected paths (falls through to a real navigation)', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/unmatched';
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => false, navigate });

    const event = clickAnchor(anchor);

    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    teardown();
  });

  it.each([
    ['download', (a: HTMLAnchorElement) => a.setAttribute('download', '')],
    ['data-native', (a: HTMLAnchorElement) => a.setAttribute('data-native', '')],
    ['rel=external', (a: HTMLAnchorElement) => a.setAttribute('rel', 'external')],
    ['target=_blank', (a: HTMLAnchorElement) => a.setAttribute('target', '_blank')],
  ])('bails out on %s', (_label, apply) => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    apply(anchor);
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    clickAnchor(anchor);

    expect(navigate).not.toHaveBeenCalled();
    teardown();
  });

  it('bails out on a modifier-key click', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    clickAnchor(anchor, { ctrlKey: true });

    expect(navigate).not.toHaveBeenCalled();
    teardown();
  });

  it('ignores a cross-origin link', () => {
    const anchor = document.createElement('a');
    anchor.href = 'https://example.com/admin/products';
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    clickAnchor(anchor);

    expect(navigate).not.toHaveBeenCalled();
    teardown();
  });

  it('does nothing after teardown', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    document.body.appendChild(anchor);

    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });
    teardown();

    clickAnchor(anchor);

    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('installDomIntegration — hover preheat', () => {
  it('preheats the hovered link after the intent delay, cancels on mouseout', () => {
    vi.useFakeTimers();
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    document.body.appendChild(anchor);

    const preheat = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), preheat });

    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(50);
    anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    vi.advanceTimersByTime(100);

    expect(preheat).not.toHaveBeenCalled(); // cancelled before the 100ms delay elapsed

    anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    vi.advanceTimersByTime(100);

    expect(preheat).toHaveBeenCalledWith('/products');
    teardown();
    vi.useRealTimers();
  });
});

describe('installDomIntegration — bfcache restore (onRestore)', () => {
  it('calls onRestore when the page is restored from bfcache (pageshow, persisted)', () => {
    const onRestore = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), onRestore });

    pageshow(true);

    expect(onRestore).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('does NOT call onRestore on a normal pageshow (not persisted)', () => {
    const onRestore = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), onRestore });

    pageshow(false);

    expect(onRestore).not.toHaveBeenCalled();
    teardown();
  });

  it('stops listening for pageshow after teardown', () => {
    const onRestore = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), onRestore });
    teardown();

    pageshow(true);

    expect(onRestore).not.toHaveBeenCalled();
  });

  it('registers no pageshow listener at all when onRestore is not provided', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn() });

    expect(addSpy).not.toHaveBeenCalledWith('pageshow', expect.anything());
    teardown();
    addSpy.mockRestore();
  });
});

describe('stampActiveLinks', () => {
  it('stamps data-active on a prefix match and data-exact-active on an exact match', () => {
    document.body.innerHTML = `
      <a id="a1" href="/admin/products">Products</a>
      <a id="a2" href="/admin/products/7">Edit</a>
      <a id="a3" href="/admin/orders">Orders</a>
      <a id="a4" href="https://example.com/admin/products/7">External-ish</a>
    `;

    // Currently on the deeper path — a1 (the parent "Products" link) should
    // be a prefix match (active, not exact); a2 (this exact record) should
    // be both; a3 (a sibling section) neither.
    stampActiveLinks('/admin', '/products/7');

    const a1 = document.getElementById('a1')!;
    const a2 = document.getElementById('a2')!;
    const a3 = document.getElementById('a3')!;
    const a4 = document.getElementById('a4')!;

    expect(a1.hasAttribute('data-active')).toBe(true);
    expect(a1.hasAttribute('data-exact-active')).toBe(false);
    expect(a2.hasAttribute('data-active')).toBe(true);
    expect(a2.hasAttribute('data-exact-active')).toBe(true);
    expect(a3.hasAttribute('data-active')).toBe(false);
    expect(a4.hasAttribute('data-active')).toBe(false); // cross-origin, not routable
  });

  it('clears stale stamps on a link that is no longer routable', () => {
    document.body.innerHTML = `<a id="a1" href="/admin/products" data-active data-exact-active>Products</a>`;
    stampActiveLinks('/admin', '/orders');
    const a1 = document.getElementById('a1')!;
    expect(a1.hasAttribute('data-active')).toBe(false);
    expect(a1.hasAttribute('data-exact-active')).toBe(false);
  });
});

describe('preheatIdle', () => {
  it('runs every factory, spaced by `gap`, once the page has settled', async () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    vi.useFakeTimers();

    const order: number[] = [];
    const factories = [
      async () => { order.push(1); },
      async () => { order.push(2); },
    ];

    preheatIdle(factories, { gap: 50 });

    // No requestIdleCallback in happy-dom → Safari fallback (setTimeout 2500ms)
    await vi.advanceTimersByTimeAsync(2500);
    await vi.advanceTimersByTimeAsync(100);

    expect(order).toEqual([1, 2]);
    vi.useRealTimers();
  });

  it('aborts remaining factories on the first user interaction', async () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    vi.useFakeTimers();

    const order: number[] = [];
    const factories = [
      async () => { order.push(1); },
      async () => { order.push(2); },
    ];

    preheatIdle(factories, { gap: 50 });
    await vi.advanceTimersByTimeAsync(2500); // fallback fires, factory 1 runs
    window.dispatchEvent(new Event('click'));
    await vi.advanceTimersByTimeAsync(1000); // past the gap — factory 2 would have run by now

    expect(order).toEqual([1]);
    vi.useRealTimers();
  });

  it('the returned cancel function aborts immediately', async () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    vi.useFakeTimers();

    const order: number[] = [];
    const cancel = preheatIdle([async () => { order.push(1); }], { gap: 50 });
    cancel();
    await vi.advanceTimersByTimeAsync(3000);

    expect(order).toEqual([]);
    vi.useRealTimers();
  });

  it('is a no-op with an empty factory list', () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    expect(() => preheatIdle([])).not.toThrow();
  });
});

describe('installDomIntegration — click guard branches', () => {
  it('ignores an already-defaultPrevented click', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    document.body.appendChild(anchor);
    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    event.preventDefault();
    anchor.dispatchEvent(event);

    expect(navigate).not.toHaveBeenCalled();
    teardown();
  });

  it('ignores a non-left (right/middle) button click', () => {
    const anchor = document.createElement('a');
    anchor.href = '/admin/products';
    document.body.appendChild(anchor);
    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    clickAnchor(anchor, { button: 2 });

    expect(navigate).not.toHaveBeenCalled();
    teardown();
  });

  it('ignores a click that resolves to no anchor', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    div.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    expect(navigate).not.toHaveBeenCalled();
    teardown();
  });

  it('ignores an in-origin link outside the base', () => {
    const anchor = document.createElement('a');
    anchor.href = '/other/page';
    document.body.appendChild(anchor);
    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    const event = clickAnchor(anchor);

    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    teardown();
  });

  it('lets an in-page hash link on the same path use the browser default', () => {
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
      'http://localhost:3000/admin/products',
    );
    const anchor = document.createElement('a');
    anchor.href = '/admin/products#section';
    document.body.appendChild(anchor);
    const navigate = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate });

    const event = clickAnchor(anchor);

    expect(navigate).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    teardown();
  });
});

describe('installDomIntegration — hover guard branches', () => {
  it('ignores a data-native anchor and an out-of-base anchor, and re-arms on rapid re-hover', () => {
    vi.useFakeTimers();
    const native = document.createElement('a');
    native.href = '/admin/products';
    native.setAttribute('data-native', '');
    const out = document.createElement('a');
    out.href = '/other/x';
    const inBase = document.createElement('a');
    inBase.href = '/admin/products';
    document.body.append(native, out, inBase);

    const preheat = vi.fn();
    const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), preheat });

    native.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // data-native → ignored
    out.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // out-of-base → not routable
    inBase.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // arms timer
    inBase.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); // clears + re-arms
    vi.advanceTimersByTime(100);

    expect(preheat).toHaveBeenCalledTimes(1);
    expect(preheat).toHaveBeenCalledWith('/products');
    teardown();
    vi.useRealTimers();
  });
});

describe('preheatIdle — environment branches', () => {
  it('skips entirely under saveData', () => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true }, configurable: true });
    const factory = vi.fn(async () => {});
    preheatIdle([factory]);
    expect(factory).not.toHaveBeenCalled();
    delete (navigator as unknown as { connection?: unknown }).connection;
  });

  it('skips entirely on a 2g connection', () => {
    Object.defineProperty(navigator, 'connection', { value: { effectiveType: '2g' }, configurable: true });
    const factory = vi.fn(async () => {});
    preheatIdle([factory]);
    expect(factory).not.toHaveBeenCalled();
    delete (navigator as unknown as { connection?: unknown }).connection;
  });

  it('uses requestIdleCallback when available', async () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
    const order: number[] = [];

    preheatIdle([async () => { order.push(1); }], { gap: 0 });
    await new Promise((r) => setTimeout(r, 10));

    expect(order).toEqual([1]);
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  it('waits for the load event when the page is not yet complete', async () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => cb();
    const order: number[] = [];

    preheatIdle([async () => { order.push(1); }], { gap: 0 });
    expect(order).toEqual([]); // not started until load

    window.dispatchEvent(new Event('load'));
    await new Promise((r) => setTimeout(r, 10));

    expect(order).toEqual([1]);
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
  });

  it('aborts between the factory and the gap wait when cancelled mid-run', async () => {
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
    // Defer the callback so preheatIdle returns (and `cancel` is assigned) before
    // run() starts — otherwise factory 1 would call the initial no-op cancel.
    (window as unknown as { requestIdleCallback: (cb: () => void) => void }).requestIdleCallback = (cb) => {
      setTimeout(cb, 0);
    };
    const order: number[] = [];
    let cancel: () => void = () => {};
    const factories = [
      async () => { order.push(1); cancel(); }, // abort mid-run
      async () => { order.push(2); },
    ];

    cancel = preheatIdle(factories, { gap: 0 });
    await new Promise((r) => setTimeout(r, 20));

    expect(order).toEqual([1]);
    delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  });
});
