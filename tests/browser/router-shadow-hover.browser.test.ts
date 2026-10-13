/**
 * Hover preheat of a router link inside an open shadow root, with a real pointer in Chromium.
 * The long note is at the end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { installDomIntegration } from '@router/dom';

// The test page's own path is the base, so the router owns everything under it.
const base = window.location.pathname.replace(/\/$/, '');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, root: Node, text: string = tag): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  node.style.display = 'inline-block';
  node.style.padding = '20px';
  root.appendChild(node);
  return node;
}

function link(text: string, href: string, root: Node): HTMLAnchorElement {
  const anchor = el('a', root, text);
  anchor.href = href;
  return anchor;
}

function shadowIn(root: Node): ShadowRoot {
  return el('div', root, '').attachShadow({ mode: 'open' });
}

/** Hovering `document.body` can land on a link (its centre), so the pointer parks on its own element. */
async function park(): Promise<HTMLElement> {
  const spot = el('p', document.body, 'park');
  await userEvent.hover(spot);
  return spot;
}

/** The integration with a 1000 ms delay: a real pointer's own latency can pass 100 ms between two hovers. */
function installSlow(seen: string[]): () => void {
  return installDomIntegration({ base, canHandle: () => true, navigate: () => {}, preheat: (p) => seen.push(p), intentDelayMs: 1000 });
}

afterEach(async () => {
  document.body.innerHTML = '';
  await park();
  document.body.innerHTML = '';
});

describe('hover preheat across a shadow root (real Chromium)', () => {
  it('control: a light-DOM link is preheated on hover', async () => {
    const seen: string[] = [];
    const teardown = installDomIntegration({ base, canHandle: () => true, navigate: () => {}, preheat: (p) => seen.push(p) });
    await userEvent.hover(link('light', `${base}/products`, document.body));
    await wait(200);
    teardown();
    expect(seen).toEqual(['/products']);
  });

  it('a link inside an open shadow root is preheated on hover', async () => {
    const seen: string[] = [];
    const anchor = link('shadow', `${base}/orders`, shadowIn(document.body));
    const teardown = installDomIntegration({ base, canHandle: () => true, navigate: () => {}, preheat: (p) => seen.push(p) });
    await userEvent.hover(anchor);
    await wait(200);
    teardown();
    expect(seen).toEqual(['/orders']);
  });
});

