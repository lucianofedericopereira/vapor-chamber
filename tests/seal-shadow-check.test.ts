// A bridge shadowing a local handler: the check P1 must add at seal() (decision 9), pinned as expected-to-fail.
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createHttpBridge } from '../src/transports';

function countingClient() {
  const s = { calls: 0 };
  const httpClient = { post: vi.fn(async () => { s.calls++; return { ok: true, status: 200, headers: {}, data: { state: 1 } }; }) } as any;
  return { s, httpClient };
}

describe('seal() and a bridge that answers an action with a local handler', () => {
  it('CONTROL: without the bridge the local handler runs', async () => {
    const bus = createAsyncCommandBus();
    let ran = 0;
    bus.register('cartAdd', async () => { ran++; return 1; });
    bus.seal();
    await bus.dispatch('cartAdd', {});
    expect(ran).toBe(1);
  });

  it('TODAY: the bridge answers, one request, and the local handler never runs', async () => {
    const { s, httpClient } = countingClient();
    const bus = createAsyncCommandBus();
    let ran = 0;
    bus.register('cartAdd', async () => { ran++; return 1; });
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'], httpClient }));
    bus.seal();
    const r = await bus.dispatch('cartAdd', {});
    expect(r.ok).toBe(true);
    expect(s.calls).toBe(1);
    expect(ran).toBe(0);
  });

  it.fails('P1 ACCEPTANCE: seal() throws core:already:handler', () => {
    const { httpClient } = countingClient();
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 1);
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'], httpClient }));
    let code: unknown;
    try { bus.seal(); } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe('core:already:handler');
  });
});

/*
 * Decision 9 of the 1.26 list (.probes/1.26-remaining.md): a bridge whose
 * `actions` match an action that also has a local handler sends it to the
 * server, and the handler never runs, with no error. The check lands with P1,
 * the plugin manifest, as one general rule (any wrapper that claims an action
 * with a local handler), at seal() and not at use(): at use() the handlers may
 * not be registered yet. `it.fails` passes while the check is absent and turns
 * RED the day seal() throws, so P1 cannot land without flipping it to `it`
 * (and deleting TODAY). The plan's probe was `.probes/p126-ext13-15-18-d2`
 * arm 15; this one injects the HTTP client instead of stubbing fetch. An
 * intended shadow exists (a handler registered only to carry `undo`, F2 of
 * the panel round): P1 needs an exemption or a home for undo that is not a
 * handler, and this test is where that case is added.
 */
