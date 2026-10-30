// Workload for scripts/ab/ab.mjs (log 36.F57): commands held offline up to a burst of 50, then the
// queue cleared. `enforceBound` filters the queue per held command. Rows: burst; outbox_online, a
// covered command online with the queue empty, is the control.
import { createAsyncCommandBus } from '__DIST__/index.js';
import { createOutbox } from '__DIST__/outbox.js';

export const ASYNC = true;
const transport = { id: 'transport', send: async (cmd) => ({ ok: true, value: cmd.target, error: undefined }) };
const outbox = createOutbox({ actions: ['cart*'], storage: null, isOnline: () => false, autoFlush: false, maxSize: 200 });
const bus = createAsyncCommandBus({ retry: false, transport, outbox });
const online = createAsyncCommandBus({ retry: false, transport, outbox: createOutbox({ actions: ['cart*'], storage: null, isOnline: () => true, autoFlush: false }) });
const BURST = 50;
export const N = { burst: 500, outbox_online: 50_000 };
export const burst = async (n) => {
  let s = 0;
  for (let r = 0; r < n; r++) {
    const held = [];
    for (let i = 0; i < BURST; i++) held.push(bus.dispatch('cartAdd', i));
    await outbox.clear();
    await Promise.allSettled(held);
    s += held.length;
  }
  return s;
};
export const outbox_online = async (n) => { let s = 0; for (let i = 0; i < n; i++) s += (await online.dispatch('cartAdd', i & 3)).value; return s; };
export const check = async () => [await burst(2), await outbox_online(8)];
