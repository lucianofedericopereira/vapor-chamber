// Workload for scripts/ab/ab.mjs: dispatch through history() (log s35.113-114).
// Rows: a command it records, a command its filter skips, and a bare bus as control.
import { createCommandBus, history } from '__DIST__/index.js';

const mk = (withHistory) => {
  const bus = createCommandBus();
  bus.register('rec', (cmd) => cmd.target + 1, { undo: () => {} });
  bus.register('skip', (cmd) => cmd.target + 1);
  if (withHistory) bus.use(history({ bus, maxSize: 50, filter: (cmd) => cmd.action !== 'skip' }));
  return bus;
};
const hist = mk(true);
const bare = mk(false);

const run = (bus, action, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch(action, i & 3).value; return s; };
export const N = { history_recorded: 200_000, history_skipped: 200_000, bare_control: 200_000 };
export const history_recorded = (n) => run(hist, 'rec', n);
export const history_skipped = (n) => run(hist, 'skip', n);
export const bare_control = (n) => run(bare, 'rec', n);
export const check = () => [run(hist, 'rec', 8), run(hist, 'skip', 8), run(bare, 'rec', 8)];
