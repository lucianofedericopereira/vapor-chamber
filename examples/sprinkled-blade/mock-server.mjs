/**
 * Mock backend for the sprinkled-blade demo. Single endpoint that emulates
 * what your Laravel `VaporChamberController` (or Rails / Django equivalent)
 * would do: receive `{ command, target, payload }`, dispatch to a handler,
 * return `{ ok, state }` or `{ ok: false, error }`.
 *
 * Run:
 *   node mock-server.mjs
 *
 * Then open ./index.html (e.g. via `npx serve .`).
 */

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

/** The one place the cart is turned into text — server and client agree on it
 *  because the client re-renders with the same shape after each dispatch. */
const summary = (s) => `${s.count} items (total: $${s.total.toFixed(2)})`;

const handlers = {
  cartAdd: (target, payload, _state) => {
    if (typeof target?.id !== 'number') throw new Error('Missing target.id');
    const qty = payload?.qty ?? 1;
    _state.count += qty;
    _state.total += 19.99 * qty;
    return { count: _state.count, total: _state.total };
  },
  cartClear: (_target, _payload, _state) => {
    _state.count = 0;
    _state.total = 0;
    return { count: 0, total: 0 };
  },
  // Read-only: what the page asks for on load, because a static file cannot
  // render the cart the way a Blade template would. The cart lives here and
  // survives page reloads — reloading the browser must not appear to empty it.
  cartState: (_target, _payload, _state) => ({ count: _state.count, total: _state.total }),
};

// Per-instance "session" — in a real backend this is the user's cart row.
const state = { count: 0, total: 0 };

const PORT = 3001;

const server = createServer((req, res) => {
  // CORS for local-dev: allow the static HTML server (default :3000) to POST.
  res.setHeader('Access-Control-Allow-Origin', '*');
  // X-Requested-With is NOT optional: the HTTP bridge stamps
  // `X-Requested-With: XMLHttpRequest` on every dispatch (it is what makes
  // Laravel answer 419/401 as JSON instead of redirecting to a login page).
  // Leaving it out of the allowlist fails the CORS preflight, and the browser
  // reports the useless "Failed to fetch" / "header is not allowed" pair.
  // Any real cross-origin backend needs the same list.
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, X-Requested-With, X-CSRF-TOKEN, X-XSRF-TOKEN, Idempotency-Key',
  );
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Serve the page itself with the cart ALREADY RENDERED INTO IT — this is the
  // Blade half of the pattern, and the reason the demo has no loading flicker
  // on this origin: the first paint is correct, so the page has nothing to ask
  // for. `data-hydrated` tells the client script to skip its startup fetch.
  // (Serving it statically instead is still supported — the script falls back
  // to a `cartState` dispatch. That path is the one that flickers, which is
  // exactly the cost server-rendering buys away.)
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace(
      /<span id="count"[^>]*>[^<]*<\/span>/,
      `<span id="count" data-cart data-hydrated>${summary(state)}</span>`,
    );
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  // The bundle the page asks for (`../../dist/...` → `/dist/...` on this
  // origin). A real app serves this from public/vendor or a CDN; here the
  // backend hands out the freshly built file so the demo is one process.
  if (req.method === 'GET' && req.url?.startsWith('/dist/')) {
    const file = new URL(`../..${req.url.split('?')[0]}`, import.meta.url);
    try {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not built — run `npm run build` at the repo root');
    }
    return;
  }

  if (req.method !== 'POST' || req.url !== '/api/vc') {
    res.writeHead(404).end(JSON.stringify({ ok: false, error: 'Not found' }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const { command, target, payload } = JSON.parse(body);
      const fn = handlers[command];
      if (!fn) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `Unknown command: ${command}` }));
        return;
      }
      const result = fn(target, payload, state);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, state: result }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e?.message ?? 'Unknown error' }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Mock backend listening on http://localhost:${PORT}/api/vc`);
  console.log('Now open the demo with `npx serve .` and click "Add to cart".');
});
