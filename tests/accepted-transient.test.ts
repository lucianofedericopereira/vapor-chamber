/**
 * Accepted: a passing failure of the status monitor is not the end of the job.
 * Why: a poll is a GET, safe to send again; a 503, a 429 or any Retry-After says the job is still running.
 * Shows: transient or wait-declaring answers poll again up to the finished state; a verdict still ends it, maxWait still caps it.
 * See: src/failure.ts, tests/accepted.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { createAsyncCommandBus, type BusError, type CommandResult } from '../src/command-bus';
import { httpTransport } from '../src/transports';

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
/** The job's end: the dispatch's Accepted, followed. */
const end = async (maxWait?: number): Promise<CommandResult> => {
  const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', poll: { interval: 1, maxWait } }) });
  const r = await bus.dispatch('orderExport', {});
  expect(r.value).toBeInstanceOf(Accepted);
  return (r.value as Accepted).done;
};
const codeOf = (r: CommandResult): string => (r.error as BusError).code;
afterEach(() => { vi.unstubAllGlobals(); });

describe('Accepted - transient monitor answers', () => {
  it.each([
    ['a 503 with Retry-After', { status: 503, body: { status: 503, code: 'unavailable', detail: 'busy' }, headers: { 'retry-after': '0', 'content-type': 'application/problem+json' } }],
    ['a 429 with Retry-After', { status: 429, body: { status: 429, code: 'slow_down', detail: 'later' }, headers: { 'retry-after': '0', 'content-type': 'application/problem+json' } }],
    ['a 502 declaring Retry-After', { status: 502, body: {}, headers: { 'retry-after': '0' } }],
    ['a 503 declaring no wait (the interval)', { status: 503, body: {} }],
  ] as Array<[string, Answer]>)('keeps polling after %s and ends with the finished state', async (_label, blip) => {
    const calls = script(accepted, blip, finished);
    expect(await end()).toEqual({ ok: true, value: { file: 'x.csv' }, error: undefined });
    expect(calls.slice(1)).toEqual(['https://api.test/jobs/7', 'https://api.test/jobs/7']);
  });

  it('still ends on a verdict from the monitor', async () => {
    script(accepted, { status: 404, body: { status: 404, code: 'no_job', detail: 'gone' }, headers: { 'content-type': 'application/problem+json' } }, finished);
    expect(codeOf(await end())).toBe('remote:missing:no_job');
  });

  it('still ends at maxWait when the monitor keeps failing', async () => {
    script(accepted, { status: 503, body: {}, headers: { 'retry-after': '0' } });
    expect(codeOf(await end(40))).toBe('transport:timeout:job');
  });
});
