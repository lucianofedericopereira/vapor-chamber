/**
 * pollWith - a passing failure of the monitor is not the end of the job.
 *
 * A poll is a GET, safe to send again (the one retry rule, failure.ts
 * `retryClass`), so a monitor answering a 503 or 429, or any answer with
 * `Retry-After`, says nothing about the job: it is still
 * running. Each ended the job as failed, after which the finished state was
 * never read. A transient answer (by `retryClass`) or one declaring
 * `Retry-After` now waits and polls again, within `maxWait`. Anything else ends
 * the job as before: a verdict, an abort, a lost reply (poll-with.test.ts).
 */
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
const finished: Answer = { status: 200, body: { state: { file: 'x.csv' } } };
const setup = (opts: Record<string, unknown> = {}) => {
  const bus = createAsyncCommandBus({ retry: false });
  bus.use(pollWith({ bus, interval: 1, ...opts }));
  bus.use(createHttpBridge({ endpoint: '/vc' }));
  const done: any[] = [];
  bus.on('orderExport$done', (cmd) => done.push(cmd.target));
  return { bus, done };
};
const until = async (cond: () => boolean) => { for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };
afterEach(() => { vi.unstubAllGlobals(); });

describe('pollWith - transient monitor answers', () => {
  it.each([
    ['a 503 with Retry-After', { status: 503, body: { status: 503, code: 'unavailable', detail: 'busy' }, headers: { 'retry-after': '0', 'content-type': 'application/problem+json' } }],
    ['a 429 with Retry-After', { status: 429, body: { status: 429, code: 'slow_down', detail: 'later' }, headers: { 'retry-after': '0', 'content-type': 'application/problem+json' } }],
    ['a 502 declaring Retry-After', { status: 502, body: {}, headers: { 'retry-after': '0' } }],
    ['a 503 declaring no wait (the interval)', { status: 503, body: {} }],
  ] as Array<[string, Answer]>)('keeps polling after %s and ends with the finished state', async (_label, blip) => {
    const calls = script(accepted, blip, finished);
    const { bus, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result).toEqual({ ok: true, value: { file: 'x.csv' }, error: undefined });
    expect(calls.slice(1)).toEqual(['https://api.test/jobs/7', 'https://api.test/jobs/7']);
  });

  it('still ends on a verdict from the monitor', async () => {
    script(accepted, { status: 404, body: { status: 404, code: 'no_job', detail: 'gone' }, headers: { 'content-type': 'application/problem+json' } }, finished);
    const { bus, done } = setup();
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result.error.code).toBe('remote:missing:no_job');
  });

  it('still ends at maxWait when the monitor keeps failing', async () => {
    script(accepted, { status: 503, body: {}, headers: { 'retry-after': '0' } });
    const { bus, done } = setup({ maxWait: 40 });
    await bus.dispatch('orderExport', {});
    await until(() => done.length === 1);
    expect(done[0].result.error.code).toBe('pollWith:timeout:job');
  });
});
