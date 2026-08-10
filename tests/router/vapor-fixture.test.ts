// @vitest-environment happy-dom
/**
 * FIXTURE — provide/inject on a real Vapor app, vue@3.6.0-rc.2.
 *
 * Two things this router depends on, MEASURED here rather than inferred:
 *   - app.provide → inject   backs every composable (composables.ts useRouter)
 *   - provide() → inject     backs nested outlets (outlet.ts OUTLET_DEPTH_KEY)
 *
 * The roadmap (vuejs/core#13687) listed "Provide/Inject System" unchecked when
 * this fixture was written, and now lists it checked. The measurements are
 * what they always were; only the framing changed. Note the rule cuts both
 * ways and this file is the reason it can be applied honestly: an unchecked
 * box never meant missing, and a checked one does not mean working.
 *
 * Everything is imported from the single with-vapor browser build on purpose.
 * Vapor ships as a physically separate dist file (see chamber.ts §probeVue and
 * whitepaper §11.6), and two separately-imported Vue dists are two disconnected
 * reactivity instances — mixing `vue` and the with-vapor build in one test would
 * silently measure nothing.
 */

import { describe, expect, it } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type VaporApp = { provide: (k: symbol, v: unknown) => void; mount: (el: unknown) => void };

describe('provide/inject on a vapor app', () => {
  it('resolves through both app-level and component-level provide', async () => {
    const vapor = (await import(/* @vite-ignore */ WITH_VAPOR)) as Record<string, unknown>;
    const { createVaporApp, defineVaporComponent, createComponent, provide, inject } = vapor as {
      createVaporApp: (root: unknown) => VaporApp;
      defineVaporComponent: (c: unknown) => unknown;
      createComponent: (c: unknown) => unknown;
      provide: (k: symbol, v: unknown) => void;
      inject: (k: symbol, fallback: unknown) => unknown;
    };
    expect(typeof createVaporApp).toBe('function');

    const APP_KEY = Symbol.for('probe:app');
    const DEPTH_KEY = Symbol.for('probe:depth');
    let appLevel: unknown = '(child never ran)';
    let componentLevel: unknown = '(grandchild never ran)';

    // shape mirrors outlet.ts: a component that provides, wrapping one that injects
    const Grandchild = defineVaporComponent({
      setup() {
        componentLevel = inject(DEPTH_KEY, '(default — provide() did NOT reach)');
        return [];
      },
    });
    const Child = defineVaporComponent({
      setup() {
        appLevel = inject(APP_KEY, '(default — app.provide did NOT reach)');
        provide(DEPTH_KEY, 'component-level OK');
        return createComponent(Grandchild);
      },
    });

    const app = createVaporApp(Child);
    app.provide(APP_KEY, 'app-level OK');
    app.mount(document.createElement('div'));

    // MEASURED on 3.6.0-rc.2: both resolve. Upstream now agrees (the roadmap
    // box is checked), but the assertion — not the box — is why we rely on it.
    expect(appLevel).toBe('app-level OK');
    expect(componentLevel).toBe('component-level OK');
  });
});
