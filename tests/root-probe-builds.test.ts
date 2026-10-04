/** The root's Vue probe in consumer builds: folded when wired, absent for getCommandBus. The long note is at the end. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as esbuild } from 'esbuild';
import { build as vite } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { vaporChamberWire } from '../src/vite-hmr';
import { requireDist } from './require-dist';

const repo = process.cwd();
const dist = (f: string) => resolve(repo, 'dist', f);
requireDist(existsSync(dist('index.js')) && existsSync(dist('vue.js')) && existsSync(dist('vapor-chamber.iife.min.js')));

const PROD = { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'false', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' };
const WIRED = { __VC_WIRED_BUILD__: 'true' };
/** Exports only a whole Vue namespace carries; a tree-shaken app that uses ref() has none of them. */
const ALL_OF_VUE = ['createSSRApp', 'Teleport', 'KeepAlive', 'TransitionGroup', 'defineCustomElement'];
const hasAllOfVue = (code: string) => ALL_OF_VUE.every((m) => code.includes(m));

const WIRED_APP = `import { effectScope, ref } from 'vue';
import { createCommandBus, setCommandBus } from '${dist('index.js')}';
import { useCommand } from '${dist('vue.js')}';
const bus = createCommandBus(); setCommandBus(bus); bus.register('inc', (c) => c.payload + 1);
const c = effectScope().run(() => useCommand());
globalThis.out = [c.dispatch('inc', null, 1).value, ref(1).value];
`;

