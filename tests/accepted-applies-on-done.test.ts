// @vitest-environment happy-dom
/** A sent answer that is an `Accepted` (a 202) applies to the stores when its `done` settles. Rationale at the end. */
import { describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { type Command, type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { defineChamberStore } from '../src/store';
import { httpTransport } from '../src/transports';

type S = { n: number };
/** An http client: each post answers `post`, each poll of the monitor answers `get`. */
function client(post: { status: number; data: unknown; headers?: Record<string, string> }, get: { status: number; data: unknown } = { status: 200, data: { state: { n: 9 } } }) {
  return {
    post: vi.fn(async () => ({ ok: true, headers: {}, ...post })),
    get: vi.fn(async () => ({ ok: get.status < 300, headers: {}, ...get })),
  };
}
const accepted = (data: unknown = {}) => ({ status: 202, data, headers: { location: '/jobs/1' } });
function world(http: ReturnType<typeof client>, answer: (s: S, v: unknown) => S = (_s, v) => v as S) {
  const bus = createAsyncCommandBus({ retry: false, transport: { cartAdd: httpTransport({ endpoint: '/vc', httpClient: http as never, poll: { interval: 1 } }) } });
  const cart = defineChamberStore('cart', { state: (): S => ({ n: 0 }), reducers: { add: null, bump: (s: S) => ({ n: s.n + 1 }) }, answer, undo: true })(bus);
  return { bus, cart };
}

describe('an Accepted answer applies when its done settles', () => {
  it("the store keeps its state while the job runs, then takes done's value", async () => {
    const { cart } = world(client(accepted()));
    const r = await cart.add('x');
    expect(r.value).toBeInstanceOf(Accepted);
    expect(cart.state.value).toEqual({ n: 0 });
    expect(await (r.value as Accepted).done).toEqual({ ok: true, value: { n: 9 }, error: undefined });
    expect(cart.state.value).toEqual({ n: 9 });
    cart.$dispose();
  });

  it('the stores the 202 declared land with done, not before, for an action with no `answer`', async () => {
    const http = client(accepted({ stores: { tally: { n: 5 } } }));
    const bus = createAsyncCommandBus({ retry: false, transport: { orderExport: httpTransport({ endpoint: '/vc', httpClient: http as never, poll: { interval: 1 } }) } });
    bus.register('orderExport', null);
    const tally = defineChamberStore('tally', { state: (): S => ({ n: 0 }), reducers: {} })(bus);
    const r = await bus.dispatch('orderExport', {});
    expect(tally.state.value).toEqual({ n: 0 });
    await (r.value as Accepted).done;
    expect(tally.state.value).toEqual({ n: 5 });
    tally.$dispose();
  });

  it('a failed job writes nothing', async () => {
    const { cart } = world(client(accepted(), { status: 200, data: { problem: { status: 409, code: 'conflict', detail: 'no' } } }));
    const r = await cart.add('x');
    expect((await (r.value as Accepted).done).ok).toBe(false);
    expect(cart.state.value).toEqual({ n: 0 });
    cart.$dispose();
  });

  it("an answer that throws fails done with its error", async () => {
    const { cart } = world(client(accepted()), () => { throw new Error('cannot apply'); });
    const r = await cart.add('x');
    const end = await (r.value as Accepted).done;
    expect([end.ok, end.error?.message]).toEqual([false, 'cannot apply']);
    cart.$dispose();
  });

  it("a rebase keeps the state done wrote", async () => {
    const { bus, cart } = world(client(accepted()));
    let first: Command | undefined;
    bus.on('cartBump', (cmd) => { first ??= cmd; });
    await cart.bump(undefined as never);
    const r = await cart.add('x');
    await (r.value as Accepted).done;
    await bus.dispatch('cartBump$undo', first);
    expect(cart.state.value).toEqual({ n: 9 });
    cart.$dispose();
  });
});

describe('controls', () => {
  it('nothing to apply: the Accepted is handed on as it is, and nothing is followed', async () => {
    const http = client(accepted());
    const bus = createAsyncCommandBus({ retry: false, transport: { orderExport: httpTransport({ endpoint: '/vc', httpClient: http as never, poll: { interval: 1 } }) } });
    // The bus has an `answer`, for another action: the send goes through the bus's answer step.
    bus.register('docSave', async () => 'local', { answer: () => {} });
    const r = await bus.dispatch('orderExport', {});
    expect(r.value).toBeInstanceOf(Accepted);
    await new Promise((res) => setTimeout(res, 5));
    expect(http.get).not.toHaveBeenCalled();
  });

  it('a 200 writes the store at once', async () => {
    const { cart } = world(client({ status: 200, data: { state: { n: 7 } } }));
    await cart.add('x');
    expect(cart.state.value).toEqual({ n: 7 });
    cart.$dispose();
  });

  it("a held outbox command: the store keeps its state, the replay's answer lands once", async () => {
    let online = false;
    const http = client({ status: 200, data: { state: { n: 7 } } });
    const outbox = createOutbox({ storage: null, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: http as never }), outbox } as never);
    let answers = 0;
    const cart = defineChamberStore('cart', { state: (): S => ({ n: 0 }), reducers: { add: null }, answer: (_s, v) => { answers++; return v as S; } })(bus);
    const r: CommandResult = await cart.add('x');
    expect(r.value).toBeInstanceOf(Accepted);
    expect(cart.state.value).toEqual({ n: 0 });
    online = true;
    await outbox.flush();
    await (r.value as Accepted).done;
    expect([cart.state.value, answers]).toEqual([{ n: 7 }, 1]);
    cart.$dispose();
  });
});

/*
 * A 202 with a Location answers the dispatch an `Accepted`: the job goes on,
 * and `done` settles with what the status monitor ends on (src/accepted.ts).
 * The transport marked the command when it read the 202 (`answerOf`), so the
 * bus handed the store's `answer` the `Accepted` itself: the store held it
 * as its state, and the job's final state never reached it. The 202's
 * declared `stores` were written before the job was done.
 *
 * An `Accepted` is not the final state. The bus applies the action's `answer`
 * and the declared stores when `done` settles ok, with `done`'s value, as
 * cache groups invalidate (src/command-bus.ts, declareGroups). The dispatch
 * answers an `Accepted` whose `done` settles once they are written, so a
 * throwing `answer` fails `done`, as it fails a 200's dispatch. With nothing
 * to apply (no `answer` for the action, no store on the bus) the transport's
 * `Accepted` is handed on as it is, and nothing is followed until the app
 * reads `done`. An outbox hold is not marked: its replay is its own command,
 * answered once. Log 36.F28.
 */
