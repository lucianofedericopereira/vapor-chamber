/**
 * Mock backend for the sprinkled-blade demo. Single endpoint that emulates
 * what your Laravel `VaporChamberController` (or Rails / Django equivalent)
 * would do: receive `{ command, target, payload }`, dispatch to a handler,
 * return `{ state }`, or an RFC 9457 problem (`application/problem+json`)
 * for a failure.
 *
 * Run:
 *   node mock-server.mjs [port]     # serves the page and the API, default 3001
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

/** The repo's dist/ directory, with its trailing separator. */
const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

/** What the page shows and what an answer carries: the cart and its sentence,
 *  said once, by the side that knows it. */
const view = (s) => ({ count: s.count, total: s.total, summary: `${s.count} items (total: $${s.total.toFixed(2)})` });

/** A failure a handler declares: answered as its RFC 9457 problem. */
class Problem extends Error {
  constructor(status, code, detail) { super(detail); this.status = status; this.code = code; }
}

const handlers = {
  cartAdd: (target, payload, _state) => {
    if (typeof target?.id !== 'number') throw new Problem(422, 'invalid_target', 'The target needs a numeric id.');
    const qty = payload?.qty ?? 1;
    _state.count += qty;
    _state.total += 19.99 * qty;
    return view(_state);
  },
  cartClear: (_target, _payload, _state) => {
    _state.count = 0;
    _state.total = 0;
    return view(_state);
  },
  // Read-only: the cart as it stands. The cart lives here and survives page
  // reloads - reloading the browser must not appear to empty it.
  cartState: (_target, _payload, _state) => view(_state),
};

// Per-instance "session" - in a real backend this is the user's cart row.
const state = { count: 0, total: 0 };

const PORT = Number(process.argv[2]) || 3001;

const server = createServer((req, res) => {
  // CORS for local-dev: allow the static HTML server (default :3000) to POST.
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Every header the transport sends that is not CORS-safelisted must be
  // listed: `Content-Type: application/json` on every dispatch, and
  // `Idempotency-Key` on a keyed one. A header left out fails the preflight,
  // and the browser reports the useless "Failed to fetch" / "header is not
  // allowed" pair. Any real cross-origin backend needs the same list.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, X-CSRF-TOKEN, X-XSRF-TOKEN, Idempotency-Key',
  );
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve the page itself with the cart ALREADY RENDERED INTO IT - this is the
  // Blade half of the pattern, and the reason the demo has no loading flicker
  // on this origin: the first paint is correct, so the page has nothing to ask
  // for. The cart is the span's text and, as JSON, its `data-cart` (Blade's
  // `@json($cart)`), which the page's store starts from. (Serving the page
  // statically instead is still supported: nothing is rendered, and the count
  // shows after the first answer.)
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const cart = view(state);
    const json = JSON.stringify(cart).replaceAll('&', '&amp;').replaceAll("'", '&#39;');
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(
      /<span id="count"([^>]*)><\/span>/,
      // A function, not a string: the sentence holds a `$`, which `replace` reads in a string.
      (_match, attrs) => `<span id="count"${attrs} data-cart='${json}'>${cart.summary}</span>`,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // The bundle the page asks for (`../../dist/...` -> `/dist/...` on this
  // origin). A real app serves this from public/vendor or a CDN; here the
  // backend hands out the freshly built file so the demo is one process.
  if (req.method === 'GET' && req.url?.startsWith('/dist/')) {
    // A raw client keeps `..` in the path. Refuse anything that resolves
    // outside dist/. An encoded `/` makes fileURLToPath throw: outside too.
    let file = '';
    try { file = fileURLToPath(new URL(`../..${req.url.split('?')[0]}`, import.meta.url)); } catch {}
    if (!file.startsWith(DIST)) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }).end('Forbidden');
      return;
    }
    // Read before the head goes out: a 404 after a sent 200 throws
    // ERR_HTTP_HEADERS_SENT and stops the process.
    let js;
    try {
      js = readFileSync(file);
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not built - run `npm run build` at the repo root');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(js);
    return;
  }

  // A browser asks for /favicon.ico at the root. The project icon lives in assets/favicon/.
  if (req.method === 'GET' && req.url === '/favicon.ico') {
    const ico = readFileSync(new URL('../../assets/favicon/favicon.ico', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'image/x-icon', 'Cache-Control': 'no-store' });
    res.end(ico);
    return;
  }

  const problem = (status, code, detail) => {
    res.writeHead(status, { 'Content-Type': 'application/problem+json' });
    res.end(JSON.stringify({ status, code, detail }));
  };

  if (req.method !== 'POST' || req.url !== '/api/vc') {
    problem(404, 'not_found', 'Not found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    // A body that does not parse carries no command. The reference controller
    // answers a missing command with 400 `missing_command`: the request is at
    // fault, not the server.
    let parsed;
    try { parsed = JSON.parse(body); } catch {}
    const { command, target, payload } = parsed ?? {};
    if (command == null || command === '') {
      problem(400, 'missing_command', 'Missing "command" field');
      return;
    }
    try {
      // Own keys only: `handlers[command]` would find `toString`, `constructor`.
      const fn = Object.hasOwn(handlers, command) ? handlers[command] : undefined;
      if (!fn) {
        problem(404, 'unknown_command', `Unknown command: ${command}`);
        return;
      }
      const result = fn(target, payload, state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: result }));
    } catch (e) {
      if (e instanceof Problem) { problem(e.status, e.code, e.message); return; }
      console.error(e);
      problem(500, 'internal_error', 'Internal error');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mock backend listening on http://localhost:${PORT}/api/vc`);
  console.log(`Open http://localhost:${PORT} and click "Add to cart".`);
});
