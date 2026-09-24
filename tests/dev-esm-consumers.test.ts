/**
 * DEV in a consumer's production build: folded in EVERY chunk, not only in the
 * chunk that defines it.
 *
 * The ESM build's DEV folds when a consumer's bundler replaces
 * `process.env.NODE_ENV` - both arms of the expression read false and the
 * minifier drops every `if (DEV)` branch with its warning string. That held for
 * one-chunk apps and failed for code-split ones: a minifier folds a constant
 * only inside the chunk that defines it, and the ESM build used to export ONE
 * shared DEV. In examples/vapor-island-cart the store chunk defined it
 * (`var t=!1`) and the Cart chunk imported it, so Cart shipped chamber.ts's
 * whole probe-path hint, dead at runtime (docs/rc-alignment-log.md s19.4).
 *
 * scripts/build.mjs now derives DEV once per importing module, so no chunk
 * imports it from another. The two shapes below are the examples' own: one
 * chunk (vapor-sfc), and islands loaded through dynamic imports that share a
 * store (vapor-island-cart), where the island reaching chamber.ts is not the
 * chunk holding the bus. Built with Vite's build API in production, as those
 * apps are; `vue` external, so only this library's code is in the chunks.
 *
 * What this cannot check lives in the log, measured by hand in a real browser:
 * DEV true in a page under Vite's dev server, and no ReferenceError on a
 * no-bundler page. tests/dev-flag.test.ts evaluates the expression for both.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
const haveDist = existsSync(dist('index.js')) && existsSync(dist('vue.js'));

/** chamber.ts's DEV-only probe-path hint - the string s19.4 found shipped. */
const HINT = 'Vue detected at runtime rather than at build time';
/** chamber.ts's runtime probe as it lands in a consumer bundle: proof chamber.ts is in the graph.
 *  Backticks too - Vite's minifier writes the literal as a template. */
const PROBE = /import\(\s*(?:\/\*[^*]*\*\/\s*)?["'`]vue["'`]\s*\)/;
/** What the DEV expression leaves behind if it does not fold. Not bare `import.meta`:
 *  Vite's own preload helper reads `import.meta.url` in any app with a dynamic import. */
const UNFOLDED = ['typeof process', 'import.meta.env'];

const FILES: Record<string, string> = {
  'store.js': `import { createCommandBus } from 'vapor-chamber';
export const bus = createCommandBus();
bus.register('cartAdd', () => 1);
`,
  // The island that reaches chamber.ts: untracked() from the Vue entry, on a live path.
  'cart.js': `import { untracked } from 'vapor-chamber/vue';
import { bus } from './store.js';
document.getElementById('add').addEventListener('click', () => untracked(() => bus.dispatch('cartAdd', null)));
`,
  'products.js': `import { bus } from './store.js';
document.getElementById('list').addEventListener('click', () => bus.dispatch('cartAdd', null));
`,
  'split.js': "import('./cart.js');\nimport('./products.js');\n",
  'one.js': "import './cart.js';\nimport './products.js';\n",
};

let dir: string;

beforeAll(() => {
  // Under node_modules/.cache so `vapor-chamber` resolves through node_modules
  // and the package's exports map, as it does for a consumer.
  const cache = resolve(process.cwd(), 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, 'vc-dev-esm-'));
  for (const [name, code] of Object.entries(FILES)) writeFileSync(join(dir, name), code);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A production app build; every chunk's minified code. */
async function chunks(entry: string): Promise<string[]> {
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    mode: 'production',
    // Explicit: vitest's process carries NODE_ENV=test, which Vite would
    // otherwise put into the client replacement.
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: true,
      modulePreload: false,
      target: 'es2022',
      rollupOptions: {
        input: join(dir, entry),
        external: ['vue', '@vue/reactivity'],
        output: { format: 'es' },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
  return outputs.filter((o) => o.type === 'chunk').map((c) => (c as { code: string }).code);
}

describe.skipIf(!haveDist)('DEV folds in every production chunk (Vite build API)', () => {
  it('one chunk (the vapor-sfc shape)', async () => {
    const code = await chunks('one.js');
    expect(code).toHaveLength(1);
    expect(code[0]).toMatch(PROBE);
    expect(code[0]).not.toContain(HINT);
    for (const s of UNFOLDED) expect(code[0]).not.toContain(s);
  });

  it('code-split islands sharing a store (the vapor-island-cart shape)', async () => {
    const code = await chunks('split.js');
    // Harness guard: really split, and chamber.ts is not in the chunk holding the bus.
    const withChamber = code.filter((c) => PROBE.test(c));
    expect(code.length).toBeGreaterThanOrEqual(3);
    expect(withChamber).toHaveLength(1);
    expect(withChamber[0]).not.toContain('createCommandBus');
    for (const c of code) {
      expect(c).not.toContain(HINT);
      for (const s of UNFOLDED) expect(c).not.toContain(s);
    }
  });
});

/** Every ESM chunk this package ships, IIFEs excluded. */
function esmChunks(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) out.push(...esmChunks(full));
    else if (entry.endsWith('.js') && !entry.includes('.iife')) out.push(full);
  }
  return out;
}

describe.skipIf(!haveDist)('the ESM dist derives DEV per module', () => {
  it('no chunk imports DEV from another, and the build left no placeholder behind', () => {
    const files = esmChunks(dist(''));
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/from\s*["'][^"']*\/dev\.js["']/);
      expect(code, file).not.toContain('__VC_DEV_ESM__');
    }
    // The two modules whose warnings matter most carry their own derivation.
    for (const f of ['chamber.js', 'command-bus.js']) {
      expect(readFileSync(dist(f), 'utf8')).toContain('import.meta.env?.DEV ? process.env.NODE_ENV !== "production" : false');
    }
  });
});
