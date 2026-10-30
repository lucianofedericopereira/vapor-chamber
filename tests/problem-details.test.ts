/**
 * An RFC 9457 problem document read by the real HTTP client and the router-fetch loader, with only `fetch` stubbed.
 * Why: a failure must reach callers as `remote:<condition>:<code>` with `detail` as its message; otherwise the code and message are lost.
 * Shows: the client parses `+json` problem types and asks for them in `Accept`; the error carries code, message and problem; the loader wraps it as `router:failed:loader` with the problem on `cause`.
 * See: docs/contract.md, RFC 9457
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';
import { problemOf } from '../src/http-errors';
import { fetchLoaders } from '../src/router-fetch/index';
import { problemReply, reply } from './backend-stubs';

const NOT_FOUND = { status: 404, code: 'not_found', detail: 'not a managed log: x.log' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttpClient reads a problem document', () => {
  it('parses application/problem+json, so the code survives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemReply(404, NOT_FOUND)));

    const error = await createHttpClient().get('/api/logs/x').catch((e) => e);

    expect(error.code).toBe('remote:missing:not_found');
    expect(problemOf(error)).toEqual(NOT_FOUND);
  });

  it('takes the error message from detail, so every reader of the client gets it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemReply(404, NOT_FOUND)));

    const error = await createHttpClient().get('/api/logs/x').catch((e) => e);

    expect(error.message).toBe('not a managed log: x.log');
  });

  it('the control: a body with no detail keeps HTTP <status>', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      reply(404, { ok: false, error: 'gone', code: 'not_found' })));

    const error = await createHttpClient().get('/api/logs/x').catch((e) => e);

    expect(error.message).toBe('HTTP 404');
    expect(error.code).toBe('remote:missing:not_found');
  });

  it('parses any +json structured suffix, with parameters', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      reply(200, { data: [] }, 'application/vnd.api+json; charset=utf-8')));

    const res = await createHttpClient().get('/api/items');

    expect(res.data).toEqual({ data: [] });
  });

  it('leaves a type that only CONTAINS json alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, 'x', 'application/json-seq')));

    const res = await createHttpClient().get('/api/stream');

    expect(res.data).toBe('"x"');
  });

  it('asks for problem documents in Accept', async () => {
    const fetchMock = vi.fn(async () => reply(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await createHttpClient().get('/api/x');

    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers.Accept).toContain('application/problem+json');
    expect(headers.Accept).toContain('application/json');
  });
});

describe('router-fetch reads a problem document', () => {
  it('router:failed:loader carries the detail, and the problem rides on cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemReply(404, NOT_FOUND)));
    const { url } = fetchLoaders();
    const location = { path: '/logs/x', fullPath: '/logs/x', query: {}, params: {}, hash: '', matched: [] } as never;

    const error = (await Promise.resolve(url!('/api/logs/x', location, { queryDefs: {} } as never, new AbortController().signal, undefined as never))
      .catch((e: unknown) => e)) as Error & { code?: string; cause?: { code?: string; context?: { status?: number } } };

    expect(error.code).toBe('router:failed:loader');
    expect(error.message).toContain('not a managed log: x.log');
    expect(error.cause?.code).toBe('remote:missing:not_found');
    expect(error.cause?.context?.status).toBe(404);
    expect(problemOf(error)).toEqual(NOT_FOUND);
  });
});

