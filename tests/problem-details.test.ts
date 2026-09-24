/**
 * FIXTURE - an RFC 9457 problem document through the real client and bridges.
 *
 * A backend that answers a failure as `application/problem+json`
 * (`{ type, title, status, detail, code }`, `code` as an extension member)
 * lost it three ways, each measured here with only `fetch` stubbed:
 *
 *  - `createHttpClient` parsed a body only when its content type contained
 *    `application/json`, which `application/problem+json` does not. The
 *    problem stayed a string, so `HttpError.code` read `undefined`. `postCommand`
 *    was never affected - its `doFetch` calls `raw.json()` whatever the type -
 *    so a bridge lost the code only when it was handed an `httpClient`.
 *  - Every bridge took its message from `error ?? message`, never `detail`,
 *    so the backend's sentence became `HTTP 404`.
 *  - A batched result carrying `problem` instead of `ok: false` resolved as a
 *    SUCCESS whose value was undefined.
 *
 * The control in each block is today's `{ ok: false, error, code }` shape,
 * which must behave exactly as before.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createHttpClient } from '../src/http';
import { fetchLoaders } from '../src/router-fetch/index';
import { createBatchingHttpBridge, createHttpBridge, createWsBridge } from '../src/transports';
import { MockWebSocket, batchServer, problemReply, reply } from './backend-stubs';

const NOT_FOUND = {
  type: 'https://panel.test/problems/not_found',
  title: 'Not found',
  status: 404,
  detail: 'not a managed log: x.log',
  code: 'not_found',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createHttpClient reads a problem document', () => {
  it('parses application/problem+json, so the code survives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemReply(404, NOT_FOUND)));

    const error = await createHttpClient().get('/api/logs/x').catch((e) => e);

    expect(error.status).toBe(404);
    expect(error.code).toBe('not_found');
    expect(error.response.data).toEqual(NOT_FOUND);
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
    expect(error.code).toBe('not_found');
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
  it('load_failed carries the detail, and the problem rides on cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemReply(404, NOT_FOUND)));
    const { url } = fetchLoaders();
    const location = { path: '/logs/x', fullPath: '/logs/x', query: {}, params: {}, hash: '', matched: [] } as never;

    const error = (await Promise.resolve(url!('/api/logs/x', location, { queryDefs: {} } as never, new AbortController().signal, undefined as never))
      .catch((e: unknown) => e)) as Error & { code?: string; cause?: { code?: string; status?: number } };

    expect(error.code).toBe('load_failed');
    expect(error.message).toContain('not a managed log: x.log');
    expect(error.cause?.code).toBe('not_found');
    expect(error.cause?.status).toBe(404);
  });
});

describe('createHttpBridge reads a problem document', () => {
  function bridged(withClient: boolean) {
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', ...(withClient ? { httpClient: createHttpClient() } : {}) }));
    return bus;
  }

  for (const withClient of [false, true]) {
    const lane = withClient ? 'through an httpClient' : 'through postCommand';

    it(`takes the message from detail and keeps code and status (${lane})`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => problemReply(404, NOT_FOUND)));

      const result = await bridged(withClient).dispatch('logClear', { name: 'x.log' });

      expect(result).toFailWith('not_found');
      const err = result.error as Error & { status?: number };
      expect(err.message).toBe('not a managed log: x.log');
      expect(err.status).toBe(404);
    });

    it(`the control: { ok: false, error, code } is unchanged (${lane})`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        reply(404, { ok: false, error: 'not a managed log: x.log', code: 'not_found' })));

      const result = await bridged(withClient).dispatch('logClear', { name: 'x.log' });

      expect(result).toFailWith('not_found');
      expect((result.error as Error).message).toBe('not a managed log: x.log');
    });
  }
});

describe('createBatchingHttpBridge reads a problem document', () => {
  function batched() {
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    return bus;
  }

  it('a problem for the whole request fails every command with its detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problemReply(401, {
      type: 'https://panel.test/problems/gitea_signin',
      title: 'Sign in to Gitea',
      status: 401,
      detail: 'sign in to Gitea first',
      code: 'gitea_signin',
    })));

    const bus = batched();
    const [a, b] = await Promise.all([bus.dispatch('repoList', {}), bus.dispatch('repoRead', { id: 1 })]);

    for (const result of [a, b]) {
      expect(result).toFailWith('gitea_signin');
      expect((result.error as Error).message).toBe('sign in to Gitea first');
    }
  });

  it('a result carrying `problem` is a failure, not a success', async () => {
    batchServer((_command, sent) => (sent.target as { name: string }).name === 'panel.log'
      ? { state: { output: 'cleared' } }
      : { problem: NOT_FOUND });

    const bus = batched();
    const [ok, refused] = await Promise.all([
      bus.dispatch('logClear', { name: 'panel.log' }),
      bus.dispatch('logClear', { name: 'x.log' }),
    ]);

    expect(ok.ok).toBe(true);
    expect(ok.value).toEqual({ output: 'cleared' });
    expect(refused).toFailWith('not_found');
    expect((refused.error as Error).message).toBe('not a managed log: x.log');
  });

  it('a problem with no detail falls back to its title', async () => {
    batchServer(() => ({ problem: { title: 'Internal error', code: 'internal_error' } }));

    const result = await batched().dispatch('logClear', { name: 'x.log' });

    expect(result).toFailWith('internal_error');
    expect((result.error as Error).message).toBe('Internal error');
  });

  it('a bare problem still fails: the result\'s own code, then a generic message', async () => {
    batchServer(() => ({ code: 'crashed', problem: {} }));

    const result = await batched().dispatch('logClear', { name: 'x.log' });

    expect(result).toFailWith('crashed');
    expect((result.error as Error).message).toBe('Backend error');
  });

  it('the control: { ok: false, error, code } per result is unchanged', async () => {
    batchServer(() => ({ ok: false, error: 'not a managed log: x.log', code: 'not_found' }));

    const result = await batched().dispatch('logClear', { name: 'x.log' });

    expect(result).toFailWith('not_found');
    expect((result.error as Error).message).toBe('not a managed log: x.log');
  });
});

describe('createWsBridge reads a problem document', () => {
  it('a frame carrying `problem` is a failure, not a success', async () => {
    let socket!: MockWebSocket;
    vi.stubGlobal('WebSocket', class extends MockWebSocket {
      constructor(url: string) { super(url); socket = this; }
    });
    const bus = createAsyncCommandBus();
    const ws = createWsBridge({ url: 'ws://test' });
    bus.use(ws);
    ws.connect();
    await Promise.resolve();

    const pending = bus.dispatch('logClear', { name: 'x.log' });
    await Promise.resolve();
    const { id } = JSON.parse(socket.sent[0]!) as { id: string };
    socket.receive({ id, problem: NOT_FOUND });
    const result = await pending;

    expect(result).toFailWith('not_found');
    expect((result.error as Error).message).toBe('not a managed log: x.log');
  });
});
