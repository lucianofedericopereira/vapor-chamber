/** A state received from another tab is never sent back, however late its write lands. Rationale at the end. */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { _errResult, createAsyncCommandBus, createCommandBus, type Command } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { createChannel } from '../src/plugins-io';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';

// The suite runs without --expose-gc; a context created after the flag has `gc` (tests/v8-helper.test.ts).
setFlagsFromString('--expose-gc');
const fullGc = runInNewContext('gc') as () => void;

type Cart = { items: number[] };
const state = (): Cart => ({ items: [] });
const reducers = { add: (s: Cart, id: number) => ({ items: [...s.items, id] }) };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store, async bus`, () => {
    it("tabs converge when the receiver's $sync lands after the next message", async () => {
      const name = `share-held-${runtime}-${n++}`;
      const tab = (delaySync: boolean) => {
        const bus = createAsyncCommandBus({ retry: false });
        // An async plugin on cart*, as a per-store `serialize` lane would be.
        if (delaySync) bus.use(async (cmd, next) => { if (cmd.action === 'cart$sync') await wait(30); return next(); });
        const lane = createFastLane();
        const ch = createChannel({ channel: name, lane, events: ['cart$state'] });
        const cart = (define as typeof defineCore)('cart', { state, reducers, share: lane })(bus);
        return { cart, close: () => { cart.$dispose(); ch.dispose(); } };
      };
      const a = tab(false);
      const b = tab(true);
      await wait(20);
      await a.cart.add(1);
      await a.cart.add(2);
      await wait(200);
      expect(a.cart.state.value.items).toEqual([1, 2]);
      expect(b.cart.state.value.items).toEqual([1, 2]);
      a.close();
      b.close();
    });
  });
}

describe('a received state whose $sync is refused', () => {
  const send = (lane: ReturnType<typeof createFastLane>, keep?: unknown[]): WeakRef<object> => {
    const s = { items: [9] };
    keep?.push(s);
    lane.emit('cart$state', { state: s, version: 5, tab: 'other' });
    return new WeakRef(s);
  };

  for (const kept of [true, false]) {
    it(kept ? 'control: a state the test keeps survives a full gc' : 'is not kept by the store', async () => {
      const bus = createCommandBus();
      bus.use((cmd: Command, next) => (cmd.action === 'cart$sync' ? _errResult(new Error('refused')) : next()));
      const lane = createFastLane();
      const cart = defineCore('cart', { state, reducers, share: lane })(bus);
      const keep: unknown[] = [];
      const ref = send(lane, kept ? keep : undefined);
      expect(cart.state.value.items).toEqual([]);
      // A WeakRef keeps its target alive to the end of the job that made it (ECMA-262 AddToKeptObjects).
      await wait(0);
      fullGc();
      expect(ref.deref() !== undefined).toBe(kept);
      expect(keep).toHaveLength(kept ? 1 : 0); // the control's state stays reachable to here
      cart.$dispose();
    });
  }
});

/*
 * `share` held the last received state in one slot and did not send a write of
 * it back. On the async bus a received `<id>$sync` can land after the next
 * message (an async plugin on `cart*`): the slot then held the newer state, so
 * the older one's write was sent as this tab's own, with a higher version, and
 * the sending tab took it: tab A ended on [1], tab B on [1, 2]. Every received
 * state is now held in a Set from its message until its `$sync` settles,
 * whatever the result, and a write of a held state is not sent. A refused
 * `$sync` (a plugin on `cart*` may refuse one) does not leave its state held:
 * the second block checks it with a full gc, beside a control that keeps the
 * state alive and must see it survive.
 */
