// A store's server commands in order with one serialize lane per store, holding only commands that reach the server; rationale at the end.
import { describe, expect, vi } from 'vitest';
import { it } from '../src/vitest';
import { useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus } from '../src/command-bus';
import { serialize } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';
import { createHttpBridge } from '../src/transports';

type Cart = { items: string[] };
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [] }),
  reducers: {
    add: (s: Cart, item: string) => ({ items: [...s.items, item] }),
    clear: () => ({ items: [] as string[] }),
    // What a read writes through once its fetch lands. Local: never sent.
    landed: (_s: Cart, fresh: Cart) => fresh,
  },
  answer: (_s, v) => v as Cart,
});

/** The store's bridged writes: what the bridge takes, the pattern of tests/store-bridged-answer.test.ts. */
const writes = ['cartAdd', 'cartClear'];
/**
 * The store's commands that reach the server: the bridged writes, and the read,
 * which reaches it through its own handler's fetch. Its reducer `cartLanded`
 * stays out.
 */
const toServer = new Set([...writes, 'cartLoad']);
const storeLane = () => serialize({ key: (cmd) => (toServer.has(cmd.action) ? 'cart' : null) });
/** The broad lane: every action of the store, its local reducers included. */
const broadLane = () => serialize({ key: () => 'cart', actions: ['cart*'] });

