// @vitest-environment happy-dom
/**
 * provide/inject on a real Vapor app, loaded from the with-vapor browser build of `vue`.
 * Why: composables read the router through `app.provide` and nested outlets through component `provide()`, so a Vapor runtime that dropped either would leave them without a router or depth.
 * Shows: a component injects the app-level value and its child injects the component-level value, in one mounted Vapor app.
 * See: vuejs/core#13687
 *
 * Everything comes from the single with-vapor build: two separately imported Vue dists are two disconnected reactivity instances.
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
        componentLevel = inject(DEPTH_KEY, '(default - provide() did NOT reach)');
        return [];
      },
    });
    const Child = defineVaporComponent({
      setup() {
        appLevel = inject(APP_KEY, '(default - app.provide did NOT reach)');
        provide(DEPTH_KEY, 'component-level OK');
        return createComponent(Grandchild);
      },
    });

    const app = createVaporApp(Child);
    app.provide(APP_KEY, 'app-level OK');
    app.mount(document.createElement('div'));

    expect(appLevel).toBe('app-level OK');
    expect(componentLevel).toBe('component-level OK');
  });
});
