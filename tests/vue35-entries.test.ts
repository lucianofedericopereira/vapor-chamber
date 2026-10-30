/**
 * Every package export whose built module graph imports bare `vue` or `@vue/reactivity`, bundled as a consumer ships it with Vue resolved to 3.5.
 * Why: the peer range promises Vue >=3.5.0, so an entry that fails to load on 3.5, other than the documented 3.6-only ones, would break a user on 3.5.
 * Shows: a control that `vue35` is a 3.5 release without the Vapor runtime; the entry list holds `./vue` and the 3.6-only entries and not the root; each other entry builds and loads; each 3.6-only entry fails to build on a missing export; `/vue` on 3.5 returns a 3.5 ref from the composable and `untracked()` suspends tracking while a plain effect re-runs.
 * See: log s35.228, log s36.F26
 */
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
// vue35 is a devDependency alias of vue@^3.5.43; its @vue/* packages nest under it, apart from the 3.6 ones the suite uses.
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
  // A static import, or a literal dynamic one. The root holds neither.
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

/** Bundle `code` the way a consumer's build does: esm-bundler build, production defines, `vue` and `@vue/reactivity` both the 3.5 copies so one reactivity instance is shared. */
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

  it('every entry that reaches Vue is checked, the 3.6-only ones included, and the root is not one', () => {
    const keys = entries.map((e) => e.key);
    for (const k of ['./vue', ...ONLY_36]) expect(keys).toContain(k);
    expect(keys).not.toContain('.');
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
        const probe = c.pending('read');
        let wrapped = 0;
        let raw = 0;
        effect(() => { wrapped++; untracked(() => bus.dispatch('read', null)); });
        effect(() => { raw++; bus.dispatch('read', null); });
        src.value = 1;
        scope.stop();
        return { loadingIsRef: isRef(probe), wrapped, raw };
      }
    `);
    const m = await import(pathToFileURL(built).href);
    // raw is the control: without untracked() the handler's read re-runs the effect.
    expect(m.run()).toEqual({ loadingIsRef: true, wrapped: 1, raw: 2 });
  });
});
