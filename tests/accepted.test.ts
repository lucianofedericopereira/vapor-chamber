/**
 * A 202 answers an Accepted whose `done` follows the status monitor to the job's end.
 * Why: a 202 says the work is not done (RFC 9110 15.3.3); the app needs the job's end, and a 202 it ignores must cost nothing.
 * Shows: the dispatch resolves at once; done waits each declared wait and settles with the end, a problem, a timeout or an abort; nothing is polled until read; a batched 202 too.
 * See: plan 1.32 3c, log s35.140.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { createAsyncCommandBus, type BusError, type CommandResult } from '../src/command-bus';
import { httpTransport, type HttpTransportOptions } from '../src/transports';

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
const answer = ({ status, body, headers = {} }: Answer) => {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  return { ok: status < 300, status, url: 'https://api.test/vc', redirected: false, headers: { entries: () => Object.entries(h), get: (k: string) => h[k.toLowerCase()] ?? null }, text: async (): Promise<string> => JSON.stringify(body) };
};
const script = (...answers: Answer[]) => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return answer(answers[Math.min(calls.length - 1, answers.length - 1)]!); }));
  return calls;
};
const accepted: Answer = { status: 202, body: {}, headers: { location: '/jobs/7', 'retry-after': '0' } };
const setup = (poll: HttpTransportOptions['poll'] = {}, more: Partial<HttpTransportOptions> = {}) =>
  createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', poll: { interval: 1, ...poll }, ...more }) });
/** The dispatch's Accepted, its `done`. */
const doneOf = (r: CommandResult): Promise<CommandResult> => {
  expect(r.value).toBeInstanceOf(Accepted);
  return (r.value as Accepted).done;
};
const codeOf = (r: CommandResult): string => (r.error as BusError).code;
afterEach(() => { vi.unstubAllGlobals(); });

