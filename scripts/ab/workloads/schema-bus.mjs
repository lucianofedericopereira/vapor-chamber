// Workload for scripts/ab/ab.mjs (log 36.F57): valid commands through a schema bus, three actions
// with target and payload fields of several types. Rows: schema_valid; plain, the same actions on a
// bus with no schema, is the control.
import { createCommandBus, createSchemaCommandBus } from '__DIST__/index.js';

const schema = {
  cartAdd: { description: 'x', target: { id: 'number' }, payload: { qty: 'number', note: 'string' } },
  userSave: { description: 'x', target: { id: 'number', tags: 'array' }, payload: { name: 'string' } },
  itemMove: { description: 'x', target: { from: 'string', to: 'string' } },
};
const sch = createSchemaCommandBus(schema);
const plain = createCommandBus();
for (const bus of [sch, plain]) for (const a of Object.keys(schema)) bus.register(a, () => 1);
const CALLS = [
  ['cartAdd', { id: 1 }, { qty: 2, note: 'a' }],
  ['userSave', { id: 2, tags: [] }, { name: 'b' }],
  ['itemMove', { from: 'x', to: 'y' }, undefined],
  ['cartAdd', { id: 3 }, { qty: 1, note: 'c' }],
];
const run = (bus, n) => { let s = 0; for (let i = 0; i < n; i++) { const c = CALLS[i & 3]; s += bus.dispatch(c[0], c[1], c[2]).value; } return s; };
export const N = { schema_valid: 200_000, plain_row: 200_000 };
export const schema_valid = (n) => run(sch, n);
export const plain_row = (n) => run(plain, n);
export const check = () => [schema_valid(8), plain_row(8)];
