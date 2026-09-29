/**
 * The route announcer and focusOnNavigate in a real engine: happy-dom's focus
 * and rendering are not evidence for a browser. src/router/announce.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { frame, makeRouter } from '../router/fixture';

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('route announcer (real Chromium)', () => {
  it('announces by title and moves focus off the pressed link to the app heading', async () => {
    const link = document.createElement('a');
    link.href = '/list';
    link.textContent = 'Orders';
    const heading = document.createElement('h1');
    heading.id = 'page-title';
    heading.textContent = 'Orders';
    document.body.append(link, heading);

    const router = makeRouter({ focusOnNavigate: '#page-title' });
    router.afterEach((to) => { document.title = to.path === '/list' ? 'Orders list' : 'Home'; });
    await router.isReady();

    link.focus();
    await router.push('/list');
    await frame();

    const region = document.querySelector('[data-vc-announcer="assertive"]') as HTMLElement;
    expect(region.textContent).toBe('Orders list');
    expect(region.getAttribute('aria-live')).toBe('assertive');
    // Visually hidden yet rendered: a real engine gives it a 1px box, not none.
    const box = region.getBoundingClientRect();
    expect(box.width).toBeLessThanOrEqual(1);
    expect(getComputedStyle(region).display).not.toBe('none');
    expect(getComputedStyle(region).visibility).not.toBe('hidden');

    expect(document.activeElement).toBe(heading);
    router.destroy();
  });
});
