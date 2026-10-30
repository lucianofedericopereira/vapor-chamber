// Workload for scripts/ab/ab.mjs (log 36.F57): `vcCommandVapor` mounted with no modifiers, as a plain
// `v-vc-command="a"` compiles. Mock elements, so listener attach is not in it (a real page adds it).
// bare_dispatch is the control.
import { createCommandBus, setCommandBus } from '__DIST__/index.js';
import { vcCommandVapor } from '__DIST__/directives.js';

const BATCH = 100;
const sharedDoc = { addEventListener() {}, removeEventListener() {} };
const mockEl = () => ({ tagName: 'BUTTON', classList: { add() {}, remove() {} }, addEventListener() {}, removeEventListener() {}, ownerDocument: sharedDoc, parentElement: null, dataset: {} });
const els = Array.from({ length: BATCH }, mockEl);
const value = () => 'a';
const plain = createCommandBus();
plain.register('x', (cmd) => cmd.target + 1);
setCommandBus(plain);
export const N = { mount_bare: 2_000, bare_dispatch: 400_000 };
export const mount_bare = (n) => { for (let r = 0; r < n; r++) { for (let i = 0; i < BATCH; i++) vcCommandVapor(els[i], value)?.(); } return n; };
export const bare_dispatch = (n) => { let s = 0; for (let i = 0; i < n; i++) s += plain.dispatch('x', i).value; return s; };
export const check = () => [mount_bare(2), bare_dispatch(2)];
