/** A NaN option behaves like a missing one, at every site bounds.ts's rule names (plan 1.27 section 10.11). Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandError, useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { rateLimit } from '../src/plugins-extra';
import { pollWith } from '../src/poll-with';
import { createSSRPlugin } from '../src/ssr';
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
