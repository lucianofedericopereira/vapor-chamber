// Workload for scripts/ab/ab.mjs: a shared store with another tab open (log 36.F39). Two "tabs" in one process
// share one channel: `first` is made first, so it holds the store's Web Lock where the build takes one, and
// `second` waits. A row writes n times in one tab, then waits until the other tab holds the last write: the
// timed window is the writes and their whole crossing (the post, the other tab's run and, where a lead posts
// it on, the relay and its confirmation). On a build with no lead the other tab runs the post as it arrives.
// Each channel is unref'd so the child exits; `window` marks a page, where shareTabs opens.
import { createCommandBus, shareTabs } from '__DIST__/index.js';
import { defineChamberStore } from '__DIST__/store.js';

const Channel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = class extends Channel { constructor(name) { super(name); this.unref(); } };
globalThis.window ??= {};

const reducers = { set: (s, n) => ({ n }) };
// The child loads both arms in one process: each bundle gets channels of its own, or the arms meet as tabs.
const own = Math.random().toString(36).slice(2);
const define = (id) => defineChamberStore(id, { state: () => ({ n: -1 }), reducers, share: shareTabs(`ab:${id}:${own}`) });
const useLead = define('peerlead');
const useFollow = define('peerfollow');
// One pair per row, so each row's writes cross on a channel of their own.
const leadWrites = { from: useLead(createCommandBus()), to: useLead(createCommandBus()) };
const followWrites = { to: useFollow(createCommandBus()), from: useFollow(createCommandBus()) };

const turn = () => new Promise((r) => setImmediate(r));
// Until the other tab holds `want`: a write that never arrives fails the run instead of timing nothing.
const reach = async (store, want) => {
  for (let i = 0; i < 1_000_000; i++) {
    if (store.state.value.n === want) return;
    await turn();
  }
  throw new Error(`the other tab never reached ${want}`);
};
let seq = 0;
const run = async (pair, n) => {
  // A value per call no tab held, so each call's last write is one the other tab must reach.
  const base = (seq += n + 1) * 2;
  let s = 0;
  for (let i = 0; i < n; i++) s += pair.from.set(base + i).value.n;
  await reach(pair.to, base + n - 1);
  return s;
};
// Both pairs settled (the lock granted, the asks answered) before any row is timed.
const ready = (async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 10));
})();

// The writing tab's own synchronous write and nothing else: no task runs inside the call, so no message is
// read. Each has a pair of its own, and they come after the rows above, whose waits would read their messages.
const leadAlone = { from: define('peerleadw')(createCommandBus()), to: null, heard: 0 };
leadAlone.to = define('peerleadw')(createCommandBus());
const followAlone = { to: define('peerfolloww')(createCommandBus()), from: null, heard: 0 };
followAlone.from = define('peerfolloww')(createCommandBus());
// A third listener on each pair's channel counts what crosses it.
for (const [pair, id] of [[leadAlone, 'peerleadw'], [followAlone, 'peerfolloww']]) {
  new globalThis.BroadcastChannel(`ab:${id}:${own}`).onmessage = () => { pair.heard++; };
}
const writes = (store, n) => {
  // A value per call no tab held, as in `run`, so SETTLE waits for this call's writes.
  const base = (seq += n + 1) * 2;
  let s = 0;
  for (let i = 0; i < n; i++) s += store.set(base + i).value.n;
  return s;
};
// Between calls, outside the timed window (scripts/ab/child.cjs): the other tab takes the last write,
// then the channel carries nothing for 5 turns, the relay and its confirmation included. So a call
// never times a backlog of unread messages or unconfirmed writes left by the calls before it.
const settle = async (pair) => {
  await reach(pair.to, pair.from.state.value.n);
  let still = 0;
  for (let i = 0; i < 100_000 && still < 5; i++) {
    const before = pair.heard;
    await turn();
    still = pair.heard === before ? still + 1 : 0;
  }
  if (still < 5) throw new Error('the channel never went quiet');
};

export const ASYNC = true;
export const N = { store_peer_lead: 2_000, store_peer_follower: 2_000, store_peer_lead_write: 20_000, store_peer_follower_write: 20_000 };
export const store_peer_lead = async (n) => { await ready; return run(leadWrites, n); };
export const store_peer_follower = async (n) => { await ready; return run(followWrites, n); };
export const store_peer_lead_write = async (n) => { await ready; return writes(leadAlone.from, n); };
export const store_peer_follower_write = async (n) => { await ready; return writes(followAlone.from, n); };
export const SETTLE = { store_peer_lead_write: () => settle(leadAlone), store_peer_follower_write: () => settle(followAlone) };
export const check = async () => {
  await ready;
  const drained = [];
  for (const pair of [leadAlone, followAlone]) {
    writes(pair.from, 8);
    await settle(pair);
    drained.push(pair.to.state.value.n === pair.from.state.value.n);
  }
  return [await run(leadWrites, 8) > 0, await run(followWrites, 8) > 0, leadWrites.to.state.value.n, followWrites.to.state.value.n, ...drained].map(String);
};
