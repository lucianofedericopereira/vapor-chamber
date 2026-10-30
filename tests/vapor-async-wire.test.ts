/**
 * `defineVaporAsyncComponent` in real Vite production builds under `vaporChamberWire({ entry: 'vapor' })`.
 * Why: the root's async wrapper would return null in production if the plugin dropped the registry seed, and an app that never defines an async component would ship Vue's async code if the seed stayed unconditional.
 * Shows: a built root-import app executes and gets a component; a built app without one imports no `defineVaporAsyncComponent` from vue; the plugin defines `__VC_WIRED_VAPOR__` only in a build under `entry: 'vapor'`; without the plugin, importing `/vapor` still seeds the root wrapper.
 * See: log s35.109, tests/vite-wire-plugin.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vaporChamberWire } from '../src/vite-hmr';
import { requireDist } from './require-dist';

requireDist(['index.js', 'vue.js', 'vapor.js'].every((f) => existsSync(resolve(process.cwd(), 'dist', f))));

// Uses the root's async wrapper, nothing from /vapor.
const ROOT_ASYNC = `import { defineVaporAsyncComponent } from 'vapor-chamber';
globalThis.__vcAsync = defineVaporAsyncComponent(() => Promise.resolve({ setup: () => [] }));
`;
// Uses the root's composables only: no async component anywhere.
const ROOT_ONLY = `import { useCommand, getCommandBus } from 'vapor-chamber';
getCommandBus().register('ping', () => 'pong');
const { dispatch } = useCommand();
globalThis.__vcGo = () => dispatch('ping', null);
`;
// No plugin: wires through /vapor, then calls the ROOT's async wrapper.
const VAPOR_THEN_ROOT = `import 'vapor-chamber/vapor';
import { defineVaporAsyncComponent } from 'vapor-chamber';
globalThis.__vcAsync = defineVaporAsyncComponent(() => Promise.resolve({ setup: () => [] }));
`;

let dir: string;

beforeAll(() => {
  const cache = resolve(process.cwd(), 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, 'vc-async-'));
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A production build of `source`, its chunks joined; `vue` stays an import unless `withVue` (a bundle run in Node needs it bundled: Node resolves an external `vue` to its CJS build, which has no Vapor exports). */
async function bundle(name: string, source: string, plugins: unknown[], withVue = false): Promise<string> {
  writeFileSync(join(dir, `${name}.js`), source);
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    mode: 'production',
    plugins: plugins as never,
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: { input: join(dir, `${name}.js`), external: withVue ? [] : ['vue', '@vue/reactivity'], output: { format: 'es', inlineDynamicImports: true } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
  return outputs.filter((o) => o.type === 'chunk').map((c) => (c as { code: string }).code).join('\n');
}

/** Run a bundle in this process. */
async function run(name: string, code: string): Promise<void> {
  const file = join(dir, `${name}.out.mjs`);
  writeFileSync(file, code);
  await import(pathToFileURL(file).href);
}

const importsFromVue = (code: string) =>
  [...code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']vue["']/g)].flatMap((m) => m[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0]));

describe("vaporChamberWire({ entry: 'vapor' }) and the async wrapper", () => {
  it("a root-import app gets a component in production, through /vapor's wrapper", async () => {
    const code = await bundle('root-async', ROOT_ASYNC, [vaporChamberWire({ entry: 'vapor' })], true);
    delete (globalThis as { __vcAsync?: unknown }).__vcAsync;
    await run('root-async', code);
    expect((globalThis as { __vcAsync?: unknown }).__vcAsync).toBeTruthy();
  });

  it('an app that never defines one ships no Vue async code', async () => {
    const code = await bundle('root-only', ROOT_ONLY, [vaporChamberWire({ entry: 'vapor' })]);
    expect(code).toContain('function useCommand(');
    expect(importsFromVue(code)).toEqual(expect.arrayContaining(['createVaporApp', 'defineVaporComponent']));
    expect(importsFromVue(code)).not.toContain('defineVaporAsyncComponent');
  });

  it("the plugin defines __VC_WIRED_VAPOR__ in a build under entry: 'vapor' only", () => {
    const build = { command: 'build' as const };
    expect(vaporChamberWire({ entry: 'vapor' }).config({}, build).define.__VC_WIRED_VAPOR__).toBe('true');
    expect(vaporChamberWire().config({}, build).define.__VC_WIRED_VAPOR__).toBeUndefined();
    expect(vaporChamberWire({ entry: 'vapor' }).config({}, { command: 'serve' }).define.__VC_WIRED_VAPOR__).toBeUndefined();
  });

  it('without the plugin, /vapor still seeds the registry for the root wrapper', async () => {
    const code = await bundle('vapor-then-root', VAPOR_THEN_ROOT, [], true);
    delete (globalThis as { __vcAsync?: unknown }).__vcAsync;
    await run('vapor-then-root', code);
    expect((globalThis as { __vcAsync?: unknown }).__vcAsync).toBeTruthy();
  });
});
