// The runtime lookup wires only the Vue the app already has; rationale at the end.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, afterEach, describe, expect, vi } from 'vitest';
import { it } from '../src/vitest';
import { requireDist } from './require-dist';
import { existsSync } from 'node:fs';

const repo = resolve(__dirname, '..');
const dist = join(repo, 'dist');
requireDist(existsSync(join(dist, 'vue.js')) && existsSync(join(dist, 'index.js')));
mkdirSync(join(repo, 'node_modules', '.cache'), { recursive: true });
const out = mkdtempSync(join(repo, 'node_modules', '.cache', 'vc-same-vue-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

afterEach(() => {
  vi.doUnmock('vue');
  vi.doUnmock('@vue/reactivity');
  vi.resetModules();
});

/** A namespace that is not the app's Vue: its own ref, and no scope. */
const otherVue = () => ({ ref: (v: unknown) => ({ value: v }), shallowRef: (v: unknown) => ({ value: v }), getCurrentScope: () => undefined, onScopeDispose: () => {} });

describe('the lookup and a Vue already wired', () => {
  it('a second Vue arriving through the lookup leaves the wired one in place', async () => {
    // The real Vue first, so it is wired before the lookup settles, as /vue does.
    const vue = await vi.importActual<typeof import('vue')>('vue');
    vi.doMock('vue', otherVue);
    vi.resetModules();
    const chamber = await import('../src/chamber');
    chamber.configureVue(vue);
    await chamber.waitForVueDetection();
    expect(chamber.getVueDeepRefFn()).toBe(vue.ref);
  });

  it('control: with nothing wired, the lookup fills the registry', async () => {
    const other = otherVue();
    vi.doMock('vue', () => other);
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();
    expect(chamber.getVueDeepRefFn()).toBe(other.ref);
  });

  it('the same Vue through the lookup still merges what the hand wiring left out', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    const vue = await import('vue');
    chamber.configureVue({ ref: vue.ref, shallowRef: vue.shallowRef });
    await chamber.waitForVueDetection();
    // getCurrentScope came from the lookup: cleanup is armed in a scope.
    let ran = false;
    const scope = vue.effectScope();
    scope.run(() => chamber.tryAutoCleanup(() => { ran = true; }));
    scope.stop();
    expect(ran).toBe(true);
  });

  it("the tracking half wires only a @vue/reactivity whose ref is the registry's", async () => {
    vi.doMock('@vue/reactivity', () => ({ ref: () => ({}), pauseTracking: () => { throw new Error('second copy paused'); }, resetTracking: () => {} }));
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();
    expect(chamber.getVueDeepRefFn()).not.toBeNull();
    expect(chamber.untracked(() => 4)).toBe(4);
  });
});

describe('a Vite SSR build that inlines Vue, run in Node', () => {
  it("keeps the app's reactivity and cleanup once the lookup settles", async () => {
    const dir = join(out, 'ssr');
    mkdirSync(dir, { recursive: true });
    // The app's own package scope: this repo's sideEffects list must not apply.
    writeFileSync(join(dir, 'package.json'), '{"name":"vc-same-vue","private":true,"type":"module"}\n');
    writeFileSync(join(dir, 'main.js'), `
      import { effect, effectScope, shallowRef } from 'vue';
      import { createCommandBus } from ${JSON.stringify(join(dist, 'index.js'))};
      import { useCommand, waitForVueDetection } from ${JSON.stringify(join(dist, 'vue.js'))};
      export async function run() {
        await waitForVueDetection();
        await new Promise((r) => setTimeout(r, 50));
        const bus = createCommandBus();
        bus.register('ping', () => 'pong');
        let heard = 0;
        const scope = effectScope();
        const c = scope.run(() => { const c = useCommand({ bus }); c.on('ping', () => { heard++; }); return c; });
        let runs = 0;
        const watcher = effectScope();
        watcher.run(() => effect(() => { runs++; void c.loading.value; }));
        c.loading.value = true;
        watcher.stop();
        // The control: the app's own state is seen by the app's own effect.
        let own = 0;
        const s = shallowRef(0);
        const ctl = effectScope();
        ctl.run(() => effect(() => { own++; void s.value; }));
        s.value = 1;
        ctl.stop();
        scope.stop();
        bus.dispatch('ping', null);
        return { runs, own, heardAfterStop: heard };
      }
    `);
    await build({
      configFile: false,
      root: dir,
      logLevel: 'silent',
      mode: 'production',
      ssr: { noExternal: true },
      build: { ssr: join(dir, 'main.js'), outDir: join(dir, 'out'), minify: false, rollupOptions: { output: { format: 'es', entryFileNames: 'main.js' } } },
    });
    const app = await import(pathToFileURL(join(dir, 'out', 'main.js')).href);
    expect(await app.run()).toEqual({ runs: 2, own: 2, heardAfterStop: 0 });
  });
});

/*
 * Why this file exists. The root reaches Vue at runtime through a lookup: a
 * bare `import("vue")` and an assembled `import("@vue/reactivity")`. Vite
 * leaves the first one bare. A server build that inlines Vue
 * (`ssr.noExternal`) then loads a second Vue from node_modules when it runs
 * in Node, and the lookup handed that copy to the registry over what
 * vapor-chamber/vue had wired at build time. The app's effects stopped seeing
 * composable state and cleanup was not armed (log s35.231, ssr-vite-inline).
 * The 1.29.0 fix covered the tracking pair only (s35.229).
 *
 * One Vue is one `ref` function: `vue` re-exports @vue/reactivity's own, in
 * Node and in a bundle, and two copies have two (s35.231). So the lookup
 * applies a namespace only to an empty registry or the same Vue, and wires a
 * tracking pair only from the registry's Vue. An empty registry still takes
 * whatever the lookup finds, and a hand wiring with the same Vue still gets
 * the rest merged in.
 */
