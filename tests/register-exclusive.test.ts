/**
 * `register(action, handler, { exclusive })`: commands with one key never overlap, in order, on the bus or across tabs.
 * Why: two withdrawals on one account must not run at once; a failure must not stall the key, and a retried command must keep its turn so the next one waits for the retry's end.
 * Shows: first in first out per key (default key is the action, `null` opts out, a throwing key fails that dispatch alone); `scope: 'cross-tab'` asks `navigator.locks` for `vapor-chamber:exclusive:<key>` and orders on this bus without it; the declaration leaves and returns with its registration; a query of an exclusive action waits; an action without it runs commands at once.
 * See: log s36.79
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusError, type Command, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { supersede } from '../src/plugins-extra';
import { defineTransport } from '../src/transports';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A handler that records its start and end, and waits for its release. */
function gated() {
  const log: string[] = [];
  const releases: Array<() => void> = [];
  const handler = async (cmd: Command) => {
    log.push(`start ${cmd.target}`);
    await new Promise<void>((r) => releases.push(r));
    log.push(`end ${cmd.target}`);
    return cmd.target;
  };
  return { log, releases, handler };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('exclusive on the async bus', () => {
  it('same action, default key: the second starts after the first ends, in order', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const g = gated();
    bus.register('accountWithdraw', g.handler, { exclusive: {} });
    const a = bus.dispatch('accountWithdraw', 1);
    const b = bus.dispatch('accountWithdraw', 2);
    await tick();
    expect(g.log).toEqual(['start 1']);
    g.releases[0]?.();
    await tick();
    expect(g.log).toEqual(['start 1', 'end 1', 'start 2']);
    g.releases[1]?.();
    expect([(await a).value, (await b).value]).toEqual([1, 2]);
  });

  it('a key function: one key across two actions waits; another key runs at once; null opts out', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const g = gated();
    const key = (cmd: Command) => (cmd.target === 0 ? null : `acct-${cmd.target % 10}`);
    bus.register('accountWithdraw', g.handler, { exclusive: { key } });
    bus.register('accountDeposit', g.handler, { exclusive: { key } });
    void bus.dispatch('accountWithdraw', 11);
    void bus.dispatch('accountDeposit', 21);
    void bus.dispatch('accountWithdraw', 12);
    void bus.dispatch('accountWithdraw', 0);
    await tick();
    expect(g.log.sort()).toEqual(['start 0', 'start 11', 'start 12']);
    for (const r of g.releases.splice(0)) r();
    await tick();
    expect(g.log).toContain('start 21');
  });

  it('a failure does not stall the key: the next runs', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let n = 0;
    bus.register('accountWithdraw', async () => { if (n++ === 0) throw new Error('down'); return 'ok'; }, { exclusive: {} });
    const a = bus.dispatch('accountWithdraw', 1);
    const b = bus.dispatch('accountWithdraw', 2);
    expect((await a).ok).toBe(false);
    expect(await b).toMatchObject({ ok: true, value: 'ok' });
  });

  it("a retried command keeps its turn: the next waits for the retry's end", async () => {
    const order: string[] = [];
    let attempts = 0;
    const bus = createAsyncCommandBus({
      retry: { baseDelay: 1, maxDelay: 2 },
      transport: defineTransport(async (cmd: { target: number }) => {
        order.push(`send ${cmd.target}`);
        if (cmd.target === 1 && attempts++ === 0) return { ok: false, value: undefined, error: new BusError('limited:busy', 'busy', { context: { retryIn: 1 } }) };
        return { ok: true, value: cmd.target, error: undefined };
      }),
    });
    bus.register('accountWithdraw', null, { exclusive: {} });
    const a = bus.dispatch('accountWithdraw', 1);
    const b = bus.dispatch('accountWithdraw', 2);
    await Promise.all([a, b]);
    expect(order).toEqual(['send 1', 'send 1', 'send 2']);
  });

  it("scope 'cross-tab' takes a Web Lock named by the prefix and the key", async () => {
    const names: string[] = [];
    vi.stubGlobal('navigator', { locks: { request: (name: string, fn: () => unknown) => { names.push(name); return Promise.resolve(fn()); } } });
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('accountWithdraw', async () => 1, { exclusive: { key: (cmd) => `a${cmd.target}`, scope: 'cross-tab' } });
    await bus.dispatch('accountWithdraw', 7);
    expect(names).toEqual(['vapor-chamber:exclusive:a7']);
  });

  it("scope 'cross-tab' without Web Locks orders on this bus", async () => {
    vi.stubGlobal('navigator', {});
    const bus = createAsyncCommandBus({ retry: false });
    const g = gated();
    bus.register('accountWithdraw', g.handler, { exclusive: { scope: 'cross-tab' } });
    void bus.dispatch('accountWithdraw', 1);
    void bus.dispatch('accountWithdraw', 2);
    await tick();
    expect(g.log).toEqual(['start 1']);
    g.releases[0]?.();
  });

  it('listeners hear each result, not a wrapper', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const heard: unknown[] = [];
    bus.on('accountWithdraw', (_cmd, r) => { heard.push(r.value); });
    bus.register('accountWithdraw', async (cmd: Command) => cmd.target, { exclusive: {} });
    await Promise.all([bus.dispatch('accountWithdraw', 1), bus.dispatch('accountWithdraw', 2)]);
    expect(heard).toEqual([1, 2]);
  });
});

