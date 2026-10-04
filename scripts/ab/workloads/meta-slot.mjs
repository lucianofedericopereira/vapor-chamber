// Workload for scripts/ab/ab.mjs (log s35.81): what stampMeta costs on the sync
// bus once its literal holds `idempotencyKey` from the start. Every dispatch
// builds a meta. The bare bus (the fast path, no plugin, hook or listener), and
// one with a listener that reads the meta, so the object escapes and is used.
// The benefit side (a keyed async command keeps one map) is not timeable here:
// the tool times sync functions only.
import { createCommandBus } from '__DIST__/index.js';

const bare = createCommandBus();
bare.register('x', (cmd) => cmd.target + 1);

const read = createCommandBus();
read.register('x', (cmd) => cmd.target + 1);
let ids = 0;
read.on('x', (cmd) => { ids += cmd.meta.id > 0 ? 1 : 0; });

const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch('x', i & 3).value; return s + ids; };
export const N = { bare_dispatch: 400_000, listener_reads_meta: 200_000 };
export const bare_dispatch = (n) => run(bare, n);
export const listener_reads_meta = (n) => run(read, n);
export const check = () => [run(bare, 8), run(read, 8)];
