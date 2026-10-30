/**
 * examples/static-server.mjs started for real and fetched with Node's fetch.
 * Why: the no-build pages and the browser project talk to this server, and a stub would only repeat the handler table.
 * Shows: prototype names are unknown commands; an unreadable body is a 400; the catalog carries ETag and Cache-Groups (RFC 9875), a matching If-None-Match is a 304, its one write names the group; each beside a control.
 * See: audit SSV-1, SSV-2.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startExampleServer, type ExampleServer } from './start-server';

let server: ExampleServer;
beforeAll(async () => { server = await startExampleServer('examples/static-server.mjs', 'Static host for examples'); });
afterAll(() => server.stop());

describe('GET /favicon.ico', () => {
  // A browser asks for it on each origin's first page, and a 404 is a console error there.
  it('answers 200 with the project icon (FAV)', async () => {
    const r = await fetch(`${server.origin}/favicon.ico`);
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'image/x-icon']);
    expect(Buffer.from(await r.arrayBuffer()).equals(readFileSync(resolve(process.cwd(), 'assets/favicon/favicon.ico')))).toBe(true);
    // Control: a file that is not there still answers 404.
    expect((await fetch(`${server.origin}/nope.ico`)).status).toBe(404);
  });
});

/** POST /api/vc with a raw body; answers status and parsed JSON. */
async function dispatch(body: string): Promise<{ status: number; type: string | null; json: Record<string, unknown> }> {
  const r = await fetch(`${server.origin}/api/vc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return { status: r.status, type: r.headers.get('content-type'), json: await r.json() };
}

describe('POST /api/vc', () => {
  it('answers 404 unknown_command for a name Object.prototype carries (SSV-1)', async () => {
    for (const command of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const r = await dispatch(JSON.stringify({ command, target: { id: 1 } }));
      expect({ command, status: r.status, code: r.json.code }).toEqual({ command, status: 404, code: 'unknown_command' });
    }
    // Positive control: a registered command still answers.
    const ok = await dispatch(JSON.stringify({ command: 'cartAdd', target: { id: 7 } }));
    expect(ok.status).toBe(200);
    expect(ok.json.state).toMatchObject({ count: expect.any(Number), lastAdded: '#7' });
  });

  it('answers 400 missing_command to a body it cannot read, as the reference controller does (SSV-2)', async () => {
    for (const body of ['{"command":', 'not json', 'null', '', '{}', '{"command":""}']) {
      const r = await dispatch(body);
      expect({ body, status: r.status, type: r.type, json: r.json }).toEqual({
        body,
        status: 400,
        type: 'application/problem+json',
        json: { status: 400, code: 'missing_command', detail: 'Missing "command" field' },
      });
    }
    // Positive control: a good request answers 200.
    expect((await dispatch(JSON.stringify({ command: 'cartState' }))).status).toBe(200);
  });
});

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${server.origin}${path}`, { headers });
}

describe('GET /api/items', () => {
  it('answers a list and an item with their ETag and Cache-Groups (CAT-1)', async () => {
    for (const path of ['/api/items?page=2&per_page=5&sort=-price', '/api/items/9']) {
      const r = await get(path);
      expect({ path, status: r.status, group: r.headers.get('cache-groups'), control: r.headers.get('cache-control'), tag: /^"[0-9a-f]{16}"$/.test(r.headers.get('etag') ?? '') }).toEqual({
        path, status: 200, group: '"items"', control: 'no-cache', tag: true,
      });
    }
    // Control: the same read twice carries the same tag, a different page another.
    const a = (await get('/api/items?page=1')).headers.get('etag');
    expect([(await get('/api/items?page=1')).headers.get('etag') === a, (await get('/api/items?page=2')).headers.get('etag') === a]).toEqual([true, false]);
  });

  it('answers 304 with no body to a matching If-None-Match, 200 to any other (CAT-2)', async () => {
    const tag = (await get('/api/items?page=3')).headers.get('etag') as string;
    const same = await get('/api/items?page=3', { 'If-None-Match': tag });
    expect([same.status, await same.text(), same.headers.get('etag'), same.headers.get('cache-groups')]).toEqual([304, '', tag, '"items"']);
    const list = await get('/api/items?page=3', { 'If-None-Match': `"other", ${tag}` });
    expect(list.status).toBe(304);
    // Controls: another tag, and a tag of another page.
    expect((await get('/api/items?page=3', { 'If-None-Match': '"other"' })).status).toBe(200);
    const page4 = (await get('/api/items?page=4')).headers.get('etag') as string;
    expect((await get('/api/items?page=3', { 'If-None-Match': page4 })).status).toBe(200);
  });

  it('answers an unknown item as a problem with no tag, as before (CAT-3)', async () => {
    const r = await get('/api/items/999');
    expect([r.status, r.headers.get('content-type'), r.headers.get('etag'), await r.json()]).toEqual([
      404, 'application/problem+json', null, { status: 404, code: 'not_found', detail: 'No such item' },
    ]);
  });
});

