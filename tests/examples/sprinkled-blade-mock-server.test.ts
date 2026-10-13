// examples/sprinkled-blade/mock-server.mjs, started for real and fetched with Node's fetch.
import { existsSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';
import { startExampleServer, type ExampleServer } from './start-server';

requireDist(existsSync(resolve(process.cwd(), 'dist/vapor-chamber-core.iife.min.js')));

let server: ExampleServer;
beforeAll(async () => { server = await startExampleServer('examples/sprinkled-blade/mock-server.mjs', 'Mock backend listening'); });
afterAll(() => server.stop());

describe('GET /dist/', () => {
  it('answers 404 for a file that is not built, and keeps serving (SBL-7)', async () => {
    const missing = await fetch(`${server.origin}/dist/nope.js`).then(
      async (r) => ({ status: r.status, body: await r.text() }),
      (e: Error) => ({ status: 0, body: e.message }),
    );
    expect(missing.status).toBe(404);
    expect(missing.body).toContain('Not built');
    // Positive control: the file the page loads still answers 200 afterwards.
    const built = await fetch(`${server.origin}/dist/vapor-chamber-core.iife.min.js`);
    expect(built.status).toBe(200);
    expect(built.headers.get('content-type')).toContain('text/javascript');
    expect(server.alive()).toBe(true);
  });

  it('refuses a path that resolves outside dist/ (SBL-8)', async () => {
    // A raw request line keeps `..`: fetch and browsers would normalize it away.
    const raw = (path: string) => new Promise<number>((ok, fail) => {
      request({ host: '127.0.0.1', port: server.port, path }, (r) => { r.resume(); ok(r.statusCode!); }).on('error', fail).end();
    });
    expect(await raw('/dist/../package.json')).toBe(403);
    expect(await raw('/dist/../examples/sprinkled-blade/mock-server.mjs')).toBe(403);
    expect(await raw('/dist/%2e%2e/package.json')).toBe(403);
    expect(await raw('/dist/..%2fpackage.json')).toBe(403);
    expect(server.alive()).toBe(true);
    // Positive control: the same raw client gets the built file.
    expect(await raw('/dist/vapor-chamber-core.iife.min.js')).toBe(200);
  });
});

describe('GET /favicon.ico', () => {
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
  it('answers 404 unknown_command for a name Object.prototype carries (SBL-1)', async () => {
    for (const command of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const r = await dispatch(JSON.stringify({ command, target: { id: 1 } }));
      expect({ command, status: r.status, code: r.json.code }).toEqual({ command, status: 404, code: 'unknown_command' });
    }
    // Positive control: a registered handler still answers.
    const ok = await dispatch(JSON.stringify({ command: 'cartAdd', target: { id: 1 } }));
    expect(ok.status).toBe(200);
    expect(ok.json.state).toMatchObject({ count: expect.any(Number) });
  });

  it('answers 400 missing_command to a body it cannot read, as the reference controller does (SBL-2)', async () => {
    for (const body of ['{"command":', 'not json', 'null', '{}', '{"command":""}']) {
      const r = await dispatch(body);
      expect({ body, status: r.status, type: r.type, json: r.json }).toEqual({
        body,
        status: 400,
        type: 'application/problem+json',
        json: { status: 400, code: 'missing_command', detail: 'Missing "command" field' },
      });
    }
    // Positive controls: a handler's own problem keeps its status, a good request answers 200.
    const invalid = await dispatch(JSON.stringify({ command: 'cartAdd', target: {} }));
    expect([invalid.status, invalid.json.code]).toEqual([422, 'invalid_target']);
    expect((await dispatch(JSON.stringify({ command: 'cartState' }))).status).toBe(200);
  });
});

/*
 * Why these tests start the real script: the bugs live in the order of
 * Node's `res.writeHead` calls and in how a raw request line reaches the
 * handler, and neither shows through a stub. Each test checks a request the
 * fix must refuse beside one it must still answer, so a server that refuses
 * everything fails as well. Rows SBL-1, SBL-2, SBL-7 and SBL-8 of the
 * 2026-10-12 release audit. FAV: a browser asks for `/favicon.ico` at the
 * root on the first page of each origin, and a 404 there is a console error
 * on that page (system Chrome, 2026-10-12; the headless shell never asks).
 * The icon lives in `assets/favicon/`.
 */
