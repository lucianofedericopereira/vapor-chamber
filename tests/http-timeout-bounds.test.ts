/**
 * FIXTURE - the HTTP `timeout` option under values that are not a usable delay.
 *
 * WHY THIS FILE EXISTS. Both request loops in src/http.ts hand `timeout`
 * straight to `setTimeout`, and `setTimeout` does not refuse a bad delay - it
 * fires at once. NaN is read as 0. Anything past the 32-bit ceiling
 * (`MAX_TIMEOUT_MS`, see src/bounds.ts) is clamped to 1ms by Node and wrapped
 * by browsers. So `timeout: NaN` - what `Number(config.x)` yields for a missing
 * value, the class src/bounds.ts exists for - and `timeout: Infinity` - the
 * natural way to ask for "no timeout" - both aborted every request the moment
 * it started, reported as a TimeoutError. src/http.ts was the one module the
 * numeric-option sweep never reached.
 *
 * The rule now, per path, normalized once before the loop:
 *   - a non-number or NaN -> that path's documented default (10_000 through
 *     `postCommand`, 30_000 through a client)
 *   - above MAX_TIMEOUT_MS -> MAX_TIMEOUT_MS, the longest wait a timer can hold
 *   - 0 and negatives are left as they are (an explicit request to fire now)
 *
 * The fetch stub never resolves; it rejects only when the request's own
 * signal aborts, the way real `fetch` does. Fake timers make the moment of the
 * TimeoutError observable in exact milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient, postCommand } from '../src/http';
import { MAX_TIMEOUT_MS } from '../src/bounds';

function neverResolvingFetch() {
  return vi.fn((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
}

/** When (in fake ms after the call) the request rejected, and with what. */
async function rejectionTime(start: () => Promise<unknown>, horizon: number) {
  const t0 = Date.now();
  let at: number | null = null;
  let error: any = null;
  const p = start().catch((e) => { at = Date.now() - t0; error = e; });
  await vi.advanceTimersByTimeAsync(horizon);
  await p;
  return { at, error };
}

describe('HTTP timeout option - bounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', neverResolvingFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('postCommand (documented default 10_000)', () => {
    const post = (timeout: number | undefined) => () =>
      postCommand('/api/vc', { command: 'x' }, timeout === undefined ? {} : { timeout });

    it('NaN waits the default instead of aborting at once', async () => {
      const { at, error } = await rejectionTime(post(Number.NaN), 10_001);
      expect(error?.name).toBe('TimeoutError');
      expect(at).toBe(10_000);
    });

    it('Infinity waits: past the default, and clamped to the longest wait a timer holds', async () => {
      const { at, error } = await rejectionTime(post(Number.POSITIVE_INFINITY), MAX_TIMEOUT_MS + 1);
      expect(error?.name).toBe('TimeoutError');
      expect(at).toBe(MAX_TIMEOUT_MS);
    });

    it('undefined waits the default (unchanged)', async () => {
      const { at } = await rejectionTime(post(undefined), 10_001);
      expect(at).toBe(10_000);
    });

    it('5_000 still aborts at 5_000 (unchanged)', async () => {
      const { at, error } = await rejectionTime(post(5_000), 10_001);
      expect(error?.name).toBe('TimeoutError');
      expect(at).toBe(5_000);
    });

    it('0 is left as it is - an explicit request to fire now', async () => {
      const { at } = await rejectionTime(post(0), 10_001);
      expect(at).toBe(0);
    });
  });

  describe('createHttpClient().get (documented default 30_000)', () => {
    // retry: 0 isolates the timeout - a GET otherwise retries a timeout twice,
    // with jittered backoff, which would blur the moment being measured.
    const get = (timeout: number | undefined) => () =>
      createHttpClient().get('/api/items', timeout === undefined ? { retry: 0 } : { retry: 0, timeout });

    it('NaN waits the default instead of aborting at once', async () => {
      const { at, error } = await rejectionTime(get(Number.NaN), 30_001);
      expect(error?.name).toBe('TimeoutError');
      expect(at).toBe(30_000);
    });

    it('Infinity waits: past the default, and clamped to the longest wait a timer holds', async () => {
      const { at, error } = await rejectionTime(get(Number.POSITIVE_INFINITY), MAX_TIMEOUT_MS + 1);
      expect(error?.name).toBe('TimeoutError');
      expect(at).toBe(MAX_TIMEOUT_MS);
    });

    it('undefined waits the default (unchanged)', async () => {
      const { at } = await rejectionTime(get(undefined), 30_001);
      expect(at).toBe(30_000);
    });

    it('5_000 still aborts at 5_000 (unchanged)', async () => {
      const { at, error } = await rejectionTime(get(5_000), 30_001);
      expect(error?.name).toBe('TimeoutError');
      expect(at).toBe(5_000);
    });
  });
});
