/**
 * createFormBus state as one store: a throwing subscriber leaves no stale cells, isValid re-runs only when it flips, duplicate ids are rejected.
 * Why: a Vue effect runs inside the write that triggers it; if the form wrote its cells one by one, a subscriber that throws would leave isDirty or isValid stale, and an invalid value would read as valid.
 * Shows: with a throwing subscriber on errors or isDirty the other cells are still current, an isValid reader runs twice over four sets, a second form with the same id on a bus throws and the bus gets no claim field, dispose frees the id, isDirty and isValid follow set and reset.
 * See: tests/form-throwing-subscriber.test.ts, log 36.63.
 */
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
