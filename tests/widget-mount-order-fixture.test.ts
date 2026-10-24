// @vitest-environment happy-dom
// FIXTURE - a widget with a child and a template ref: the child and the ref are in place before the host's mounted hook. The note is at the end.

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

/*
 * WHY THIS FILE EXISTS. On Vue 3.6.0-rc.12 a Vapor custom element created its
 * component before the app mounted it, outside the flush that the root mount
 * runs. The jobs the creation queued (template refs, the mounted hooks of
 * children) ran later: the host's mounted hook saw `null` for its ref and ran
 * before the child's. Vue 3.6.0-rc.13 (#15991, "flush custom element component
 * creation with its mount") flushes both together. This file fails on rc.12
 * and passes on rc.13 (docs/rc-alignment-log.md, section 36.F43).
 *
 * defineWidget is this library's way to define such an element, through
 * defineVaporCustomElement, so a widget whose mounted hook reads a ref or a
 * child's state is what an app sees.
 */
