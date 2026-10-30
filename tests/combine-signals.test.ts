/**
 * Two abort signals combine as `AbortSignal.any` does, with or without it, at every site: the helper, httpTransport, batches, supersede.
 * Why: the IIFEs target browsers without `AbortSignal.any`, where a site that drops one signal cannot cancel; the bus reads the aborting input's reason.
 * Shows: in both modes the first to abort wins with its reason; scope and bridge signals cancel requests and batches; supersede honours the caller; no listener outlives a request.
 * See: log 36.13 F1, scripts/build.mjs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Accepted } from '../src/accepted';
import { createAsyncCommandBus } from '../src/command-bus';
import { httpTransport } from '../src/transports';
import { supersede } from '../src/plugins-extra';
import { _combineSignals } from '../src/http';
import type { Command } from '../src/command-bus';

const nativeAny = AbortSignal.any;
afterEach(() => {
  AbortSignal.any = nativeAny;
  vi.unstubAllGlobals();
});

/** A backend that answers after `ms` unless the request's signal aborts first; records each request's signal. */
function backend(ms = 300, batched = false) {
  const sent: AbortSignal[] = [];
  vi.stubGlobal('fetch', (_u: string, init: { body: string; signal: AbortSignal }) => {
    sent.push(init.signal);
    const body = batched
      ? { results: (JSON.parse(init.body) as { commands: Array<{ id: string }> }).commands.map((c) => ({ id: c.id, state: 'saved' })) }
      : { state: 'saved' };
    return new Promise((resolve, reject) => {
      if (init.signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })), ms);
      init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
    });
  });
  return sent;
}

const code = (r: { ok: boolean; value?: unknown; error?: unknown }) => (r.ok ? r.value : (r.error as { code?: string }).code);
const later = (fn: () => void, ms = 5) => setTimeout(fn, ms);

