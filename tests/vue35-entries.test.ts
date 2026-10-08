// Every entry that reaches Vue loads and works on Vue 3.5, except the documented 3.6-only ones; rationale at the end.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, describe, expect } from 'vitest';
import { it } from '../src/vitest';

const repo = resolve(__dirname, '..');
const dist = join(repo, 'dist');
const require = createRequire(import.meta.url);
const vue35Dir = dirname(require.resolve('vue35/package.json'));
const reactivity35Dir = dirname(require.resolve('@vue/reactivity/package.json', { paths: [vue35Dir] }));

/** The entries documented as Vue >= 3.6 (README, docs/router.md, the modules' own headers). */
const ONLY_36 = ['./vapor', './transitions/vapor', './router/vapor'];

const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { exports: Record<string, unknown> };

/** True when the built module graph from `file` imports bare `vue` or `@vue/reactivity`. */
function reachesVue(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  // A static import, or the root's lookup: import(/* @vite-ignore */ "vue").
  if (/from\s*["'](?:vue|@vue\/reactivity)["']|import\(\s*(?:\/\*[^*]*\*\/\s*)?["']vue["']\s*\)/.test(src)) return true;
  for (const m of src.matchAll(/(?:from|import)\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    if (reachesVue(resolve(dirname(file), m[1]), seen)) return true;
  }
  return false;
}

const entries = Object.entries(pkg.exports)
  .map(([key, value]) => {
    const target = typeof value === 'string' ? value : ((value as { import?: string }).import ?? (value as { default?: string }).default);
    return { key, file: target ? join(repo, target) : '' };
  })
  .filter((e) => e.file.endsWith('.js') && reachesVue(e.file));

const out = mkdtempSync(join(repo, 'node_modules', '.cache', 'vc-vue35-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

/** Bundle `code` the way a consumer's build does, with Vue resolved to 3.5. */
async function bundle35(name: string, code: string): Promise<string> {
  mkdirSync(out, { recursive: true });
  const entry = join(out, `${name}.in.mjs`);
  const file = join(out, `${name}.mjs`);
  writeFileSync(entry, code);
  await build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    alias: { vue: vue35Dir, '@vue/reactivity': reactivity35Dir },
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
  return file;
}

describe('Vue 3.5', () => {
  it('control: vue35 is a 3.5 release, without the Vapor runtime', async () => {
    const file = await bundle35('control', "export { version } from 'vue'; import * as V from 'vue'; export const vapor = 'createVaporApp' in V;");
    const m = await import(pathToFileURL(file).href);
    expect(m.version).toMatch(/^3\.5\./);
    expect(m.vapor).toBe(false);
  });

  it('every entry that reaches Vue is checked, the 3.6-only ones included', () => {
    const keys = entries.map((e) => e.key);
    for (const k of ['.', './vue', ...ONLY_36]) expect(keys).toContain(k);
  });

  for (const { key, file } of entries) {
    const name = key === '.' ? 'root' : key.slice(2).replace(/\//g, '-');
    if (ONLY_36.includes(key)) {
      it(`${key} does not build on 3.5: its Vapor imports are missing`, async () => {
        await expect(bundle35(name, `export * from ${JSON.stringify(file)};`)).rejects.toThrow(/No matching export/);
      });
    } else {
      it(`${key} builds and loads on 3.5`, async () => {
        const built = await bundle35(name, `export * from ${JSON.stringify(file)};`);
        await expect(import(pathToFileURL(built).href)).resolves.toBeDefined();
      });
    }
  }

  it('/vue on 3.5: composable state is a 3.5 ref, and untracked() suspends tracking', async () => {
    const built = await bundle35('behaviour', `
      import { effect, effectScope, isRef, shallowRef } from 'vue';
      import { useCommand, untracked } from ${JSON.stringify(join(dist, 'vue.js'))};
      import { createCommandBus } from ${JSON.stringify(join(dist, 'index.js'))};
      export function run() {
        const bus = createCommandBus();
        const src = shallowRef(0);
        bus.register('read', () => src.value);
        const scope = effectScope();
        const c = scope.run(() => useCommand({ bus }));
        let wrapped = 0;
        let raw = 0;
        effect(() => { wrapped++; untracked(() => bus.dispatch('read', null)); });
        effect(() => { raw++; bus.dispatch('read', null); });
        src.value = 1;
        scope.stop();
        return { loadingIsRef: isRef(c.loading), wrapped, raw };
      }
    `);
    const m = await import(pathToFileURL(built).href);
    // raw is the control: without untracked() the handler's read re-runs the effect.
    expect(m.run()).toEqual({ loadingIsRef: true, wrapped: 1, raw: 2 });
  });
});

/*
 * Why this file exists. The peer range promises Vue >=3.5.0, and nothing ran
 * on 3.5. A manual run on 3.5.43 found every entry loading except the three
 * documented as 3.6-only (log s35.228). This keeps that true on every run.
 *
 * `vue35` is a devDependency alias, `npm:vue@^3.5.43`. Its own @vue/* packages
 * nest under it, apart from the 3.6 ones the suite uses. Each entry is bundled
 * the way a consumer ships it, Vue's esm-bundler build with production
 * defines, and `vue` and `@vue/reactivity` both resolve to the 3.5 copies, so
 * the library and Vue share one reactivity instance.
 *
 * Which entries: every export whose built module graph imports bare `vue` or
 * `@vue/reactivity`. A new entry that reaches Vue is checked without editing
 * this file. The three 3.6-only entries must FAIL to build, on a missing
 * export: that, with the first test, proves the build really used 3.5.
 */
