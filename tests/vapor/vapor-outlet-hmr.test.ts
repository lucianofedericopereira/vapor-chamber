// @vitest-environment happy-dom
/**
 * A route component hot-reloading under the Vapor outlet, driven by the real `__VUE_HMR_RUNTIME__` (a smoke test).
 * Why: if the outlet's branch held a stale render generation, an editor save on a route component would leave the page stale until a reload.
 * Shows: after an HMR rerender the new output is in the DOM and the old one is gone, and navigating away and back renders the reloaded component.
 * See: tests/hmr-render-scope-fixture.test.ts
 */

import { describe, expect, it } from 'vitest';
import {
  createComponent,
  createVaporApp,
  defineVaporComponent,
  nextTick,
  setInsertionState,
  template,
} from 'vue';
import { createMemoryHistory } from '@router/history';
import { createRouter } from '@router/index';
import { RouterOutlet } from '@router/vapor';
import type { RouteRecord } from '@router/types';

const ROWS: RouteRecord[] = [
  { name: 'home', path: '/', component: 'Home' },
  { name: 'user', path: '/user/:id', component: 'User', params: { id: 'int' } },
  { name: 'about', path: '/about', component: 'About' },
];

const leaf = (html: string) => defineVaporComponent({ setup: () => (template(html, 1) as () => Element)() });

describe('Vapor outlet - dev HMR', () => {
  it('a route component rerender reaches the DOM through the outlet', async () => {
    const hmr = (globalThis as { __VUE_HMR_RUNTIME__?: Record<string, (...args: never[]) => unknown> })
      .__VUE_HMR_RUNTIME__;
    // The dev runtime exists only in a development build; without it the test would measure nothing.
    expect(hmr).toBeTruthy();

    const hmrId = 'fixture-vapor-outlet-route-component';
    const render = (label: string) => () => (template(`<span class="user">${label}</span>`, 1) as () => Element)();

    const User = defineVaporComponent({ __hmrId: hmrId, render: render('v1') } as never);
    (hmr as { createRecord: (id: string, comp: unknown) => void }).createRecord(hmrId, User);

    const router = createRouter({
      base: '',
      history: createMemoryHistory(''),
      routes: ROWS,
      components: { Home: leaf('<span>home</span>'), User, About: leaf('<span>about</span>') },
    }) as unknown as { isReady: () => Promise<void>; push: (to: string) => Promise<unknown>; dispose: () => void };

    const Root = defineVaporComponent({
      setup() {
        const el = (template('<div class="root"></div>', 1) as () => Element)();
        setInsertionState(el);
        createComponent(RouterOutlet as never);
        return el;
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(Root as never);
    app.use(router as never);
    app.mount(host);
    await router.isReady();

    await router.push('/user/1');
    await nextTick();
    expect(host.textContent).toContain('v1');

    // Same component identity, new render function.
    (hmr as { rerender: (id: string, fn: unknown) => void }).rerender(hmrId, render('v2'));
    await nextTick();
    expect(host.textContent).toContain('v2');
    expect(host.textContent).not.toContain('v1');

    await router.push('/about');
    await nextTick();
    expect(host.textContent).toContain('about');

    await router.push('/user/2');
    await nextTick();
    expect(host.textContent).toContain('v2');

    app.unmount();
    host.remove();
    router.dispose();
  });
});
