// @vitest-environment happy-dom
/**
 * Custom directives on a real Vapor app, built from the single with-vapor browser build of Vue.
 * Why: a Vapor directive is a plain function `(el, value, argument, modifiers) => cleanup | void`, run once per root element in a detached `EffectScope`; a port that reads `value` once would freeze on the first value, and one that expects an `updated` hook would never react.
 * Shows: `withVaporDirectives` is exported; the directive receives the element and getters for value and argument plus the modifiers; a directive's click listener works on the mounted DOM; the returned cleanup runs on unmount; the directive function is not re-invoked on a value change while an effect it opened itself sees the new value.
 * See: vuejs/core#15490 (argument is a getter), tests/directives-vapor-fixture.test.ts, tests/router/vapor-fixture.test.ts
 */

import { describe, expect, it } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type VaporDir = (el: Element, value: () => unknown, argument?: () => unknown, modifiers?: Record<string, boolean>) => (() => void) | void;

type VaporApi = {
  createVaporApp: (root: unknown) => { mount: (el: unknown) => void; unmount: () => void };
  defineVaporComponent: (c: unknown) => unknown;
  withVaporDirectives: (node: unknown, dirs: Array<[VaporDir, (() => unknown)?, (() => unknown)?, Record<string, boolean>?]>) => void;
  template: (html: string, root?: boolean) => () => Element;
  shallowRef: <T>(v: T) => { value: T };
  renderEffect: (fn: () => void) => void;
  nextTick: () => Promise<void>;
};

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

describe('custom directives on a vapor app (rc.3)', () => {
  it('exposes withVaporDirectives as a public export', async () => {
    const v = await vapor();
    expect(typeof v.withVaporDirectives).toBe('function');
  });

  it('runs a custom directive on a vapor component and passes el/value/arg/modifiers', async () => {
    const { createVaporApp, defineVaporComponent, withVaporDirectives, template } = await vapor();

    const seen: Array<{ tag: string; value: unknown; argType: string; argument: unknown; modifiers?: Record<string, boolean> }> = [];

    const vProbe: VaporDir = (el, value, argument, modifiers) => {
      // Records the type as well as the read: the shape the runtime hands over is what is pinned.
      seen.push({ tag: el.tagName, value: value(), argType: typeof argument, argument: argument?.(), modifiers });
    };

    const Comp = defineVaporComponent({
      setup() {
        const el = template('<button>go</button>', true)();
        // Same shape compiler-vapor emits for <button v-probe:cmd.stop="'cartAdd'">
        withVaporDirectives(el, [[vProbe, () => 'cartAdd', () => 'cmd', { stop: true }]]);
        return el;
      },
    });

    const host = document.createElement('div');
    createVaporApp(Comp).mount(host);

    // Asserting `typeof` on the argument pins that it is a getter.
    expect(seen).toHaveLength(1);
    expect(seen[0].tag).toBe('BUTTON');
    expect(seen[0].value).toBe('cartAdd');
    expect(seen[0].argType).toBe('function');
    expect(seen[0].argument).toBe('cmd');
    expect(seen[0].modifiers).toEqual({ stop: true });
    expect(host.querySelector('button')).not.toBeNull();
  });

  it('registers a real click listener that survives into the mounted DOM', async () => {
    const { createVaporApp, defineVaporComponent, withVaporDirectives, template } = await vapor();

    const clicks: string[] = [];
    const vCommand: VaporDir = (el, value) => {
      const handler = () => clicks.push(String(value()));
      el.addEventListener('click', handler);
      return () => el.removeEventListener('click', handler);
    };

    const Comp = defineVaporComponent({
      setup() {
        const el = template('<button>go</button>', true)();
        withVaporDirectives(el, [[vCommand, () => 'cartAdd']]);
        return el;
      },
    });

    const host = document.createElement('div');
    const app = createVaporApp(Comp);
    app.mount(host);

    const btn = host.querySelector('button') as HTMLElement;
    btn.click();
    btn.click();

    expect(clicks).toEqual(['cartAdd', 'cartAdd']);
  });

  it('runs the returned cleanup on unmount (the beforeUnmount equivalent)', async () => {
    const { createVaporApp, defineVaporComponent, withVaporDirectives, template } = await vapor();

    let cleaned = 0;
    const vCleanup: VaporDir = () => {
      return () => { cleaned++; };
    };

    const Comp = defineVaporComponent({
      setup() {
        const el = template('<button>go</button>', true)();
        withVaporDirectives(el, [[vCleanup]]);
        return el;
      },
    });

    const app = createVaporApp(Comp);
    app.mount(document.createElement('div'));
    expect(cleaned).toBe(0);

    app.unmount();

    expect(cleaned).toBe(1);
  });

  it('has NO updated hook - the value arrives as a getter, reactivity is the directive\'s own job', async () => {
    const { createVaporApp, defineVaporComponent, withVaporDirectives, template, shallowRef, renderEffect, nextTick } = await vapor();

    const action = shallowRef('cartAdd');
    const invocations: string[] = []; // values seen by each run of the directive function itself
    const effectReads: string[] = []; // values seen by an effect opened inside the directive

    const vTracked: VaporDir = (_el, value) => {
      invocations.push(String(value()));
      renderEffect(() => { effectReads.push(String(value())); });
    };

    const Comp = defineVaporComponent({
      setup() {
        const el = template('<button>go</button>', true)();
        withVaporDirectives(el, [[vTracked, () => action.value]]);
        return el;
      },
    });

    createVaporApp(Comp).mount(document.createElement('div'));
    expect(invocations).toEqual(['cartAdd']);
    expect(effectReads).toEqual(['cartAdd']);

    action.value = 'cartRemove';
    await nextTick();

    // No `updated` hook: only an effect the directive opened itself sees the new value.
    expect(invocations).toEqual(['cartAdd']);
    expect(effectReads).toEqual(['cartAdd', 'cartRemove']);
  });
});
