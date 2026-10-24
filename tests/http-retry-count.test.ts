// The HTTP `retry.maxAttempts` follows the count rule (src/bounds.ts countOption). See the note at the end of this file.
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

// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
//
// Found while collapsing http.ts runWithRetry (log 36.17, F12): the line after
// its loop, `throw new Error('unreachable')`, was reachable. The client's
// `retry` and postCommand's went to the loop unchecked, while every other
// count in src goes through countOption. A negative or NaN `retry` failed the
// loop's first test, so nothing was sent and the caller got a raw
// `Error('unreachable')`, not a BusError. A fractional one (1.5) made its
// last re-send and then fell out of the loop the same way. Red before: the
// five cases above; the two controls passed.
//
// Step 3d of plan 1.32 (log 36.50): the count became the bus's bound,
// `retry: { maxAttempts }` (attempts in total, at least 1, default 3), read
// by the same rule as the bus's (`countOption(maxAttempts, 3, 1)`). The cases
// keep their shapes: below 1 sends once, NaN takes the default, a fraction is
// truncated.
