/** One spelling per request header name, merged as the Fetch Standard's "set": first spelling kept, last value wins (plan 1.27 item 4). Rationale at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createHttpClient, invalidateCsrfCache, postCommand } from '../src/http';
import { idempotent } from '../src/plugins-extra';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

function ok(status = 200, body = '{"state":1}') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  return {
    ok: status >= 200 && status < 300, status, url: '', redirected: false,
    headers: { entries: () => Object.entries(headers), get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
  };
}

// Each request's headers as fetch sends them (a Headers joins spellings), and the names as given.
let sent: Headers[];
let names: string[][];
function stubFetch(status: (n: number, url: string) => number = () => 200, body?: (init: { body?: unknown }) => string) {
  let n = 0;
  const fetch = vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: unknown }) => {
    if (url !== '/sanctum/csrf-cookie') {
      sent.push(new Headers(init.headers));
      names.push(Object.keys(init.headers ?? {}));
    }
    return ok(status(++n, url), body?.(init));
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => { sent = []; names = []; });
afterEach(() => { vi.unstubAllGlobals(); invalidateCsrfCache(); });

describe('one spelling per header name', () => {
  it('postCommand: an app content-type replaces the default under its first spelling, never joined to it', async () => {
    stubFetch();
    await postCommand('/vc', {}, { headers: { 'content-type': 'application/vnd.api+json' } });
    expect(sent[0].get('content-type')).toBe('application/vnd.api+json');
    expect(names[0]).toEqual(['Content-Type', 'X-Requested-With']);
  });

  it('the bridge: an app idempotency-key header and the command key are one header, the command key', async () => {
    stubFetch();
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent());
    bus.use(createHttpBridge({ endpoint: '/vc', headers: { 'idempotency-key': '"app"' } }));
    await bus.dispatch('cartAdd', { id: 1 });
    const key = sent[0].get('idempotency-key') as string;
    expect(key).not.toContain(',');
    expect(key).not.toBe('"app"');
  });

  it('the batching bridge: two commands carrying one name in two spellings send it once', async () => {
    stubFetch(() => 200, (init) => JSON.stringify({ results: JSON.parse(String(init.body)).commands.map((c: { id: string }) => ({ id: c.id, state: 1 })) }));
    const bus = createAsyncCommandBus({ retry: false });
    bus.use((cmd, next) => { cmd.meta!.request = { headers: cmd.action === 'a' ? { 'X-Tenant': '1' } : { 'x-tenant': '2' } }; return next(); }, { priority: 10 });
    bus.use(createBatchingHttpBridge({ endpoint: '/vc' }));
    await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);
    expect(sent[0].get('x-tenant')).toBe('2');
  });

  it('the client: FormData drops an app content-type of any spelling, so the browser sets the boundary', async () => {
    stubFetch();
    const form = new FormData();
    form.append('a', '1');
    await createHttpClient().post('/up', form, { headers: { 'content-type': 'application/json' } });
    expect(sent[0].get('content-type')).toBeNull();
  });

  it('the client: an object body sends one Content-Type', async () => {
    stubFetch();
    await createHttpClient().post('/x', { a: 1 }, { headers: { 'content-type': 'text/plain' } });
    expect(sent[0].get('content-type')).toBe('application/json');
  });

  it('a 419 refresh replaces an app x-csrf-token, never sent beside the fresh one', async () => {
    let cookie = 'XSRF-TOKEN=stale';
    vi.stubGlobal('document', { querySelector: () => null, get cookie() { return cookie; } });
    stubFetch((n, url) => {
      if (url === '/sanctum/csrf-cookie') { cookie = 'XSRF-TOKEN=fresh'; return 200; }
      return n === 1 ? 419 : 200;
    });
    await postCommand('/vc', {}, { csrf: true, headers: { 'x-csrf-token': 'app-stale' } });
    expect(sent[1].get('x-csrf-token')).toBeNull();
    expect(sent[1].get('x-xsrf-token')).toBe('fresh');
  });

  it('csrf: true sends its token once, under the spelling the app used for that name', async () => {
    vi.stubGlobal('document', { querySelector: () => ({ content: 'meta-token' }), cookie: '' });
    stubFetch();
    await postCommand('/vc', {}, { csrf: true, headers: { 'x-csrf-token': 'app' } });
    expect(sent[0].get('x-csrf-token')).toBe('meta-token');
    expect(names[0]).toEqual(['Content-Type', 'X-Requested-With', 'x-csrf-token']);
  });

  it('the client: csrf: true on a POST sends its token once', async () => {
    vi.stubGlobal('document', { querySelector: () => ({ content: 'meta-token' }), cookie: '' });
    stubFetch();
    await createHttpClient({ csrf: true }).post('/x', { a: 1 }, { headers: { 'x-csrf-token': 'app' } });
    expect(sent[0].get('x-csrf-token')).toBe('meta-token');
  });
});

describe('controls', () => {
  it('names with no collision go out exactly as the release sent them', async () => {
    vi.stubGlobal('document', { querySelector: () => ({ content: 'meta-token' }), cookie: '' });
    stubFetch();
    await postCommand('/vc', {}, { csrf: true, headers: { Authorization: 'Bearer t' } });
    await createHttpClient().get('/r', { headers: { 'Accept-Language': 'it' } });
    expect(names).toEqual([
      ['Content-Type', 'X-Requested-With', 'Authorization', 'X-CSRF-TOKEN'],
      ['Accept', 'X-Requested-With', 'Accept-Language'],
    ]);
  });

  it('csrf: true with no token found leaves the app its own csrf header', async () => {
    vi.stubGlobal('document', { querySelector: () => null, cookie: '' });
    stubFetch();
    await postCommand('/vc', {}, { csrf: true, headers: { 'X-CSRF-TOKEN': 'app' } });
    expect(sent[0].get('x-csrf-token')).toBe('app');
  });

  it('a request interceptor that returns a config with no headers: the request still goes', async () => {
    stubFetch();
    const http = createHttpClient();
    http.interceptors.request.use((config) => ({ ...config, headers: undefined }));
    await expect(http.get('/r')).resolves.toMatchObject({ status: 200 });
    expect([...sent[0].keys()]).toEqual([]);
  });

  it('a header name in any case still identifies the request for a re-send', async () => {
    const fetch = vi.fn((_u: string, init: { signal?: AbortSignal }) => new Promise((_r, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    await postCommand('/vc', {}, { retry: 1, timeout: 10, headers: { 'IDEMPOTENCY-KEY': '"k"' } }).catch(() => {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a header named __proto__ is a header, never a prototype write', async () => {
    stubFetch();
    const extra = JSON.parse('{"__proto__":"x","X-A":"1"}') as Record<string, string>;
    await postCommand('/vc', {}, { headers: extra });
    expect(names[0]).toEqual(['Content-Type', 'X-Requested-With', '__proto__', 'X-A']);
  });
});

/*
 * HTTP field names are case-insensitive (RFC 9110 5.1); an object key is
 * not. A request's headers live in a plain object, the library writing its
 * own names capitalised and the app writing whatever it wrote, so one name
 * could sit under two keys, and fetch sends them as one header, both values
 * joined ("a, b"). Found on the release: an app `idempotency-key` beside the
 * bridge's `Idempotency-Key`, an app `content-type` beside the default, a
 * FormData request keeping an app `content-type` (no multipart boundary), a
 * 419 refresh deleting only `X-CSRF-TOKEN`.
 *
 * The Fetch Standard's header list "set": "If list contains name, then set
 * the value of the first such header to value and remove the others." So
 * the merge keeps the first spelling and the last value, and deleting a name
 * deletes every spelling. The library keeps writing its own names as it
 * did; lowercasing on the wire stays the platform's (RFC 9113 8.2). Plan
 * .probes/1.27-plan.md item 4 rev 2, audit S4 and D7, log s35.163.
 */
