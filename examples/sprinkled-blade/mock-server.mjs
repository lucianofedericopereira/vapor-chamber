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

import { createServer } from 'node:http';

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
};

// Per-instance "session" — in a real backend this is the user's cart row.
const state = { count: 0, total: 0 };

const PORT = 3001;

const server = createServer((req, res) => {
  // CORS for local-dev: allow the static HTML server (default :3000) to POST.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-TOKEN, X-XSRF-TOKEN');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
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