// The catalog is shared by the tests of one server, so each reads its stock before it writes.
describe('POST /api/vc productStockAdd', () => {
  const stock = async (id: number) => ((await (await get(`/api/items/${id}`)).json()) as { stock: number }).stock;

  it('changes the stock, names the group it made stale, and moves the reads tag (CAT-4)', async () => {
    const before = { stock: await stock(2), tag: (await get('/api/items/2')).headers.get('etag') };
    const r = await fetch(`${server.origin}/api/vc`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'productStockAdd', target: { id: 2 }, payload: { qty: 5 } }),
    });
    const json = (await r.json()) as { state: { id: number; stock: number } };
    expect([r.status, r.headers.get('cache-group-invalidation'), json.state.stock, await stock(2)]).toEqual([200, '"items"', before.stock + 5, before.stock + 5]);
    // The old tag no longer matches: the read is stale.
    expect((await get('/api/items/2', { 'If-None-Match': before.tag as string })).status).toBe(200);
    // Control: a command that changes no catalog names no group.
    const cart = await dispatch(JSON.stringify({ command: 'cartAdd', target: { id: 1 } }));
    const raw = await fetch(`${server.origin}/api/vc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'cartState' }) });
    expect([cart.status, raw.headers.get('cache-group-invalidation')]).toEqual([200, null]);
  });

  it('refuses what the stock cannot give, as a problem that names no group (CAT-5)', async () => {
    const send = (target: unknown, payload: unknown) =>
      fetch(`${server.origin}/api/vc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'productStockAdd', target, payload }) });
    const before = await stock(1);
    const cases: Array<[unknown, unknown, number, string]> = [
      [{ id: 1 }, { qty: -(before + 1) }, 409, 'out_of_stock'],
      [{ id: 999 }, { qty: 1 }, 404, 'not_found'],
      [{ id: 1 }, { qty: 1.5 }, 422, 'invalid_qty'],
      [{ id: 1 }, {}, 422, 'invalid_qty'],
    ];
    for (const [target, payload, status, code] of cases) {
      const r = await send(target, payload);
      expect({ status: r.status, type: r.headers.get('content-type'), group: r.headers.get('cache-group-invalidation'), code: ((await r.json()) as { code: string }).code }).toEqual({
        status, type: 'application/problem+json', group: null, code,
      });
    }
    expect(await stock(1)).toBe(before);
    // Control: selling exactly what is there is allowed.
    const all = await send({ id: 1 }, { qty: -before });
    expect([all.status, await stock(1)]).toEqual([200, 0]);
  });

  it('lets a cross-origin page read the group it names (CAT-6)', async () => {
    const pre = await fetch(`${server.origin}/api/vc`, { method: 'POST', headers: { Origin: 'http://other.test', 'Content-Type': 'application/json' }, body: '{"command":"cartState"}' });
    expect(pre.headers.get('access-control-expose-headers')).toBe('Cache-Group-Invalidation');
  });
});
