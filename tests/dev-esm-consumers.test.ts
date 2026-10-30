/**
 * DEV in a consumer's production build: folded in every chunk, not only the chunk that defines it.
 * Why: a minifier folds a constant only inside its own chunk, so one shared DEV would ship every warning string in a code-split app; the build derives DEV per module.
 * Shows: Vite production builds of one chunk and of code-split islands (the vapor-sfc and vapor-island-cart shapes) carry no hint, no unfolded expression; no dist chunk imports DEV.
 * See: docs/rc-alignment-log.md s19.4, scripts/build.mjs, tests/dev-flag.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDist } from './require-dist';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
requireDist(existsSync(dist('index.js')) && existsSync(dist('vue.js')));

/** chamber.ts's DEV-only probe-path hint. */
const HINT = 'Vue detected at runtime rather than at build time';
/** chamber.ts's runtime probe as it lands in a consumer bundle: proof chamber.ts is in the graph.
 *  Its specifier is a module binding (VUE_PKG), minified to `x="vue"` or `x=\`vue\``. */
const PROBE = /[\w$]\s*=\s*["'`]vue["'`]/;
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

// Not checkable here: DEV true under Vite's dev server, and no ReferenceError on a no-bundler page (tests/dev-flag.test.ts).
describe('DEV folds in every production chunk (Vite build API)', () => {
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

describe('the ESM dist derives DEV per module', () => {
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