let dir: string;
beforeAll(() => {
  const cache = resolve(repo, 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, 'vc-probe-'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** esbuild, the way an app builds: ESM, splitting, browser, minified. Every emitted file, entry first. */
async function esbuildApp(name: string, source: string, define: Record<string, string>, writeTo?: string) {
  const entry = join(dir, `${name}.js`);
  writeFileSync(entry, source);
  const r = await esbuild({
    entryPoints: [entry], bundle: true, write: writeTo !== undefined, format: 'esm', platform: 'browser',
    minify: true, splitting: true, outdir: writeTo ?? join(dir, `${name}-out`), define: { ...PROD, ...define }, logLevel: 'silent', nodePaths: [join(repo, 'node_modules')],
  });
  const files = r.outputFiles ?? [];
  return { entry: files.find((f) => f.path.endsWith(`${name}.js`))?.text ?? '', all: files.map((f) => f.text).join('\n') };
}

describe('a wired Vue app built by esbuild', () => {
  it('control: without the define, the probe pulls all of Vue into the build', async () => {
    const { all } = await esbuildApp('wired-plain', WIRED_APP, {});
    expect(hasAllOfVue(all)).toBe(true);
  });

  it('with __VC_WIRED_BUILD__ defined true, the probe folds and Vue is tree-shaken', async () => {
    const { all } = await esbuildApp('wired-define', WIRED_APP, WIRED);
    expect(hasAllOfVue(all)).toBe(false);
    expect(all.includes('__VAPOR_CHAMBER_VUE__')).toBe(false);
  });
});

describe('a Vue-less app using the shared bus', () => {
  it('control: an app that keeps the probe module imports a chunk at load', async () => {
    const { entry } = await esbuildApp('probe-kept', `import { waitForVueDetection } from '${dist('index.js')}';\nglobalThis.w = waitForVueDetection;\n`, {});
    expect(/import\(/.test(entry)).toBe(true);
  });

  it('getCommandBus does not bring the probe: nothing imported at load, no __VUE__ read', async () => {
    const { entry } = await esbuildApp('shared-bus', `import { createCommandBus, getCommandBus } from '${dist('index.js')}';\nglobalThis.b = [createCommandBus(), getCommandBus()];\n`, {});
    expect(/import\(/.test(entry)).toBe(false);
    expect(entry.includes('__VUE__')).toBe(false);
  });
});

describe('a root-only Vue app keeps working', () => {
  it('esbuild production, no define: signal() is a Vue ref after waitForVueDetection', async () => {
    const out = mkdtempSync(join(tmpdir(), 'vc-rootonly-'));
    try {
      await esbuildApp('rootonly', `import { isRef } from 'vue';
import { waitForVueDetection, signal } from '${dist('index.js')}';
await waitForVueDetection();
globalThis.__vcRootOnly = isRef(signal(0));
`, {}, out);
      await import(pathToFileURL(join(out, 'rootonly.js')).href);
      expect((globalThis as { __vcRootOnly?: boolean }).__vcRootOnly).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('vaporChamberWire defines __VC_WIRED_BUILD__ in a Vite build', () => {
  async function viteApp(plugins: unknown[]) {
    const entry = join(dir, 'vite-main.js');
    writeFileSync(entry, `import { useCommand, getCommandBus } from 'vapor-chamber';
getCommandBus().register('ping', () => 'pong');
const { dispatch, loading } = useCommand();
globalThis.go = () => { dispatch('ping', null); return loading.value; };
`);
    const r = await vite({
      configFile: false, root: dir, logLevel: 'silent', mode: 'production', plugins: plugins as never,
      build: { write: false, minify: true, modulePreload: false, rollupOptions: { input: entry, external: ['vue', '@vue/reactivity'] } },
    });
    return (Array.isArray(r) ? r : [r]).flatMap((o) => ('output' in o ? o.output : [])).filter((o) => o.type === 'chunk').map((c) => (c as { code: string }).code).join('\n');
  }

  it('control: without the plugin the probe ships', async () => {
    expect((await viteApp([])).includes('__VAPOR_CHAMBER_VUE__')).toBe(true);
  });

  it('with the plugin the probe folds away', async () => {
    const code = await viteApp([vaporChamberWire()]);
    expect(/configureVue\(|shallowRef/.test(code)).toBe(true);
    expect(code.includes('__VAPOR_CHAMBER_VUE__')).toBe(false);
  });

  it('the plugin object: the define in a build, __VC_WIRED__ under serve', () => {
    expect(vaporChamberWire().config({}, { command: 'build' })).toEqual({ define: { __VC_WIRED_BUILD__: 'true', __VC_LEAN__: 'false' } });
    expect(vaporChamberWire().config({}, { command: 'serve' })).toEqual({ define: { __VC_WIRED__: 'true', __VC_LEAN__: 'false' } });
  });
});

describe('the shipped files', () => {
  it('the ESM build carries the guard; the IIFE builds define it false and fold it', () => {
    expect(readFileSync(dist('chamber.js'), 'utf8').includes('typeof __VC_WIRED_BUILD__')).toBe(true);
    for (const f of ['vapor-chamber.iife.min.js', 'vapor-chamber-core.iife.min.js', 'vapor-chamber-elements.iife.min.js']) {
      expect([f, readFileSync(dist(f), 'utf8').includes('__VC_WIRED_BUILD__')]).toEqual([f, false]);
    }
  });
});

describe('the source guard, read as a global (as vitest and a dev server deliver a define)', () => {
  afterEach(() => {
    delete (globalThis as { __VC_WIRED_BUILD__?: boolean }).__VC_WIRED_BUILD__;
    delete (globalThis as { __VUE__?: unknown }).__VUE__;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('control: unset, the probe finds Vue and the unwired warning can fire', async () => {
    vi.resetModules();
    const { signal, waitForVueDetection } = await import('../src/chamber');
    const { isRef } = await import('vue');
    await waitForVueDetection();
    expect(isRef(signal(0))).toBe(true);
  });

  it('true: no probe, nothing to await, and no unwired warning even with __VUE__ set', async () => {
    (globalThis as { __VC_WIRED_BUILD__?: boolean }).__VC_WIRED_BUILD__ = true;
    (globalThis as { __VUE__?: unknown }).__VUE__ = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { signal, waitForVueDetection, tryAutoCleanup } = await import('../src/chamber');
    const { isRef } = await import('vue');
    await waitForVueDetection();
    expect(isRef(signal(0))).toBe(false);
    tryAutoCleanup(() => {});
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('without reactivity'))).toEqual([]);
  });
});

/*
 * Bugs B1, B2 and B11 of the 1.26 evaluation (log s35.41).
 *
 * The root reaches Vue through a runtime probe, `import(vuePkg)` with the
 * specifier in a variable. Vite leaves that import alone; esbuild and webpack
 * resolve it, to the whole Vue namespace. So an esbuild or webpack app that
 * imports its composables the documented way (bus from the root, composables
 * from `vapor-chamber/vue`) still carried all of Vue, because `vue.js`
 * reaches `chamber.js` and `chamber.js` holds the probe (B1), and every
 * webpack build of the root warned "Critical dependency" (B11).
 *
 * B1. A wired build needs no probe: `vapor-chamber/vue` wires Vue at build
 * time. The probe's body and the unwired warning now sit inside a condition on
 * `__VC_WIRED_BUILD__`, which `vaporChamberWire()` defines in a Vite build and
 * which an esbuild or webpack app defines with one line. Conditions, never an
 * early return: Vite's minifier kept a function's body after a folded
 * `if (true) return` (measured in the evaluation). Without the define nothing
 * changes, which is what keeps a root-only Vue app working on esbuild and
 * webpack, where the probe resolves the bundled Vue (the fourth block; the
 * Vite dev server and webpack were checked by the evaluation's probes). The
 * IIFE builds define it false, so the guard costs them nothing. The last
 * block runs the guard in vitest, where a define arrives as a global.
 *
 * B2. `getCommandBus` lived in `chamber.ts`, so a Vue-less app that used the
 * shared bus kept the probe module and loaded a Vue chunk at start. The shared
 * bus now lives in a probe-free module, re-exported from `chamber.ts`.
 */
