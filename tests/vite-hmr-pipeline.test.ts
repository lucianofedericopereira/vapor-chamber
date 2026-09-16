/**
 * vaporChamberHMR against a REAL Vite dev pipeline.
 *
 * src/vite-hmr.ts sat on the coverage exclusion list with the reason "Vite
 * plugin code that exercises in a real Vite server, not a unit test
 * environment". That reason was true and it was also the hole: the plugin
 * claimed `.vue` and `.vapor.vue` and had never once delivered a shim to
 * either, while 24 unit tests passed, because the unit tests called
 * `plugin.transform()` directly and the string they fed it was not what Vite
 * feeds it. `enforce: 'pre'` means the plugin sees RAW SFC text, where a
 * prepended import lands outside every block and compiler-sfc drops it with no
 * diagnostic.
 *
 * A real server is the only thing that can tell the difference, and it turns
 * out to cost about a second: `createServer({ middlewareMode: true })` never
 * listens on a port, and `transformRequest` walks the actual plugin container -
 * alias, our `pre` transform, plugin-vue, the import rewriter, the lot.
 *
 * The fixture is written to a temp directory rather than pointed at
 * examples/vapor-sfc, so this test owns its inputs and cannot be broken by an
 * edit to an example.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { vaporChamberHMR } from '../src/vite-hmr';

/**
 * fetch(), retrying only a failure to CONNECT.
 *
 * `listen()` having resolved means the socket is bound, not that this worker
 * will get scheduled to accept on it. Under full-suite load - 178 workers on a
 * busy machine - the connect attempt outlived its timeout and the test failed
 * with `TypeError: fetch failed / connect ETIMEDOUT`, twice, at whichever fetch
 * happened to go first. It never failed in isolation.
 *
 * Only a connect-level failure is retried. An HTTP response, of any status, is
 * returned to the caller untouched, so a 404 or a 500 still fails the assertion
 * it was going to fail - this hides a starved event loop, never a broken server.
 */
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

/**
 * The same app twice: once with the plugin, once with vue() alone as control.
 *
 * `listening` swaps middleware mode for a real socket on an ephemeral port and
 * lets Vite serve index.html itself, which is the only way to exercise the
 * transform middleware that decodes the `/@id/__x00__` URL.
 */
async function serve(withPlugin: boolean, listening = false): Promise<ViteDevServer> {
  return createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    appType: listening ? 'spa' : 'custom',
    // `watch: null` is not tidiness - without it `server.close()` never settles
    // in middleware mode, because the chokidar instance keeps the process alive
    // and Vite waits on it. Nothing here edits a file after the server starts,
    // so there is nothing for a watcher to do.
    server: listening
      ? { port: 0, hmr: false, watch: null }
      : { middlewareMode: true, hmr: false, watch: null },
    // The fixture lives outside this project's node_modules, so both bare
    // specifiers are aliased to real files. The plugin matches on SOURCE text
    // and alias rewrites ids rather than text, so `from 'vapor-chamber'` still
    // reads as itself by the time we see it.
    resolve: {
      alias: {
        'vapor-chamber': resolve(__dirname, '../src/index.ts'),
        vue: resolve(__dirname, '../node_modules/vue/dist/vue.runtime.esm-bundler.js'),
      },
    },
    // Both specifiers are aliased to source files, so there is nothing to
    // pre-bundle. Left on, the optimiser starts a scan on the first request and
    // `close()` waits for it - the whole suite hung for 30s on that, not on
    // anything this plugin does.
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
    // The dependency optimiser stamps a per-server hash into resolved URLs;
    // that is server identity, not plugin output.
    const norm = (s: string) => s.replace(/\?v=\w+/g, '');

    expect(withPlugin?.code).not.toContain(SHIM);
    expect(norm(withPlugin?.code ?? '')).toBe(norm(control?.code ?? ''));
  });

  it('does not flatten the sourcemap it passes through', async () => {
    // Injecting on the same line means no line moves, so no map is needed and
    // the downstream map arrives intact. The predecessor emitted a line-shift
    // map that collapsed every chained segment onto column 0, which showed up
    // here as a mappings string a fraction of the control's length.
    const [withPlugin, control] = await Promise.all([
      server.transformRequest('/src/App.vue'),
      plain.transformRequest('/src/App.vue'),
    ]);
    expect(withPlugin?.map?.mappings).toBe(control?.map?.mappings);
  });

  it('serves the shim module itself, with the dispose hook wired', async () => {
    // Addressed by module id here. The URL form the HTML tag uses is a
    // middleware concern, and is checked over real HTTP below.
    const out = await server.transformRequest(`\0${SHIM}`);
    expect(out?.code).toContain('__VAPOR_CHAMBER_BUS__');
    expect(out?.code).toContain('import.meta.hot');
  });

  it('puts the shim in index.html ahead of the app entry', async () => {
    const html = await server.transformIndexHtml('/index.html',
      '<!doctype html><html><head><title>t</title></head>' +
      '<body><script type="module" src="/src/bare.ts"></script></body></html>');

    expect(html).toContain(`/@id/__x00__${SHIM}`);
    // Ahead of the app's own entry, so the shim (and the Vue priming it pulls)
    // evaluates first - module scripts run in document order.
    expect(html.indexOf(SHIM)).toBeLessThan(html.indexOf('/src/bare.ts'));
  });

  /**
   * OVER REAL HTTP, because everything above this point is still the plugin
   * being asked about itself. The `/@id/__x00__` URL in that script tag is
   * decoded by Vite's transform middleware, not by any hook this plugin owns,
   * so an in-process call can only confirm the string we wrote - which is
   * exactly the mistake that let the SFC injection pass for six releases.
   * A listening server answering a fetch is the difference between "the tag
   * says the right thing" and "a browser gets the shim".
   */
  it('a browser fetching that tag really receives the shim', async () => {
    const live = await serve(true, true);
    try {
      await live.listen();
      // Use the URL Vite reports, unchanged. This server binds IPv6 only:
      // rewriting `localhost` to 127.0.0.1 here turned the intermittent
      // `ETIMEDOUT ::1:PORT` into a deterministic `ECONNREFUSED 127.0.0.1:PORT`,
      // which is how we learned that. The intermittent failure is the worker's
      // event loop being starved under full-suite load so the listener does not
      // accept in time - not the address family. fetchWhenReady handles it.
      const base = live.resolvedUrls?.local[0];
      expect(base).toBeTruthy();

      const html = await (await fetchWhenReady(new URL('/', base))).text();
      const src = html.match(/src="([^"]*vapor-chamber-hmr)"/)?.[1];
      expect(src).toBeTruthy();

      const res = await fetchWhenReady(new URL(src!, base));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('__VAPOR_CHAMBER_BUS__');
      // It pulls the Vue priming module too, which is the ordering the design
      // depends on - and that module resolved, so it is not the no-op stub.
      expect(body).toContain('vapor-chamber-hmr-vue-prime');
    } finally {
      await live.close();
    }
  });

  it('reaches an app whose entry never names the package', async () => {
    // The module-graph route cannot see this entry at all: nothing in it
    // matches, so the transform declines and the HTML tag is the only route.
    const entry = await server.transformRequest('/src/bare.ts');
    expect(entry?.code).not.toContain(SHIM);

    const html = await server.transformIndexHtml('/index.html',
      '<!doctype html><html><head></head><body></body></html>');
    expect(html).toContain(SHIM);
  });
});
