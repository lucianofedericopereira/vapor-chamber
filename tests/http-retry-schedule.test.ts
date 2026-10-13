// The HTTP client re-sends on the async bus's schedule (docs/retry.md). Notes at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusError, createAsyncCommandBus, createHttpClient, postCommand } from '../src/index';

type Answer = number | 'lost' | [number, Record<string, string>];

/** fetch answering each call from `answers` in turn, the last one repeating. Returns each call's time. */
function wire(answers: Answer[]): number[] {
  const at: number[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => {
    const a = answers[Math.min(at.length, answers.length - 1)];
    at.push(Date.now());
    if (a === 'lost') throw new TypeError('Failed to fetch');
    const [status, headers] = Array.isArray(a) ? a : [a, {}];
    return new Response(status === 200 ? '{"done":1}' : '', { status, headers: { 'content-type': 'application/json', ...headers } });
  }));
  return at;
}

const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - at[i]);

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the client's own wait", () => {
  it('a GET re-sent after a 503 waits under 200 ms x 2^n', async () => {
    const at = wire([503, 503, 503, 200]);
    expect((await settle(createHttpClient().get('/a', { retry: 3 }))).ok).toBe(true);
    expect(gaps(at)).toEqual([100, 200, 400]);
  });

  it('the same after no reply', async () => {
    const at = wire(['lost', 'lost', 200]);
    expect((await settle(createHttpClient().get('/a', { retry: 2 }))).ok).toBe(true);
    expect(gaps(at)).toEqual([100, 200]);
  });

  it('postCommand with retry above 0 waits the same', async () => {
    const at = wire([503, 503, 200]);
    expect((await settle(postCommand('/c', {}, { retry: 2 }))).ok).toBe(true);
    expect(gaps(at)).toEqual([100, 200]);
  });

  it('is capped at 20 s', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const at = wire([503, 503, 503, 503, 503, 503, 503, 503, 200]);
    expect((await settle(createHttpClient().get('/a', { retry: 8 }))).ok).toBe(true);
    expect(gaps(at)).toEqual([199, 399, 799, 1598, 3196, 6393, 12787, 20_000]);
  });

  it("draws the bus's waits for the same random values", async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.37);
    const at = wire([503, 503, 503, 200]);
    await settle(createHttpClient().get('/a', { retry: 3 }));
    const bus = createAsyncCommandBus({ retry: { maxAttempts: 4 } });
    const calls: number[] = [];
    bus.register('save', async () => {
      calls.push(Date.now());
      if (calls.length < 4) throw new BusError('limited:action', 'Held back.');
      return 'done';
    });
    expect((await settle(bus.dispatch('save', {}))).ok).toBe(true);
    expect(gaps(at)).toEqual(gaps(calls));
  });
});

describe('control: a declared wait is unchanged', () => {
  it('Retry-After sets the wait', async () => {
    const at = wire([[503, { 'retry-after': '2' }], 200]);
    expect((await settle(createHttpClient().get('/a', { retry: 1 }))).ok).toBe(true);
    expect(gaps(at)).toEqual([2000]);
  });

  it("one over the bus's 20 s and under the client's 30 s is still slept", async () => {
    const at = wire([[503, { 'retry-after': '25' }], 200]);
    expect((await settle(postCommand('/c', {}, { retry: 1 }))).ok).toBe(true);
    expect(gaps(at)).toEqual([25_000]);
  });

  it('one over 30 s ends the request', async () => {
    const at = wire([[503, { 'retry-after': '31' }], 200]);
    const e = await settle(createHttpClient().get('/a', { retry: 2 }).catch((x: unknown) => x));
    expect((e as BusError).context).toMatchObject({ status: 503, retryIn: 31_000 });
    expect(at).toHaveLength(1);
  });
});

/*
 * Log 36.16 item 1 (F3 of the complexity review). The client's own wait was
 * 1 s x 2^n, capped at 30 s, plus 0-200 ms: clients that failed together came
 * back within 200 ms of each other. The bus's schedule is the owner's decision
 * of 2026-09-28: full jitter, uniform under 200 ms x 2^n, capped at 20 s, so
 * they do not come back together. One function now gives both. A declared
 * wait still sets when, and the client's 30 s ceiling on a declared wait it
 * sleeps inside one request (MAX_RETRY_AFTER_MS) is a different rule: the
 * controls pin both. Math.random is stubbed so a wait is exact; delays are
 * whole milliseconds (delayOption truncates).
 */
