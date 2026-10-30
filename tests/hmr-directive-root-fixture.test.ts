// @vitest-environment happy-dom
/**
 * `v-vc-command` on a component follows its root element through a real HMR rerender, under a Vapor and a vDOM parent.
 * Why: after a hot reload the directive would sit on the replaced root, so the new button dispatches nothing while the detached one still does (a dead control in the dev editing loop).
 * Shows: the directive dispatches on the first root, after the rerender only the new root dispatches, and after unmount neither does; uses the real __VUE_HMR_RUNTIME__ of the with-vapor build.
 * See: docs/rc-alignment-log.md, tests/compile-vapor.ts.
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
    // The probe's import('vue') loads a second Vue that also writes __VUE_HMR_RUNTIME__; settle it first so the with-vapor build writes last.
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
      // Positive control: without it, "the new root dispatches" could pass on a directive that never mounted.
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
