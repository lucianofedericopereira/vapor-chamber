// @vitest-environment happy-dom
/**
 * Tests for router/outlet.ts — <RouterOutlet> renders the matched component at
 * its depth, falls back to the default slot when nothing matches, and requires
 * an installed router.
 */

import { describe, expect, it } from 'vitest';
import { createApp, defineComponent, h } from 'vue';
import { createMemoryHistory } from '../../src/router/history';
import { createRouter } from '../../src/router/index';
import { RouterOutlet } from '../../src/router/outlet';
import { ROUTER_KEY } from '../../src/router/keys';
import type { RouteRecord } from '../../src/router/types';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'list', path: '/list', parent: 'shell', component: 'List' },
];

function makeRouter() {
  return createRouter({
    base: '/admin',
    history: createMemoryHistory('/admin'),
    routes: ROWS,
    components: {
      Home: defineComponent({ render: () => h('span', 'home-page') }),
      List: defineComponent({ render: () => h('span', 'list-page') }),
    },
  });
}

describe('RouterOutlet', () => {
  it('renders the matched component at its depth', async () => {
    const router = makeRouter();
    await router.isReady();
    await router.push('/list');

    const host = document.createElement('div');
    const app = createApp({ render: () => h(RouterOutlet) });
    app.provide(ROUTER_KEY, router);
    app.mount(host);

    expect(host.textContent).toContain('list-page');
    app.unmount();
  });

  it('renders the default slot when nothing matches at this depth', () => {
    const router = makeRouter();
    // Not started → START_LOCATION, render[] is empty at depth 0.
    const host = document.createElement('div');
    const app = createApp({
      render: () => h(RouterOutlet, null, { default: () => h('em', 'fallback') }),
    });
    app.provide(ROUTER_KEY, router);
    app.mount(host);

    expect(host.textContent).toContain('fallback');
    app.unmount();
  });

  it('throws when used without an installed router', () => {
    const host = document.createElement('div');
    const app = createApp({ render: () => h(RouterOutlet) });
    expect(() => app.mount(host)).toThrow(/without an installed router/);
  });
});

describe('RouterOutlet — default slot', () => {
  it('renders the default slot when nothing matches at this depth', async () => {
    // A nested outlet past the end of the render chain: the fallback is what a
    // layout uses for "no child route selected".
    const router = createRouter({
      base: '',
      history: createMemoryHistory(''),
      routes: [{ name: 'home', path: '/', component: 'Home' }],
      components: { Home: defineComponent({ render: () => h(RouterOutlet, null, { default: () => h('em', 'empty') }) }) },
    });
    await router.isReady();

    const app = createApp(defineComponent({ render: () => h(RouterOutlet) }));
    app.use(router);
    const host = document.createElement('div');
    app.mount(host);

    expect(host.innerHTML).toContain('empty');
    app.unmount();
    router.destroy();
  });
});

describe('RouterOutlet — nothing to render and no slot', () => {
  it('renders null rather than failing when there is no match and no default slot', async () => {
    const router = createRouter({
      base: '',
      history: createMemoryHistory(''),
      routes: [{ name: 'home', path: '/', component: 'Home' }],
      components: { Home: defineComponent({ render: () => h(RouterOutlet) }) }, // nested, past the chain
    });
    await router.isReady();

    const app = createApp(defineComponent({ render: () => h(RouterOutlet) }));
    app.use(router);
    const host = document.createElement('div');
    expect(() => app.mount(host)).not.toThrow();
    app.unmount();
    router.destroy();
  });
});
