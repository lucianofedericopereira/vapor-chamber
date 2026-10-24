// Workload for scripts/ab/ab.mjs: a form, plan 1.32 step 4f (Q6, a new row). A form of three
// fields and three rules. `form_set_read`: `set()` with a Vue effect reading each public slice
// (values, errors, touched, isDirty, isValid), the way a template reads a form. `form_set`: the
// same with no reader. `form_set_headless`: `reactive: false`. `form_create`: a form created and
// disposed on a shared bus. Wired through vapor-chamber/vue, as a correct app is.
import { effect } from 'vue';
import { createCommandBus, createFormBus } from '__DIST__/vue.js';

const fields = { email: '', name: '', age: '' };
const rules = {
  email: (v) => (v.includes('@') ? null : 'Invalid email'),
  name: (v) => (v.length > 0 ? null : 'Required'),
  age: (v) => (/^\d*$/.test(v) ? null : 'Digits only'),
};
const make = (reactive) => createFormBus({ fields: { ...fields }, rules, reactive });

const read = make(true);
let seen = 0;
for (const slice of ['values', 'errors', 'touched', 'isDirty', 'isValid']) effect(() => { void read[slice].value; seen++; });
const quiet = make(true);
const headless = make(false);

const typing = ['a', 'ab', 'ab@', 'ab@c', 'ab@c.d'];
const run = (form, n) => { for (let i = 0; i < n; i++) form.set('email', typing[i % 5]); return form.isValid.value ? 1 : 0; };
const shared = createCommandBus();

export const N = { form_set_read: 100_000, form_set: 100_000, form_set_headless: 100_000, form_create: 20_000, form_create_bare: 20_000 };
// A form created and disposed with none of its state cells read: a headless or submit-only form.
export function form_create_bare(n) {
  let s = 0;
  for (let i = 0; i < n; i++) { const f = createFormBus({ fields: { ...fields }, rules, bus: shared }); s += f.isSubmitting.value ? 1 : 0; f.dispose(); }
  return s;
}
export const form_set_read = (n) => run(read, n) + seen;
export const form_set = (n) => run(quiet, n);
export const form_set_headless = (n) => run(headless, n);
export function form_create(n) {
  let s = 0;
  for (let i = 0; i < n; i++) { const f = createFormBus({ fields: { ...fields }, rules, bus: shared }); s += f.isValid.value ? 1 : 0; f.dispose(); }
  return s;
}
export const check = () => [form_set_read(10), form_set(10), form_set_headless(10), form_create(10)];
