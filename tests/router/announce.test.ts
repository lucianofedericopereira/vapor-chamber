// @vitest-environment happy-dom
/**
 * The route announcer and focusOnNavigate: what a client-side navigation tells assistive technology.
 * Why: a client-side navigation gives a screen reader no new-page signal and resets no focus unless the router does both; the initial load and a query-only change must stay silent.
 * Shows: a commit is announced in a visually hidden assertive live region (title, then first h1, then path); the initial load, a refused initial load and a query-only change say nothing; announce can be off or custom; focus moves only to an app-named element and sets tabindex -1 only on a non-focusable one; nothing is announced after dispose().
 * See: log 36.11 (RA-3), tests/browser/route-announce.browser.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import { frame, makeRouter } from './fixture';

const region = () => document.querySelector('[data-vc-announcer="assertive"]');

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('route announcer', () => {
  it('announces a client-side navigation by document.title, in an assertive live region', async () => {
    const router = makeRouter();
    router.afterEach((to) => {
      document.title = to.path === '/list' ? 'Orders list' : 'Home';
    });
    await router.isReady();
    await frame();
    expect(region()?.textContent ?? '').toBe(''); // the initial load is not announced

    await router.push('/list');
    await frame();
    const r = region()!;
    expect(r.textContent).toBe('Orders list');
    expect(r.getAttribute('aria-live')).toBe('assertive');
    expect(r.getAttribute('aria-atomic')).toBe('true');
    // display:none would hide the region from the accessibility tree.
    expect((r as HTMLElement).style.display).not.toBe('none');
    router.dispose();
  });

  it('falls back to the first h1, then to the path', async () => {
    const router = makeRouter();
    await router.isReady();
    const h1 = document.createElement('h1');
    h1.textContent = 'All orders';
    document.body.append(h1);
    await router.push('/list');
    await frame();
    expect(region()!.textContent).toBe('All orders');

    h1.remove();
    await router.push('/');
    await frame();
    expect(region()!.textContent).toBe('/');
    router.dispose();
  });

  it('announces the first navigation after an initial load that did not commit (audit RA-3)', async () => {
    const router = makeRouter();
    let refuseFirst = true;
    router.beforeEach(() => {
      if (refuseFirst) { refuseFirst = false; return false; }
      return true;
    });
    document.title = 'Orders list';
    await router.isReady().catch(() => {});
    await frame();
    expect(region()?.textContent ?? '').toBe(''); // the refused initial load says nothing
    expect(await router.push('/list')).toBeNull(); // committed
    await frame();
    expect(region()?.textContent).toBe('Orders list');
    router.dispose();
  });

  it('does not announce a query-only change', async () => {
    const router = makeRouter();
    document.title = 'Orders list';
    await router.isReady();
    await router.push('/list');
    await frame();
    region()!.textContent = '';
    await router.push('/list?page=2');
    await frame();
    expect(region()!.textContent).toBe('');
    router.dispose();
  });

  it('can be turned off, or told what to say', async () => {
    const off = makeRouter({ announce: false });
    await off.isReady();
    await off.push('/list');
    await frame();
    expect(region()).toBeNull();
    off.dispose();

    const custom = makeRouter({ announce: (to: { path: string }) => `Now on ${to.path}` });
    await custom.isReady();
    await custom.push('/list');
    await frame();
    expect(region()!.textContent).toBe('Now on /list');
    custom.dispose();
  });

  it('announcing off still moves focus; an empty announcement and a missing target are skipped', async () => {
    const heading = document.createElement('h1');
    heading.id = 'page-title';
    document.body.append(heading);
    const silent = makeRouter({ announce: false, focusOnNavigate: '#page-title' });
    await silent.isReady();
    await silent.push('/list');
    await frame();
    expect(region()).toBeNull(); // nothing said
    expect(document.activeElement).toBe(heading); // focus still moved
    silent.dispose();

    const empty = makeRouter({ announce: () => '', focusOnNavigate: '#not-on-this-page' });
    await empty.isReady();
    await empty.push('/list');
    await frame();
    expect(region()).toBeNull(); // an empty string is not spoken
    expect(document.activeElement).toBe(heading); // no target: focus left where it was
    empty.dispose();
  });

  it('moves focus to the element the app names, making it focusable only if it is not', async () => {
    const heading = document.createElement('h1');
    heading.id = 'page-title';
    heading.textContent = 'Orders';
    document.body.append(heading);
    const router = makeRouter({ focusOnNavigate: '#page-title' });
    await router.isReady();
    await frame();
    expect(document.activeElement).not.toBe(heading); // not on the initial load

    await router.push('/list');
    await frame();
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
    router.dispose();
  });

  it('leaves an element that is already focusable as it is', async () => {
    const skip = document.createElement('a');
    skip.href = '#main';
    skip.className = 'skip';
    skip.textContent = 'Skip to content';
    document.body.append(skip);
    const router = makeRouter({ focusOnNavigate: '.skip' });
    await router.isReady();
    await router.push('/list');
    await frame();
    expect(document.activeElement).toBe(skip);
    expect(skip.hasAttribute('tabindex')).toBe(false);
    router.dispose();
  });

  it('leaves editable content as it is too (tests/browser/route-announce.browser.test.ts in Chromium)', async () => {
    const editor = document.createElement('div');
    editor.id = 'editor';
    editor.contentEditable = 'true';
    document.body.append(editor);
    const router = makeRouter({ focusOnNavigate: '#editor' });
    await router.isReady();
    await router.push('/list');
    await frame();
    expect([editor.isContentEditable, editor.hasAttribute('tabindex')]).toEqual([true, false]);
    router.dispose();
  });

  it('stops announcing after dispose(); the region is the document\'s, shared, and stays', async () => {
    const router = makeRouter();
    document.title = 'Orders list';
    await router.isReady();
    await router.push('/list');
    await frame();
    await frame();
    expect(region()!.textContent).toBe('Orders list');
    router.dispose();
    region()!.textContent = '';
    document.title = 'Home';
    await frame();
    expect(region()!.textContent).toBe('');
  });
});
