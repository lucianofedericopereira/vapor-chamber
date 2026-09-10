/**
 * serve-docs - serve the repo root so index.html can read docs/api/*.md.
 *
 * A static file server and nothing else: no rendering, no Markdown, no build
 * step. That is the point. The site is index.html plus assets/docs/*, which
 * fetch the generated Markdown at view time, so what this serves locally is
 * byte-for-byte what GitHub Pages serves. A previewer that rendered the
 * Markdown itself would be a second implementation to keep in agreement with
 * the first, and the two would drift.
 *
 * It exists because `fetch()` cannot read a `file://` URL, which is the only
 * reason opening index.html directly does not work.
 *
 * Run: node scripts/serve-docs.mjs [--port 8910]
 *      npm run docs:serve
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('.');
const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
// `--port` with no value, or a non-numeric one, used to reach `listen(NaN)` -
// which binds a RANDOM port while the line below cheerfully prints
// `http://127.0.0.1:NaN/`. The same degenerate-option shape swept out of src in
// this cycle (see src/bounds.ts), in the one script whose whole job is telling
// you where to point a browser.
const rawPort = portFlag === -1 ? 8910 : Number(args[portFlag + 1]);
const PORT = Number.isInteger(rawPort) && rawPort >= 0 && rawPort <= 65535 ? rawPort : 8910;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

if (!existsSync('docs/api/README.md')) {
  console.error('[serve-docs] docs/api is empty. Run `npm run docs` first.');
  process.exit(1);
}

const server = createServer((req, res) => {
  const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // normalize() collapses any `..` before the prefix check, so a traversal
  // resolves inside the root or is rejected.
  const path = join(ROOT, normalize(requested === '/' ? '/index.html' : requested));

  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`Not found: ${requested}`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(path).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`docs: http://127.0.0.1:${PORT}/  (ctrl-c to stop)`);
});
