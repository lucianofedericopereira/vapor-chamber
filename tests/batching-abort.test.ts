/** The batching bridge: a dispatch's abort settles that dispatch, before or after the flush (plan 1.27 section 10.6). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge } from '../src/transports';

afterEach(() => { vi.unstubAllGlobals(); });

/** A backend answering after `ms`, every command saved; records each POST and whether its signal aborted. */
function backend(ms = 20) {
  const posts: Array<{ ids: string[]; aborted: boolean }> = [];
  vi.stubGlobal('fetch', (_u: string, init: { body: string; signal?: AbortSignal }) => {
    const ids = (JSON.parse(init.body) as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
    const post = { ids, aborted: false };
    posts.push(post);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response(JSON.stringify({ results: ids.map((id) => ({ id, state: 'saved' })) }), { status: 200, headers: { 'content-type': 'application/json' } })), ms);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); post.aborted = true; reject(new DOMException('aborted', 'AbortError')); });
    });
  });
  return posts;
}

const bridged = (window: number | 'microtask' = 30) => {
  const bus = createAsyncCommandBus({ retry: false });
  bus.use(createBatchingHttpBridge({ endpoint: '/b', window }));
  return bus;
};
const code = (r: { ok: boolean; value?: unknown; error?: unknown }) => (r.ok ? r.value : (r.error as { code: string }).code);

describe('an aborted dispatch', () => {
  it('aborted before the flush: settles aborted and is never sent', async () => {
    const posts = backend();
    const bus = bridged(30);
    const ac = new AbortController();
    const p = bus.dispatch('save', { id: 1 }, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    expect(code(await p)).toBe('core:aborted:dispatch');
    await new Promise((r) => setTimeout(r, 40));
    expect(posts).toHaveLength(0);
  });

  it('aborted after the flush: settles at once, and the request is cancelled when it was the only command', async () => {
    const posts = backend(1000);
    const bus = bridged('microtask');
    const ac = new AbortController();
    const p = bus.dispatch('save', { id: 1 }, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const t0 = Date.now();
    expect(code(await p)).toBe('core:aborted:dispatch');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(posts).toEqual([{ ids: expect.any(Array), aborted: true }]);
  });

  it('another command in the same batch still gets its result, and the request is not cancelled', async () => {
    const posts = backend(30);
    const bus = bridged('microtask');
    const ac = new AbortController();
    const a = bus.dispatch('save', { id: 1 }, undefined, { signal: ac.signal });
    const b = bus.dispatch('save', { id: 2 });
    setTimeout(() => ac.abort(), 5);
    expect([code(await a), code(await b)]).toEqual(['core:aborted:dispatch', 'saved']);
    expect(posts.map((p) => [p.ids.length, p.aborted])).toEqual([[2, false]]);
  });

  it('a command aborted before the flush leaves the rest of its batch to go', async () => {
    const posts = backend(5);
    const bus = bridged(20);
    const ac = new AbortController();
    const a = bus.dispatch('save', { id: 1 }, undefined, { signal: ac.signal });
    const b = bus.dispatch('save', { id: 2 });
    setTimeout(() => ac.abort(), 5);
    expect([code(await a), code(await b)]).toEqual(['core:aborted:dispatch', 'saved']);
    expect(posts.map((p) => p.ids.length)).toEqual([1]);
  });

  it('every command in a sent batch aborted: the request is cancelled', async () => {
    const posts = backend(50);
    const bus = bridged('microtask');
    const a = new AbortController();
    const b = new AbortController();
    const pa = bus.dispatch('save', { id: 1 }, undefined, { signal: a.signal });
    const pb = bus.dispatch('save', { id: 2 }, undefined, { signal: b.signal });
    setTimeout(() => a.abort(), 5);
    setTimeout(() => b.abort(), 10);
    await Promise.all([pa, pb]);
    await new Promise((r) => setTimeout(r, 5));
    expect(posts.map((p) => p.aborted)).toEqual([true]);
  });

  it("with the bridge's own signal too, a command's abort still cancels its batch of one", async () => {
    const posts = backend(50);
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(createBatchingHttpBridge({ endpoint: '/b', signal: new AbortController().signal }));
    const ac = new AbortController();
    const p = bus.dispatch('save', { id: 1 }, undefined, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    expect(code(await p)).toBe('core:aborted:dispatch');
    await new Promise((r) => setTimeout(r, 5));
    expect(posts.map((x) => x.aborted)).toEqual([true]);
  });

  it('without AbortSignal.any: the command settles at once, the request keeps the bridge signal', async () => {
    const any = AbortSignal.any;
    (AbortSignal as { any?: unknown }).any = undefined;
    try {
      const posts = backend(30);
      const bus = createAsyncCommandBus({ retry: false });
      bus.use(createBatchingHttpBridge({ endpoint: '/b', signal: new AbortController().signal }));
      const ac = new AbortController();
      const p = bus.dispatch('save', { id: 1 }, undefined, { signal: ac.signal });
      setTimeout(() => ac.abort(), 5);
      expect(code(await p)).toBe('core:aborted:dispatch');
      await new Promise((r) => setTimeout(r, 40));
      expect(posts.map((x) => x.aborted)).toEqual([false]);
    } finally {
      AbortSignal.any = any;
    }
  });

});

describe('control', () => {
  it('no signal: as released', async () => {
    const posts = backend(5);
    const bus = bridged('microtask');
    expect(code(await bus.dispatch('save', { id: 1 }))).toBe('saved');
    expect(posts).toHaveLength(1);
  });
});

/*
 * `Command.signal` says HTTP transports "auto-propagate it", and README and
 * supersede's comment name the batching bridge. It checked the signal only
 * before queueing, so a dispatch aborted while waiting for its window went
 * out and reported `ok` (audit B10, D1). Now an abort before the flush
 * removes the command, never sent; after the flush the command settles
 * `core:aborted:dispatch` at once. The shared request is cancelled only once
 * every command in it has aborted, the HTTP client's dedupe rule ("cancelled
 * once every caller holding it has aborted"); the WebSocket bridge documents
 * the same per-command limit. Log s35.168.
 *
 * One block holds every test of the fix: all seven fail on the code before
 * it (log s35.202, which corrects s35.168's "green before" for the bridge's
 * own signal and the fallback without `AbortSignal.any`). The control is the
 * dispatch with no signal. "At once" reads against a backend answering in
 * 1 s, not 50 ms, so a timer late under load cannot fail it.
 */
