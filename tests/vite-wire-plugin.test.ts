/**
 * `vaporChamberWire` (src/vite-hmr.ts) against Vite's real production build and a real dev server, plus the plugin object's own hooks.
 * Why: a production bundle of a root-only consumer imports nothing from `vue` without wiring, so composables would ship as plain `{ value }` objects; under the dev server a redirect would put two chamber modules in the page, so wiring would land on a registry the app never reads.
 * Shows: built with the plugin, the same entry imports the `@vue/reactivity` tracking pair and the eight `configureVue()` names (Vapor names only for `entry: 'vapor'`); the plugin redirects in builds only, defines `__VC_WIRED__` under serve, and the DEV probe-path hint stays quiet once it is defined.
 * See: log s16.7, log s18.1, tests/vapor-async-wire.test.ts, tests/root-probe-builds.test.ts, tests/isloading-profile.test.ts, tests/root-only-prod-fixture.test.ts
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { build, createServer, type ViteDevServer } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { vaporChamberWire } from '../src/vite-hmr';
import { requireDist } from './require-dist';

const dist = (f: string) => resolve(process.cwd(), 'dist', f);
requireDist(existsSync(dist('index.js')) && existsSync(dist('vue.js')) && existsSync(dist('vapor.js')));

// What src/vue.ts passes to configureVue(): the list that must reach a built app.
const VUE_NAMES = [
  'ref',
  'shallowRef',
  'getCurrentScope',
  'getCurrentInstance',
  'hasInjectionContext',
  'onScopeDispose',
  'onActivated',
  'onDeactivated',
];
const TRACKING = ['pauseTracking', 'resetTracking'];
const VAPOR_NAMES = ['createVaporApp', 'defineVaporComponent', 'defineVaporAsyncComponent'];

const MAIN = `import { useCommand, getCommandBus } from 'vapor-chamber';

const bus = getCommandBus();
bus.register('ping', () => 'pong');
const { dispatch, pending } = useCommand();
const pinging = pending('ping', null);
document.getElementById('go').addEventListener('click', () => {
  dispatch('ping', null);
  document.title = String(pinging.value);
});
`;

let dir: string;

beforeAll(() => {
  // Under node_modules/.cache so `vapor-chamber` resolves as for a consumer, through node_modules and the exports map to dist/, with no alias.
  const cache = resolve(process.cwd(), 'node_modules', '.cache');
  mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, 'vc-wire-'));
  writeFileSync(join(dir, 'main.js'), MAIN);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// A production app build of the consumer, every chunk's code joined; `vue` and `@vue/reactivity` are external so the wiring shows as import statements.
async function bundle(plugins: unknown[]): Promise<string> {
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
      rollupOptions: {
        input: join(dir, 'main.js'),
        external: ['vue', '@vue/reactivity'],
        output: { format: 'es' },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
  return outputs
    .filter((o) => o.type === 'chunk')
    .map((c) => (c as { code: string }).code)
    .join('\n');
}

// Names a bundle imports statically from `spec`: `import { a, b as c } from "spec"`.
function importsFrom(code: string, spec: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']${spec}["']`, 'g'))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

const br = (s: string) =>
  zlib.brotliCompressSync(Buffer.from(s), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

describe('vaporChamberWire in a real Vite production build', () => {
  it('control: without it, a root-only consumer imports nothing from vue', async () => {
    const code = await bundle([]);
    // The composable must be called on a live path: app builds drop entry exports, so an unused one would be tree-shaken and the assertion would measure the shaker.
    expect(code).toContain('function useCommand(');
    expect(importsFrom(code, 'vue')).toEqual([]);
    expect(importsFrom(code, '@vue/reactivity')).toEqual([]);
  });

  it('wires the tracking pair and the eight configureVue names from the root, no import changed', async () => {
    const [control, wired] = await Promise.all([bundle([]), bundle([vaporChamberWire()])]);
    expect(wired).toContain('function useCommand(');
    expect(importsFrom(wired, '@vue/reactivity')).toEqual(expect.arrayContaining(TRACKING));
    expect(importsFrom(wired, 'vue')).toEqual(expect.arrayContaining(VUE_NAMES));
    // The default entry sends no Vapor name to a vDOM app.
    for (const name of VAPOR_NAMES) expect(importsFrom(wired, 'vue')).not.toContain(name);
    // The wiring call is present in the bundle, not only imported.
    expect(wired).toMatch(/configureVue\(\{/);
    expect(wired).toMatch(/_wireUntrack\(pauseTracking, resetTracking, true\)/);

    console.log(
      `  wire: control ${control.length} B raw / ${br(control)} B br, ` +
        `wired ${wired.length} B raw / ${br(wired)} B br (vue external)`,
    );
  });

  it("entry: 'vapor' also wires the Vapor names, the async one only where it is used", async () => {
    const wired = await bundle([vaporChamberWire({ entry: 'vapor' })]);
    expect(importsFrom(wired, '@vue/reactivity')).toEqual(expect.arrayContaining(TRACKING));
    expect(importsFrom(wired, 'vue')).toEqual(expect.arrayContaining([...VUE_NAMES, 'createVaporApp', 'defineVaporComponent']));
    // This consumer defines no async component, so Vue's stays out (tests/vapor-async-wire.test.ts runs one that does).
    expect(importsFrom(wired, 'vue')).not.toContain('defineVaporAsyncComponent');
  });
});

describe('vaporChamberWire - the plugin object', () => {
  it('redirects in builds only; under the dev server it defines __VC_WIRED__, never __VC_WIRED_BUILD__', async () => {
    const ctx = { resolve: async () => ({ id: '/x/dist/index.js' }) };
    const plugin = vaporChamberWire();
    expect(plugin.name).toBe('vapor-chamber-wire');
    expect(plugin.enforce).toBe('pre');
    // No `apply`: Vite drops a plugin before its `config` hook runs, and the dev-server half lives in that hook.
    expect(plugin.apply).toBeUndefined();

    // __VC_WIRED_BUILD__ folds the root's probe (tests/root-probe-builds.test.ts); both defines carry the build profile (tests/isloading-profile.test.ts).
    expect(plugin.config({}, { command: 'build', mode: 'production' })).toEqual({ define: { __VC_WIRED_BUILD__: 'true', __VC_LEAN__: 'false' } });
    expect(await plugin.resolveId.call(ctx, 'vapor-chamber', '/app/main.js')).toMatch(/^\0/);

    const dev = vaporChamberWire();
    expect(dev.config({}, { command: 'serve', mode: 'development' })).toEqual({ define: { __VC_WIRED__: 'true', __VC_LEAN__: 'false' } });
    expect(await dev.resolveId.call(ctx, 'vapor-chamber', '/app/main.js')).toBeUndefined();
  });

  it("profile: 'lean' defines __VC_LEAN__ true, in a build and under serve; 'performance' is the default", () => {
    const build = { command: 'build' as const, mode: 'production' };
    const serve = { command: 'serve' as const, mode: 'development' };
    expect(vaporChamberWire({ profile: 'lean' }).config({}, build)).toEqual({ define: { __VC_WIRED_BUILD__: 'true', __VC_LEAN__: 'true' } });
    expect(vaporChamberWire({ profile: 'lean' }).config({}, serve)).toEqual({ define: { __VC_WIRED__: 'true', __VC_LEAN__: 'true' } });
    expect(vaporChamberWire({ profile: 'performance' }).config({}, build)).toEqual(vaporChamberWire().config({}, build));
    expect(vaporChamberWire({ profile: 'performance' }).config({}, serve)).toEqual(vaporChamberWire().config({}, serve));
  });

  it("leaves an app's own __VC_LEAN__ define alone, whatever the profile", () => {
    const user = { define: { __VC_LEAN__: 'true' } };
    expect(vaporChamberWire().config(user, { command: 'build' })).toEqual({ define: { __VC_WIRED_BUILD__: 'true' } });
    expect(vaporChamberWire({ profile: 'lean' }).config({ define: { __VC_LEAN__: 'false' } }, { command: 'serve' })).toEqual({ define: { __VC_WIRED__: 'true' } });
  });

  it('leaves every other specifier alone, subpaths included', async () => {
    const plugin = vaporChamberWire();
    const ctx = { resolve: async () => ({ id: '/x/dist/index.js' }) };
    expect(await plugin.resolveId.call(ctx, 'vapor-chamber/vue', '/app/main.js')).toBeUndefined();
    expect(await plugin.resolveId.call(ctx, 'vue', '/app/main.js')).toBeUndefined();
    expect(plugin.load('/app/main.js')).toBeUndefined();
  });

  it('declines when the root does not resolve, or resolves external', async () => {
    const plugin = vaporChamberWire();
    const none = { resolve: async () => null };
    const external = { resolve: async () => ({ id: 'vapor-chamber', external: true }) };
    expect(await plugin.resolveId.call(none, 'vapor-chamber', '/app/main.js')).toBeUndefined();
    expect(await plugin.resolveId.call(external, 'vapor-chamber', '/app/main.js')).toBeUndefined();
  });

  it('resolves the real root with skipSelf and re-exports it by id', async () => {
    const plugin = vaporChamberWire();
    const calls: unknown[][] = [];
    const ctx = {
      resolve: async (...args: unknown[]) => {
        calls.push(args);
        return { id: '/x/node_modules/vapor-chamber/dist/index.js' };
      },
    };
    const virtual = await plugin.resolveId.call(ctx, 'vapor-chamber', '/app/main.js');
    expect(calls).toEqual([['vapor-chamber', '/app/main.js', { skipSelf: true }]]);
    expect(virtual.startsWith('\0')).toBe(true);
    expect(plugin.load(virtual)).toBe(
      "import 'vapor-chamber/vue';\nexport * from \"/x/node_modules/vapor-chamber/dist/index.js\";\n",
    );
    expect(vaporChamberWire({ entry: 'vapor' }).load(virtual)).toContain("import 'vapor-chamber/vapor';");
  });
});

// chamber.ts's DEV probe-path text: present in every module that is a chamber, pre-bundled or not.
const CHAMBER_MARK = 'Vue detected at runtime rather than at build time';

let devRoot: string;

// An app root in the OS temp dir with the package installed as npm leaves it: Vite skips optimizing imports made from files inside node_modules.
function makeDevProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vc-wire-dev-')));
  writeFileSync(join(root, 'package.json'), '{"name":"vc-wire-dev","private":true,"type":"module"}\n');
  writeFileSync(join(root, 'root-only.js'), "import { useCommand } from 'vapor-chamber';\nglobalThis.use = useCommand;\n");
  writeFileSync(
    join(root, 'documented.js'),
    "import { getCommandBus } from 'vapor-chamber';\nimport { useCommand } from 'vapor-chamber/vue';\n" +
      'globalThis.use = [getCommandBus, useCommand];\n',
  );
  const pkg = join(root, 'node_modules', 'vapor-chamber');
  mkdirSync(pkg, { recursive: true });
  cpSync(resolve(process.cwd(), 'package.json'), join(pkg, 'package.json'));
  // A copy, not a link: Vite follows a symlink to its real path, and a package whose real path is outside node_modules is treated as source, not a dep.
  cpSync(resolve(process.cwd(), 'dist'), join(pkg, 'dist'), {
    recursive: true,
    filter: (src) => !/\.(map|d\.ts)$/.test(src),
  });
  // Links suit Vue: its real path is inside node_modules.
  symlinkSync(resolve(process.cwd(), 'node_modules', 'vue'), join(root, 'node_modules', 'vue'));
  symlinkSync(resolve(process.cwd(), 'node_modules', '@vue'), join(root, 'node_modules', '@vue'));
  return root;
}

// Middleware-mode dev server on the project; each arm gets its own optimizer cache.
async function devServer(plugins: unknown[], arm: string): Promise<ViteDevServer> {
  return createServer({
    configFile: false,
    root: devRoot,
    cacheDir: join(devRoot, 'node_modules', `.vite-${arm}`),
    logLevel: 'silent',
    appType: 'custom',
    // `watch: null` keeps close() from waiting on a watcher.
    server: { middlewareMode: true, hmr: false, watch: null },
    plugins: plugins as never,
  });
}

// Every module a browser would load from `entry`, keyed by URL, as served.
async function crawl(server: ViteDevServer, entry: string): Promise<Map<string, string>> {
  const unwrap = (u: string) => (u.startsWith('/@id/__x00__') ? `\0${u.slice(12)}` : u.startsWith('/@id/') ? u.slice(5) : u);
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    // Sources before pre-bundled deps: the optimizer holds its first run until the static crawl ends.
    queue.sort((a, b) => Number(a.includes('/deps/')) - Number(b.includes('/deps/')));
    const url = queue.shift() as string;
    if (seen.has(url)) continue;
    seen.set(url, (await server.transformRequest(unwrap(url)))?.code ?? '');
    const mod = await server.moduleGraph.getModuleByUrl(unwrap(url));
    for (const dep of mod?.importedModules ?? []) if (dep.url && !seen.has(dep.url)) queue.push(dep.url);
  }
  return seen;
}

const chamberModules = (graph: Map<string, string>) =>
  [...graph].filter(([, code]) => code.includes(CHAMBER_MARK)).map(([url]) => url);

describe('vaporChamberWire under a real Vite dev server, package pre-bundled', () => {
  beforeAll(() => {
    devRoot = makeDevProject();
  });

  afterAll(() => {
    if (devRoot) rmSync(devRoot, { recursive: true, force: true });
  });

  it('the measurement: a dev-time redirect puts TWO chamber modules in the page', async () => {
    // The redirect forced to run under serve: with no `config` hook to tell it the command, resolveId behaves as in a build.
    const server = await devServer([{ ...vaporChamberWire(), apply: undefined, config: undefined }], 'redirect');
    try {
      const chambers = chamberModules(await crawl(server, '/root-only.js'));
      console.log(`  dev redirect, chamber modules: ${chambers.join(', ')}`);
      expect(chambers).toHaveLength(2);
      // The app's copy, pre-bundled, and the one the /vue import wired, unbundled.
      expect(chambers.filter((u) => u.includes('/deps/'))).toHaveLength(1);
      expect(chambers.filter((u) => u.includes('/vapor-chamber/dist/chamber.js'))).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it('control: the documented pattern - bus from the root, composables from /vue - has one', async () => {
    const server = await devServer([], 'documented');
    try {
      const chambers = chamberModules(await crawl(server, '/documented.js'));
      expect(chambers).toHaveLength(1);
      expect(chambers[0]).toContain('/deps/');
    } finally {
      await server.close();
    }
  });

  it('as shipped: no redirect under serve, one chamber module, and __VC_WIRED__ reaches the page', async () => {
    const server = await devServer([vaporChamberWire()], 'shipped');
    try {
      expect(chamberModules(await crawl(server, '/root-only.js'))).toHaveLength(1);
      // Vite leaves dependency code untouched in dev; its client env module assigns every define to globalThis, where chamber.ts reads it.
      const env = (await server.transformRequest('/@vite/env'))?.code ?? '';
      expect(env).toContain('"__VC_WIRED__": true');
    } finally {
      await server.close();
    }
  });
});

describe('the DEV probe-path hint reads __VC_WIRED__', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const PROBE_HINT = /detected at runtime rather than at build time/;

  afterEach(() => {
    delete g.__VC_WIRED__;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // A root-only consumer on the probe path in a page: `window` is stubbed because the hint is a page's (a server gets none, tests/root-only-prod-fixture.test.ts).
  // The global is set as the define arrives: vitest and Vite's client env module both assign defines to globalThis.
  async function probeHints(wired: boolean): Promise<string[]> {
    vi.stubGlobal('window', globalThis);
    if (wired) g.__VC_WIRED__ = true;
    vi.resetModules();
    const chamber = await import('../src/chamber');
    await chamber.waitForVueDetection();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chamber.useCommand().dispose();
    return warn.mock.calls.map((c) => String(c[0])).filter((m) => PROBE_HINT.test(m));
  }

  it('control: fires once for a root-only consumer on the probe path', async () => {
    expect(await probeHints(false)).toHaveLength(1);
  });

  it('stays quiet when vaporChamberWire() has defined __VC_WIRED__', async () => {
    expect(await probeHints(true)).toHaveLength(0);
  });
});
