// @vitest-environment happy-dom
/**
 * FIXTURE - `v-vc-command` on a component follows its root through a real HMR
 * rerender, on both renderers. Fails on Vue 3.6.0-rc.10, passes from rc.11.
 * The long note is at the end of this file.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, resetCommandBus, setCommandBus, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('v-vc-command across an HMR rerender of the component it sits on', () => {
  const seen: string[] = [];
  let v: VaporApi;

  beforeAll(async () => {
    // The probe's `import('vue')` loads a second Vue that also writes
    // __VUE_HMR_RUNTIME__; settled first, the with-vapor build writes last.
    await waitForVueDetection();
    v = await import(/* @vite-ignore */ WITH_VAPOR);
    configureVue(v);
  });

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd: { action: string }) => {
      seen.push(cmd.action);
    });
  });

  const click = async (el: Element | null) => {
    seen.length = 0;
    (el as HTMLElement).click();
    await settle();
    return [...seen];
  };

  for (const parent of ['vapor', 'vdom'] as const) {
    it(`${parent} parent: the new root dispatches and the replaced one does not`, async () => {
      const hmr = (globalThis as any).__VUE_HMR_RUNTIME__;
      const id = `hmr-directive-root-${parent}`;
      const Child = v.defineVaporComponent({
        __hmrId: id,
        render: () => v.template('<button id="a">A</button>', true)(),
      });
      hmr.createRecord(id, Child);

      const host = document.createElement('div');
      document.body.appendChild(host);
      const source = `<div><Child v-vc-command="'cartAdd'" /></div>`;
      let app: VaporApi;
      if (parent === 'vapor') {
        const tpl = await compileVapor(v, source);
        app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render({}) }));
        app.directive('vc-command', vcCommandVapor);
      } else {
        const tpl = await compileVdom(v, source);
        app = v.createApp({ render: () => tpl.render({}, []) });
        app.use(v.vaporInteropPlugin).use(createDirectivePlugin());
      }
      app.component('Child', Child);
      app.mount(host);

      const first = host.querySelector('#a');
      // Positive control: the directive is live on the first root.
      expect(await click(first)).toEqual(['cartAdd']);

      hmr.rerender(id, () => v.template('<button id="b">B</button>', true)());
      await v.nextTick();
      const second = host.querySelector('#b');
      expect(second).toBeTruthy();
      expect(await click(second)).toEqual(['cartAdd']);
      // The replaced root is detached but still clickable through its reference.
      expect(await click(first)).toEqual([]);

      app.unmount();
      expect(await click(second)).toEqual([]);
      host.remove();
    });
  }
});

/*
 * WHY THIS FILE EXISTS. `v-vc-command` written on a COMPONENT lands on that
 * component's root element: through `withVaporDirectives` in a Vapor parent,
 * through interop's directive hooks in a vDOM parent. An HMR rerender of the
 * component swaps the root in place without the parent rendering again.
 *
 * Measured on Vue 3.6.0-rc.10 (docs/rc-alignment-log.md, the rc.11 cycle),
 * both parents: after the rerender the new root dispatched nothing and the
 * detached one still did. A dev-only dead control, gone at the next full
 * reload, so nothing a production page sees - but it is the editing loop.
 *
 * Vue 3.6.0-rc.11 `e6f62259` re-applies root-chain state after a rerender:
 * custom directives (`hmrRootHooks` in `withVaporDirectives`), interop
 * directive hooks, v-show and transitions. Nothing in `src` changed for it.
 *
 * The HMR runtime is the real `__VUE_HMR_RUNTIME__` of the with-vapor build,
 * and the parent templates go through tests/compile-vapor.ts on the installed
 * Vue. The first click is the positive control: without it, "the new root
 * dispatches" could pass on a directive that never mounted at all.
 */
