/**
 * The bus's placed plugin parts on their less common paths: a part with no id, past 512 actions, a step without begin, two signals, a ticket's answer over a failing work, command-state queries, `_keyed` with no meta.
 * Why: a throwing part with no id would fail without an owner's code, per-action answers would break past their 512 cap, an abort of one of several tickets would go unseen by the work, and a request or query would leave the command state counting a pending command. Also the only file reaching the id-less part report, the chain-cache cap, two tickets' signals, the query facts and `_keyed` with no meta, so the 100% floor needs it.
 * Shows: a throwing `started` part reports `plugin:failed:plugin` and the dispatch still succeeds; across 520 actions the scoped filter and the step are each asked once per dispatch and the first action still answers; the work sees an abort of either ticket's signal; a ticket's answer stands when the work rejects or answered at once; sync request, async query and async request answer and leave the command state not pending; `_keyed` leaves a missing meta alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus, _keyed, _okResult as ok } from '../src/command-bus';
import { commandState } from '../src/command-state';
import { configureReport, type Report } from '../src/report';

afterEach(() => { configureReport(null); });
const collect = () => { const got: Report[] = []; configureReport({ sinks: [(r) => { got.push(r); }] }); return got; };

describe('placed parts, less common paths', () => {
  it("a facts part with no id throws under the generic owner's code", () => {
    const got = collect();
    const bus = createCommandBus();
    bus.use({ started: () => { throw new Error('x'); } });
    bus.register('a', () => 1);
    expect(bus.dispatch('a', {}).ok).toBe(true);
    expect(got.map((r) => [r.code, r.context?.plugin, r.context?.parts])).toEqual([['plugin:failed:plugin', undefined, ['started']]]);
  });

  it('past 512 actions the scoped facts and the steps start their per-action answers over', () => {
    const bus = createCommandBus();
    const asked: string[] = [];
    let steps = 0;
    bus.use({ settled() {}, actionFilter: (action) => { asked.push(action); return true; } });
    bus.use({ admit: () => { steps++; return undefined; } });
    for (let i = 0; i < 520; i++) bus.register(`a${i}`, () => i);
    for (let i = 0; i < 520; i++) bus.dispatch(`a${i}`, {});
    expect(bus.dispatch('a0', {})).toMatchObject({ ok: true, value: 0 });
    expect([asked.length, steps]).toEqual([521, 521]);
  });

  it('a step plugin with an admit and no begin lets the command through', () => {
    const bus = createCommandBus();
    bus.use({ admit: () => undefined });
    bus.register('a', () => 1);
    expect(bus.dispatch('a', {})).toMatchObject({ ok: true, value: 1 });
  });

  it("two tickets' signals combine: the work sees either one abort", async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const first = new AbortController();
    const second = new AbortController();
    let seen: AbortSignal | undefined;
    bus.use({ begin: () => ({ signal: first.signal }) });
    bus.use({ begin: () => ({ signal: second.signal }) });
    bus.register('a', async (cmd) => { seen = cmd.signal; return 1; });
    await bus.dispatch('a', {});
    expect(seen?.aborted).toBe(false);
    second.abort();
    expect(seen?.aborted).toBe(true);
  });

  it("a ticket's answer stands when the work it answers for rejects", async () => {
    const bus = createAsyncCommandBus({ retry: false, onMissing: 'throw' });
    bus.use({ begin: () => ({ answer: Promise.resolve(ok('shared')) }) });
    expect(await bus.dispatch('nobody', {})).toMatchObject({ ok: true, value: 'shared' });
  });

  it("control: on a sync bus the ticket's answer stands over a work that answered at once", async () => {
    const bus = createCommandBus();
    bus.use({ begin: () => ({ answer: Promise.resolve(ok('shared')) }) });
    bus.register('a', () => 1);
    expect(await (bus.dispatch('a', {}) as unknown as Promise<unknown>)).toMatchObject({ ok: true, value: 'shared' });
  });

  it('a sync request with a responder tells the command state it was queried, then answers', async () => {
    const bus = createCommandBus();
    const state = commandState(bus);
    bus.respond('ask', () => 42);
    expect(await bus.request('ask', {})).toMatchObject({ ok: true, value: 42 });
    expect(state.anyPending.value).toBe(false);
    state.dispose();
  });

  it('an async query on a bus with a command state counts nothing pending', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const state = commandState(bus);
    const busy = state.pending('q');
    bus.register('q', async () => 1);
    expect(await bus.query('q', {})).toMatchObject({ ok: true, value: 1 });
    expect(busy.value).toBe(false);
    state.dispose();
  });

  it('an async request with no responder runs the handler', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('ask', async () => 7);
    expect(await bus.request('ask', {})).toMatchObject({ ok: true, value: 7 });
  });

  it('the key rule leaves a command with no meta alone', () => {
    expect(() => _keyed(undefined, 'k')).not.toThrow();
    const meta = { id: 'm1' } as never as { id: string; idempotencyKey?: string };
    _keyed(meta as never);
    expect(meta.idempotencyKey).toBe('m1');
  });
});
