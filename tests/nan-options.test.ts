/** A NaN option behaves like a missing one, and a delay past the timer maximum is capped, at every site bounds.ts's rule names. Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandError, useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { debounce, throttle } from '../src/plugins-core';
import { rateLimit } from '../src/plugins-extra';
import { pollWith } from '../src/poll-with';
import { createSSRPlugin } from '../src/ssr';
import { createBatchingHttpBridge, createWsBridge } from '../src/transports';
import { createReaction } from '../src/utilities';

afterEach(() => { resetCommandBus(); vi.restoreAllMocks(); });
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many of `n` dispatches rateLimit lets through. */
function passed(opts: { max?: number; window?: number }, n = 20) {
  const bus = createCommandBus();
  bus.register('api', () => 1);
  bus.use(rateLimit(opts));
  let ok = 0;
  for (let i = 0; i < n; i++) if (bus.dispatch('api', {}).ok) ok++;
  return { ok, bus };
}

describe('NaN reads as the default', () => {
  it('rateLimit max: the default 10, never unlimited', () => {
    expect(passed({ max: NaN }).ok).toBe(10);
    expect(passed({ max: 1 }).ok).toBe(1); // control
  });

  it('rateLimit window: the default 1000 ms, and a refusal says when', () => {
    const { bus } = passed({ max: 2, window: NaN }, 2);
    const retryIn = (bus.dispatch('api', {}).error as unknown as { context: { retryIn: number } }).context.retryIn;
    expect(Number.isFinite(retryIn) && retryIn > 0 && retryIn <= 1000).toBe(true);
  });

  it('createReaction maxHops: the default 8', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [maxHops, runs] of [[NaN, 9], [3, 4]] as const) {
      const bus = createCommandBus();
      let n = 0;
      bus.register('cartRecalculate', () => { n++; });
      createReaction('cart*', 'cartRecalculate', { allowSelfMatch: true, maxHops }).install(bus);
      bus.dispatch('cartRecalculate', {});
      expect([maxHops, n]).toEqual([maxHops, runs]);
    }
  });

  it('pollWith interval and maxWait: the defaults, never a hot loop or an endless wait', async () => {
    for (const [interval, most] of [[NaN, 1], [10, 6]] as const) {
      let gets = 0;
      const httpClient = { get: async () => { gets++; return { status: 202, data: null, headers: {}, ok: true, url: '', redirected: false }; } };
      const bus = createAsyncCommandBus({ retry: false });
      const pw = pollWith({ bus, interval, maxWait: NaN, httpClient: httpClient as never });
      bus.use(pw);
      bus.use(async (cmd) => { cmd.meta!.response = { status: 202, headers: { location: '/jobs/1' }, url: 'http://x/vc' } as never; return { ok: true, value: 1, error: undefined }; });
      await bus.dispatch('reportExport', {});
      await tick(60);
      pw.dispose();
      expect(gets, String(interval)).toBeLessThanOrEqual(most);
    }
  });

  it('useCommandError maxSize: the default 50', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const { errors, dispose } = useCommandError({ maxSize: NaN });
    for (let i = 0; i < 60; i++) bus.dispatch(`missing${i}`, {});
    expect(errors.value).toHaveLength(50);
    dispose();
  });

  it('useSharedCommandState maxSize: the default 10', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const state = useSharedCommandState({ maxSize: NaN });
    for (let i = 0; i < 20; i++) bus.dispatch(`missing${i}`, {});
    expect(state.errors.value).toHaveLength(10);
  });

  it('createSSRPlugin maxSize: the default 500, never nothing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    bus.register('cmd', () => 'ok');
    const ssr = createSSRPlugin({ maxSize: NaN });
    bus.use(ssr.plugin);
    for (let i = 0; i < 3; i++) bus.dispatch('cmd', { i });
    expect(ssr.size()).toBe(3);
  });
});