// The same cases in both modes; `native` is the control.
describe.each([['without AbortSignal.any', true], ['native AbortSignal.any (control)', false]])('%s', (_name, fallback) => {
  const mode = () => { if (fallback) delete (AbortSignal as { any?: unknown }).any; };

  describe('the helper', () => {
    it('an input already aborted gives a result already aborted, with that input\'s reason (the first input first)', () => {
      mode();
      const a = new AbortController();
      const b = new AbortController();
      const ra = new Error('a');
      const rb = new Error('b');
      b.abort(rb);
      expect(_combineSignals(a.signal, b.signal).signal.reason).toBe(rb);
      a.abort(ra);
      const both = _combineSignals(a.signal, b.signal).signal;
      expect([both.aborted, both.reason]).toEqual([true, ra]);
    });

    // Read between the two aborts: Node's native result, read only after both, reports the first input's reason, not the spec's.
    it('the first input to abort aborts the result, with its reason', () => {
      mode();
      const a = new AbortController();
      const b = new AbortController();
      const { signal } = _combineSignals(a.signal, b.signal);
      expect(signal.aborted).toBe(false);
      const rb = new Error('b');
      b.abort(rb);
      expect([signal.aborted, signal.reason]).toEqual([true, rb]);
      a.abort(new Error('a'));
      expect(signal.reason).toBe(rb);
    });

    it('after detach, neither input aborts the result', () => {
      mode();
      const a = new AbortController();
      const b = new AbortController();
      const combined = _combineSignals(a.signal, b.signal);
      combined.detach();
      a.abort();
      // Native has no detach: its result follows its inputs for their lifetime.
      expect(combined.signal.aborted).toBe(!fallback);
    });
  });

  describe('httpTransport', () => {
    it('disposing the scope cancels a request when the bridge has its own signal too', async () => {
      mode();
      const sent = backend();
      const scope = new AbortController();
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: new AbortController().signal, scopeController: scope }) });
      later(() => scope.abort());
      expect(code(await bus.dispatch('save', {}))).toBe('core:aborted:dispatch');
      expect(sent[0].aborted).toBe(true);
    });

    it("the bridge's signal cancels a request that carries a dispatch signal", async () => {
      mode();
      const sent = backend();
      const bridgeCtrl = new AbortController();
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: bridgeCtrl.signal }) });
      later(() => bridgeCtrl.abort());
      expect(code(await bus.dispatch('save', {}, undefined, { signal: new AbortController().signal }))).toBe('core:aborted:dispatch');
      expect(sent[0].aborted).toBe(true);
    });

    it("the caller's own reason is the failure, through the bridge's two signals", async () => {
      mode();
      backend();
      const own = new AbortController();
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: own.signal, scopeController: new AbortController() }) });
      const reason = new Error('left the page');
      later(() => own.abort(reason));
      expect((await bus.dispatch('save', {})).error).toBe(reason);
    });
  });

  describe('httpTransport with batch', () => {
    it('disposing the scope cancels a batch when the bridge has its own signal too', async () => {
      mode();
      const sent = backend(300, true);
      const scope = new AbortController();
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/b', signal: new AbortController().signal, scopeController: scope, batch: {} }) });
      later(() => scope.abort());
      expect(code(await bus.dispatch('save', {}))).toBe('core:aborted:dispatch');
      expect(sent[0].aborted).toBe(true);
    });

    it("the bridge's signal cancels a batch whose commands carry signals", async () => {
      mode();
      const sent = backend(300, true);
      const bridgeCtrl = new AbortController();
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/b', signal: bridgeCtrl.signal, batch: {} }) });
      later(() => bridgeCtrl.abort());
      expect(code(await bus.dispatch('save', {}, undefined, { signal: new AbortController().signal }))).toBe('core:aborted:dispatch');
      expect(sent[0].aborted).toBe(true);
    });

    it('on a bridge with its own signal, a batch whose every command aborted is cancelled', async () => {
      mode();
      const sent = backend(300, true);
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/b', signal: new AbortController().signal, batch: {} }) });
      const a = new AbortController();
      const b = new AbortController();
      const done = Promise.all([
        bus.dispatch('save', { id: 1 }, undefined, { signal: a.signal }),
        bus.dispatch('save', { id: 2 }, undefined, { signal: b.signal }),
      ]);
      later(() => a.abort(), 5);
      later(() => b.abort(), 10);
      expect((await done).map(code)).toEqual(['core:aborted:dispatch', 'core:aborted:dispatch']);
      expect(sent.map((s) => s.aborted)).toEqual([true]);
    });
  });

  describe('supersede', () => {
    it("the caller's own signal aborts the dispatch in flight, with its reason", async () => {
      mode();
      const bus = createAsyncCommandBus({ retry: false });
      bus.use(supersede({ actions: ['search'] }));
      // The handler answers in 300 ms, or with what aborted it.
      bus.register('search', (c: Command) => new Promise((resolve) => {
        const t = setTimeout(() => resolve('answered'), 300);
        c.signal!.addEventListener('abort', () => { clearTimeout(t); resolve(c.signal!.reason); });
      }));
      const user = new AbortController();
      const reason = new Error('typed again');
      later(() => user.abort(reason));
      expect((await bus.dispatch('search', {}, undefined, { signal: user.signal })).value).toBe(reason);
    });

    it('a newer dispatch on the same key still aborts the one in flight', async () => {
      mode();
      const bus = createAsyncCommandBus({ retry: false });
      bus.use(supersede({ actions: ['search'] }));
      const seen: AbortSignal[] = [];
      bus.register('search', (c: Command) => { seen.push(c.signal!); return new Promise((r) => setTimeout(() => r(1), 20)); });
      const first = bus.dispatch('search', {}, undefined, { signal: new AbortController().signal });
      await bus.dispatch('search', {}, undefined, { signal: new AbortController().signal });
      await first;
      expect(seen.map((s) => s.aborted)).toEqual([true, false]);
    });
  });

  // A bridge's signal and its scope are combined once for the bridge's life; per-request listeners must all go.
  describe('no listener left behind', () => {
    /** Live 'abort' listeners on one signal: added minus removed. */
    function live(signal: AbortSignal) {
      let n = 0;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((t: string, l: EventListener, o?: AddEventListenerOptions) => { if (t === 'abort') n++; add(t, l, o); }) as typeof signal.addEventListener;
      signal.removeEventListener = ((t: string, l: EventListener, o?: EventListenerOptions) => { if (t === 'abort') n--; remove(t, l, o); }) as typeof signal.removeEventListener;
      return () => n;
    }

    it('on the bridge signal, after requests with a dispatch signal settle', async () => {
      mode();
      backend(1);
      const bridgeCtrl = new AbortController();
      const count = live(bridgeCtrl.signal);
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: bridgeCtrl.signal }) });
      for (let i = 0; i < 3; i++) expect(code(await bus.dispatch('save', {}, undefined, { signal: new AbortController().signal }))).toBe('saved');
      expect(count()).toBe(0);
    });

    it('on the bridge signal, after batches with a dispatch signal settle', async () => {
      mode();
      backend(1, true);
      const bridgeCtrl = new AbortController();
      const count = live(bridgeCtrl.signal);
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/b', signal: bridgeCtrl.signal, batch: {} }) });
      for (let i = 0; i < 3; i++) expect(code(await bus.dispatch('save', {}, undefined, { signal: new AbortController().signal }))).toBe('saved');
      expect(count()).toBe(0);
    });

    it("on the bridge signal and the dispatch's, after a 202's polls end", async () => {
      mode();
      let n = 0;
      vi.stubGlobal('fetch', async () => (n++ === 0
        ? new Response('{}', { status: 202, headers: { 'content-type': 'application/json', location: 'http://x/jobs/1', 'retry-after': '0' } })
        : new Response('{"state":2}', { status: 200, headers: { 'content-type': 'application/json' } })));
      const bridgeCtrl = new AbortController();
      const user = new AbortController();
      const count = live(bridgeCtrl.signal);
      const own = live(user.signal);
      const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: bridgeCtrl.signal, poll: { interval: 1 } }) });
      const r = await bus.dispatch('report', {}, undefined, { signal: user.signal });
      expect(code(await (r.value as Accepted).done)).toBe(2);
      expect([count(), own()]).toEqual([0, 0]);
    });

    it("on the caller's signal, after superseded dispatches settle", async () => {
      mode();
      const user = new AbortController();
      const count = live(user.signal);
      const bus = createAsyncCommandBus({ retry: false });
      bus.use(supersede({ actions: ['search'] }));
      bus.register('search', async () => 1);
      for (let i = 0; i < 3; i++) await bus.dispatch('search', {}, undefined, { signal: user.signal });
      expect(count()).toBe(0);
    });
  });
});
