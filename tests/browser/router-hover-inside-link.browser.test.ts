/**
 * Hover preheat of a router link with an icon inside it, with a real pointer in Chromium.
 * Why: moving onto the icon fires mouseout on the link, then mouseover on the icon; that must not restart the warm-up delay.
 * Shows: in light DOM and in a shadow root the link warms 1000 ms after the pointer reached it; leaving the link from its icon still cancels.
 * See: plan-preheat M11, log 36.21, tests/browser/router-shadow-hover.browser.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { installDomIntegration } from '@router/dom';

// The test page's own path is the base, so the router owns everything under it.
const base = window.location.pathname.replace(/\/$/, '');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function box<K extends keyof HTMLElementTagNameMap>(tag: K, root: Node, width: number, height: number): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node.style, { display: 'block', width: `${width}px`, height: `${height}px` });
  root.appendChild(node);
  return node;
}

/** A 300 by 80 link with a 40 by 40 icon at its top left: the link's centre is the link, not the icon. */
function link(href: string, root: Node): { anchor: HTMLAnchorElement; icon: HTMLElement } {
  const anchor = box('a', root, 300, 80);
  anchor.href = href;
  return { anchor, icon: box('span', anchor, 40, 40) };
}

/** Hovering `document.body` can land on a link (its centre), so the pointer parks on its own element. */
async function park(): Promise<HTMLElement> {
  const spot = box('p', document.body, 300, 40);
  spot.textContent = 'park';
  await userEvent.hover(spot);
  return spot;
}

/** Every install is torn down after its test, so a test that fails early leaves no listener for the next. */
const teardowns: Array<() => void> = [];

/** The integration with a 1000 ms delay, as the shadow-hover file: a real pointer's own latency can pass 100 ms. */
function installSlow(seen: string[]): void {
  teardowns.push(installDomIntegration({ base, canHandle: () => true, navigate: () => {}, preheat: (p) => seen.push(p), intentDelayMs: 1000 }));
}

afterEach(async () => {
  for (const teardown of teardowns.splice(0)) teardown();
  document.body.innerHTML = '';
  await park();
  document.body.innerHTML = '';
});

// Read 1200 ms after the pointer reached the link: the warm-up fires at 1000, a restarted timer at 1600 or later.
describe('the pointer moving onto an icon inside a link keeps its delay (real Chromium)', () => {
  it('a light-DOM link: warmed 1000 ms after the pointer reached the link', async () => {
    await park();
    const { anchor, icon } = link(`${base}/a`, document.body);
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.hover(anchor);
    await wait(600);
    await userEvent.hover(icon);
    await wait(600);
    expect(seen).toEqual(['/a']);
  });

  it('a link inside an open shadow root: warmed 1000 ms after the pointer reached the link', async () => {
    await park();
    const { anchor, icon } = link(`${base}/a`, box('div', document.body, 300, 80).attachShadow({ mode: 'open' }));
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.hover(anchor);
    await wait(600);
    await userEvent.hover(icon);
    await wait(600);
    expect(seen).toEqual(['/a']);
  });

  it('control: the pointer leaves the link from its icon: nothing warms', async () => {
    const outside = await park();
    const { anchor, icon } = link(`${base}/a`, document.body);
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.hover(anchor);
    await userEvent.hover(icon);
    await userEvent.hover(outside);
    await wait(1300);
    expect(seen).toEqual([]);
  });

  it('control: the pointer leaves a link in a shadow root from its icon: nothing warms', async () => {
    const outside = await park();
    const { anchor, icon } = link(`${base}/a`, box('div', document.body, 300, 80).attachShadow({ mode: 'open' }));
    const seen: string[] = [];
    installSlow(seen);
    await userEvent.hover(anchor);
    await userEvent.hover(icon);
    await userEvent.hover(outside);
    await wait(1300);
    expect(seen).toEqual([]);
  });
});