describe('a timeout: NaN waits the default, Infinity and past 2^31-1 the timer maximum', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Whether `p` has settled once `ms` more fake milliseconds pass. */
  async function settledAfter(p: Promise<unknown>, ms: number): Promise<boolean> {
    let done = false;
    void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(ms);
    return done;
  }

  /** A socket that opens and never answers. */
  class SilentWs {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    static last: SilentWs;
    readyState = 0;
    onopen: (() => void) | null = null; onmessage = null; onclose = null; onerror = null;
    constructor() { SilentWs.last = this; }
    send() {}
    close() { this.readyState = 3; }
  }

  it('createWsBridge timeout: the default 10 s', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', SilentWs);
    const at = async (timeout?: number) => {
      const bus = createAsyncCommandBus({ retry: false });
      const ws = createWsBridge({ url: 'ws://x', reconnect: false, ...(timeout === undefined ? {} : { timeout }) });
      bus.use(ws);
      ws.connect();
      SilentWs.last.readyState = 1;
      SilentWs.last.onopen!();
      const p = bus.dispatch('save', {});
      const out = [await settledAfter(p, 9_999), await settledAfter(p, 1)];
      ws.disconnect();
      return out;
    };
    expect(await at()).toEqual([false, true]); // control: the default
    expect(await at(50)).toEqual([true, true]); // control: a number is kept
    expect(await at(NaN)).toEqual([false, true]);
    expect(await at(Infinity)).toEqual([false, false]);
    expect(await at(3e9)).toEqual([false, false]);
  });

  it('createBatchingHttpBridge window: NaN is the default, a microtask; Infinity the timer maximum', async () => {
    vi.useFakeTimers();
    let posts = 0;
    vi.stubGlobal('fetch', async (_u: string, init: { body: string }) => {
      posts++;
      const ids = (JSON.parse(init.body) as { commands: Array<{ id: string }> }).commands.map((c) => c.id);
      return new Response(JSON.stringify({ results: ids.map((id) => ({ id, state: 'ok' })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    /** POSTs after the microtasks, then after 1 s of timers. */
    const at = async (window: number | 'microtask') => {
      posts = 0;
      const bus = createAsyncCommandBus({ retry: false });
      bus.use(createBatchingHttpBridge({ endpoint: '/b', window }));
      void bus.dispatch('a', {});
      void bus.dispatch('b', {});
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const early = posts;
      await vi.advanceTimersByTimeAsync(1000);
      return [early, posts];
    };
    expect(await at('microtask')).toEqual([1, 1]); // control: the default
    expect(await at(20)).toEqual([0, 1]); // control: a number is kept
    expect(await at(NaN)).toEqual([1, 1]);
    expect(await at(Infinity)).toEqual([0, 0]);
  });

  type Requester = { respond(action: string, fn: () => unknown): unknown; request(action: string, target: unknown, payload?: unknown, options?: { timeout?: number }): Promise<unknown> };

  for (const [name, make] of [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const) {
    it(`request() timeout on the ${name} bus: the default 5 s`, async () => {
      vi.useFakeTimers();
      const at = async (timeout?: number | null) => {
        const bus = make() as unknown as Requester;
        bus.respond('ask', () => new Promise(() => {})); // never answers
        const p = bus.request('ask', {}, undefined, timeout === undefined ? undefined : { timeout: timeout as number });
        return [await settledAfter(p, 4_999), await settledAfter(p, 1)];
      };
      expect(await at()).toEqual([false, true]); // control: the default
      expect(await at(50)).toEqual([true, true]); // control: a number is kept
      expect(await at(null)).toEqual([false, true]); // null keeps its released meaning, the default
      expect(await at(NaN)).toEqual([false, true]);
      expect(await at(Infinity)).toEqual([false, false]);
      expect(await at(3e9)).toEqual([false, false]);
    });
  }
});

describe('a throttle wait: NaN is the default, no throttle; Infinity the timer maximum', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Five dispatches 30 ms apart through each entry: 1 ran, 0 refused. */
  function runs(wait: number): { plugin: string; register: string } {
    vi.useFakeTimers();
    const a = createCommandBus();
    a.register('save', () => 'ok');
    a.use(throttle(['save'], wait));
    const b = createCommandBus();
    b.register('save', () => 'ok', { throttle: wait });
    let plugin = '';
    let register = '';
    for (let i = 0; i < 5; i++) {
      plugin += a.dispatch('save', {}).ok ? 1 : 0;
      register += b.dispatch('save', {}).ok ? 1 : 0;
      vi.advanceTimersByTime(30);
    }
    return { plugin, register };
  }

  it('both entries read a bad wait the same way', () => {
    expect(runs(10)).toEqual({ plugin: '11111', register: '11111' }); // control
    expect(runs(1000)).toEqual({ plugin: '10000', register: '10000' }); // control
    expect(runs(NaN)).toEqual({ plugin: '11111', register: '11111' });
    expect(runs(Infinity)).toEqual({ plugin: '10000', register: '10000' });
  });

  it('debounce: NaN is no delay, Infinity the timer maximum, never 1 ms', () => {
    vi.useFakeTimers();
    /** Whether the debounced handler has run after 0 ms, then after 50 ms more. */
    const at = (wait: number): boolean[] => {
      const bus = createCommandBus();
      let ran = false;
      bus.register('search', () => { ran = true; });
      bus.use(debounce(['search'], wait));
      bus.dispatch('search', {});
      vi.advanceTimersByTime(0);
      const first = ran;
      vi.advanceTimersByTime(50);
      return [first, ran];
    };
    expect(at(20)).toEqual([false, true]); // control
    expect(at(0)).toEqual([true, true]); // control: no delay
    expect(at(NaN)).toEqual([true, true]);
    expect(at(Infinity)).toEqual([false, false]);
    expect(at(3e9)).toEqual([false, false]);
  });
});

/*
 * bounds.ts: "A NaN option is indistinguishable in intent from a missing
 * one ... so it now behaves like a missing one", through `countOption`.
 * Seven sites read their option raw (audit B14): `rateLimit({ max: NaN })`
 * let 20 of 20 through and `window: NaN` refused for good with no
 * `retryIn`; `createReaction({ maxHops: NaN })` ran a self loop to the depth
 * bound; `pollWith({ interval: NaN })` polled in a hot loop and `maxWait:
 * NaN` never ended; `maxSize: NaN` kept every error in both composables;
 * `createSSRPlugin({ maxSize: NaN })` recorded nothing. Each now reads
 * through `countOption` with its default. Zero keeps its released meaning
 * (`max: 0` refuses every call), so the minimum stays 0. Log s35.174.
 */

/*
 * The timeouts (audit D8, log 36.11). createWsBridge's `timeout` and
 * request()'s `timeout`, on both buses, went to setTimeout as given. A timer
 * fires at once on NaN and on anything past 2^31-1, Infinity included. So a
 * timeout read from a config that failed to parse, or "no limit", failed
 * every WebSocket command and every request after about 1 ms. They now read
 * through countOption with MAX_TIMEOUT_MS as the ceiling, as the http
 * client's timeout and the ws bridge's other three options already did.
 * `null` still means the default (`?? 5000` before the read), and 0 still
 * fires at once.
 */

/*
 * The throttle wait (audit D9, owner 2026-10-12: "bad value on throttle
 * should fallback to default"). A throttle has no wait of its own: register()
 * without the option throttles nothing, and a wait of 0 lets every call
 * through. So the default is no throttle. Before, the two entries disagreed:
 * `throttle(list, NaN)` refused every call for good (`now - last >= NaN` is
 * false) while `register(..., { throttle: NaN })` throttled nothing, and
 * Infinity refused even the first call in both. The shared gate now reads its
 * wait once, through countOption with MAX_TIMEOUT_MS as the ceiling.
 */

/*
 * debounce (audit D9, the same rule): its wait went to setTimeout as given,
 * so NaN, Infinity and anything past 2^31-1 ran the handler after about 1 ms.
 * It now reads its wait once, as the throttle gate does: NaN is no delay, the
 * default a wait of 0 gives, and a larger wait the timer maximum.
 */