describe('hover follows the pointer inside shadow roots (real Chromium)', () => {
  it('from link A to link B in one root: B is preheated', async () => {
    await park();
    const s = shadowIn(document.body);
    const a = link('A', `${base}/a`, s);
    const b = link('B', `${base}/b`, s);
    const seen: string[] = [];
    const teardown = installSlow(seen);
    await userEvent.hover(a);
    await wait(30);
    await userEvent.hover(b);
    await wait(1300);
    teardown();
    expect(seen).toEqual(['/b']);
  });

  it('into a root on a plain element, then onto a link: the link is preheated', async () => {
    await park();
    const s = shadowIn(document.body);
    const span = el('span', s, 'plain');
    const a = link('A', `${base}/a`, s);
    const seen: string[] = [];
    const teardown = installSlow(seen);
    await userEvent.hover(span);
    await wait(30);
    await userEvent.hover(a);
    await wait(1300);
    teardown();
    expect(seen).toEqual(['/a']);
  });

  it('nested roots, outer first: link A in S1, then link B in S2 inside S1', async () => {
    await park();
    const s1 = shadowIn(document.body);
    const a = link('A', `${base}/a`, s1);
    const b = link('B', `${base}/b`, shadowIn(s1));
    const seen: string[] = [];
    const teardown = installSlow(seen);
    await userEvent.hover(a);
    await wait(30);
    await userEvent.hover(b);
    await wait(1300);
    teardown();
    expect(seen).toEqual(['/b']);
  });

  it('nested roots, inner first: link B in S2, then link A in S1', async () => {
    await park();
    const s1 = shadowIn(document.body);
    const b = link('B', `${base}/b`, shadowIn(s1));
    const a = link('A', `${base}/a`, s1);
    const seen: string[] = [];
    const teardown = installSlow(seen);
    await userEvent.hover(b);
    await wait(30);
    await userEvent.hover(a);
    await wait(1300);
    teardown();
    expect(seen).toEqual(['/a']);
  });

  it('pin: a root entered again from outside is preheated once, not once per listener', async () => {
    const outside = await park();
    const s = shadowIn(document.body);
    const a = link('A', `${base}/a`, s);
    const b = link('B', `${base}/b`, s);
    const seen: string[] = [];
    const teardown = installSlow(seen);
    await userEvent.hover(a);
    await userEvent.hover(outside);
    await userEvent.hover(b);
    await wait(1300);
    teardown();
    expect(seen).toEqual(['/b']);
  });

  it('pin: a link whose own hover listener re-renders the hovered node is preheated, with no error', async () => {
    await park();
    const errors: string[] = [];
    const onError = (e: ErrorEvent) => {
      errors.push(e.message);
      e.preventDefault();
    };
    window.addEventListener('error', onError);
    const a = link('', `${base}/products`, document.body);
    Object.assign(a.style, { display: 'block', width: '300px', height: '80px', padding: '0' });
    const span = el('span', a, 'label');
    Object.assign(span.style, { display: 'block', width: '300px', height: '80px', padding: '0' });
    a.addEventListener('mouseover', (e) => {
      if (e.target === span) span.replaceWith(span.cloneNode(true));
    });
    const seen: string[] = [];
    const teardown = installSlow(seen);
    // The link, not the span: a locator on the replaced span keeps retrying.
    await userEvent.hover(a);
    await wait(1300);
    teardown();
    window.removeEventListener('error', onError);
    expect(seen).toEqual(['/products']);
    expect(errors).toEqual([]);
  });

  it('pin: after teardown, a move inside a seen root preheats nothing', async () => {
    await park();
    const s = shadowIn(document.body);
    const a = link('A', `${base}/a`, s);
    const b = link('B', `${base}/b`, s);
    const seen: string[] = [];
    const teardown = installSlow(seen);
    await userEvent.hover(a);
    teardown();
    await userEvent.hover(b);
    await wait(1300);
    expect(seen).toEqual([]);
  });
});

// The note.
//
// Complexity review F8 (log 36.17). At the document, a pointer event from
// inside a shadow root has the host as its target, so a `closest('a[href]')`
// from the target cannot see a link inside the shadow tree. The click path
// scanned `event.composedPath()`, which an open shadow root's nodes are part
// of. The hover now finds its link the same way (`anchorOf`). Red before: the
// shadow case, with the light-DOM hover as the control. happy-dom passes the
// shadow case before the fix too: it does not retarget `event.target` to the
// host at the document, so only a real engine shows this.
//
// Log 36.19 item 2. A move between two nodes of one shadow root never reached
// the document: the dispatch stops at the host when the target and the related
// target retarget to it (DOM Standard, dispatch steps 6.9.3 and 6.9.7). So
// the hover warmed the link the pointer left, never the one under it. Every
// open shadow root an event comes from now gets the listeners too, each unseen
// root out to the document. Red before: one root (`["/a"]`), the plain element
// first (`[]`), nested outer first (`["/a"]`) and inner first (`["/b"]`: the
// `mouseout` from B never reached the document, so B's timer ran). Attaching
// only the innermost root was seeded once and turned the inner-first test red
// (`[]`): the outer root stayed deaf. Pins, green before and after: a root
// entered again (root and document both arm one timer), a re-render inside
// the link (a walk that read `.host` off the removed node threw there, seeded
// once: one error, the link still preheated by the next event), and teardown
// (root listeners added without teardown's signal, seeded once: `["/b"]`).
// The 1000 ms delay: with 100 ms, Playwright's own latency between two hovers
// sometimes passed the delay and the first link warmed legitimately.
