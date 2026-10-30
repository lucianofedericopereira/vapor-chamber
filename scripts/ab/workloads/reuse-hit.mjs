// Workload for scripts/ab/ab.mjs (log 36.F57): a `reuse` part answering every command, so `guarded`
// runs per dispatch: a synchronous answer and a promise. Rows: reuse_sync, reuse_promise; bare, no
// plugin, is the control.
import { createAsyncCommandBus, createCommandBus } from '__DIST__/index.js';

const ANSWER = { ok: true, value: 1, error: undefined };
const sync = createCommandBus();
sync.register('x', () => 0);
sync.use({ id: 'hit', reuse: () => ANSWER });
const asyncBus = createAsyncCommandBus({ retry: false });
asyncBus.register('x', async () => 0);
asyncBus.use({ id: 'hit', reuse: () => Promise.resolve(ANSWER) });
const bare = createCommandBus();
bare.register('x', () => 1);

export const ASYNC = true;
export const N = { reuse_sync: 200_000, reuse_promise: 50_000, bare_row: 200_000 };
export const reuse_sync = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += sync.dispatch('x', i).value; return s; };
export const reuse_promise = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += (await asyncBus.dispatch('x', i)).value; return s; };
export const bare_row = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += bare.dispatch('x', i).value; return s; };
export const check = async () => [await reuse_sync(8), await reuse_promise(8), await bare_row(8)];
