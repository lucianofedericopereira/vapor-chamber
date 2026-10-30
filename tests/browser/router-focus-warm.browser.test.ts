/**
 * Focus warm-up of a router link, in light DOM and open shadow roots, with a real keyboard in Chromium.
 * Why: a focused link warms its page as a hover does; focus moves inside one shadow root stop at the host, so each open root needs focusin/focusout.
 * Shows: Tab onto a light-DOM or shadow-root link warms it; Tab between links in one root warms the second; across nested roots, the one focused.
 * See: log 36.19 item 4, DOM Standard dispatch steps 6.9.3 and 6.9.7, tests/browser/router-shadow-hover.browser.test.ts.
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
async function park(): Promise<void> {
  await userEvent.hover(el('p', document.body, 'park'));
}

/** The button the keyboard starts from, focused. */
function start(): void {
  el('button', document.body, 'start').focus();
}

/** Every install is torn down after its test, so a test that fails early leaves no listener for the next. */
const teardowns: Array<() => void> = [];

/** The integration with a 1000 ms delay, as the shadow-hover file: a real device's own latency can pass 100 ms. */
function installSlow(seen: string[]): void {
  teardowns.push(installDomIntegration({ base, canHandle: () => true, navigate: () => {}, preheat: (p) => seen.push(p), intentDelayMs: 1000 }));
}

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.innerHTML = '';
  await park();
  document.body.innerHTML = '';
});

// Chromium only: Safari's Tab reaches links only when the user turns that on.
// Each test checks where focus landed first, so a red means "not warmed", never "Tab went elsewhere".
describe('a link that takes focus warms its page (real Chromium)', () => {
  it('Tab onto a light-DOM link warms it', async () => {
    await park();
    start();
    const a = link('A', `${base}/a`, document.body);
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.tab();
    expect(document.activeElement).toBe(a);
    await wait(1300);
    expect(seen).toEqual(['/a']);
  });

  it('Tab onto a link inside an open shadow root warms it', async () => {
    await park();
    start();
    const s = shadowIn(document.body);
    const a = link('A', `${base}/a`, s);
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.tab();
    expect(s.activeElement).toBe(a);
    await wait(1300);
    expect(seen).toEqual(['/a']);
  });

  it('Tab from link A to link B in one root warms B', async () => {
    await park();
    start();
    const s = shadowIn(document.body);
    const a = link('A', `${base}/a`, s);
    const b = link('B', `${base}/b`, s);
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.tab();
    expect(s.activeElement).toBe(a);
    await wait(30);
    await userEvent.tab();
    expect(s.activeElement).toBe(b);
    await wait(1300);
    expect(seen).toEqual(['/b']);
  });

  it('nested roots, Tab onto B in S2, then to A in S1: A warms', async () => {
    await park();
    start();
    const s1 = shadowIn(document.body);
    const s2 = shadowIn(s1);
    const b = link('B', `${base}/b`, s2);
    const a = link('A', `${base}/a`, s1);
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.tab();
    expect(s2.activeElement).toBe(b);
    await wait(30);
    await userEvent.tab();
    expect(s1.activeElement).toBe(a);
    await wait(1300);
    expect(seen).toEqual(['/a']);
  });
});
