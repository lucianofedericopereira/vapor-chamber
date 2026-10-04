/** pollWith: a 202 Accepted followed to its end (RFC 9110 15.3.3; log s35.140). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { pollWith } from '../src/poll-with';
import { createHttpBridge } from '../src/transports';

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
const answer = ({ status, body, headers = {} }: Answer) => {
  const h: Record<string, string> = { 'content-type': 'application/json', ...headers };
  return { ok: status < 300, status, url: 'https://api.test/vc', redirected: false, headers: { entries: () => Object.entries(h), get: (k: string) => h[k.toLowerCase()] ?? null }, text: async () => JSON.stringify(body) };
};
const script = (...answers: Answer[]) => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return answer(answers[Math.min(calls.length - 1, answers.length - 1)]!); }));
  return calls;
};
const accepted: Answer = { status: 202, body: {}, headers: { location: '/jobs/7', 'retry-after': '0' } };
const setup = (opts: Record<string, unknown> = {}) => {
  const bus = createAsyncCommandBus({ retry: false });
  const p = pollWith({ bus, interval: 1, ...opts });
  bus.use(p);
  bus.use(createHttpBridge({ endpoint: '/vc' }));
  const done: any[] = [];
  bus.on('orderExport$done', (cmd) => done.push(cmd.target));
  return { bus, p, done };
};
const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };
afterEach(() => { vi.unstubAllGlobals(); });

describe('pollWith', () => {
  it('the dispatch resolves at once; the job end arrives as <action>$done with its state', async () => {
    const calls = script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } }, { status: 200, body: { state: { file: 'x.csv' } } });
    const { bus, done } = setup();
    const r = await bus.dispatch('orderExport', {});
    expect(r.ok).toBe(true);
    expect(done).toHaveLength(0);
    await until(() => done.length === 1);
    expect(done[0].result).toEqual({ ok: true, value: { file: 'x.csv' }, error: undefined });
    expect(done[0].command.action).toBe('orderExport');
    expect(calls.slice(1)).toEqual(['https://api.test/jobs/7', 'https://api.test/jobs/7']);
  });

  it('a monitor answering a problem ends as that coded failure', async () => {
    script(accepted, { status: 200, body: { problem: { status: 422, code: 'bad_rows', detail: 'Row 3' } } });
    const { bus, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result.error.code).toBe('remote:invalid:bad_rows');
  });

  it('past maxWait it ends as pollWith:timeout:job', async () => {
    script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const { bus, done } = setup({ maxWait: 30 });
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result.error.code).toBe('pollWith:timeout:job');
  });

  it('a 200, or a 202 with no Location, is not followed', async () => {
    const calls = script({ status: 202, body: {} });
    const { bus, done } = setup();
    await bus.dispatch('orderExport', {});
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    expect(done).toHaveLength(0);
  });

  it('dispose stops every follow, with no event', async () => {
    const calls = script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const { bus, p, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => calls.length >= 2);
    p.dispose();
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBeLessThanOrEqual(n + 1);
    expect(done).toHaveLength(0);
  });

  it('only the actions it is given', async () => {
    const calls = script(accepted, { status: 200, body: { state: 1 } });
    const { bus, done } = setup({ actions: ['report*'] });
    await bus.dispatch('orderExport', {});
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);
    expect(done).toHaveLength(0);
  });

  it('no Retry-After waits the interval; a plain 200 is not followed', async () => {
    script({ status: 202, body: {}, headers: { location: '/jobs/7' } }, { status: 202, body: {} }, { status: 200, body: { state: 2 } });
    const { bus, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result.value).toBe(2);
    const calls = script({ status: 200, body: { state: 1 } });
    await bus.dispatch('orderExport', {});
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);
  });

  it('a poll with no response ends as that failure', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { if (n++ === 0) return answer(accepted); throw new TypeError('Failed to fetch'); }));
    const { bus, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result.error.code).toBe('transport:lost:reply');
  });

  it("the command's own signal stops the follow, with no event", async () => {
    const calls = script(accepted, { status: 202, body: {}, headers: { 'retry-after': '0' } });
    const { bus, done } = setup();
    const ac = new AbortController();
    await bus.dispatch('orderExport', {}, undefined, { signal: ac.signal });
    ac.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(done).toHaveLength(0);
  });

  it('dispose while a poll is on the wire ends it with no event', async () => {
    let release!: () => void;
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      if (n++ === 0) return answer(accepted);
      return new Promise((_r, reject) => { release = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); init.signal!.addEventListener('abort', release); });
    }));
    const { bus, p, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => n === 2);
    p.dispose();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toHaveLength(0);
  });

  it('a reply with no url follows Location as it is', async () => {
    const urls: string[] = [];
    const client = { get: vi.fn(async (url: string) => { urls.push(url); return { status: 200, headers: {}, data: { state: 3 } }; }) };
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(pollWith({ bus, interval: 1, httpClient: client as never }));
    bus.use(createHttpBridge({ endpoint: '/vc', httpClient: { post: async () => ({ ok: true, status: 202, headers: { location: '/jobs/9' }, data: {} }) } as never }));
    const done: any[] = [];
    bus.on('orderExport$done', (cmd) => done.push(cmd.target));
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(urls).toEqual(['/jobs/9']);
    expect(done[0].result.value).toBe(3);
  });
});
