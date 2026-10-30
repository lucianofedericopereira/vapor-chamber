/**
 * A Vite production build of a Vapor consumer (`vapor-chamber/vapor` plus `vapor-chamber/router/vapor`): what its bundle must not carry.
 * Why: the audience that wires through `/vapor` pays for no vDOM renderer and no interop, and two copies of chamber.ts would mean two registries (the wiring landing in one, the composables reading the other). The runtime Vue probe must stay a name, since a browser with no import map cannot resolve a literal `import('vue')`.
 * Shows: the entry chunk imports none of the vDOM markers from `vue` and holds one `VUE_PKG = "vue"` probe; the lazy chunks import no `vaporInteropPlugin`; with Vue bundled in, the probe is still one name, no `import('vue')` literal is written and no lazy chunk carries `createVaporApp`.
 * See: log s36.F26, tests/router/vapor-boundary.test.ts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
requireDist(existsSync(dist('vapor.js')) && existsSync(dist('router/index.js')) && existsSync(dist('router/vapor.js')));

/** Names whose presence would mean the vDOM renderer or interop is in the app. Checked as imported bindings, not text: chamber.ts reads the property `vaporInteropPlugin` off a namespace and an error message says "createApp()", and neither is the renderer. */
const VDOM_MARKERS = ['vaporInteropPlugin', 'defineComponent', 'createApp', 'h', 'createVNode', 'createRenderer'];

const MAIN = `import { createVaporChamberApp, useCommand } from 'vapor-chamber/vapor';
import { createMemoryHistory, createRouter } from 'vapor-chamber/router';
import { RouterOutlet } from 'vapor-chamber/router/vapor';
import { createComponent, defineVaporComponent, setInsertionState, template } from 'vue';

const Page = defineVaporComponent({
  setup() {
    const { dispatch } = useCommand();
    const el = template('<button>go</button>', 1)();
    el.addEventListener('click', () => dispatch('ping', null));
    return el;
  },
});
const Root = defineVaporComponent({
  setup() { const el = template('<div></div>', 1)(); setInsertionState(el); createComponent(RouterOutlet); return el; },
});
const router = createRouter({
  base: '',
  history: createMemoryHistory(''),
  routes: [{ name: 'home', path: '/', component: 'Page' }],
  components: { Page },
});
createVaporChamberApp(Root).use(router).mount('#app');
`;

let dir: string;

beforeAll(() => {
  const cache = resolve(process.cwd(), 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, 'vc-markers-'));
  writeFileSync(join(dir, 'main.js'), MAIN);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** chamber.ts's runtime probe as it lands in a consumer bundle. */
const PROBE = /\bVUE_PKG(?:\$\d+)?\s*=\s*["']vue["']/g;
/** The literal the probe must never become: a bundler would resolve it. */
const LITERAL = /import\(\s*(?:\/\*[^*]*\*\/\s*)*["'`]vue["'`]\s*\)/;

/** Production app build; the entry chunk, and every lazy chunk kept apart. */
async function bundle(vueExternal = true): Promise<{ entry: string; lazy: string[] }> {
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    mode: 'production',
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      modulePreload: false,
      rollupOptions: {
        input: join(dir, 'main.js'),
        external: vueExternal ? ['vue', '@vue/reactivity'] : [],
        output: { format: 'es' },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
  const chunks = outputs.filter((o) => o.type === 'chunk') as Array<{ code: string; isEntry: boolean }>;
  return { entry: chunks.filter((c) => c.isEntry).map((c) => c.code).join('\n'), lazy: chunks.filter((c) => !c.isEntry).map((c) => c.code) };
}

function importsFrom(code: string, spec: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${spec}["']`, 'g'))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

describe('Vapor consumer bundle (vapor-chamber/vapor + router/vapor, Vite)', () => {
  it('imports nothing vDOM from vue, and carries one chamber module', async () => {
    const { entry, lazy } = await bundle();
    const vueNames = importsFrom(entry, 'vue');
    console.log(`  vue bindings in the entry chunk: ${vueNames.join(', ')}`);

    // An empty enumeration would pass the marker check vacuously.
    expect(vueNames).toEqual(expect.arrayContaining(['createVaporApp', 'createDynamicComponent', 'hasInjectionContext']));

    expect(vueNames.filter((n) => VDOM_MARKERS.includes(n))).toEqual([]);

    // The runtime probe is the fingerprint of one chamber module.
    expect(entry.match(PROBE) ?? []).toHaveLength(1);

    // The router's lazy blade chunk loads only when a blade row renders; only it may hold vDOM.
    for (const code of lazy) expect(importsFrom(code, 'vue')).not.toContain('vaporInteropPlugin');
  });

  it('the runtime probe stays a name even when the app bundles Vue', async () => {
    const external = await bundle(true);
    const bundled = await bundle(false);
    // Vue is really in the bundled build.
    expect(bundled.entry.length).toBeGreaterThan(external.entry.length * 3);
    // No chunk and no literal for the probe: with no import map the import rejects in a browser.
    expect(bundled.entry.match(PROBE) ?? []).toHaveLength(1);
    expect(LITERAL.test(bundled.entry)).toBe(false);
    expect(bundled.lazy.some((code) => /\bcreateVaporApp\b/.test(code))).toBe(false);
  });
});