describe('with supersede (from tests/same-in-any-order.test.ts)', () => {
  it('the newer command aborts the older one in flight', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(supersede());
    bus.register('search', async (cmd: Command) => {
      await tick();
      await tick();
      if (cmd.signal?.aborted) throw cmd.signal.reason;
      return 'ok';
    }, { exclusive: {} });
    const first = bus.dispatch('search', { q: 1 });
    void bus.dispatch('search', { q: 1 });
    expect(((await first).error as { code?: string } | undefined)?.code).toBe('core:aborted:dispatch');
  });
});

describe('exclusive: edges', () => {
  it('a key that throws fails that dispatch alone, heard by after-hooks; the next runs', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const after: string[] = [];
    bus.onAfter((cmd, r) => { after.push(`${cmd.action}:${r.ok}`); });
    bus.register('accountWithdraw', async () => 'ok', { exclusive: { key: (cmd) => { if (cmd.target === 'bad') throw new Error('no key'); return 'k'; } } });
    const bad = await bus.dispatch('accountWithdraw', 'bad');
    expect(bad.ok).toBe(false);
    expect((await bus.dispatch('accountWithdraw', 'good')).ok).toBe(true);
    expect(after).toEqual(['accountWithdraw:false', 'accountWithdraw:true']);
  });

  it('a key that throws with no after-hook fails the dispatch the same', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('accountWithdraw', async () => 'ok', { exclusive: { key: () => { throw new Error('no key'); } } });
    expect((await bus.dispatch('accountWithdraw', 1)).ok).toBe(false);
  });

  it('a query of an exclusive action waits for its key; of an optimistic one runs at once', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const g = gated();
    bus.register('accountRead', g.handler, { exclusive: {} });
    bus.register('accountPing', async () => 'pong', { undo: () => {}, optimistic: true });
    void bus.query('accountRead', 1);
    void bus.query('accountRead', 2);
    await tick();
    expect(g.log).toEqual(['start 1']);
    expect(await bus.query('accountPing', 0)).toMatchObject({ ok: true, value: 'pong' });
    g.releases[0]?.();
    await tick();
    g.releases[1]?.();
  });

  it('nothing escapes an exclusive run on a throw bus: each failure is a result, and the key is freed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = defineTransport(() => { throw new Error('send threw'); });
    const fallsBack = defineTransport(async (_cmd, local) => local(), { localFallback: true });
    const buses = [
      createAsyncCommandBus({ retry: false, onMissing: 'throw', transport: throwing }),
      createAsyncCommandBus({ retry: false, onMissing: 'throw', transport: fallsBack }),
      createAsyncCommandBus({ retry: false, onMissing: 'throw' }),
    ];
    buses[0].register('accountWithdraw', null, { exclusive: {} });
    buses[1].register('accountWithdraw', null, { exclusive: {} });
    buses[2].register('accountWithdraw', () => { throw new Error('handler threw'); }, { exclusive: {} });
    for (const bus of buses) {
      const runs = await Promise.all([bus.dispatch('accountWithdraw', 1), bus.dispatch('accountWithdraw', 1)]);
      expect(runs.map((r) => r.ok)).toEqual([false, false]);
    }
  });

  it('an exclusive registration removed leaves no declaration: on a throw bus each dispatch throws, none waits for a key', async () => {
    const bus = createAsyncCommandBus({ retry: false, onMissing: 'throw' });
    bus.register('accountWithdraw', async () => 1, { exclusive: {} })();
    const both = Promise.allSettled([bus.dispatch('accountWithdraw', 1), bus.dispatch('accountWithdraw', 1)]);
    const r = await Promise.race([both, new Promise<'hung'>((ok) => setTimeout(() => ok('hung'), 200))]);
    expect(r === 'hung' ? r : r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
  });

  it('a declaration leaves with its registration and comes back with it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    const waiting: Array<() => void> = [];
    bus.register('accountWithdraw', () => new Promise((r) => { waiting.push(() => r('A')); }), { exclusive: {} });
    const off = bus.register('accountWithdraw', async (cmd) => cmd.target); // replaces A, and A's declaration with it
    expect((await Promise.all([bus.dispatch('accountWithdraw', 1), bus.dispatch('accountWithdraw', 2)])).map((r) => r.value)).toEqual([1, 2]);
    off();
    const one = bus.dispatch('accountWithdraw', 1);
    const two = bus.dispatch('accountWithdraw', 1);
    await vi.waitFor(() => expect(waiting.length).toBe(1));
    await new Promise((r) => setTimeout(r, 5));
    expect(waiting.length).toBe(1); // the second waits for the key: A's declaration is back
    waiting[0]();
    await vi.waitFor(() => expect(waiting.length).toBe(2));
    waiting[1]();
    expect([(await one).value, (await two).value]).toEqual(['A', 'A']);
  });
});

describe('exclusive on the sync bus', () => {
  it('already holds: a sync handler runs to its end before the next', () => {
    const bus = createCommandBus();
    bus.register('accountWithdraw', (cmd: Command) => cmd.target, { exclusive: {} });
    expect(bus.dispatch('accountWithdraw', 3)).toMatchObject({ ok: true, value: 3 });
  });
});

describe('control: an action without it', () => {
  it('runs two commands at once', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const g = gated();
    bus.register('accountWithdraw', g.handler);
    void bus.dispatch('accountWithdraw', 1);
    void bus.dispatch('accountWithdraw', 2);
    await tick();
    expect(g.log).toEqual(['start 1', 'start 2']);
    for (const r of g.releases) r();
  });
});
