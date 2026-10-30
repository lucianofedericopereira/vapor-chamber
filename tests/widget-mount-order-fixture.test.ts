// @vitest-environment happy-dom
/**
 * `defineWidget` on a Vapor component with a child and a template ref, placed in the DOM as a custom element.
 * Why: if a custom element's component were created outside the flush of its mount, the host's mounted hook would see a null template ref and run before its child's mounted hook.
 * Shows: in the same tick the tag is placed, the child's mounted hook runs first and the host's mounted hook sees its ref as a DIV, and the order is unchanged a tick later.
 * See: vuejs/core#15991, log s36.F43
 */

import { afterEach, beforeAll, expect, it } from 'vitest';
import { configureVue, waitForVueDetection } from '../src/chamber';
import { defineWidget } from '../src/widget';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
let v: VaporApi;

beforeAll(async () => {
  await waitForVueDetection();
  v = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
});

const boxes: Element[] = [];
afterEach(() => {
  for (const b of boxes.splice(0)) b.remove();
});

async function mountOrder(tag: string): Promise<{ sync: string[]; later: string[] }> {
  const calls: string[] = [];
  const child = await compileVapor(v, '<p>child</p>');
  const host = await compileVapor(v, '<div ref="el"><Child /></div>');
  const Child = v.defineVaporComponent({
    setup() {
      v.onMounted(() => calls.push('child mounted'));
      return {};
    },
    render: child.render,
  });
  const Widget = v.defineVaporComponent({
    components: { Child },
    setup() {
      const el = v.ref(null);
      v.onMounted(() => calls.push(`mounted ${el.value?.tagName}`));
      return { el };
    },
    render: host.render,
  });
  expect(defineWidget(tag, Widget)).toBe(true);
  const box = document.createElement('div');
  document.body.append(box);
  boxes.push(box);
  box.innerHTML = `<${tag}></${tag}>`;
  const sync = calls.slice();
  await v.nextTick();
  return { sync, later: calls.slice() };
}

it('the child mounts and the ref is set before the host mounted hook, in the tick the tag is placed', async () => {
  const r = await mountOrder('vc-mount-order');
  expect(r.sync).toEqual(['child mounted', 'mounted DIV']);
  expect(r.later).toEqual(['child mounted', 'mounted DIV']);
});
