// Workload for scripts/ab/ab.mjs (log 36.F57): `pathActivity` over a menu's anchors, as
// `stampActiveLinks` calls it per anchor per commit. No DOM here: a real page adds attribute writes,
// so this row is an upper bound on what a page sees. parse_row, a query parse, is the control.
import { parseQuery, pathActivity } from '__DIST__/router/index.js';

const TARGETS = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? `/section/${i}/` : `/section/${i}`));
const CURRENT = ['/section/7', '/section/10/detail', '/'];
export const N = { activity: 20_000, parse_row: 200_000 };
export const activity = (n) => { let s = 0; for (let r = 0; r < n; r++) { const c = CURRENT[r % 3]; for (let i = 0; i < 50; i++) { const a = pathActivity(TARGETS[i], c); s += a.active ? 1 : 0; } } return s; };
export const parse_row = (n) => { let s = 0; for (let i = 0; i < n; i++) s += parseQuery('a=1&b=2').a.length; return s; };
export const check = () => [activity(4), parse_row(4)];
