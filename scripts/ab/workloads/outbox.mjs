// Workload for scripts/ab/ab.mjs: dispatch on an async bus with an outbox, online with nothing
// held (the normal path). Rows: an action the outbox covers, one outside its `actions`, and the
// same bus with no outbox as control. Before 1.32 step 4i the outbox was a chain plugin
// (`outbox.plugin`); since then it is the bus's `outbox` option. The transport answers at once.
import { createAsyncCommandBus } from '__DIST__/index.js';
import * as O from '__DIST__/outbox.js';

export const ASYNC = true;

const transport = { id: 'transport', send: async (cmd) => ({ ok: true, value: cmd.target, error: undefined }) };
// This tab's memory: an adapter before the 1-7 fix-up, `null` since (the queue a state half).
const memory = O.localStorageOutbox ? { load: () => null, save: () => {}, clear: () => {} } : null;

const mk = (withOutbox) => {
  if (!withOutbox) return createAsyncCommandBus({ retry: false, transport });
  const outbox = O.createOutbox({ actions: ['cart*'], storage: memory, isOnline: () => true, autoFlush: false });
  if (typeof outbox.plugin === 'function') {
    const bus = createAsyncCommandBus({ retry: false, transport });
    bus.use(outbox.plugin, { priority: 200 });
    return bus;
  }
  return createAsyncCommandBus({ retry: false, transport, outbox });
};
const held = mk(true);
const bare = mk(false);

const run = async (bus, action, n) => { let s = 0; for (let i = 0; i < n; i++) s += (await bus.dispatch(action, i & 3)).value; return s; };
export const N = { outbox_covered: 50_000, outbox_outside: 50_000, outbox_none: 50_000 };
export const outbox_covered = (n) => run(held, 'cartAdd', n);
export const outbox_outside = (n) => run(held, 'noteAdd', n);
export const outbox_none = (n) => run(bare, 'cartAdd', n);
export const check = async () => [await run(held, 'cartAdd', 8), await run(held, 'noteAdd', 8), await run(bare, 'cartAdd', 8)];
