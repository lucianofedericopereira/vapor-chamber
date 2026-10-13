// @vitest-environment happy-dom
// Hover and focus preheat and shadow roots: which roots get the listeners, a node removed first, and teardown. The long note is at the end.
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
    // vitest's happy-dom turns error capture off, so a listener's throw would leave dispatchEvent.
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

// The note.
//
// Log 36.19 item 2. A move between two nodes of one shadow root never reaches
// the document's listeners (DOM Standard, dispatch steps 6.9.3 and 6.9.7), so
// each open shadow root an event comes from gets the hover listeners too.
// Item 4 adds the focus pair (`focusin`, `focusout`) to every target, so each
// root gets four listeners.
// happy-dom does not stop the dispatch at the host, so the hover itself is
// shown in tests/browser/router-shadow-hover.browser.test.ts. This file holds
// what happy-dom can show: which roots get the listeners, and teardown.
//
// Red before: the two attach tests (no root got a listener) and teardown (no
// root listener to carry a signal). The walk goes out from the innermost root
// to the document and stops at a seen root: an event from a nested root
// attaches it and every unseen root outside it.
//
// The walk asks each root's type. An app listener earlier on the path can
// remove or move the hovered node before the router's listener runs, and the
// node's root is then an element or a fragment, not a shadow root. A walk that
// read `.host` off it threw (seeded once: red here, an uncaught error per
// hover in a browser), and one that attached any root put listeners on the
// removed node. Pins, green before and after: the removal, the fragment, and
// the control that the same page preheats when nothing moves.
//
// Teardown aborts one signal that every listener was added with, the roots'
// included. So the listeners come off, as `router.dispose()` promises, with no
// list of roots kept. A flag that only made them return kept the router in
// memory while a root it saw stayed on the page. Root listeners added without
// the signal were seeded once and turned the teardown test red.
