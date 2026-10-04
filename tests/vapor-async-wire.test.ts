/**
 * `defineVaporAsyncComponent` under `vaporChamberWire({ entry: 'vapor' })`
 * (decision 6, D1 scoped to the plugin; build list A5). Rationale at the end.
 *
 * Real Vite production builds of three consumers, the way
 * tests/vite-wire-plugin.test.ts builds them: the package resolved through
 * node_modules to `dist/`. The one read for its imports keeps `vue` external;
 * the two run in Node afterwards bundle it (Node would resolve an external
 * `vue` to its CJS build, which has no Vapor exports), so "non-null in
 * production" is an executed fact, not a reading of the bundle.
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

/** A production build of `source`, its chunks joined; `vue` stays an import unless `withVue`. */
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

/*
 * Decision 6 (owner, 2026-10-02; .probes/1.26-remaining.md row 6, plan list
 * row 9). `vapor-chamber/vapor` seeded Vue's `defineVaporAsyncComponent` into
 * the registry for the root's wrapper, a static import every `/vapor` app kept
 * whether it defined an async component or not (1.84 KB raw / 0.74 KB gzip on
 * the vapor-sfc example, vapor.ts's table). D1, the seed dropped and /vapor's
 * wrapper calling Vue's directly, would make the root's own documented example
 * (chamber-vapor.ts) return null in production only, where the probe that
 * fills the registry in dev does not run, and where a DEV warning cannot fire.
 * So D1 is scoped to the plugin: under `entry: 'vapor'` the wired root exports
 * /vapor's wrapper by name (an explicit export beats `export *`), the plugin
 * defines `__VC_WIRED_VAPOR__` in a build, and the seed sits in a condition
 * on it. Every other build keeps today's seed and behaviour.
 *
 * Seeded red: the second test fails on today's tree (the seed keeps the
 * import); the first fails with the condition in place but the wired root's
 * explicit export removed (null); the third fails with the seed under the
 * condition and no `typeof` guard defaulting it on.
 *
 * examples/vapor-sfc does not use vaporChamberWire (examples/vite.base.ts
 * composes `vue()` and `vaporChamberHMR()` only), so the saving shows in
 * these fixture builds, not in that example.
 */
