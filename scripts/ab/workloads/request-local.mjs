// Workload for scripts/ab/ab.mjs (log 36.F59): a local request on an async
// bus. `request()` joined an identical call, then wrapped the dispatch in a
// per-caller promise; the change removed the async frame around that wrapper,
// not the joiner. `dispatch_local` is the same bus's dispatch, the path
// without the joiner: the control.
import { createAsyncCommandBus } from '__DIST__/index.js';

const bus = createAsyncCommandBus({ retry: false });
bus.register('local', () => 1);
bus.respond('priceGet', () => 1);

export const ASYNC = true;
export const N = { request_local: 20_000, dispatch_local: 20_000 };

const request = async (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += (await bus.request('priceGet', { id: i & 3 })).ok ? 1 : 0;
  return s;
};
const dispatch = async (n) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += (await bus.dispatch('local', { id: i & 3 })).ok ? 1 : 0;
  return s;
};

export const request_local = (n) => request(n);
export const dispatch_local = (n) => dispatch(n);

/** Self-check: each request and dispatch answers ok. */
export const check = async () => [await request(4), await dispatch(4)];