describe('Accepted: a 202 followed to its end', () => {
  it('the dispatch resolves at once; done settles with the state the monitor ends on', async () => {
    const calls = script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } }, { status: 200, body: { state: { file: 'x.csv' } } });
    const r = await setup().dispatch('orderExport', {});
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await doneOf(r)).toEqual({ ok: true, value: { file: 'x.csv' }, error: undefined });
    expect(calls.slice(1)).toEqual(['https://api.test/jobs/7', 'https://api.test/jobs/7']);
  });

  it('nothing is polled until done is read, and done is one promise', async () => {
    const calls = script(accepted, { status: 200, body: { state: 1 } });
    const r = await setup().dispatch('orderExport', {});
    await new Promise((res) => setTimeout(res, 30));
    expect(calls).toHaveLength(1);
    const a = r.value as Accepted;
    expect(a.done).toBe(a.done);
    expect((await a.done).value).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('a monitor answering a problem ends as that coded failure', async () => {
    script(accepted, { status: 200, body: { problem: { status: 422, code: 'bad_rows', detail: 'Row 3' } } });
    const end = await doneOf(await setup().dispatch('orderExport', {}));
    expect(codeOf(end)).toBe('remote:invalid:bad_rows');
  });

  it('past maxWait it ends as transport:timeout:job', async () => {
    script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const end = await doneOf(await setup({ maxWait: 30 }).dispatch('orderExport', {}));
    expect(codeOf(end)).toBe('transport:timeout:job');
  });

  it('control: a 202 with no Location, or a 200, is a plain success', async () => {
    let calls = script({ status: 202, body: { state: 3 } });
    expect(await setup().dispatch('orderExport', {})).toEqual({ ok: true, value: 3, error: undefined });
    calls = script({ status: 200, body: { state: 4 }, headers: { location: '/jobs/7' } });
    expect(await setup().dispatch('orderExport', {})).toEqual({ ok: true, value: 4, error: undefined });
    expect(calls).toHaveLength(1);
  });

  it('a 202 carrying a problem stays the failure', async () => {
    script({ status: 202, body: { problem: { status: 409, code: 'busy' } }, headers: { location: '/jobs/7' } });
    expect(codeOf(await setup().dispatch('orderExport', {}))).toBe('remote:conflict:busy');
  });

  it('bus.dispose() stops every follow: done settles aborted', async () => {
    const calls = script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const bus = setup();
    const done = doneOf(await bus.dispatch('orderExport', {}));
    for (let i = 0; i < 100 && calls.length < 2; i++) await new Promise((res) => setTimeout(res, 2));
    bus.dispose();
    const n = calls.length;
    expect(codeOf(await done)).toBe('core:aborted:dispatch');
    await new Promise((res) => setTimeout(res, 30));
    expect(calls.length).toBeLessThanOrEqual(n + 1);
  });

  it('done read after bus.dispose() settles aborted with nothing polled', async () => {
    const calls = script(accepted);
    const bus = setup();
    const r = await bus.dispatch('orderExport', {});
    bus.dispose();
    expect(codeOf(await doneOf(r))).toBe('core:aborted:dispatch');
    expect(calls).toHaveLength(1);
  });

  it('no Retry-After waits the interval', async () => {
    script({ status: 202, body: {}, headers: { location: '/jobs/7' } }, { status: 202, body: {} }, { status: 200, body: { state: 2 } });
    expect((await doneOf(await setup().dispatch('orderExport', {}))).value).toBe(2);
  });

  it('a poll with no response ends as that failure', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { if (n++ === 0) return answer(accepted); throw new TypeError('Failed to fetch'); }));
    expect(codeOf(await doneOf(await setup().dispatch('orderExport', {})))).toBe('transport:lost:reply');
  });

  it("the command's own signal stops the follow: done settles with the abort", async () => {
    const calls = script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const ac = new AbortController();
    const done = doneOf(await setup().dispatch('orderExport', {}, undefined, { signal: ac.signal }));
    ac.abort();
    expect(codeOf(await done)).toBe('core:aborted:dispatch');
    await new Promise((res) => setTimeout(res, 30));
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('dispose while a poll is on the wire ends it aborted', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      if (n++ === 0) return answer(accepted);
      return new Promise((_r, reject) => { init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    }));
    const bus = setup();
    const done = doneOf(await bus.dispatch('orderExport', {}));
    for (let i = 0; i < 100 && n < 2; i++) await new Promise((res) => setTimeout(res, 2));
    bus.dispose();
    expect(codeOf(await done)).toBe('core:aborted:dispatch');
  });

  it("the transport's scope signal stops the follow too", async () => {
    script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const scope = new AbortController();
    const done = doneOf(await setup({}, { scopeController: scope }).dispatch('orderExport', {}));
    scope.abort();
    expect(codeOf(await done)).toBe('core:aborted:dispatch');
  });

  it('a monitor declaring RateLimit t with no quota left is polled after t, not the interval (log 36.42)', async () => {
    vi.useFakeTimers();
    try {
      const calls = script(
        { status: 202, body: {}, headers: { location: '/jobs/7', ratelimit: '"default";r=0;t=1' } },
        { status: 202, body: {}, headers: { 'x-ratelimit-reset': '1' } },
        { status: 200, body: { state: 4 } },
      );
      const done = doneOf(await setup().dispatch('orderExport', {}));
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);
      expect((await done).value).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an app's own client sends and polls: Location and the wait in any case", async () => {
    const urls: string[] = [];
    const httpClient = {
      post: async () => ({ ok: true, status: 202, headers: { Location: '/jobs/9', 'Retry-After': '0' }, data: {} }),
      get: vi.fn(async (url: string, _config?: unknown) => { urls.push(url); return urls.length === 1 ? { status: 202, headers: { 'Retry-After': '0' }, data: {} } : { status: 200, headers: {}, data: { state: 5 } }; }),
    };
    const bus = setup({ interval: 60_000 }, { httpClient: httpClient as never });
    expect((await doneOf(await bus.dispatch('orderExport', {}))).value).toBe(5);
    expect(urls).toEqual(['/jobs/9', '/jobs/9']);
    expect(httpClient.get.mock.calls[0]![1]).toMatchObject({ dedupe: false });
  });

  it('Location in any case, its first string spelling; a reply with no headers is a plain success', async () => {
    const urls: string[] = [];
    let headers: unknown = { 'X-Abcdef': 'not it', LOCATION: 5, Location: '/jobs/2', location: '/jobs/3' };
    const httpClient = {
      post: async () => ({ ok: true, status: 202, headers, data: { state: 1 } }),
      get: async (url: string) => { urls.push(url); return { status: 200, headers: {}, data: { state: 9 } }; },
    };
    const bus = setup({}, { httpClient: httpClient as never });
    expect((await doneOf(await bus.dispatch('orderExport', {}))).value).toBe(9);
    expect(urls).toEqual(['/jobs/2']);
    headers = undefined;
    expect(await bus.dispatch('orderExport', {})).toEqual({ ok: true, value: 1, error: undefined });
  });

  it('a reply with no url follows Location as it is', async () => {
    const urls: string[] = [];
    const httpClient = {
      post: async () => ({ ok: true, status: 202, headers: { location: '/jobs/9' }, data: {} }),
      get: async (url: string) => { urls.push(url); return { status: 200, headers: {}, data: { state: 3 } }; },
    };
    expect((await doneOf(await setup({}, { httpClient: httpClient as never }).dispatch('orderExport', {}))).value).toBe(3);
    expect(urls).toEqual(['/jobs/9']);
  });

  it('a monitor answering a body that is not JSON (a sign-in page) ends as remote:unexpected:json, not as a success', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (n++ === 0
      ? answer(accepted)
      : { ok: true, status: 200, url: 'https://api.test/login', redirected: true, headers: { entries: () => [['content-type', 'text/html']], get: () => 'text/html' }, text: async (): Promise<string> => '<!doctype html><title>Sign in</title>' })));
    expect(codeOf(await doneOf(await setup().dispatch('orderExport', {})))).toBe('remote:unexpected:json');
  });

  it('a Location no URL holds is polled as sent: its failure ends done, not the dispatch', async () => {
    const calls = script({ status: 202, body: {}, headers: { location: 'http://[', 'retry-after': '0' } }, { status: 200, body: { state: 8 } });
    const r = await setup().dispatch('orderExport', {});
    expect(r.ok).toBe(true);
    expect((await doneOf(r)).value).toBe(8);
    expect(calls[1]).toBe('http://[');
  });

  it("a poll is a read: Accept, X-Requested-With and the transport's own headers, no body", async () => {
    const sent: RequestInit[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => { sent.push(init); return answer(n++ === 0 ? accepted : { status: 200, body: { state: 1 } }); }));
    await doneOf(await setup({}, { headers: { 'X-Tenant': '42' } }).dispatch('orderExport', {}));
    expect(sent[1]).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect(sent[1]!.body).toBeUndefined();
    expect(sent[1]!.headers).toMatchObject({ 'Accept': 'application/json, application/problem+json', 'X-Requested-With': 'XMLHttpRequest', 'X-Tenant': '42' });
  });

  it('a listener sees the Accepted with its command: what <action>$done carried', async () => {
    script(accepted, { status: 200, body: { state: 6 } });
    const bus = setup();
    const seen: Array<Promise<[string, unknown]>> = [];
    bus.on('orderExport', (cmd, r) => { if (r.value instanceof Accepted) seen.push(r.value.done.then((end) => [cmd.action, end.value])); });
    await bus.dispatch('orderExport', {});
    expect(await seen[0]).toEqual(['orderExport', 6]);
  });

});

describe('Accepted in a batch: the result carries its own 202', () => {
  let server: Server;
  let base = '';
  const gets: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        gets.push(req.url!);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ state: { job: req.url } }));
        return;
      }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const { commands } = JSON.parse(raw) as { commands: Array<{ id: string; command: string }> };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: commands.map((c) => (c.command === 'reportExport'
          ? { id: c.id, status: 202, headers: { Location: `/jobs/${c.id}`, 'Retry-After': '0' } }
          : { id: c.id, status: 200, headers: {}, state: 'saved' })) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('a batched 202 is an Accepted, its Location against the batch response', async () => {
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: `${base}/vc`, batch: {}, poll: { interval: 1 } }) });
    const [job, plain] = await Promise.all([bus.dispatch('reportExport', {}), bus.dispatch('noteSave', {})]);
    expect(plain).toEqual({ ok: true, value: 'saved', error: undefined });
    const end = await doneOf(job);
    expect(gets).toHaveLength(1);
    expect(end).toEqual({ ok: true, value: { job: gets[0] }, error: undefined });
  });
});
