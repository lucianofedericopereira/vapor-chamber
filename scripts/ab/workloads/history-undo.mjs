// Workload for scripts/ab/ab.mjs: dispatch through history() (log s35.113-114).
// Rows: a command it records, a command its filter skips, an undo and redo of one recorded
// command, and a bare bus as control. Three rows scope the recorder by name patterns, as an app
// that wrote `filter: startsWith('re')` now writes `actions: ['re*']`; both options are given, so
// each arm reads its own.
// Before 1.32 step 4h history() returned a plugin to `use`; since then it installs itself.
import { createCommandBus, history } from '__DIST__/index.js';

const mk = (withHistory) => {
  const bus = createCommandBus();
  bus.register('rec', (cmd) => cmd.target + 1, { undo: () => {} });
  bus.register('skip', (cmd) => cmd.target + 1);
  let h;
  if (withHistory) {
    h = history({ bus, maxSize: 50, filter: (cmd) => cmd.action !== 'skip', actionFilter: (a) => a !== 'skip' });
    if (typeof h === 'function') bus.use(h);
  }
  return { bus, h };
};
const mkScoped = () => {
  const bus = createCommandBus();
  bus.register('rec', (cmd) => cmd.target + 1, { undo: () => {} });
  bus.register('skip', (cmd) => cmd.target + 1);
  history({ bus, maxSize: 50, filter: (cmd) => cmd.action.startsWith('re'), actions: ['re*'] });
  return { bus };
};
const hist = mk(true);
const scoped = mkScoped();
const bare = mk(false);
const cycle = mk(true);
cycle.bus.dispatch('rec', 1);

const run = ({ bus }, action, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch(action, i & 3).value; return s; };
const undoRedo = (n) => { let s = 0; for (let i = 0; i < n; i++) { s += cycle.h.undo() ? 1 : 0; s += cycle.h.redo() ? 1 : 0; } return s; };
// The probe for the constant-folding claim: the name is read from a global each call, so no arm can fold it.
globalThis.__vcName = 'rec';
const opaque = ({ bus }, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch(globalThis.__vcName, i & 3).value; return s; };
const alternate = ({ bus }, n) => { let s = 0; for (let i = 0; i < n; i++) s += bus.dispatch(i & 1 ? 'rec' : 'skip', i & 3).value; return s; };
export const N = { history_recorded: 200_000, history_skipped: 200_000, undo_redo: 100_000, bare_control: 200_000, scope_recorded: 200_000, scope_skipped: 200_000, scope_alternate: 200_000, scope_recorded_opaque: 200_000 };
export const history_recorded = (n) => run(hist, 'rec', n);
export const history_skipped = (n) => run(hist, 'skip', n);
export const undo_redo = (n) => undoRedo(n);
export const bare_control = (n) => run(bare, 'rec', n);
export const scope_recorded = (n) => run(scoped, 'rec', n);
export const scope_skipped = (n) => run(scoped, 'skip', n);
export const scope_alternate = (n) => alternate(scoped, n);
export const scope_recorded_opaque = (n) => opaque(scoped, n);
export const check = () => [run(hist, 'rec', 8), run(hist, 'skip', 8), undoRedo(8), run(bare, 'rec', 8), run(scoped, 'rec', 8), run(scoped, 'skip', 8), alternate(scoped, 8), opaque(scoped, 8)];
