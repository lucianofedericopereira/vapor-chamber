/**
 * The HTTP `timeout` option under values that are not a usable delay.
 * Why: setTimeout fires at once on NaN and on a delay past the 32-bit ceiling, so a `timeout` of NaN or Infinity would abort every request the moment it started; a bad value must fall back to the path's default or clamp to MAX_TIMEOUT_MS.
 * Shows: NaN and undefined wait the default (10_000 through postCommand, 30_000 through a client); Infinity waits until MAX_TIMEOUT_MS; 5_000 aborts at 5_000; postCommand with 0 aborts at once; each rejects with transport:timeout:reply where checked.
 * See: src/bounds.ts
 */
// The fetch stub never resolves and rejects only when the request's own signal aborts, as real fetch does; fake timers make the abort time exact.
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
      expect((error as { code?: string })?.code).toBe('transport:timeout:reply');
      expect(at).toBe(10_000);
    });

    it('Infinity waits: past the default, and clamped to the longest wait a timer holds', async () => {
      const { at, error } = await rejectionTime(post(Number.POSITIVE_INFINITY), MAX_TIMEOUT_MS + 1);
      expect((error as { code?: string })?.code).toBe('transport:timeout:reply');
      expect(at).toBe(MAX_TIMEOUT_MS);
    });

    it('undefined waits the default (unchanged)', async () => {
      const { at } = await rejectionTime(post(undefined), 10_001);
      expect(at).toBe(10_000);
    });

    it('5_000 still aborts at 5_000 (unchanged)', async () => {
      const { at, error } = await rejectionTime(post(5_000), 10_001);
      expect((error as { code?: string })?.code).toBe('transport:timeout:reply');
      expect(at).toBe(5_000);
    });

    it('0 is left as it is - an explicit request to fire now', async () => {
      const { at } = await rejectionTime(post(0), 10_001);
      expect(at).toBe(0);
    });
  });

  describe('createHttpClient().get (documented default 30_000)', () => {
    // retry: false isolates the timeout: a retried GET would blur the moment measured.
    const get = (timeout: number | undefined) => () =>
      createHttpClient().get('/api/items', timeout === undefined ? { retry: false } : { retry: false, timeout });

    it('NaN waits the default instead of aborting at once', async () => {
      const { at, error } = await rejectionTime(get(Number.NaN), 30_001);
      expect((error as { code?: string })?.code).toBe('transport:timeout:reply');
      expect(at).toBe(30_000);
    });

    it('Infinity waits: past the default, and clamped to the longest wait a timer holds', async () => {
      const { at, error } = await rejectionTime(get(Number.POSITIVE_INFINITY), MAX_TIMEOUT_MS + 1);
      expect((error as { code?: string })?.code).toBe('transport:timeout:reply');
      expect(at).toBe(MAX_TIMEOUT_MS);
    });

    it('undefined waits the default (unchanged)', async () => {
      const { at } = await rejectionTime(get(undefined), 30_001);
      expect(at).toBe(30_000);
    });

    it('5_000 still aborts at 5_000 (unchanged)', async () => {
      const { at, error } = await rejectionTime(get(5_000), 30_001);
      expect((error as { code?: string })?.code).toBe('transport:timeout:reply');
      expect(at).toBe(5_000);
    });
  });
});
