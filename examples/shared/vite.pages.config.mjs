/**
 * One command for the no-build examples: `npm run examples`, then open
 * http://localhost:3000/.
 *
 * Vite serves the index (examples/index.html) and what that page needs from
 * Vite itself, nothing more. Every other URL goes, untouched, to the handler of
 * ./static-server.mjs: the pages under examples/pages/, dist/, the import map's
 * Vue, the favicon and the mock API (`/api/vc`, `/api/items*`). Untouched is the
 * point: those pages show a script tag or an import map with no build step,
 * and a page Vite transformed (its client injected, its imports rewritten)
 * would no longer show that. The URLs are the static server's, so
 * `node examples/shared/static-server.mjs` serves the same pages at the same
 * paths.
 *
 * sprinkled-blade's own backend (../pages/sprinkled-blade/mock-server.mjs)
 * starts beside it on port 3001, the port that page names: http://localhost:3001/
 * is the server-rendered, same-origin form, the page under /examples/pages/ the
 * cross-origin one (its README has both).
 *
 * The apps (examples/apps/) keep their own dev servers and builds, since their
 * bundles are measured apart; the index names their commands.
 */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { serveSprinkled } from '../pages/sprinkled-blade/mock-server.mjs';
import { serveExamples } from './static-server.mjs';

/** Vite's own URLs: the index, and its client, env and module paths. */
const VITE = /^\/(?:index\.html)?(?:\?.*)?$|^\/@(?:vite|id|fs)\//;

/**
 * The runner as a plugin: the static handler in front of Vite's middlewares,
 * and sprinkled-blade's backend on `sprinkledPort`, closed with the server.
 * Exported so tests/examples/vite-pages-runner.test.ts can pick free ports.
 *
 * @param {{ sprinkledPort?: number }} [options]
 * @returns {import('vite').Plugin}
 */
export function examplesRunner({ sprinkledPort = 3001 } = {}) {
  return {
    name: 'vapor-chamber-examples',
    configureServer(server) {
      server.middlewares.use((req, res, next) => (VITE.test(req.url ?? '/') ? next() : serveExamples(req, res)));
      const backend = createServer(serveSprinkled);
      backend.on('error', (e) =>
        server.config.logger.warn(`  sprinkled-blade backend not started on :${sprinkledPort}: ${e.message}`),
      );
      backend.listen(sprinkledPort, () =>
        server.config.logger.info(`  sprinkled-blade backend -> http://localhost:${sprinkledPort}/`),
      );
      server.httpServer?.once('close', () => backend.close());
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  // Under the root node_modules (ignored), so a run leaves nothing in examples/.
  cacheDir: fileURLToPath(new URL('../../node_modules/.vite-examples', import.meta.url)),
  // 3000, the static server's default, so every URL a page or README names holds.
  // The watcher stays out of the Laravel scaffold (gitignored, Laravel's vendor/ and a link
  // back to this repo).
  server: { port: 3000, strictPort: true, watch: { ignored: ['**/demo-app/**'] } },
  plugins: [examplesRunner()],
});
