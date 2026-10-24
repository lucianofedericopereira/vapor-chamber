/** The form's state is one store: one write per command, per-slice cells, the duplicate id from the registry. Rationale at the end. */
import { beforeAll, describe, expect, it } from 'vitest';
import { effect } from 'vue';
import { waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createFormBus } from '../src/form';

const boom = new Error('subscriber threw');
const emailForm = (bus = createCommandBus()) => createFormBus({
  fields: { email: '', name: '' },
  rules: { email: (v: string) => (v.includes('@') ? null : 'Invalid email') },
  bus,
});

describe('a form on a store', () => {
  beforeAll(async () => { await waitForVueDetection(); });

  it('a subscriber throwing on `errors` leaves no stale isDirty or isValid', () => {
    const f = emailForm();
    const runner = effect(() => { if (f.errors.value.email) throw boom; });
    f.set('email', 'x');
    expect({ isDirty: f.isDirty.value, isValid: f.isValid.value, errors: f.errors.value.email }).toEqual({ isDirty: true, isValid: false, errors: 'Invalid email' });
    runner.effect.stop();
  });

  it('a subscriber throwing on `isDirty` leaves no stale isValid', () => {
    const f = emailForm();
    const runner = effect(() => { if (f.isDirty.value) throw boom; });
    f.set('email', 'x');
    expect(f.isValid.value).toBe(false);
    runner.effect.stop();
  });

  it('a reader of isValid re-runs when it flips, not on every set', () => {
    const f = emailForm();
    let runs = 0;
    const runner = effect(() => { void f.isValid.value; runs++; });
    f.set('name', 'a');
    f.set('name', 'ab');
    f.set('email', 'x');
    f.set('email', 'xy');
    expect(runs).toBe(2);
    runner.effect.stop();
  });

  it('a second form with one id on a bus still throws, and the bus carries no claim field', () => {
    const bus = createCommandBus();
    emailForm(bus);
    expect(() => emailForm(bus)).toThrow('form id "form" already on this bus');
    expect(Object.keys(bus as object)).not.toContain('__vcFormIds');
  });

  it('dispose frees the id for a new form', () => {
    const bus = createCommandBus();
    emailForm(bus).dispose();
    expect(() => emailForm(bus).dispose()).not.toThrow();
  });

  it('isDirty and isValid follow set and reset', () => {
    const f = emailForm();
    f.set('email', 'a@b.c');
    expect([f.isDirty.value, f.isValid.value]).toEqual([true, true]);
    f.reset();
    expect([f.isDirty.value, f.isValid.value, f.values.value.email]).toEqual([false, true, '']);
  });

  it('values is read-only', () => {
    const f = emailForm();
    // @ts-expect-error a direct write bypassed the commands
    f.values.value = { email: 'x', name: '' };
    void f;
  });
});

/*
 * Plan 1.32 4f. The form held eight signals and wrote them one by one: a Vue
 * effect runs inside the write that triggers it, so a subscriber that threw on
 * `errors` or `isDirty` skipped the writes after it (pinned as "today, not
 * fixed" in tests/form-throwing-subscriber.test.ts). The form's state is now
 * one store, written once per command; its public cells are each a signal over
 * the store's field events, the shape `fieldRef` uses, so a reader of `isValid`
 * still re-runs only when it flips (coordinator 2026-10-19, B: per-slice
 * re-runs are released behaviour). A subscriber's throw lands in the field
 * lane's log line and the other cells are written. The duplicate-id check
 * reads the bus's store registry; the `__vcFormIds` field on the bus is gone.
 * `values` and the other state cells are read-only by type.
 */
