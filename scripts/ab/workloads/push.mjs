// Workload for scripts/ab/ab.mjs (.probes/step-ritual.md item 14, step 3f): a server's push.
// Rows: echo_fact, a broadcast with no `stores` heard by one listener (released: Echo's
// default `bus.emit`; 1.32: the push, which reads `stores` first); push_state, a pushed cart
// state written to its store. Arm A (1.31) writes it the way its examples did, a command
// dispatched from `onBroadcast` to the store's own reducer; arm B is the push itself.
import { createCommandBus } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store.js';
import * as T from '__DIST__/transports.js';

/** An Echo with laravel-echo's channel API, one channel; `fire` delivers a broadcast. */
const echoOf = () => {
  const listeners = {};
  const ch = { listen: (event, cb) => { listeners[event] = cb; return ch; } };
  return { echo: { channel: () => ch, leave: () => {} }, fire: (event, payload) => listeners[event](payload) };
};

const is132 = typeof T.httpTransport === 'function';

let heard = 0;
const factBus = createCommandBus();
factBus.on('OrderShipped', () => { heard++; });
const facts = echoOf();
T.createEchoBridge({ echo: facts.echo, channels: [{ name: 'u', events: ['OrderShipped'] }] }).install(factBus);

const stateBus = createCommandBus();
const cart = defineChamberStore('cart', { state: () => ({ rev: 0, items: [] }), reducers: { set: (_s, next) => next } })(stateBus);
const states = echoOf();
T.createEchoBridge({
  echo: states.echo,
  channels: [{ name: 'u', events: ['CartUpdated'] }],
  ...(is132 ? {} : { onBroadcast: ({ payload }, bus) => bus.dispatch('cartSet', payload.stores.cart) }),
}).install(stateBus);

export const N = { echo_fact: 200_000, push_state: 100_000 };
export const echo_fact = (n) => { for (let i = 0; i < n; i++) facts.fire('OrderShipped', { i }); return heard; };
export const push_state = (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) { states.fire('CartUpdated', { stores: { cart: { rev: i, items: [] } } }); s += cart.state.value.rev; }
  return s;
};

/** Self-check: a fact is heard once, a pushed state lands in the store. */
export const check = () => {
  heard = 0;
  echo_fact(3);
  push_state(3);
  if (heard !== 3 || cart.state.value.rev !== 2) throw new Error(`heard ${heard} rev ${cart.state.value.rev}, want 3 2`);
  return [heard, cart.state.value.rev];
};
