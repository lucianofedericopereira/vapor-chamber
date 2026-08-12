// @vitest-environment happy-dom
/**
 * FIXTURE — custom directives on a real Vapor app, vue@3.6.0-rc.3.
 *
 * WHY THIS FILE EXISTS. Four places in this repo asserted that custom
 * directives are a VDOM-only feature and will never work in Vapor:
 * ROADMAP's "what is not on the roadmap" list ("the Vue team has consistently
 * signaled directives remain a VDOM-only feature"), whitepaper §10.3, the
 * README composables note, and a runtime `console.warn` in
 * `src/directives.ts` fired at plugin install whenever Vapor is detected.
 *
 * The claim is false, and was false when it was written. `withVaporDirectives`
 * is a public export of the with-vapor build and ships in EVERY Vue version
 * this project has tracked — verified by unpacking the published
 * `@vue/runtime-vapor` dist for 3.6.0-alpha.3, beta.8, beta.10, beta.15,
 * beta.17, rc.1 and rc.2: the helper is present in all of them. rc.3 did not
 * add the feature; it hardened it (#15258 codegen parens, #15167 async
 * component roots, #15158 fragment roots).
 *
 * So this fixture measures the thing the docs asserted about, the same way
 * `tests/router/vapor-fixture.test.ts` measures provide/inject rather than
 * trusting a roadmap checkbox. The rule that file states cuts both ways: an
 * unchecked box never meant missing — and a confident sentence in our own
 * docs is not evidence either.
 *
 * WHAT IS ACTUALLY DIFFERENT IN VAPOR (the reason a port is not a rename):
 * a Vapor directive is a PLAIN FUNCTION, not the VDOM object-hook record.
 *
 *   VDOM   { mounted(el, binding), updated(el, binding), beforeUnmount(el) }
 *   Vapor  (el, value, argument, modifiers) => cleanup | void
 *
 * It is invoked ONCE per root element inside a detached `EffectScope`, and a
 * returned function is registered via `onScopeDispose`. There is no `updated`
 * hook at all — a Vapor directive that must react to changing values creates
 * its own effect inside that scope, because `value` is delivered as a getter.
 * That is the substantive porting cost for `v-vc:command`, and the reason
 * this fixture asserts the shape rather than just "it runs".
 *
 * Everything is imported from the single with-vapor browser build on purpose —
 * two separately-imported Vue dists are two disconnected reactivity instances
 * (chamber.ts §probeVue, whitepaper §11.6), so mixing builds here would
 * silently measure nothing.
 */

import { describe, expect, it } from 'vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

type VaporDir = (el: Element, value: () => unknown, argument?: string, modifiers?: Record<string, boolean>) => (() => void) | void;

type VaporApi = {
  createVaporApp: (root: unknown) => { mount: (el: unknown) => void; unmount: () => void };
  defineVaporComponent: (c: unknown) => unknown;
  withVaporDirectives: (node: unknown, dirs: Array<[VaporDir, (() => unknown)?, string?, Record<string, boolean>?]>) => void;
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
    // The lib's own claim ("VDOM-only, no Vapor port planned") rests on this
    // being absent. It is not absent, and never was.
    expect(typeof v.withVaporDirectives).toBe('function');
  });

  it('runs a custom directive on a vapor component and passes el/value/arg/modifiers', async () => {
    const { createVaporApp, defineVaporComponent, withVaporDirectives, template } = await vapor();

    const seen: Array<{ tag: string; value: unknown; argument?: string; modifiers?: Record<string, boolean> }> = [];

    const vProbe: VaporDir = (el, value, argument, modifiers) => {
      seen.push({ tag: el.tagName, value: value(), argument, modifiers });
    };

    const Comp = defineVaporComponent({
      setup() {
        const el = template('<button>go</button>', true)();
        // Shape mirrors what compiler-vapor emits for
        //   <button v-probe:cmd.stop="'cartAdd'">
        withVaporDirectives(el, [[vProbe, () => 'cartAdd', 'cmd', { stop: true }]]);
        return el;
      },
    });

    const host = document.createElement('div');
    createVaporApp(Comp).mount(host);

    // MEASURED on 3.6.0-rc.3: the directive runs, against a real element, with
    // the full binding surface v-vc:command needs (action value, arg, modifiers).
    expect(seen).toHaveLength(1);
    expect(seen[0].tag).toBe('BUTTON');
    expect(seen[0].value).toBe('cartAdd');
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

    // This is the exact behaviour `v-vc:command` needs: a direct listener on a
    // real element inside a Vapor component. It works.
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

    // The returned function is registered with onScopeDispose on a detached
    // scope, so teardown is scope-driven — which is exactly the lifecycle
    // every composable in this lib already uses (tryAutoCleanup).
    expect(cleaned).toBe(1);
  });

  it('has NO updated hook — the value arrives as a getter, reactivity is the directive\'s own job', async () => {
    const { createVaporApp, defineVaporComponent, withVaporDirectives, template, shallowRef, renderEffect, nextTick } = await vapor();

    const action = shallowRef('cartAdd');
    const invocations: string[] = [];   // how many times the directive fn itself ran
    const effectReads: string[] = [];   // what an effect INSIDE the directive saw

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

    // THE PORTING CONSTRAINT, pinned: the directive function is NOT re-invoked
    // on a value change (no `updated` hook exists). Only an effect the
    // directive opened itself sees the new value. A port of v-vc:command that
    // reads `binding.value` once and stores it would silently freeze on the
    // first action name.
    expect(invocations).toEqual(['cartAdd']);
    expect(effectReads).toEqual(['cartAdd', 'cartRemove']);
  });
});
