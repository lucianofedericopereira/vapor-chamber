// Workload for scripts/ab/ab.mjs (log s35.209): the async bus through two
// before-hooks and two after-hooks, distinct functions (V8-RULES 11), against
// the async bus with none (the control: an untouched path).
import { createAsyncCommandBus } from '__DIST__/index.js';

export const ASYNC = true;

// A before-hook on the base arm; from 1.32 step 8e its replacement: an observer is a
// `started` part, a gate an `authorize` rule.
const observe = (bus, fn) => (bus.onBefore ? bus.onBefore(fn) : bus.use({ started: fn }));
const gate = (bus, refuses) => (bus.onBefore
  ? bus.onBefore((cmd) => { if (refuses(cmd)) throw new Error('never'); })
  : bus.use({ authorize: () => (cmd) => (refuses(cmd) ? { ok: false, value: undefined, error: new Error('never') } : undefined) }));

let seen = 0;
const hooked = createAsyncCommandBus({ retry: false });
hooked.register('x', async (cmd) => cmd.target + 1);
observe(hooked, (cmd) => { seen += cmd.target & 1; });
gate(hooked, (cmd) => cmd.target < 0);
hooked.onAfter((_cmd, r) => { seen += r.ok ? 1 : 0; });
hooked.onAfter((cmd) => { seen ^= cmd.target; });

const bare = createAsyncCommandBus({ retry: false });
bare.register('x', async (cmd) => cmd.target + 1);

const run = async (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += (await bus.dispatch('x', i & 3)).value; return s + (seen & 1); };
export const N = { async_bare: 50_000, async_hooks2_2: 50_000 };
export const async_bare = (n) => run(bare, n);
export const async_hooks2_2 = (n) => run(hooked, n);
export const check = async () => [await run(bare, 8)];
