/** The bus's placed parts on their less common paths: no id, past the caps, a step without begin, two signals, an answer over a failing work. The long note is at the end. */
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

// Step 8's close measured these paths unreached (coverage, log 36.125). Each
// is a reachable case of a part the bus places: a part without an id owns its
// throw as `plugin`; the facts filter and the steps keep a per-action answer
// capped at 512 like every per-action map; a step may lack `begin`; several
// tickets' signals combine; a ticket's answer is the caller's even when the
// work rejects (onMissing 'throw' with no handler); a sync request with a
// responder and an async query tell the command state they were queried; a
// request with no responder is a dispatch; `_keyed` is exported, so its guard
// on a missing meta is pinned.
