/** Two reads sharing one request: each failure is marked by its own request's `silent` (log 36.13). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

afterEach(() => { vi.unstubAllGlobals(); });

/** A backend answering every GET with `status` after 5 ms unless its signal aborts first; counts requests. */
function backend(status: number) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init: { signal?: AbortSignal }) => {
    calls.push(url);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ ok: status < 300, status, headers: { entries: () => [], get: () => null }, text: async () => '{}' }), 5);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
    });
  }));
  return calls;
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: { code: string; context?: { silent?: boolean } }) => [e.code, e.context?.silent]);

describe('two reads of one URL at once', () => {
  it('a silent one first: the loud one is not marked silent', async () => {
    const calls = backend(500);
    const http = createHttpClient({ retry: false });
    const [quiet, loud] = await Promise.all([failure(http.get('/api/x', { silent: true })), failure(http.get('/api/x'))]);
    expect([quiet, loud, calls.length]).toEqual([['remote:failed:http', true], ['remote:failed:http', undefined], 2]);
  });

  it('a loud one first: the silent one is marked silent', async () => {
    const calls = backend(500);
    const http = createHttpClient({ retry: false });
    const [loud, quiet] = await Promise.all([failure(http.get('/api/x')), failure(http.get('/api/x', { silent: true }))]);
    expect([loud, quiet, calls.length]).toEqual([['remote:failed:http', undefined], ['remote:failed:http', true], 2]);
  });
});

describe('a silent read that its own signal aborts', () => {
  it('joining a read in flight: marked silent', async () => {
    backend(500);
    const http = createHttpClient({ retry: false });
    const leader = failure(http.get('/api/x', { silent: true }));
    const ac = new AbortController();
    const joiner = failure(http.get('/api/x', { silent: true, signal: ac.signal }));
    ac.abort();
    expect([await joiner, await leader]).toEqual([['transport:aborted:request', true], ['remote:failed:http', true]]);
  });

  it('already aborted when it would join: marked silent', async () => {
    backend(500);
    const http = createHttpClient({ retry: false });
    const leader = failure(http.get('/api/x', { silent: true }));
    const ac = new AbortController();
    ac.abort();
    expect(await failure(http.get('/api/x', { silent: true, signal: ac.signal }))).toEqual(['transport:aborted:request', true]);
    await leader;
  });

  it('leading a read others may join: marked silent', async () => {
    backend(500);
    const http = createHttpClient({ retry: false });
    const ac = new AbortController();
    const leader = failure(http.get('/api/x', { silent: true, signal: ac.signal }));
    ac.abort();
    expect(await leader).toEqual(['transport:aborted:request', true]);
  });
});

describe('control', () => {
  it('a silent read, alone, that its signal aborts: marked silent', async () => {
    backend(500);
    const ac = new AbortController();
    const p = failure(createHttpClient({ retry: false }).get('/api/x', { silent: true, signal: ac.signal, dedupe: false }));
    ac.abort();
    expect(await p).toEqual(['transport:aborted:request', true]);
  });

  it('two silent reads: both marked, one request', async () => {
    const calls = backend(500);
    const http = createHttpClient({ retry: false });
    const both = await Promise.all([failure(http.get('/api/x', { silent: true })), failure(http.get('/api/x', { silent: true }))]);
    expect([both, calls.length]).toEqual([[['remote:failed:http', true], ['remote:failed:http', true]], 1]);
  });

  it('two loud reads: neither marked, one request', async () => {
    const calls = backend(500);
    const http = createHttpClient({ retry: false });
    const both = await Promise.all([failure(http.get('/api/x')), failure(http.get('/api/x'))]);
    expect([both, calls.length]).toEqual([[['remote:failed:http', undefined], ['remote:failed:http', undefined]], 1]);
  });
});

/*
 * HttpConfig.silent marks a request's own failure for a global error handler
 * to skip. A GET joins a read already in flight for the same key, and the
 * key holds what changes the answer (method, responseType, the 304 opt-in,
 * headers, url), and not `silent`, which changes the failure's mark. The
 * leader's chain marks the error in place (asSilent), and every joiner was
 * handed that same object. Now `silent` is in the key, as the 304 opt-in is:
 * a silent read and a loud one at once are two requests (asserted), each
 * marked by its own. A holder's own abort (`hold`, an already aborted
 * joiner) was not marked at all; it is now. The controls: two reads alike,
 * one request; a silent read alone, aborted.
 */
