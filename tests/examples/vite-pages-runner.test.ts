/**
 * examples/shared/vite.pages.config.mjs started for real (Vite's createServer on that config, free ports) and fetched with Node's fetch.
 * Why: `npm run examples` is the one command for the no-build pages, and they must reach the browser as the static server sends them, or they no longer show "no build step".
 * Shows: the index is Vite's (its client injected) and links every page; each page, a dist file and the import map's Vue arrive byte for byte as on disk, no client injected; the mock API answers; sprinkled-blade's backend answers on its own port with the cart rendered into its page; each beside a control.
 * See: examples/shared/static-server.mjs, tests/examples/static-server.test.ts, tests/examples/sprinkled-blade-mock-server.test.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { resolve } from 'node:path';
import { createServer, type InlineConfig, type ViteDevServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';

requireDist(existsSync(resolve(process.cwd(), 'dist/vapor-chamber-core.iife.min.js')));

/** A port the OS just handed out and released. */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

const file = (path: string) => readFileSync(resolve(process.cwd(), path));

let server: ViteDevServer;
let origin: string;
let backend: string;

beforeAll(async () => {
  const runner = (await import('../../examples/shared/vite.pages.config.mjs')) as unknown as {
    default: InlineConfig;
    examplesRunner: (o: { sprinkledPort: number }) => NonNullable<InlineConfig['plugins']>[number];
  };
  const [port, sprinkledPort] = [await freePort(), await freePort()];
  // The config as shipped, its ports swapped for free ones.
  server = await createServer({
    ...runner.default,
    configFile: false,
    logLevel: 'silent',
    server: { ...runner.default.server, port, strictPort: true, host: '127.0.0.1' },
    plugins: [runner.examplesRunner({ sprinkledPort })],
  });
  await server.listen();
  origin = `http://127.0.0.1:${port}`;
  backend = `http://127.0.0.1:${sprinkledPort}`;
});
afterAll(() => server?.close());

describe('the index', () => {
  it('is Vite-served (its client injected) and links every page', async () => {
    const r = await fetch(`${origin}/`);
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain('/@vite/client');
    for (const href of [
      '/examples/pages/router-demo/',
      '/examples/pages/feature-directives.html',
      '/examples/pages/pattern-1-blade-cdn.html',
      '/examples/pages/sprinkled-blade/index.html',
    ]) {
      expect(html).toContain(`href="${href}"`);
      // Each link answers.
      expect((await fetch(`${origin}${href}`)).status).toBe(200);
    }
  });
});

describe('the pages, as on disk', () => {
  it('sends each page byte for byte, with no client injected', async () => {
    for (const [url, path] of [
      ['/examples/pages/feature-directives.html', 'examples/pages/feature-directives.html'],
      ['/examples/pages/pattern-1-blade-cdn.html', 'examples/pages/pattern-1-blade-cdn.html'],
      ['/examples/pages/sprinkled-blade/index.html', 'examples/pages/sprinkled-blade/index.html'],
      // The router demo's catch-all: a deep link gets the shell.
      ['/examples/pages/router-demo/products/7', 'examples/pages/router-demo/index.html'],
    ]) {
      const body = Buffer.from(await (await fetch(`${origin}${url}`)).arrayBuffer());
      expect({ url, same: body.equals(file(path)) }).toEqual({ url, same: true });
      expect(body.toString()).not.toContain('/@vite/client');
    }
  });

  it('sends dist/ and the import map Vue untransformed', async () => {
    for (const path of ['dist/vapor-chamber-core.iife.min.js', 'dist/router/index.js', 'node_modules/vue/dist/vue.esm-browser.js']) {
      const body = Buffer.from(await (await fetch(`${origin}/${path}`)).arrayBuffer());
      expect({ path, same: body.equals(file(path)) }).toEqual({ path, same: true });
    }
    // Control: a file that is not there is a 404, not Vite's fallback page.
    expect((await fetch(`${origin}/examples/pages/nope.html`)).status).toBe(404);
  });
});

describe('the mock APIs', () => {
  it('answers /api/vc and the catalog read', async () => {
    const r = await fetch(`${origin}/api/vc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'cartState' }) });
    expect([r.status, await r.json()]).toEqual([200, { state: { count: 0, total: 0 } }]);
    const items = await fetch(`${origin}/api/items?page=1`);
    expect([items.status, items.headers.get('cache-groups')]).toEqual([200, '"items"']);
    // Control: an unknown command is still a problem.
    expect((await fetch(`${origin}/api/vc`, { method: 'POST', body: JSON.stringify({ command: 'nope' }) })).status).toBe(404);
  });

  it("starts sprinkled-blade's backend beside it, the cart rendered into its page", async () => {
    const page = await (await fetch(`${backend}/`)).text();
    expect(page).toContain(`data-cart='{"count":0,"total":0,"summary":"0 items (total: $0.00)"}'`);
    const r = await fetch(`${backend}/api/vc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'cartAdd', target: { id: 1 } }) });
    expect([r.status, ((await r.json()) as { state: { count: number } }).state.count]).toEqual([200, 1]);
    // Control: the Vite server's own /api/vc is the static server's, a cart of its own.
    const own = await fetch(`${origin}/api/vc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'cartState' }) });
    expect(((await own.json()) as { state: { count: number } }).state.count).toBe(0);
  });
});
