/**
 * `vaporChamberHMR` (src/vite-hmr.ts) run through a real Vite dev server, with a temp-directory fixture the test owns.
 * Why: a unit call to `plugin.transform()` is fed text Vite does not feed it; the plugin runs `enforce: 'pre'` on raw SFC text, where a prepended import lands outside every block and compiler-sfc drops it silently. Also the only file reaching transformIndexHtml's output and the virtual module's skip, so the 100% floor needs it.
 * Shows: the shim reaches a script module that imports the package and the index.html ahead of the entry, an SFC compiles byte-identical to `vue()` alone with an unflattened sourcemap, and over real HTTP the browser URL serves the shim and its Vue priming module.
 * See: tests/vite-hmr.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from '../src/vite-hmr';

// fetch(), retrying only a failure to connect: `listen()` resolving means the socket is bound, not that a loaded worker accepts on it in time.
// Any HTTP response, of any status, is returned untouched, so a 404 or 500 still fails its assertion.
async function fetchWhenReady(url: URL, attempts = 5): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

const SHIM = 'virtual:vapor-chamber-hmr';

let root: string;
let server: ViteDevServer;
let plain: ViteDevServer;

// The same app twice: with the plugin, and with vue() alone as control.
// `listening` swaps middleware mode for a real socket on an ephemeral port, the only way to exercise the middleware that decodes `/@id/__x00__`.
async function serve(withPlugin: boolean, listening = false): Promise<ViteDevServer> {
  return createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: listening ? 'spa' : 'custom',
    // `watch: null`: without it `server.close()` never settles in middleware mode (the chokidar instance keeps it alive).
    server: listening
      ? { port: 0, hmr: false, watch: null }
      : { middlewareMode: true, hmr: false, watch: null },
    // The fixture lives outside this project's node_modules, so both bare specifiers are aliased; the plugin matches source text, which alias leaves alone.
    resolve: {
      alias: {
        'vapor-chamber': resolve(__dirname, '../src/index.ts'),
        vue: resolve(__dirname, '../node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      },
    },
    // Nothing to pre-bundle; with discovery on, the optimiser scans on the first request and `close()` waits for it.
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: withPlugin ? [vue(), vaporChamberHMR()] : [vue()],
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'vc-hmr-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'index.html'),
    '<!doctype html><html><head><title>t</title></head>' +
    '<body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>');
  // The entry names the package, so the module-graph route applies to it.
  writeFileSync(join(root, 'src/main.ts'),
    "import { createCommandBus } from 'vapor-chamber';\nexport const bus = createCommandBus();\n");
  // An entry that does NOT name the package - the case only the HTML tag reaches.
  writeFileSync(join(root, 'src/bare.ts'), "export const nothing = 1;\n");
  writeFileSync(join(root, 'src/App.vue'), [
    '<script setup lang="ts">',
    "import { createCommandBus } from 'vapor-chamber';",
    'const bus = createCommandBus();',
    '</script>',
    '<template><button>{{ bus ? 1 : 0 }}</button></template>',
  ].join('\n'));

  server = await serve(true);
  plain = await serve(false);
});

afterAll(async () => {
  await server?.close();
  await plain?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('vaporChamberHMR in a real Vite dev server', () => {
  it('injects the shim into a script module that imports the package', async () => {
    const out = await server.transformRequest('/src/main.ts');
    expect(out?.code).toContain(SHIM);
  });

  it('leaves an SFC byte-identical to what vue() alone produces', async () => {
    const [withPlugin, control] = await Promise.all([
      server.transformRequest('/src/App.vue'),
      plain.transformRequest('/src/App.vue'),
    ]);
    // The optimiser stamps a per-server hash into resolved URLs: server identity, not plugin output.
    const norm = (s: string) => s.replace(/\?v=\w+/g, '');

    expect(withPlugin?.code).not.toContain(SHIM);
    expect(norm(withPlugin?.code ?? '')).toBe(norm(control?.code ?? ''));
  });

  it('does not flatten the sourcemap it passes through', async () => {
    // Injecting on the same line moves no line, so the downstream map must arrive intact.
    const [withPlugin, control] = await Promise.all([
      server.transformRequest('/src/App.vue'),
      plain.transformRequest('/src/App.vue'),
    ]);
    expect(withPlugin?.map?.mappings).toBe(control?.map?.mappings);
  });

  it('serves the shim module itself, with the dispose hook wired', async () => {
    // By module id; the URL form the HTML tag uses is checked over real HTTP below.
    const out = await server.transformRequest(`\0${SHIM}`);
    expect(out?.code).toContain('__VAPOR_CHAMBER_BUS__');
    expect(out?.code).toContain('import.meta.hot');
  });

  it('puts the shim in index.html ahead of the app entry', async () => {
    const html = await server.transformIndexHtml('/index.html',
      '<!doctype html><html><head><title>t</title></head>' +
      '<body><script type="module" src="/src/bare.ts"></script></body></html>');

    expect(html).toContain(`/@id/__x00__${SHIM}`);
    // Module scripts run in document order, so the shim (and the Vue priming it pulls) must come first.
    expect(html.indexOf(SHIM)).toBeLessThan(html.indexOf('/src/bare.ts'));
  });

  // Over real HTTP: the `/@id/__x00__` URL is decoded by Vite's transform middleware, not by a hook this plugin owns, so an in-process call only confirms the string we wrote.
  it('a browser fetching that tag really receives the shim', async () => {
    const live = await serve(true, true);
    try {
      await live.listen();
      // The URL Vite reports, unchanged: this server binds IPv6 only, so rewriting `localhost` to 127.0.0.1 would be refused.
      const base = live.resolvedUrls?.local[0];
      expect(base).toBeTruthy();

      const html = await (await fetchWhenReady(new URL('/', base))).text();
      const src = html.match(/src="([^"]*vapor-chamber-hmr)"/)?.[1];
      expect(src).toBeTruthy();

      const res = await fetchWhenReady(new URL(src!, base));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('__VAPOR_CHAMBER_BUS__');
      // The shim pulls the Vue priming module too.
      expect(body).toContain('vapor-chamber-hmr-vue-prime');
    } finally {
      await live.close();
    }
  });

  it('reaches an app whose entry never names the package', async () => {
    // Nothing in this entry matches, so the transform declines and the HTML tag is the only route.
    const entry = await server.transformRequest('/src/bare.ts');
    expect(entry?.code).not.toContain(SHIM);

    const html = await server.transformIndexHtml('/index.html',
      '<!doctype html><html><head></head><body></body></html>');
    expect(html).toContain(SHIM);
  });
});
