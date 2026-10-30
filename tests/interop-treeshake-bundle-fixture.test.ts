// @vitest-environment happy-dom
/**
 * Fixture: a vDOM app with vaporInteropPlugin and a Vapor child, bundled for production with and without Transition and KeepAlive.
 * Why: Vue gates its vapor interop code behind flags the plugin and those components set so a bundler can drop it; a flag left false where the code is needed would keep the Vapor child from mounting or leaving.
 * Shows: both bundle shapes mount the Vapor child, remove it and mount it again in happy-dom, and the bundle without Transition and KeepAlive is smaller by brotli size.
 * See: vuejs/core#15990, vuejs/core#15994, log 36.F43.
 */

import { build } from 'esbuild';
import { brotliCompressSync } from 'node:zlib';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const root = process.cwd();
const BUNDLER_BUILD = resolve(root, 'node_modules/vue/dist/vue.runtime.esm-bundler.js');

function entry(full: boolean): string {
  return `
import { createApp, h, ref, nextTick, defineVaporComponent, template, vaporInteropPlugin${full ? ', Transition, KeepAlive' : ''} } from 'vue';
const Child = defineVaporComponent({ setup: () => template('<p>vapor child</p>', true)() });
const show = ref(true);
const render = () => ${full ? "h(Transition, { mode: 'out-in' }, () => show.value ? h(KeepAlive, null, [h(Child)]) : h('span', 'gone'))" : "show.value ? h(Child) : h('span', 'gone')"};
globalThis.__interop = async (el) => {
  const app = createApp({ render });
  app.use(vaporInteropPlugin);
  app.mount(el);
  const first = el.innerHTML;
  show.value = false;
  await nextTick();
  await new Promise((r) => setTimeout(r, 30));
  const second = el.innerHTML;
  show.value = true;
  await nextTick();
  await new Promise((r) => setTimeout(r, 30));
  const third = el.innerHTML;
  app.unmount();
  return { first, second, third };
};`;
}

async function bundle(full: boolean): Promise<{ code: string; brotli: number }> {
  const r = await build({
    stdin: { contents: entry(full), resolveDir: root, loader: 'js' },
    bundle: true,
    minify: true,
    format: 'iife',
    write: false,
    alias: { vue: BUNDLER_BUILD },
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    logLevel: 'error',
  });
  const code = r.outputFiles[0].text;
  return { code, brotli: brotliCompressSync(code).length };
}

async function run(code: string): Promise<{ first: string; second: string; third: string }> {
  new Function(code)();
  const el = document.createElement('div');
  document.body.append(el);
  try {
    return await (globalThis as unknown as { __interop: (e: Element) => Promise<{ first: string; second: string; third: string }> }).__interop(el);
  } finally {
    el.remove();
  }
}

it('a production bundle with Transition and KeepAlive mounts the Vapor child and toggles it', async () => {
  const { code } = await bundle(true);
  const r = await run(code);
  expect(r.first).toContain('<p>vapor child</p>');
  expect(r.second).toContain('gone');
  expect(r.third).toContain('<p');
  expect(r.third).toContain('vapor child');
});

it('a production bundle with neither mounts the Vapor child and toggles it the same', async () => {
  const { code } = await bundle(false);
  const r = await run(code);
  expect(r.first).toContain('<p>vapor child</p>');
  expect(r.second).toContain('gone');
  expect(r.third).toContain('vapor child');
});

it('the bundle without Transition and KeepAlive is the smaller one', async () => {
  const [full, plain] = [await bundle(true), await bundle(false)];
  expect(plain.brotli).toBeLessThan(full.brotli);
});
