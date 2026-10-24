// The island-cart loader looks a tag up by own key only (audit row VIC-8).
import { afterEach, describe, expect, it, vi } from 'vitest';

function pageWith(html: string): void {
  document.body.innerHTML = html;
}

async function loadMain(): Promise<void> {
  vi.resetModules();
  await import('../../examples/vapor-island-cart/src/main');
  // hydrate() awaits the loader, then defines: give both a turn.
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

/*
 * Why. main.ts builds `loaders` as a plain `{}` keyed by tag name and checked
 * `!loaders[tag]`. HTML lowercases tag names, so of Object.prototype's keys
 * only `constructor` can be a tag: `<constructor client:load>` found
 * `Object`, called it, got `{}`, and passed `undefined` to
 * defineVaporCustomElement under the name "constructor", which is not a valid
 * custom element name. The promise rejected unhandled. `Object.hasOwn` reads
 * the map the way src/dict.ts says external strings must be read. Since
 * 1.32 step 6d main.ts walks its island files and defines each tag through
 * `defineWidget`, so a tag no island file names is never looked up.
 *
 * The control cannot hydrate a real island: neither test project loads
 * @vitejs/plugin-vue, so a `.vue` import does not compile here. It shows the
 * page's real islands still reach the loader path (client:visible observes
 * them, through defineWidget's one observer) through the same module, so the fix did not stop the lookup working.
 * It runs in the Vapor project because main.ts imports
 * `defineVaporCustomElement` from `vue`, which only the with-vapor build has.
 */
