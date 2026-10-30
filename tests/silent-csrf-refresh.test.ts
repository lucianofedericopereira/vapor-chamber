/**
 * A `silent` request whose 419 refresh finds no token marks its transport:missing:csrf failure silent, as every other failure is.
 * Why: `silent` stamps context.silent so a global error handler can skip the failure; an unstamped refresh failure would reach that handler, and a shared refresh must not stamp a loud request silent.
 * Shows: postCommand and the client both mark the 419 failure silent, two requests sharing one refresh each keep their own mark, and the controls (a silent 500, a 419 without silent) are marked or left unmarked accordingly.
 * See: log s36.13, src/http.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, invalidateCsrfCache, postCommand } from '../src/http';

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateCsrfCache();
});

const reply = (status: number) => ({ ok: status >= 200 && status < 300, status, headers: { entries: () => [], get: () => null }, text: async () => '{}' });

/** A server (no document, so no token anywhere) answering the request with `status`, the refresh with 200. */
function server(status: number) {
  invalidateCsrfCache();
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(reply(url === '/sanctum/csrf-cookie' ? 200 : status))));
}

const failure = (p: Promise<unknown>) => p.then(() => null, (e: { code: string; context?: { silent?: boolean } }) => [e.code, e.context?.silent]);

describe('postCommand, silent', () => {
  it('a 419 whose refresh finds no token: transport:missing:csrf, marked silent', async () => {
    server(419);
    expect(await failure(postCommand('/api/cmd', {}, { csrf: true, silent: true }))).toEqual(['transport:missing:csrf', true]);
  });
});

describe('two requests sharing one refresh', () => {
  it('the client: a silent one does not mark the other one silent', async () => {
    server(419);
    const http = createHttpClient();
    const [quiet, loud] = await Promise.all([
      failure(http.post('/api/a', {}, { csrf: true, silent: true })),
      failure(http.post('/api/b', {}, { csrf: true })),
    ]);
    expect([quiet, loud]).toEqual([['transport:missing:csrf', true], ['transport:missing:csrf', undefined]]);
  });

  it('postCommand: a silent one does not mark the other one silent', async () => {
    server(419);
    const [quiet, loud] = await Promise.all([
      failure(postCommand('/api/a', {}, { csrf: true, silent: true })),
      failure(postCommand('/api/b', {}, { csrf: true })),
    ]);
    expect([quiet, loud]).toEqual([['transport:missing:csrf', true], ['transport:missing:csrf', undefined]]);
  });
});

describe('control', () => {
  it('postCommand, silent: a 500 is marked silent', async () => {
    server(500);
    expect(await failure(postCommand('/api/cmd', {}, { silent: true }))).toEqual(['remote:failed:problem', true]);
  });

  it('the client, silent: the same 419 is marked silent', async () => {
    server(419);
    expect(await failure(createHttpClient().post('/api/cmd', {}, { csrf: true, silent: true }))).toEqual(['transport:missing:csrf', true]);
  });

  it('postCommand, not silent: the same 419 is not marked', async () => {
    server(419);
    expect(await failure(postCommand('/api/cmd', {}, { csrf: true }))).toEqual(['transport:missing:csrf', undefined]);
  });
});
