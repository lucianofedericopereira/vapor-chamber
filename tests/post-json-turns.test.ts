// A POST through _postJson settles in the turns of a GET through _getJson: no frame of its own. The long note is at the end.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _getJson, _postJson } from '../src/http';

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

/** A fetch that answers at once with a JSON body, so every turn counted is the client's. */
const answer = (status: number, body: unknown) => {
  const text = JSON.stringify(body);
  const h: Record<string, string> = { 'content-type': 'application/json' };
  return Promise.resolve({
    ok: status >= 200 && status < 300, status, url: '/api', redirected: false,
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null, entries: () => Object.entries(h) },
    json: async () => JSON.parse(text), text: async () => text,
  });
};

afterEach(() => vi.unstubAllGlobals());

describe('_postJson: no async frame', () => {
  it('a POST settles in the turns of a GET', async () => {
    vi.stubGlobal('fetch', () => answer(200, { ok: 1 }));
    const get = await turns(_getJson('/api', {}));
    expect(await turns(_postJson('/api', '{}'))).toBe(get);
  });

  it('control: the counter sees a slower fetch', async () => {
    vi.stubGlobal('fetch', () => answer(200, { ok: 1 }));
    const get = await turns(_getJson('/api', {}));
    vi.stubGlobal('fetch', async () => { await null; return answer(200, { ok: 1 }); });
    expect(await turns(_getJson('/api', {}))).toBeGreaterThan(get);
  });

  it('a throw in its body is still a rejection, never a sync throw', async () => {
    vi.stubGlobal('fetch', () => answer(200, { ok: 1 }));
    const headers = { get bad(): string { throw new Error('header getter'); } } as unknown as Record<string, string>;
    let call: Promise<unknown> | undefined;
    expect(() => { call = _postJson('/api', '{}', { headers }); }).not.toThrow();
    await expect(call).rejects.toThrow('header getter');
  });
});

// Why: `_postJson` was `async` and returned runWithRetry's promise without an
// await, so every sent command paid an outer promise resolved with a thenable:
// ECMAScript 27.2.1.3.2 queues NewPromiseResolveThenableJob and then the
// `then`, two turns. `_getJson` already had the plain shape. The turn count pins
// it against `_getJson`, the same loop and fetch. The control keeps the counter
// honest. The last case pins what `async` gave for free: a throw in the body
// (a header getter, here) still reaches the caller as a rejection.