/** A client whose replies the test releases by hand, by command, and which records what was sent. */
function heldClient(replies: Record<string, object>) {
  const held = new Map<string, () => void>();
  const sent: string[] = [];
  const post = vi.fn((_url: string, body: { command: string }) =>
    new Promise((resolve) => {
      sent.push(body.command);
      held.set(body.command, () => resolve({ ok: true, status: 200, data: replies[body.command], headers: {} }));
    }));
  return { client: { post } as never, sent, release: (command: string) => held.get(command)!() };
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// The server applied cartAdd first, then cartClear.
const WRITES = { cartAdd: { state: { items: ['milk'] } }, cartClear: { state: { items: [] } } };

/**
 * A bus with `lane` installed before the bridge (equal priority: the first
 * installed runs outermost), the bridge taking the store's writes only, and a
 * local read `cartLoad` whose fetch the test releases. The read writes what it
 * fetched through `cart.landed`, awaited or not.
 */
function app(lane: ReturnType<typeof serialize> | null, awaitLanded: boolean) {
  const { client, sent, release } = heldClient(WRITES);
  const bus = createAsyncCommandBus({ retry: false });
  if (lane) bus.use(lane);
  // Outside the bridge's scope a command skips it and its local handler runs:
  // the read and its reducer stay local.
  bus.use(createHttpBridge({ endpoint: '/vc', httpClient: client, actions: writes }));
  const cart = useCart(bus);
  let landFetch!: (v: Cart) => void;
  bus.register('cartLoad', async () => {
    const fresh = await new Promise<Cart>((r) => { landFetch = r; });
    if (awaitLanded) await cart.landed(fresh);
    else void cart.landed(fresh);
    return 1;
  });
  return { bus, cart, sent, release, land: (v: Cart) => landFetch(v) };
}

/** Race a promise against 50 ms, so a lane that waits for itself reads as 'waits', never as a hang. */
const within = <T>(p: Promise<T>): Promise<T | 'waits'> => Promise.race([p, new Promise<'waits'>((r) => setTimeout(r, 50, 'waits'))]);

describe('two different writes of one store', () => {
  it('control: the default key is the action, so both are in flight and the older answer can win', async () => {
    const { cart, sent, release } = app(serialize(), false);
    const a = cart.add('milk');
    const b = cart.clear();
    await settle();
    expect(sent).toEqual(['cartAdd', 'cartClear']);
    release('cartClear');
    await b;
    release('cartAdd');
    await a;
    expect(cart.state.value).toEqual({ items: ['milk'] });
    cart.$dispose();
  });

  it("the store's lane sends them one at a time, so they answer in order", async () => {
    const { cart, sent, release } = app(storeLane(), false);
    const a = cart.add('milk');
    const b = cart.clear();
    await settle();
    expect(sent).toEqual(['cartAdd']);
    release('cartAdd');
    await a;
    await settle();
    expect(sent).toEqual(['cartAdd', 'cartClear']);
    release('cartClear');
    await b;
    expect(cart.state.value).toEqual({ items: [] });
    cart.$dispose();
  });
});

describe("a store's read in flight across a write", () => {
  // The read fetched the cart before the write committed: it lands the old, empty cart.
  it('control: with no lane the stale read lands after the write and puts the older state back', async () => {
    const { bus, cart, release, land } = app(null, true);
    const read = bus.dispatch('cartLoad', null);
    const write = cart.add('milk');
    await settle();
    release('cartAdd');
    await write;
    land({ items: [] });
    await read;
    expect(cart.state.value).toEqual({ items: [] });
    cart.$dispose();
  });

  it("with the store's lane the write waits for the read: the store ends on the write's state", async () => {
    const { bus, cart, sent, release, land } = app(storeLane(), true);
    const read = bus.dispatch('cartLoad', null);
    const write = cart.add('milk');
    await settle();
    expect(sent).toEqual([]);
    land({ items: [] });
    await read;
    await settle();
    release('cartAdd');
    await write;
    expect(cart.state.value).toEqual({ items: ['milk'] });
    cart.$dispose();
  });
});

describe('a broad lane catches the reducers a read writes through', () => {
  it('(d) awaited: the reducer queues behind the read awaiting it, and the read never settles', async () => {
    const { bus, cart, land } = app(broadLane(), true);
    const read = bus.dispatch('cartLoad', null);
    await settle();
    land({ items: ['fresh'] });
    expect(await within(read)).toBe('waits');
    cart.$dispose();
  });

  it('(d) control: in the store lane the awaited reducer runs at once, inside the read', async () => {
    const { bus, cart, land } = app(storeLane(), true);
    const read = bus.dispatch('cartLoad', null);
    await settle();
    land({ items: ['fresh'] });
    expect(await within(read)).not.toBe('waits');
    expect(cart.state.value).toEqual({ items: ['fresh'] });
    cart.$dispose();
  });

  /** A read in flight, a write queued behind it, then the read lands the old cart. */
  async function unawaited(lane: ReturnType<typeof serialize>) {
    const { bus, cart, sent, release, land } = app(lane, false);
    const read = bus.dispatch('cartLoad', null);
    const write = cart.add('milk');
    await settle();
    land({ items: [] });
    await read;
    await settle();
    expect(sent).toEqual(['cartAdd']);
    release('cartAdd');
    await write;
    await settle();
    const state = cart.state.value;
    cart.$dispose();
    return state;
  }

  it('(e) not awaited: no deadlock, but the reducer joins the lane after the write and the old state lands last', async () => {
    expect(await unawaited(broadLane())).toEqual({ items: [] });
  });

  it("(e) control: in the store lane the reducer runs inside the read's slot, before the write", async () => {
    expect(await unawaited(storeLane())).toEqual({ items: ['milk'] });
  });
});

describe('a command waiting in the lane', () => {
  /** A read in flight, then a write: is the write sent yet, and does it read as loading? */
  async function waitingWrite(lane: ReturnType<typeof serialize> | null) {
    const { bus, cart, sent, release, land } = app(lane, true);
    const shared = useSharedCommandState({ bus });
    const flag = shared.isLoading('cartAdd', 'milk');
    const read = bus.dispatch('cartLoad', null);
    const write = cart.add('milk');
    await settle();
    const during = { sent: [...sent], loading: flag.value };
    land({ items: [] });
    await read;
    await settle();
    release('cartAdd');
    await write;
    const after = flag.value;
    shared.dispose();
    cart.$dispose();
    return { during, after };
  }

  it('reads as loading from its dispatch, while it waits and before it is sent', async () => {
    expect(await waitingWrite(storeLane())).toEqual({ during: { sent: [], loading: true }, after: false });
  });

  it('control: with no lane it is sent at once, and reads the same', async () => {
    expect(await waitingWrite(null)).toEqual({ during: { sent: ['cartAdd'], loading: true }, after: false });
  });
});

/*
 * Why this file exists. docs/store.md said the `serialize` plugin on a store's
 * actions sends one write at a time, so the server applies and answers them in
 * order. serialize's default key is the action (src/plugins-extra.ts), so two
 * different writes of one store were both in flight: the first case pins that.
 *
 * One lane per store sends the store's server commands one at a time, and it
 * orders the store's reads as well as its writes: a read in flight across a
 * write cannot land after the write's answer and put the older state back.
 * `version` covers bridged answers only, not that read.
 *
 * The lane must hold only commands that reach the server. The lanes have no
 * re-entry (src/scheduler.ts): a same-key run always chains behind the tail.
 * A read that writes through one of the store's own reducers, inside a lane
 * that also holds that reducer, either waits for ever (awaited, case d) or
 * lands its old answer after a write already queued behind it (not awaited,
 * case e). Keyed to null, the reducer runs at once inside the read's slot. So
 * the key is a function naming the server commands, not `actions: ['cart*']`.
 * Plan C3b, the owner's corrections of 2026-10-08.
 *
 * A command waiting in a lane already reads as loading. isLoading() counts a
 * start in a before-hook, and the async runner walks the before-hooks before
 * the plugin chain, where serialize holds it (src/command-bus.ts, _asyncRun).
 * So isLoading cannot tell a queued command from a sent one: the last two
 * cases differ only in what was sent. Plan C3b step 3, log s35.239.
 */
