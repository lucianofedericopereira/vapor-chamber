/**
 * The tracking pair /vue wires at build time is not replaced by the runtime lookup's pair.
 * Why: in a bundle that inlines Vue and runs in Node, the lookup resolves Node's own @vue/reactivity, a second instance; if it replaced the build-time pair, untracked() would pause the wrong instance and effects would re-run on a handler's read.
 * Shows: on src, a pair wired before the lookup settles is still the one untracked() calls; on a built bundle, untracked() keeps suspending tracking after the lookup settles (wrapped 1, raw control 2).
 * See: log s35.229
 */
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
    // Wire a recording pair as src/vue.ts does on import, before chamber's runtime lookup settles.
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
    // The lookup resolves Node's @vue/reactivity, not the inlined copy; wait for it to settle.
    await new Promise((r) => setTimeout(r, 50));
    expect(app.run()).toEqual({ wrapped: 1, raw: 2 });
  });
});
