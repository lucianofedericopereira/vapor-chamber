// Workload for scripts/ab/ab.mjs: building a router failure (plan 8d.1, log s35.108).
// A superseded navigation (no stack since 8b) against a failed one (stack kept: the control row).
import { routerError } from '__DIST__/router/index.js';

const to = { fullPath: '/list', path: '/list' };
const run = (code, n) => { let s = 0; for (let i = 0; i < n; i++) s += routerError(code, 'superseded', { to }).message.length; return s; };
export const N = { superseded_navigation: 50_000, failed_loader_control: 50_000 };
export const superseded_navigation = (n) => run('aborted:navigation', n);
export const failed_loader_control = (n) => run('failed:loader', n);
export const check = () => [run('aborted:navigation', 2), run('failed:loader', 2)];
