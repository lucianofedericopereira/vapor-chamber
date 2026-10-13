// The HTTP `retry` count follows the count rule (src/bounds.ts countOption). See the note at the end of this file.
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

const get = (retry: number) => () => createHttpClient().get('/x', { retry });
const post = (retry: number) => () => postCommand('/api/vc', { command: 'x' }, { retry });

describe('HTTP retry count: a value the count rule normalizes', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('client, retry -1: sends once, as retry 0', async () => {
    const r = await settle(answering(200), get(-1));
    expect(r.error).toBe(null);
    expect(r.sent).toBe(1);
  });

  it('postCommand, retry -1: sends once, as retry 0', async () => {
    const r = await settle(answering(200), post(-1));
    expect(r.error).toBe(null);
    expect(r.sent).toBe(1);
  });

  it('client GET, retry NaN: the GET default (2 re-sends), then the answer', async () => {
    const r = await settle(answering(503), get(Number.NaN));
    expect(r.error).toBeInstanceOf(BusError);
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(3);
  });

  it('postCommand, retry NaN: its default (no re-send), then the answer', async () => {
    const r = await settle(answering(503), post(Number.NaN));
    expect(r.error).toBeInstanceOf(BusError);
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(1);
  });

  it('client GET, retry 1.5: truncated to 1, then the answer', async () => {
    const r = await settle(answering(503), get(1.5));
    expect(r.error).toBeInstanceOf(BusError);
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(2);
  });

  // Controls: a whole number at or above 0 behaved this way before.
  it('control: client GET, retry 1 on a 503: one re-send, then the answer', async () => {
    const r = await settle(answering(503), get(1));
    expect((r.error as BusError).code).toMatch(/^remote:/);
    expect(r.sent).toBe(2);
  });

  it('control: postCommand, retry 0 on a 200: sends once', async () => {
    const r = await settle(answering(200), post(0));
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
