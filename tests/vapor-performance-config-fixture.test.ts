// @vitest-environment happy-dom
// FIXTURE - app.config.performance on a Vapor app with a v-if and a v-for renders and reports no error. The note is at the end.

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

/*
 * WHY THIS FILE EXISTS. On Vue 3.6.0-rc.12 a render effect that created a
 * nested one (a v-if or v-for branch) ended the component's `renderEffect`
 * performance mark in the inner run. The outer run then measured a mark that
 * was gone and threw `The "vue-renderEffect-N" performance mark has not been
 * set`, which the app's error handler received, and the first render came out
 * empty. Vue 3.6.0-rc.13 (#15993) measures the outermost run only. This file
 * fails on rc.12 and passes on rc.13 (docs/rc-alignment-log.md, section
 * 36.F43).
 *
 * The library measures nothing through this flag. A page that turns it on
 * while it develops (app.config.performance is a documented Vue switch) hits
 * the same render, so the shape here is a component with both branches.
 */
