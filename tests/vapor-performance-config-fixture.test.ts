// @vitest-environment happy-dom
/**
 * `app.config.performance = true` on a Vapor app whose component has a `v-if` and a `v-for`.
 * Why: a render effect that creates a nested one (a branch) would measure a performance mark that is already gone, throw into the app's error handler and leave the first render empty. The library sets no such flag, but a page that turns it on while developing renders the same component.
 * Shows: the first render shows both branches, a push, a hide and a show leave the right text, and the app's error handler receives nothing.
 * See: vuejs/core#15993, log s36.F43
 */

import { beforeAll, expect, it } from 'vitest';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let v: VaporApi;

beforeAll(async () => {
  v = await import(/* @vite-ignore */ WITH_VAPOR);
});

it('branch effects nest inside the component effect, and the render stays whole', async () => {
  const data = v.reactive({ show: true, list: [1] });
  const tpl = await compileVapor(v, '<div v-if="data.show">{{ data.list.length }}</div><i v-for="n in data.list">{{ n }}</i>');
  const errors: string[] = [];
  const root = document.createElement('div');
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render({ data }) }));
  app.config.performance = true;
  app.config.errorHandler = (e: unknown) => {
    errors.push(String(e));
  };
  app.mount(root);
  expect(root.textContent).toBe('11');
  data.list.push(2);
  await v.nextTick();
  data.show = false;
  await v.nextTick();
  data.show = true;
  await v.nextTick();
  expect({ text: root.textContent, errors }).toEqual({ text: '212', errors: [] });
  app.unmount();
});
