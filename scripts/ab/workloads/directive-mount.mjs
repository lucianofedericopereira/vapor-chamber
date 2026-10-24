// Workload for scripts/ab/ab.mjs (step 4 close, log 36.83): the two rows of tests/perf.bench.ts
// "directive delegation (.delegate) - mount/unmount cost at scale" that read slower in one
// unpaired bench run against e0c7e86. The same shapes: the directive plugin installed on a
// stand-in app, a batch of mock elements mounted then unmounted, direct and delegated. A
// bare dispatch is the control.
import { createCommandBus } from '__DIST__/index.js';
import { createDirectivePlugin } from '__DIST__/directives.js';

const BATCH = 100;
const sharedDoc = { addEventListener() {}, removeEventListener() {} };
const mockEl = () => ({
  tagName: 'BUTTON',
  classList: { add() {}, remove() {} },
  addEventListener() {},
  removeEventListener() {},
  ownerDocument: sharedDoc,
  parentElement: null,
  dataset: {},
});
const directives = new Map();
createDirectivePlugin().install({ directive(name, def) { directives.set(name, def); } });
const vc = directives.get('vc-command');
const els = Array.from({ length: BATCH }, mockEl);
const binding = { arg: 'command', value: 'a', modifiers: {} };
const delegated = { arg: 'command', value: 'a', modifiers: { delegate: true } };
const unbind = { arg: 'command' };

const cycle = (n, b) => {
  for (let r = 0; r < n; r++) {
    for (let i = 0; i < BATCH; i++) vc.mounted(els[i], b);
    for (let i = 0; i < BATCH; i++) vc.beforeUnmount(els[i], unbind);
  }
  return n;
};
const plain = createCommandBus();
plain.register('x', (cmd) => cmd.target + 1);

export const N = { mount_direct: 2_000, mount_delegated: 2_000, bare_dispatch: 400_000 };
export const mount_direct = (n) => cycle(n, binding);
export const mount_delegated = (n) => cycle(n, delegated);
export const bare_dispatch = (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain.dispatch('x', i & 3).value; return s; };
export const check = () => [cycle(1, binding), cycle(1, delegated), bare_dispatch(8)];
