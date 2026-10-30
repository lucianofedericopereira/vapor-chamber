/**
 * A store with `exclusive: true` sends its transport-covered commands one at a time; local actions run at once.
 * Why: two writes of one store could be answered out of order, and a read in flight across a write could land after the write's answer and put the older state back (`version` orders answers only, not that read); a local action must never wait on a sent command, and a command waiting for its turn still reads as loading from its dispatch.
 * Shows: without `exclusive` the older answer wins and the stale read overwrites the write; with it the commands go out in order and the store ends on the write's state; a local action runs while a sent command holds the key; a waiting write reads as loading before it is sent.
 * See: log s36.81
 */
import { describe, expect, vi } from 'vitest';
import { it } from '../src/vitest';
import { useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { httpTransport } from '../src/transports';

type Cart = { items: string[] };
const define = (exclusive: boolean) => defineChamberStore('cart', {
  state: (): Cart => ({ items: [] }),
  reducers: {
    // Sent: no local change, the answer is the state.
    add: null,
    clear: null,
    load: null,
    // Local: no transport covers it.
    note: (s: Cart, item: string) => ({ items: [...s.items, `note:${item}`] }),
  },
  answer: (_s, v) => v as Cart,
  exclusive,
});

// A client whose replies the test releases by hand, by command, and which records what was sent.
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

// The server applied cartAdd first, then cartClear; the read fetched the cart before the write committed.
const REPLIES = { cartAdd: { state: { items: ['milk'] } }, cartClear: { state: { items: [] } }, cartLoad: { state: { items: [] } } };

// A bus whose transport sends the store's add, clear and load; `note` stays local.
function app(exclusive: boolean) {
  const { client, sent, release } = heldClient(REPLIES);
  const t = httpTransport({ endpoint: '/vc', httpClient: client });
  const bus = createAsyncCommandBus({ retry: false, transport: { cartAdd: t, cartClear: t, cartLoad: t } });
  const cart = define(exclusive)(bus);
  return { bus, cart, sent, release };
}

/** Race a promise against 50 ms, so a command that waits for itself reads as 'waits', never as a hang. */
const within = <T>(p: Promise<T>): Promise<T | 'waits'> => Promise.race([p, new Promise<'waits'>((r) => setTimeout(r, 50, 'waits'))]);

describe('two different writes of one store', () => {
  it('control: without exclusive both are in flight and the older answer can win', async () => {
    const { cart, sent, release } = app(false);
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

  it('exclusive: true sends them one at a time, so they answer in order', async () => {
    const { cart, sent, release } = app(true);
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
  it('control: without exclusive the stale read lands after the write and puts the older state back', async () => {
    const { cart, release } = app(false);
    const read = cart.load();
    const write = cart.add('milk');
    await settle();
    release('cartAdd');
    await write;
    release('cartLoad');
    await read;
    expect(cart.state.value).toEqual({ items: [] });
    cart.$dispose();
  });

  it("exclusive: true holds the write behind the read: the store ends on the write's state", async () => {
    const { cart, sent, release } = app(true);
    const read = cart.load();
    const write = cart.add('milk');
    await settle();
    expect(sent).toEqual(['cartLoad']);
    release('cartLoad');
    await read;
    await settle();
    release('cartAdd');
    await write;
    expect(cart.state.value).toEqual({ items: ['milk'] });
    cart.$dispose();
  });
});

describe('a local action of the store', () => {
  it('runs at once while a sent command holds the key: it never waits on itself', async () => {
    const { cart, release } = app(true);
    const read = cart.load();
    await settle();
    expect(await within(cart.note('x') as Promise<unknown>)).not.toBe('waits');
    expect(cart.state.value).toEqual({ items: ['note:x'] });
    release('cartLoad');
    await read;
    cart.$dispose();
  });
});

describe('a command waiting for its turn', () => {
  /** A read in flight, then a write: is the write sent yet, and does it read as loading? */
  async function waitingWrite(exclusive: boolean) {
    const { bus, cart, sent, release } = app(exclusive);
    const shared = useSharedCommandState({ bus });
    const flag = shared.pending('cartAdd', 'milk');
    const read = cart.load();
    const write = cart.add('milk');
    await settle();
    const during = { sent: [...sent], loading: flag.value };
    release('cartLoad');
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
    expect(await waitingWrite(true)).toEqual({ during: { sent: ['cartLoad'], loading: true }, after: false });
  });

  it('control: without exclusive it is sent at once, and reads the same', async () => {
    expect(await waitingWrite(false)).toEqual({ during: { sent: ['cartLoad', 'cartAdd'], loading: true }, after: false });
  });
});
