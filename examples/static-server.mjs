#!/usr/bin/env node
/**
 * Static host for the no-build examples (sprinkled-blade, the pattern-*.html
 * pages). Serves the repo root, so a page's `../../dist/...` resolves.
 *
 * Sends `Cache-Control: no-store` on everything. These pages load `dist/`
 * straight off disk with no cache headers of their own, and a browser that
 * heuristically caches the bundle leaves you testing the library build from
 * ten minutes ago — including a bug you already fixed.
 *
 *   node examples/static-server.mjs [port]      # default 3000
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const port = Number(process.argv[2]) || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Minimal in-memory backend, so a static example that dispatches actually
 * completes instead of 404-ing on `/api/vc`. Same wire contract as
 * `sprinkled-blade/mock-server.mjs` and the Laravel controller:
 * `{ command, target, payload }` in, `{ ok, state }` out.
 */
const cart = { count: 0, total: 0 };
const commands = {
  cartAdd: (target, payload) => {
    const qty = payload?.qty ?? payload?.quantity ?? 1;
    cart.count += qty;
    cart.total += 19.99 * qty;
    return { ...cart, lastAdded: `#${target?.id ?? 1}` };
  },
  cartClear: () => {
    cart.count = 0;
    cart.total = 0;
    return { ...cart };
  },
  cartState: () => ({ ...cart }),
};

function api(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    try {
      const { command, target, payload } = JSON.parse(body || '{}');
      const fn = commands[command];
      if (!fn) {
        json(404, { ok: false, error: `Unknown command: ${command}`, code: 'unknown_command' });
        return;
      }
      json(200, { ok: true, state: fn(target, payload) });
    } catch (e) {
      json(500, { ok: false, error: e?.message ?? 'Unknown error' });
    }
  });
}

/** A paginated catalog for the router demo's `load` templates. Names are
 *  deliberately MIXED CASE and carry no embedded number, so name-sort is a
 *  clean alphabetical demo (and proves the sort is case-insensitive: "americano"
 *  must land next to "Affogato", not after every capitalized name). */
const NAMES = [
  'Affogato', 'americano', 'Cappuccino', 'chai latte', 'Cold Brew',
  'Cortado', 'espresso', 'Flat White', 'Iced Latte', 'Macchiato',
  'MATCHA', 'Mocha', 'oat latte', 'Ristretto', 'Turmeric Tonic',
];
const CATALOG = Array.from({ length: 47 }, (_, i) => ({
  id: i + 1,
  name: NAMES[i % NAMES.length],
  price: +(3 + ((i * 7) % 23) + 0.99).toFixed(2),
  stock: (i * 13) % 40,
}));

createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://localhost');
  const url = decodeURIComponent(parsed.pathname);

  // Paginated list — what a `load: "/api/items?page={page}"` row fetches.
  if (url === '/api/items') {
    const perPage = Math.max(1, Math.min(50, Number(parsed.searchParams.get('per_page')) || 10));
    const page = Math.max(1, Number(parsed.searchParams.get('page')) || 1);
    // `sort=price` ascending, `sort=-price` descending — the leading-'-'
    // convention, so one query param carries both column and direction.
    const rawSort = parsed.searchParams.get('sort') || 'id';
    const desc = rawSort.startsWith('-');
    const field = desc ? rawSort.slice(1) : rawSort;
    const cmp =
      field === 'price'
        ? (a, b) => a.price - b.price
        : field === 'stock'
          ? (a, b) => a.stock - b.stock // numeric
          : field === 'name'
            ? // Case-insensitive: `sensitivity: 'base'` folds case (and accents),
              // so "americano" sorts by its letters, not after every capital.
              (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
            : (a, b) => a.id - b.id; // numeric, never string
    const rows = [...CATALOG].sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)));
    const start = (page - 1) * perPage;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(
      JSON.stringify({
        items: rows.slice(start, start + perPage),
        page,
        per_page: perPage,
        total: rows.length,
        last_page: Math.ceil(rows.length / perPage),
      }),
    );
    return;
  }

  // One item — `load: "/api/items/{id}"`, a path param this time.
  if (url.startsWith('/api/items/')) {
    const item = CATALOG.find((row) => String(row.id) === url.slice('/api/items/'.length));
    res.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(item ?? { error: 'not found' }));
    return;
  }

  // THE CATCH-ALL. Every URL under the router demo's base returns the same
  // shell, exactly like Laravel's `Route::get('/admin/{any?}')` — that is what
  // makes a deep link and a hard refresh work on a client-routed path.
  if (url.startsWith('/examples/router-demo')) {
    const file = resolve(repo, 'examples/router-demo/index.html');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
    return;
  }

  if (url === '/api/vc') {
    // Same-origin here, but allow the cross-origin case too — every header the
    // bridge actually sends must be on the preflight allowlist.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, X-Requested-With, X-CSRF-TOKEN, X-XSRF-TOKEN, Idempotency-Key',
    );
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'POST') { api(req, res); return; }
  }
  const target = join(repo, normalize(url));
  if (!target.startsWith(repo)) {
    res.writeHead(403, { 'Cache-Control': 'no-store' }).end('Forbidden');
    return;
  }
  const file =
    existsSync(target) && statSync(target).isDirectory() ? join(target, 'index.html') : target;
  if (!existsSync(file)) {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store, must-revalidate',
  });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Static host for examples → http://localhost:${port}/`);
  console.log(`  sprinkled-blade → http://localhost:${port}/examples/sprinkled-blade/index.html`);
});
