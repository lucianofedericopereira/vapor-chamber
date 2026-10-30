// @vitest-environment happy-dom
/**
 * Hover and focus preheat in shadow roots (src/router/dom.ts): which roots get listeners, a node moved first, teardown.
 * Why: a move between two nodes of one shadow root never reaches the document, so every root an event comes from
 * needs its own hover and focus listeners; a node an app listener removed or moved must not throw or get listeners;
 * teardown would otherwise leave root listeners behind after router.dispose().
 * Shows: the first event from a root (nested roots innermost first) attaches the four listeners once; a removed node
 * or one moved into a fragment gets none and nothing throws; teardown aborts the signal on every root listener.
 * Hover itself is shown in tests/browser/router-shadow-hover.browser.test.ts (happy-dom stops no dispatch at the host).
 * See: log s36.19
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomIntegration } from '@router/dom';

function shadow(parent: Node): ShadowRoot {
  const host = document.createElement('div');
  parent.appendChild(host);
  return host.attachShadow({ mode: 'open' });
}

function linkIn(root: Node, href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = href;
  root.appendChild(anchor);
  return anchor;
}

const over = (el: Element) => el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));

/** Every install is torn down after its test, so a test that fails early leaves no listener for the next. */
const teardowns: Array<() => void> = [];

function install(seen: string[] = []): () => void {
  const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), preheat: (p) => seen.push(p) });
  teardowns.push(teardown);
  return teardown;
}

/** The event types a spied `addEventListener` was called with, in order. */
const types = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call[0]);

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const ALL = ['mouseover', 'mouseout', 'focusin', 'focusout'];

describe('which shadow roots get the hover and focus listeners', () => {
  it('the first event from inside a root attaches them, a second attaches none', () => {
    const s = shadow(document.body);
    const a = linkIn(s, '/admin/a');
    const adds = vi.spyOn(s, 'addEventListener');
    const teardown = install();
    over(a);
    expect(types(adds)).toEqual(ALL);
    over(a);
    expect(types(adds)).toEqual(ALL);
    teardown();
  });

  it('an event from a root nested in another attaches both, innermost first, once', () => {
    const s1 = shadow(document.body);
    linkIn(s1, '/admin/a');
    const s2 = shadow(s1);
    const b = linkIn(s2, '/admin/b');
    const outer = vi.spyOn(s1, 'addEventListener');
    const inner = vi.spyOn(s2, 'addEventListener');
    const teardown = install();
    over(b);
    expect([types(inner), types(outer)]).toEqual([ALL, ALL]);
    expect(inner.mock.invocationCallOrder[0]!).toBeLessThan(outer.mock.invocationCallOrder[0]!);
    over(b);
    expect(inner.mock.calls.length + outer.mock.calls.length).toBe(8);
    teardown();
  });
});

describe('a node an app listener moved before the router listener runs', () => {
  it('control: the link is preheated when nothing moves', () => {
    vi.useFakeTimers();
    const a = linkIn(document.body, '/admin/products');
    const span = document.createElement('span');
    a.appendChild(span);
    const seen: string[] = [];
    const teardown = install(seen);
    over(span);
    vi.advanceTimersByTime(100);
    teardown();
    expect(seen).toEqual(['/products']);
  });

  it('removed: no throw, and nothing is attached to the removed node', () => {
    const a = linkIn(document.body, '/admin/products');
    const span = document.createElement('span');
    a.appendChild(span);
    a.addEventListener('mouseover', (e) => {
      if (e.target === span) span.remove();
    });
    const adds = vi.spyOn(span, 'addEventListener');
    const teardown = install();
    // happy-dom under vitest has error capture off, so a listener's throw would escape dispatchEvent.
    expect(() => over(span)).not.toThrow();
    expect(adds).not.toHaveBeenCalled();
    teardown();
  });

  it('moved into a DocumentFragment: no throw, and nothing is attached to the fragment', () => {
    const a = linkIn(document.body, '/admin/products');
    const span = document.createElement('span');
    a.appendChild(span);
    const fragment = document.createDocumentFragment();
    a.addEventListener('mouseover', (e) => {
      if (e.target === span) fragment.appendChild(span);
    });
    const adds = vi.spyOn(fragment, 'addEventListener');
    const teardown = install();
    expect(() => over(span)).not.toThrow();
    expect(adds).not.toHaveBeenCalled();
    teardown();
  });
});

describe('teardown', () => {
  it("removes a seen root's listeners: each carried the signal teardown aborts, and a later move preheats nothing", () => {
    vi.useFakeTimers();
    const s = shadow(document.body);
    const a = linkIn(s, '/admin/a');
    const b = linkIn(s, '/admin/b');
    const adds = vi.spyOn(s, 'addEventListener');
    const seen: string[] = [];
    const teardown = install(seen);
    over(a);
    teardown();
    over(b);
    vi.advanceTimersByTime(100);
    const signals = adds.mock.calls.map((call) => (call[2] as AddEventListenerOptions | undefined)?.signal);
    expect(signals.length).toBe(4);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
    expect(seen).toEqual([]);
  });
});
