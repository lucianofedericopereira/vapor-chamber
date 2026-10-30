/**
 * The HTTP client's cache: a read in flight is stored unless an invalidation of its own URL happens meanwhile.
 * Why: if a write to another URL also kept the read from being stored, every overlapping read of an app that writes often would cost an extra fetch.
 * Shows: a read is stored with nothing else going on or after a write to another URL, and is not stored after a write to its own URL, with dedupe on or off.
 * See: tests/http-cache-writes.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpClient } from '../src/http';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Counts GETs per URL; `hold` keeps the next GET open until `release()`. */
function server() {
  const s = { gets: new Map<string, number>(), hold: false, release: () => {} };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return json({ ok: 1 });
    s.gets.set(url, (s.gets.get(url) ?? 0) + 1);
    if (s.hold) {
      s.hold = false;
      await new Promise<void>((r) => (s.release = r));
    }
    return json({ v: url });
  });
  return s;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('a read in flight across an invalidation of another URL', () => {
  it('control: nothing else happens, the read is stored', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await tick();
    s.release();
    await first;
    await http.get('/a', { cache: true });
    expect(s.gets.get('/a')).toBe(1);
  });

  it('control: a write to ITS URL, the read is not stored', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await tick();
    await http.post('/a', {});
    s.release();
    await first;
    await http.get('/a', { cache: true });
    expect(s.gets.get('/a')).toBe(2);
  });

  it('a write to another URL resolves meanwhile: the read is stored', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true });
    await tick();
    await http.post('/b', { x: 1 });
    s.release();
    await first;
    await http.get('/a', { cache: true });
    expect(s.gets.get('/a')).toBe(1);
  });

  it('dedupe off: a write to its URL still keeps the read from being stored', async () => {
    const s = server();
    const http = createHttpClient();
    s.hold = true;
    const first = http.get('/a', { cache: true, dedupe: false });
    await tick();
    await http.post('/a', {});
    s.release();
    await first;
    await http.get('/a', { cache: true });
    expect(s.gets.get('/a')).toBe(2);
  });
});
