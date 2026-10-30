/**
 * The HTTP `retry.maxAttempts` follows the bus's count rule (countOption(maxAttempts, 3, 1)).
 * Why: a negative, NaN or fractional count must never leave the retry loop without a BusError; a count below 1 would send nothing and hand the caller a raw Error.
 * Shows: below 1 sends once, NaN takes the default of 3 attempts, 2.5 is truncated to 2, each ending in a remote: BusError on a 503; a count of 2 re-sends once; retry false on a 200 sends once.
 * See: src/bounds.ts, log 36.17, log 36.50
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusError } from '../src/failure';
import { createHttpClient, postCommand } from '../src/http';

function answering(status: number) {
  return vi.fn(async () => new Response(JSON.stringify({}), { status, headers: { 'content-type': 'application/json' } }));
}

/** How the request settles once every backoff has run, and how many requests it sent. */
async function settle(fetchStub: ReturnType<typeof answering>, start: () => Promise<unknown>) {
  vi.stubGlobal('fetch', fetchStub);
  const p = start().then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: undefined, error }));
  await vi.advanceTimersByTimeAsync(60_000);
  return { ...(await p), sent: fetchStub.mock.calls.length };
}

const get = (maxAttempts: number) => () => createHttpClient().get('/x', { retry: { maxAttempts } });
const post = (maxAttempts: number) => () => postCommand('/api/vc', { command: 'x' }, { retry: { maxAttempts } });

describe('HTTP retry.maxAttempts: a value the count rule normalizes', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('client, maxAttempts -1: sends once, as 1', async () => {
    const r = await settle(answering(503), get(-1));
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(1);
  });

  it('postCommand, maxAttempts 0: sends once, as 1', async () => {
    const r = await settle(answering(503), post(0));
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(1);
  });

  it('client GET, maxAttempts NaN: the default (3 attempts), then the answer', async () => {
    const r = await settle(answering(503), get(Number.NaN));
    expect(r.error).toBeInstanceOf(BusError);
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(3);
  });

  it('postCommand, maxAttempts NaN: the default (3 attempts) on a transient 503', async () => {
    const r = await settle(answering(503), post(Number.NaN));
    expect(r.error).toBeInstanceOf(BusError);
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(3);
  });

  it('client GET, maxAttempts 2.5: truncated to 2, then the answer', async () => {
    const r = await settle(answering(503), get(2.5));
    expect(r.error).toBeInstanceOf(BusError);
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(2);
  });

  it('control: client GET, maxAttempts 2 on a 503: one re-send, then the answer', async () => {
    const r = await settle(answering(503), get(2));
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(2);
  });

  it('control: postCommand, retry false on a 200: sends once', async () => {
    const r = await settle(answering(200), () => postCommand('/api/vc', { command: 'x' }, { retry: false }));
    expect(r.error).toBe(null);
    expect(r.sent).toBe(1);
  });
});
