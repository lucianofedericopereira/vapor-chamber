// @vitest-environment happy-dom
/**
 * Route changes for assistive technology.
 *
 * A full page load tells a screen reader a new page arrived and resets focus;
 * a client-side navigation does neither unless the router does it. Two
 * sources set the rules pinned here:
 *
 *   - Next.js announces every client-side navigation in an assertive live
 *     region, reading `document.title`, then the first `<h1>`, then the path.
 *   - Gatsby's user testing with disabled users (Marcy Sutton, Fable Tech
 *     Labs, 2019): focusing a small element (a heading or a skip link) served
 *     best; focus on a large wrapper broke magnification, and a live region
 *     alone did not help magnification users. So: announce by default, and
 *     move focus to an element THE APP names, as an option.
 *
 * The initial load is not announced (the browser already read the page), and
 * neither is a query-only change (sorting or paging is not a new page).
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
    // Hidden visually, NOT from the accessibility tree (display:none would silence it).
    expect((r as HTMLElement).style.display).not.toBe('none');
    router.destroy();
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
    router.destroy();
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
    router.destroy();
  });

  it('can be turned off, or told what to say', async () => {
    const off = makeRouter({ announce: false });
    await off.isReady();
    await off.push('/list');
    await frame();
    expect(region()).toBeNull();
    off.destroy();

    const custom = makeRouter({ announce: (to: { path: string }) => `Now on ${to.path}` });
    await custom.isReady();
    await custom.push('/list');
    await frame();
    expect(region()!.textContent).toBe('Now on /list');
    custom.destroy();
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
    silent.destroy();

    const empty = makeRouter({ announce: () => '', focusOnNavigate: '#not-on-this-page' });
    await empty.isReady();
    await empty.push('/list');
    await frame();
    expect(region()).toBeNull(); // an empty string is not spoken
    expect(document.activeElement).toBe(heading); // no target: focus left where it was
    empty.destroy();
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
    router.destroy();
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
    router.destroy();
  });

  it('stops announcing after destroy(); the region is the document\'s, shared, and stays', async () => {
    const router = makeRouter();
    document.title = 'Orders list';
    await router.isReady();
    await router.push('/list');
    await frame();
    await frame();
    expect(region()!.textContent).toBe('Orders list');
    router.destroy();
    region()!.textContent = '';
    document.title = 'Home';
    await frame();
    expect(region()!.textContent).toBe('');
  });
});
