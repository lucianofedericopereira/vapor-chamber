// examples/static-server.mjs, started for real and fetched with Node's fetch.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startExampleServer, type ExampleServer } from './start-server';

let server: ExampleServer;
beforeAll(async () => { server = await startExampleServer('examples/static-server.mjs', 'Static host for examples'); });
afterAll(() => server.stop());

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

/*
 * Why these tests start the real script: the server is what the no-build
 * example pages and the browser project talk to, and a stub would only
 * repeat the handler table. Each test checks a request the fix must refuse
 * beside one it must still answer. Rows SSV-1 and SSV-2 of the 2026-10-12
 * release audit. FAV: a browser asks for `/favicon.ico` at the root on the
 * first page of each origin, and a 404 there is a console error on that
 * page (system Chrome, 2026-10-12; the headless shell never asks). The icon
 * lives in `assets/favicon/`.
 */
