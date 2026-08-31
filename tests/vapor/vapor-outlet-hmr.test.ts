// @vitest-environment happy-dom
/**
 * FIXTURE - a route component hot-reloading UNDER the Vapor outlet.
 *
 * WHY THIS EXISTS. The outlet renders route components through a
 * `DynamicFragment` whose branch is keyed by the resolved component, and rc.6's
 * `9ab65a1` gave each dev render generation its own `EffectScope` so
 * `hmrRerender` can tear the old one down. Those two mechanisms meet here and
 * nowhere else: an editor save on a route component is the single most common
 * thing a developer does to an app built on this outlet, and if the branch
 * held a stale generation the symptom would be "my page stops updating until I
 * reload", which no other fixture in this repo would catch.
 *
 * It is a SMOKE test and says so: it pins that a rerender reaches the DOM
 * through the outlet and that navigation still works afterwards. The detailed
 * generation-teardown contract is `tests/hmr-render-scope-fixture.test.ts`'s
 * job, and that file is the harness precedent this one follows - the real
 * `__VUE_HMR_RUNTIME__` driven against a real `createVaporApp`, never a stand-in.
 *
 * Dev-only by nature: `__VUE_HMR_RUNTIME__` exists only in a development build,
 * which is what this project's `vue` alias resolves to. There is deliberately
 * no production arm - HMR does not exist in one.
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
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { RouterOutlet } from '../../src/router/vapor';
import type { RouteRecord } from '../../src/router/types';

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
    // Guard the harness: without the dev runtime this file would pass by
    // measuring nothing at all.
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
    }) as unknown as { isReady: () => Promise<void>; push: (to: string) => Promise<unknown>; destroy: () => void };

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

    // The edit: same component identity, new render function. The outlet's
    // branch must NOT be holding the superseded generation.
    (hmr as { rerender: (id: string, fn: unknown) => void }).rerender(hmrId, render('v2'));
    await nextTick();
    expect(host.textContent).toContain('v2');
    expect(host.textContent).not.toContain('v1');

    // And the outlet still routes afterwards: a record change swaps the branch,
    // and coming back re-renders the reloaded generation rather than a stale one.
    await router.push('/about');
    await nextTick();
    expect(host.textContent).toContain('about');

    await router.push('/user/2');
    await nextTick();
    expect(host.textContent).toContain('v2');

    app.unmount();
    host.remove();
    router.destroy();
  });
});
