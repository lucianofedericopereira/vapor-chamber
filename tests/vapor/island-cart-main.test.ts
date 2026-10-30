/**
 * The vapor-island-cart entry module (`examples/vapor-island-cart/src/main.ts`) hydrating islands from a page.
 * Why: a tag that is not an island file's own tag, such as an Object.prototype name like `constructor` (the one HTML can spell), would reach `defineVaporCustomElement` as `undefined` and reject unhandled if the entry looked tags up in a plain object. It needs the with-vapor build, because the entry imports `defineVaporCustomElement` from `vue`.
 * Shows: a page with `<constructor client:load>` defines no custom element and raises no unhandled rejection; the page's real `vc-products` and `vc-cart` islands under `client:visible` are each observed. The control cannot hydrate a real island: no test project loads `@vitejs/plugin-vue`.
 * See: audit VIC-8, log s36.11
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

function pageWith(html: string): void {
  document.body.innerHTML = html;
}

async function loadMain(): Promise<void> {
  vi.resetModules();
  await import('../../examples/vapor-island-cart/src/main');
  // Hydration awaits the island loader, then defines: give both a turn.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('examples/vapor-island-cart/src/main.ts: island lookup', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('a `<constructor client:load>` element defines nothing and rejects nothing', async () => {
    const rejected: unknown[] = [];
    const onRejection = (reason: unknown) => { rejected.push(reason); };
    process.on('unhandledRejection', onRejection);
    const define = vi.spyOn(customElements, 'define');
    try {
      pageWith('<constructor client:load></constructor>');
      await loadMain();
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect({ defined: define.mock.calls.map((c) => c[0]), rejected: rejected.map(String) })
      .toEqual({ defined: [], rejected: [] });
  });

  it('control: a real island tag is still picked up (observed for client:visible)', async () => {
    const observe = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { observe = observe; unobserve() {} disconnect() {} });
    pageWith('<vc-products client:visible></vc-products><vc-cart client:visible></vc-cart>');
    await loadMain();
    expect(observe.mock.calls.map((c) => (c[0] as Element).tagName.toLowerCase()).sort()).toEqual(['vc-cart', 'vc-products']);
  });
});
