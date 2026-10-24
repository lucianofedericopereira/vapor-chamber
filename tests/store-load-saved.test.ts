/** A store loads saved state through a declared action: from storage or from the server (log s35.103). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { saveTo } from '../src/store-persist';

type Cart = { items: Array<{ name: string; line: number }> };

/** One definition, as the server and the client modules would share it. `line` is minted per side. */
function cartStore(storage?: { getItem(k: string): string | null; setItem(k: string, v: string): void }) {
  let line = 0;
  return defineChamberStore('cart', {
    state: (): Cart => ({ items: [] }),
    ...(storage ? { persist: saveTo<Cart>({ key: 'vc:cart', storage }) } : {}),
    reducers: {
      add: (s: Cart, name: string) => ({ items: [...s.items, { name, line: ++line }] }),
      load: (s: Cart, saved: Cart | null) => saved ?? s,
    },
  });
}

function memoryStorage() {
  let stored: string | null = null;
  return {
    getItem: () => stored,
    setItem: (_k: string, v: string) => { stored = v; },
    read: () => stored,
  };
}

describe('from the server', () => {
  it('the snapshot reaches the client store through the declared action, and its persist saves it', async () => {
    const server = createCommandBus();
    const onServer = cartStore()(server);
    onServer.add('tea');
    onServer.add('jam');
    const html = JSON.stringify(onServer.state.value); // embedded in the page

    const client = createCommandBus();
    const storage = memoryStorage();
    const onClient = cartStore(storage)(client);
    onClient.load(JSON.parse(html));
    await Promise.resolve();

    expect(onClient.state.value).toEqual(onServer.state.value);
    expect(storage.read()).toBe(html);
    onServer.$dispose();
    onClient.$dispose();
  });

});

describe('the origin of a load', () => {
  it("`__origin: 'replay'` in the payload reaches meta.origin, so a listener can tell it from a user action", () => {
    const bus = createCommandBus();
    const cart = cartStore()(bus);
    const origins: Array<string | undefined> = [];
    bus.on('cart*', (cmd) => origins.push(cmd.meta?.origin));
    cart.load({ items: [{ name: 'tea', line: 1 }] }, { __origin: 'replay' });
    cart.add('jam');
    expect(origins).toEqual(['replay', undefined]);
    expect(cart.state.value.items.map((i) => i.name)).toEqual(['tea', 'jam']);
    cart.$dispose();
  });
});

/*
 * Log s35.103 (D6, hydration as a command). A store's state has no setter,
 * so the only way saved state can enter it is a dispatch of an action the
 * store declares; docs/store.md, "Loading state from the server", states that one
 * pattern for the server. Storage: the store's own `persist` reads it
 * at creation (tests/store-persist.test.ts). The server: the
 * state itself, serialized into the page, passed to the same action - a FACT,
 * which converges where replaying the commands re-runs every reducer on the
 * client and diverges whenever one is not deterministic (the createChannel
 * finding, whitepaper appendix B, rc.9). `__origin` in the payload is the
 * documented way to mark where a dispatch came from (stampMeta), here
 * 'replay', so a listener can tell a load from what the user did.
 */
