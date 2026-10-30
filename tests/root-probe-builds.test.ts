/**
 * The root's runtime Vue probe in consumer builds (esbuild, Vite, the shipped dist files, the source guard).
 * Why: an app that wires Vue at build time, or never uses Vue, would ship all of Vue or load a Vue chunk at start; the probe specifier must stay a runtime name so no bundler resolves it.
 * Shows: with __VC_WIRED_BUILD__ defined (esbuild define or vaporChamberWire) the probe and Vue are gone; getCommandBus imports nothing at load; a root-only app emits one file with no dynamic import and still finds Vue in Node; the guard also works as a global.
 * See: log s35.41, log 36.F26
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  it('control: without the define the probe ships, and pulls no Vue of its own', async () => {
    const { all } = await esbuildApp('wired-plain', WIRED_APP, {});
    expect(all.includes('__VAPOR_CHAMBER_VUE__')).toBe(true);
    expect(hasAllOfVue(all)).toBe(false);
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

const ROOT_ONLY = `import { isRef } from 'vue';
import { waitForVueDetection, signal } from '${dist('index.js')}';
await waitForVueDetection();
globalThis.__vcRootOnly = isRef(signal(0));
`;

describe('a root-only Vue app built by esbuild', () => {
  it('the probe stays a runtime name: one file, no Vue chunk made for it', async () => {
    const out = mkdtempSync(join(tmpdir(), 'vc-rootonly-'));
    try {
      await esbuildApp('rootonly', ROOT_ONLY, {}, out);
      expect(readdirSync(out)).toEqual(['rootonly.js']);
      expect(/import\(\s*["'`]/.test(readFileSync(join(out, 'rootonly.js'), 'utf8'))).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('control: run in Node, which resolves the name at runtime, it still finds Vue', async () => {
    const out = mkdtempSync(join(tmpdir(), 'vc-rootonly-node-'));
    try {
      await esbuildApp('rootonly', ROOT_ONLY, {}, out);
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
const { dispatch, pending } = useCommand();
const pinging = pending('ping', null);
globalThis.go = () => { dispatch('ping', null); return pinging.value; };
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
