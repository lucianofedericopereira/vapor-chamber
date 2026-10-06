/**
 * The HTTP client's failures are the core's (7.1 #16, log s35.131): the same
 * BusError a bridge returns for the same answer, read once where the response
 * arrives, retried by the bus's one rule.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { BusError, conditionOf, createAsyncCommandBus } from '../src/command-bus';
import { createHttpClient, postCommand } from '../src/http';
import { problemOf } from '../src/http-errors';
import { createHttpBridge } from '../src/transports';
import { it } from '../src/vitest';

function mockResponse(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  const all = { 'content-type': 'application/json', ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { entries: () => Object.entries(all), get: (k: string) => (all as Record<string, string>)[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}
const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { vi.unstubAllGlobals(); });

const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('resolved'); }, (e: unknown) => e as BusError);

describe('one failure, whichever path', () => {
  it('a backend problem: the client throws what the bridge returns', async () => {
    const problem = { status: 409, code: 'stale', detail: 'Changed meanwhile', version: 3 };
    fetchMock().mockResolvedValue(mockResponse(409, problem, { 'retry-after': '2' }));
    const direct = await caught(postCommand('/api/vc', {}));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const viaBridge = (await bus.dispatch('orderSave', {})).error as BusError;
    expect(direct).toBeInstanceOf(BusError);
    expect(direct.code).toBe('remote:conflict:stale');
    expect(direct.message).toBe('Changed meanwhile');
    expect(direct.context).toMatchObject({ status: 409, code: 'stale', version: 3, retryIn: 2000 });
    expect(viaBridge.code).toBe(direct.code);
    expect(viaBridge.context).toEqual(direct.context);
    expect(problemOf(direct)).toEqual(problemOf(viaBridge));
  });

  it('a non-problem body is remote:<condition>:http with its status', async () => {
    fetchMock().mockResolvedValue(mockResponse(500, 'oops', { 'content-type': 'text/plain' }));
    const e = await caught(postCommand('/api/vc', {}));
    expect(e.code).toBe('remote:failed:http');
    expect(e.context).toMatchObject({ status: 500 });
  });

  it('no reply in time is transport:timeout:reply on both paths', async () => {
    fetchMock().mockImplementation((_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const direct = await caught(postCommand('/api/vc', {}, { timeout: 5 }));
    expect(direct.code).toBe('transport:timeout:reply');
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc', timeout: 5 }));
    expect(((await bus.dispatch('x', {})).error as BusError).code).toBe('transport:timeout:reply');
  });

  it('no response at all is transport:lost:reply on both paths', async () => {
    fetchMock().mockRejectedValue(new TypeError('Failed to fetch'));
    const direct = await caught(postCommand('/api/vc', {}));
    expect(direct.code).toBe('transport:lost:reply');
    expect((direct as Error).cause).toBeInstanceOf(TypeError);
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    expect(((await bus.dispatch('x', {})).error as BusError).code).toBe('transport:lost:reply');
  });

  it("the caller's abort: transport:aborted:request from the client, the dispatch's abort on the bus", async () => {
    fetchMock().mockImplementation((_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const ac = new AbortController();
    const pending = caught(postCommand('/api/vc', {}, { signal: ac.signal }));
    ac.abort();
    expect((await pending).code).toBe('transport:aborted:request');
  });

  it('a body that is not the JSON it declared is remote:unexpected:json, the parse error as cause', async () => {
    fetchMock().mockResolvedValue(mockResponse(200, '{oops'));
    const e = await caught(createHttpClient({ retry: 0 }).get('/x'));
    expect(e.code).toBe('remote:unexpected:json');
    expect((e as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('status first: a 503 whose body is not its declared JSON stays remote:limited, on every path', async () => {
    fetchMock().mockResolvedValue(mockResponse(503, '<html>busy</html>'));
    expect((await caught(createHttpClient({ retry: 0 }).get('/x'))).code).toBe('remote:limited:http');
    expect((await caught(postCommand('/api/vc', {}))).code).toBe('remote:limited:http');
  });

  it('a 2xx reply that is not the JSON envelope fails the command: remote:unexpected:json', async () => {
    fetchMock().mockResolvedValue(mockResponse(200, '<html>login</html>', { 'content-type': 'text/html' }));
    expect((await caught(postCommand('/api/vc', {}))).code).toBe('remote:unexpected:json');
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const r = await bus.dispatch('orderSave', {});
    expect(r.ok).toBe(false);
    expect((r.error as BusError).code).toBe('remote:unexpected:json');
    fetchMock().mockResolvedValue(mockResponse(200, [1, 2]));
    expect(((await bus.dispatch('orderSave', {})).error as BusError).code).toBe('remote:unexpected:json');
  });

  it('a 2xx with an empty body is a success with no data, on every path', async () => {
    fetchMock().mockResolvedValue(mockResponse(200, ''));
    expect((await createHttpClient().get('/x')).data).toBeNull();
    expect((await postCommand('/api/vc', {})).data).toBeNull();
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    expect((await bus.dispatch('orderSave', {})).ok).toBe(true);
  });

  it("a custom client's rejection carrying a response is read as that answer", async () => {
    const problem = { status: 409, code: 'stale', detail: 'Changed meanwhile' };
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient: { post: () => Promise.reject({ response: { status: 409, data: problem } }) } as never }));
    const e = (await bus.dispatch('orderSave', {})).error as BusError;
    expect(e.code).toBe('remote:conflict:stale');
    expect(problemOf(e)).toEqual(problem);
  });

  it("a response interceptor's own throw passes through untouched", async () => {
    fetchMock().mockResolvedValue(mockResponse(200, { ok: 1 }));
    const http = createHttpClient();
    const own = new RangeError('app');
    http.interceptors.response.use(() => { throw own; });
    await expect(http.get('/x', { silent: true })).rejects.toBe(own);
  });

  it('a request marked silent says so in context', async () => {
    fetchMock().mockResolvedValue(mockResponse(400, { status: 400, code: 'bad' }));
    const e = await caught(postCommand('/api/vc', {}, { silent: true }));
    expect(e.context?.silent).toBe(true);
  });

  it('the safe helpers return the same failure', async () => {
    fetchMock().mockResolvedValue(mockResponse(404, { status: 404, code: 'nope', detail: 'Not here' }));
    const http = createHttpClient({ retry: 0 });
    const r = await http.safe.get('/x');
    expect(r.data).toBeNull();
    expect(r.status).toBe(404);
    expect(r.error).toBeInstanceOf(BusError);
    expect(conditionOf(r.error)).toBe('missing');
    expect(problemOf(r.error)).toEqual({ status: 404, code: 'nope', detail: 'Not here' });
  });
});

describe("the client's retry is the bus's rule", () => {
  const calls = () => fetchMock().mock.calls.length;

  it('an uncertain failure (every 5xx but 503/504, no response) is re-sent for an idempotent request only', async () => {
    const http = createHttpClient({ retry: 1 });
    const answers: Array<() => unknown> = [500, 501, 502, 505].map((s) => () => Promise.resolve(mockResponse(s, null)));
    answers.push(() => Promise.reject(new TypeError('Failed to fetch')));
    for (const answer of answers) {
      fetchMock().mockReset();
      fetchMock().mockImplementation(answer);
      await caught(http.get('/x'));
      expect(calls()).toBe(2);
      fetchMock().mockClear();
      await caught(http.post('/x', {}));
      expect(calls()).toBe(1);
      fetchMock().mockClear();
      await caught(http.post('/x', {}, { headers: { 'Idempotency-Key': 'k1' } }));
      expect(calls()).toBe(2);
    }
  });

  it('idempotent by RFC 9110 9.2.2: GET, HEAD, OPTIONS, PUT, DELETE re-sent; POST, PATCH not', async () => {
    const http = createHttpClient({ retry: 1 });
    fetchMock().mockResolvedValue(mockResponse(500, null));
    const sent = async (method: string) => {
      fetchMock().mockClear();
      await caught(http.request('/x', { method: method as never }));
      return calls();
    };
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']) expect([m, await sent(m)]).toEqual([m, 2]);
    for (const m of ['POST', 'PATCH']) expect([m, await sent(m)]).toEqual([m, 1]);
  });

  it('the key is read as a header name, case-insensitively (RFC 9110 5.1)', async () => {
    const http = createHttpClient({ retry: 1 });
    fetchMock().mockResolvedValue(mockResponse(500, null));
    await caught(http.post('/x', {}, { headers: { 'idempotency-key': 'k1' } }));
    expect(calls()).toBe(2);
  });

  it('a transient one (408, 429, 503) is re-sent for any method; no reply (504, a timeout) only when identified; a verdict (400, 404, 409) never', async () => {
    const http = createHttpClient({ retry: 1 });
    for (const status of [408, 429, 503]) {
      fetchMock().mockReset();
      fetchMock().mockResolvedValue(mockResponse(status, null, { 'retry-after': '0' }));
      await caught(http.post('/x', {}));
      expect(calls()).toBe(2);
    }
    for (const [headers, sent] of [[{}, 1], [{ 'Idempotency-Key': 'k1' }, 2]] as const) {
      fetchMock().mockReset();
      fetchMock().mockResolvedValue(mockResponse(504, null, { 'retry-after': '0' }));
      await caught(http.post('/x', {}, { headers }));
      expect(calls()).toBe(sent);
      fetchMock().mockReset();
      fetchMock().mockImplementation((_u: string, init: { signal: AbortSignal }) => new Promise((_r, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      expect((await caught(http.post('/x', {}, { timeout: 5, headers }))).code).toBe('transport:timeout:reply');
      expect(calls()).toBe(sent);
    }
    for (const status of [400, 404, 409]) {
      fetchMock().mockReset();
      fetchMock().mockResolvedValue(mockResponse(status, null));
      await caught(http.get('/x'));
      expect(calls()).toBe(1);
    }
  });
});
