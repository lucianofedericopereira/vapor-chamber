// Workload for scripts/ab/ab.mjs (.probes/fixup-1-7-pickup.md, 2c): the buffer, a command held
// before its handler exists and run when it registers. Rows: buffer_cycle, 64 dispatches of an
// action with no handler, then the handler registers and runs them (the path the queue's state
// half changes), per held command; buffer_control, a dispatch of a handled action on a bus with
// a buffer (a path the buffer never reaches, which should read 1.000).
import { createBuffer, createCommandBus } from '__DIST__/index.js';

const bus = createCommandBus({ buffer: createBuffer() });
const handled = createCommandBus({ buffer: createBuffer() });
handled.register('ready', (cmd) => cmd.target);

const BATCH = 64;
let sum = 0;
const handler = (cmd) => { sum += cmd.target; return cmd.target; };

export const N = { buffer_cycle: 2_000, buffer_control: 200_000 };
export const buffer_cycle = (n) => {
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < BATCH; k++) bus.dispatch('later', k & 3);
    const off = bus.register('later', handler);
    off();
  }
  return sum;
};
export const buffer_control = (n) => { let s = 0; for (let i = 0; i < n; i++) s += handled.dispatch('ready', i & 3).value; return s; };

/** Self-check: held commands run once their handler registers; the handled action runs at once. */
export const check = () => {
  sum = 0;
  for (let k = 0; k < 4; k++) bus.dispatch('later', 1);
  const off = bus.register('later', handler);
  off();
  if (sum !== 4) throw new Error(`ran ${sum}, want 4`);
  sum = 0;
  return [buffer_cycle(1), buffer_control(4)];
};
