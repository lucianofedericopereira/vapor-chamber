// /vue's build-time tracking pair is not replaced by the runtime lookup's; rationale at the end.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect, vi } from 'vitest';
import { it } from '../src/vitest';

const repo = resolve(__dirname, '..');
const dist = join(repo, 'dist');
const out = mkdtempSync(join(repo, 'node_modules', '.cache', 'vc-untracked-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('the build-time pair wins over the runtime lookup', () => {
  it('src: a pair wired as /vue wires it is still the one untracked() calls once the lookup settles', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    // What src/vue.ts does on import, with a pair that records its calls, wired
    // before the runtime lookup (started by chamber's import) has settled.
    const calls: string[] = [];
    chamber._wireUntrack(() => { calls.push('pause'); }, () => { calls.push('reset'); }, true);
    await chamber.waitForVueDetection();
    chamber.untracked(() => 0);
    expect(calls).toEqual(['pause', 'reset']);
  });
});

describe('untracked() in a bundle that inlines Vue, run in Node', () => {
  it('keeps suspending tracking after the runtime lookup settles', async () => {
    const entry = join(out, 'app.in.mjs');
    const file = join(out, 'app.mjs');
    writeFileSync(entry, `
      import { effect, shallowRef } from 'vue';
      import { untracked } from ${JSON.stringify(join(dist, 'vue.js'))};
      import { createCommandBus } from ${JSON.stringify(join(dist, 'index.js'))};
      export function run() {
        const bus = createCommandBus();
        const src = shallowRef(0);
        bus.register('read', () => src.value);
        let wrapped = 0;
        let raw = 0;
        effect(() => { wrapped++; untracked(() => bus.dispatch('read', null)); });
        effect(() => { raw++; bus.dispatch('read', null); });
        src.value = 1;
        return { wrapped, raw };
      }
    `);
    await build({
      entryPoints: [entry],
      outfile: file,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
      define: {
        'process.env.NODE_ENV': '"production"',
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
    });
    const app = await import(pathToFileURL(file).href);
    // raw is the control: without untracked() the handler's read re-runs the effect.
    expect(app.run()).toEqual({ wrapped: 1, raw: 2 });
    // The runtime lookup's import('@vue/reactivity') resolves Node's copy, not
    // the one inlined in the bundle. Let it settle, then ask again.
    await new Promise((r) => setTimeout(r, 50));
    expect(app.run()).toEqual({ wrapped: 1, raw: 2 });
  });
});

/*
 * Why this file exists. vapor-chamber/vue wires untracked() at build time: it
 * imports pauseTracking and resetTracking from @vue/reactivity, so the
 * consumer's bundler resolves the copy the app's Vue uses. The root's runtime
 * lookup also imports @vue/reactivity, by a specifier assembled at runtime so
 * no bundler folds it. In a browser bundle that import fails. In a bundle run
 * in Node (a server build that inlines Vue, a test harness) it resolves Node's
 * own copy, a second reactivity instance. It then replaced the build-time pair,
 * and untracked() paused the wrong instance: the effect re-ran on the
 * handler's read (wrapped 2), measured on Vue 3.6.0-rc.10 and 3.5.43 (log
 * s35.229). vue.ts promises "no probe to lose a race with"; the build-time
 * pair now wins.
 */
