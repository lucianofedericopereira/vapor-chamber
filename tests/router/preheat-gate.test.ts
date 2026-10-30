// @vitest-environment happy-dom
/**
 * When the router warms a page's code: on hover and focus, which links are skipped, and `meta.preheat: false`.
 * Why: warming a download link, or warming for a user saving data, wastes bandwidth for a page that never opens; a route marked `preheat: false` would be downloaded anyway; a warm-up that navigates or moves focus would disturb the user.
 * Shows: hover skips download and data-native links, Save-Data and 2g, and reads Save-Data when the timer fires; `_blank` and `rel=external` links still warm; focus warms with its own timer; `meta.preheat: false` is read per record while a same-named component on an unmarked route still warms; a warm-up leaves route, focus and live region alone while a click moves focus and announces.
 * See: log 36.19, docs/accessibility.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDomIntegration } from '@router/dom';
import type { RouteRecord } from '@router/types';
import { frame, makeRouter } from './fixture';

function link(attrs: Record<string, string> = {}): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = '/admin/products';
  for (const [name, value] of Object.entries(attrs)) anchor.setAttribute(name, value);
  document.body.appendChild(anchor);
  return anchor;
}

function setConnection(value: { saveData?: boolean; effectiveType?: string } | undefined): void {
  Object.defineProperty(navigator, 'connection', { value, configurable: true });
}

const fire = (el: Element, type: 'mouseover' | 'mouseout' | 'focusin' | 'focusout') =>
  el.dispatchEvent(type.startsWith('mouse') ? new MouseEvent(type, { bubbles: true }) : new FocusEvent(type, { bubbles: true }));

/** The paths warmed after `act` and the 100 ms intent delay, `duringDelay` run halfway. */
function warmedAfter(act: () => void, duringDelay?: () => void): string[] {
  vi.useFakeTimers();
  const seen: string[] = [];
  const teardown = installDomIntegration({ base: '/admin', canHandle: () => true, navigate: vi.fn(), preheat: (p) => seen.push(p) });
  act();
  vi.advanceTimersByTime(50);
  duringDelay?.();
  vi.advanceTimersByTime(50);
  teardown();
  return seen;
}

const warmedOnHover = (anchor: HTMLAnchorElement, duringDelay?: () => void) => warmedAfter(() => fire(anchor, 'mouseover'), duringDelay);

afterEach(() => {
  document.body.innerHTML = '';
  delete (navigator as { connection?: unknown }).connection;
  vi.useRealTimers();
});

describe('hover warms a link unless no page will use it, or the user saves data', () => {
  it('control: a plain link, no `navigator.connection` (Firefox, Safari): warmed', () => {
    expect(warmedOnHover(link())).toEqual(['/products']);
  });

  it('a download link is not warmed: no page opens', () => {
    expect(warmedOnHover(link({ download: '' }))).toEqual([]);
  });

  it('control: a data-native link is not warmed', () => {
    expect(warmedOnHover(link({ 'data-native': '' }))).toEqual([]);
  });

  it.each([['target', '_blank'], ['rel', 'external']])('a %s="%s" link is still warmed: a page of the app opens', (name, value) => {
    expect(warmedOnHover(link({ [name]: value }))).toEqual(['/products']);
  });

  it('Save-Data on: not warmed', () => {
    setConnection({ saveData: true, effectiveType: '4g' });
    expect(warmedOnHover(link())).toEqual([]);
  });

  it.each(['2g', 'slow-2g'])('a %s connection: not warmed', (effectiveType) => {
    setConnection({ saveData: false, effectiveType });
    expect(warmedOnHover(link())).toEqual([]);
  });

  it.each(['3g', '4g'])('control: a %s connection without Save-Data is warmed', (effectiveType) => {
    setConnection({ saveData: false, effectiveType });
    expect(warmedOnHover(link())).toEqual(['/products']);
  });

  it('Save-Data switched on during the delay: not warmed', () => {
    expect(warmedOnHover(link(), () => setConnection({ saveData: true }))).toEqual([]);
  });

  it('Save-Data switched off during the delay: warmed, read when the warm-up fires', () => {
    setConnection({ saveData: true });
    expect(warmedOnHover(link(), () => setConnection({ saveData: false }))).toEqual(['/products']);
  });
});

