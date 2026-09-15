/**
 * MARKER GUARD - what a Vapor consumer's production bundle must NOT carry.
 *
 * Vue 3.6.0-rc.8's CI (commit 21) fails the build when a Vapor client-render
 * bundle still contains hydration code, and it checks the bundle Vue's own
 * bundler produced. This is the same stance one level up: a consumer that
 * wires through `vapor-chamber/vapor` and renders routes through
 * `vapor-chamber/router/vapor` is the audience this library says pays for no
 * vDOM renderer and no interop, so its bundle - built with Vite, the bundler
 * that audience ships with - is checked for exactly that.
 *
 * WHAT IT ADDS OVER tests/router/vapor-boundary.test.ts, which it must not
 * duplicate. That file enumerates the `vue` bindings the ROUTER's Vapor outlet
 * retains, alone, under esbuild. This one bundles the WIRING entry beside it -
 * `/vapor` pulls chamber.ts, the static Vue lists in vue.ts and vapor.ts, the
 * composables - with rolldown, and asks two questions the router-only check
 * cannot: does the wiring entry drag in anything vDOM, and does the graph
 * carry ONE chamber module or two. The runtime probe is the fingerprint: one
 * copy of chamber.ts, one `import("vue")`. (A literal, not the `vuePkg`
 * variable chamber.ts writes: this library's own build folds the constant
 * into the dist, and `@vite-ignore` is what keeps a consumer's bundler from
 * resolving it.)
 *
 * And one fact the static entries and `vaporChamberWire()` both rest on,
 * pinned here because this is where the consumer's bundler runs: even when
 * the app BUNDLES Vue, that probe stays a bare `import("vue")` - no Vue chunk
 * is made for it - so in a browser with no import map it cannot resolve.
 *
 * WHY BINDINGS, NOT TEXT, for the vDOM markers. `vue` is external, so anything
 * vDOM the app pulls shows up as a name imported from it. A raw text search
 * would be wrong here in both directions: chamber.ts's registry reads the
 * PROPERTY `vaporInteropPlugin` off whatever namespace it is handed (that is
 * how the opt-in works, and it pulls no interop code), and
 * `createVaporChamberApp`'s error message says "use createApp() from vue" in a
 * string. Neither is the renderer; an imported binding is.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
const haveDist = existsSync(dist('vapor.js')) && existsSync(dist('router/index.js')) && existsSync(dist('router/vapor.js'));

/** Names whose presence would mean the vDOM renderer or interop is in the app. */
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
const PROBE = /import\(\s*(?:\/\*[^*]*\*\/\s*)?["']vue["']\s*\)/g;

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

describe.skipIf(!haveDist)('Vapor consumer bundle (vapor-chamber/vapor + router/vapor, Vite)', () => {
  it('imports nothing vDOM from vue, and carries one chamber module', async () => {
    const { entry, lazy } = await bundle();
    const vueNames = importsFrom(entry, 'vue');
    console.log(`  vue bindings in the entry chunk: ${vueNames.join(', ')}`);

    // Harness guard: an empty enumeration would pass the check below vacuously.
    expect(vueNames).toEqual(expect.arrayContaining(['createVaporApp', 'createDynamicComponent', 'hasInjectionContext']));

    expect(vueNames.filter((n) => VDOM_MARKERS.includes(n))).toEqual([]);

    // ONE chamber module: its runtime probe is the fingerprint. Two copies of
    // chamber.ts would mean two registries - the wiring landing in one and the
    // composables reading the other.
    expect(entry.match(PROBE) ?? []).toHaveLength(1);

    // The router's lazy blade chunk is the only other chunk, and it is the one
    // place vDOM is allowed to live: it loads only when a blade row renders.
    for (const code of lazy) expect(importsFrom(code, 'vue')).not.toContain('vaporInteropPlugin');
  }, 60_000);

  it('the runtime probe stays a bare import("vue") even when the app bundles Vue', async () => {
    const external = await bundle(true);
    const bundled = await bundle(false);
    // Vue is really in the bundled build - the app's own static imports pull it.
    expect(bundled.entry.length).toBeGreaterThan(external.entry.length * 3);
    // ...and the probe still names the bare specifier: the bundler made no
    // chunk for it and rewrote it to nothing. In a browser, with no import
    // map, that import rejects, which is why wiring has to be static.
    expect(bundled.entry.match(PROBE) ?? []).toHaveLength(1);
    expect(bundled.lazy.some((code) => /\bcreateVaporApp\b/.test(code))).toBe(false);
  }, 60_000);
});