describe('a link that takes focus warms as a hover does', () => {
  it('a focusin on a link warms it', () => {
    expect(warmedAfter(() => fire(link(), 'focusin'))).toEqual(['/products']);
  });

  it('a real focus() warms it', () => {
    expect(warmedAfter(() => link().focus())).toEqual(['/products']);
  });

  it('mouse over A, focus B, the mouse leaves A: B warms, A does not', () => {
    const a = link({ href: '/admin/a' });
    const b = link({ href: '/admin/b' });
    const act = () => {
      fire(a, 'mouseover');
      fire(b, 'focusin');
      fire(a, 'mouseout');
    };
    expect(warmedAfter(act)).toEqual(['/b']);
  });

  it('focus, then blur before the delay: nothing warms', () => {
    const a = link();
    const act = () => {
      fire(a, 'focusin');
      fire(a, 'focusout');
    };
    expect(warmedAfter(act)).toEqual([]);
  });

  it('focus on a download link: not warmed', () => {
    expect(warmedAfter(() => fire(link({ download: '' }), 'focusin'))).toEqual([]);
  });

  it('focus under Save-Data: not warmed', () => {
    setConnection({ saveData: true });
    expect(warmedAfter(() => fire(link(), 'focusin'))).toEqual([]);
  });
});

describe('meta.preheat: false on a route: a link to it does not warm its component', () => {
  const ROWS: RouteRecord[] = [
    { name: 'shell', path: '/', parent: null },
    { name: 'home', path: '/', parent: 'shell', component: 'Home' },
    { name: 'admin', path: '/admin', parent: 'shell', component: 'Admin' },
    { name: 'report', path: '/admin/report', parent: 'admin', component: 'Report', meta: { preheat: false } },
    { name: 'stats', path: '/admin/stats', parent: 'admin', component: 'Stats' },
    { name: 'export', path: '/admin/export', parent: 'admin', component: 'Report' },
    { name: 'vault', path: '/vault', parent: 'shell', component: 'Vault', meta: { preheat: false } },
    { name: 'item', path: '/vault/item', parent: 'vault', component: 'Item' },
  ];

  async function hoverLoads(href: string): Promise<Record<string, number>> {
    const lazy = (name: string) => vi.fn(async () => ({ name }));
    const loaders = { Admin: lazy('Admin'), Report: lazy('Report'), Stats: lazy('Stats'), Vault: lazy('Vault'), Item: lazy('Item') };
    const router = makeRouter({ routes: ROWS, components: { Home: { name: 'Home' }, ...loaders } });
    try {
      await router.isReady();
      const anchor = document.createElement('a');
      anchor.href = href;
      document.body.appendChild(anchor);
      anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      router.dispose();
    }
    return Object.fromEntries(Object.entries(loaders).map(([name, fn]) => [name, fn.mock.calls.length]));
  }

  it('a page marked false: not warmed, its unmarked layout is', async () => {
    const loads = await hoverLoads('/admin/report');
    expect(loads.Report).toBe(0);
    expect(loads.Admin).toBe(1);
  });

  it('a layout marked false: not warmed by a child link, the unmarked child is', async () => {
    const loads = await hoverLoads('/vault/item');
    expect(loads.Vault).toBe(0);
    expect(loads.Item).toBe(1);
  });

  it('control: an unmarked page and its layout are warmed', async () => {
    const loads = await hoverLoads('/admin/stats');
    expect(loads.Stats).toBe(1);
    expect(loads.Admin).toBe(1);
  });

  it('an unmarked route naming the component of a page marked false: warmed', async () => {
    const loads = await hoverLoads('/admin/export');
    expect(loads.Report).toBe(1);
  });
});

describe('a warm-up never navigates, moves focus or speaks (docs/accessibility.md, 3.2.1)', () => {
  const region = () => document.querySelector('[data-vc-announcer="assertive"]');

  async function page() {
    document.body.innerHTML = '<h1 id="title">Orders</h1><a id="to-list" href="/list">list</a>';
    const lazy = vi.fn(async () => ({ name: 'List' }));
    // focusOnNavigate and announce are on, else no navigation would move focus or speak either.
    const router = makeRouter({ components: { Home: { name: 'Home' }, List: lazy }, focusOnNavigate: '#title', announce: true });
    await router.isReady();
    await frame();
    return { router, lazy, anchor: document.getElementById('to-list')!, heading: document.getElementById('title')! };
  }

  it('focus on a lazy page link: its code loads, the route, the focus and the live region stay', async () => {
    const { router, lazy, anchor } = await page();
    try {
      anchor.focus();
      await new Promise((r) => setTimeout(r, 250));
      await frame();
      expect(lazy).toHaveBeenCalledTimes(1);
      expect(router.currentRoute.value.location.name).toBe('home');
      expect(document.activeElement).toBe(anchor);
      expect(region()?.textContent ?? '').toBe('');
    } finally {
      router.dispose();
    }
  });

  it('control: a click on the same link navigates, moves focus to the heading and announces', async () => {
    const { router, anchor, heading } = await page();
    try {
      anchor.click();
      await vi.waitFor(() => expect(router.currentRoute.value.location.name).toBe('list'));
      await frame();
      await frame();
      expect(document.activeElement).toBe(heading);
      expect(region()!.textContent).toBe('Orders');
    } finally {
      router.dispose();
    }
  });
});
