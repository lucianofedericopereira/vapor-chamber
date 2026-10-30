/**
 * createFormBus with a synchronous Vue effect that throws on one of the form's signal writes.
 * Why: a Vue effect runs inside the write that triggers it; if a throw skipped later writes, set() would leave isValid stale (an invalid value reading as valid) and submit() would leave a busy flag stuck on true.
 * Shows: after a throw on values, errors or isDirty, set() leaves all cells current; a throw on isValidating or isSubmitting rejects submit() with that error and ends with every flag false; the isValidating case then submits again; the control records the order of every write across set and submit.
 * See: log s35.18, log s35.23, log 36.63.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { effect, isRef } from 'vue';
import { waitForVueDetection } from '../src/chamber';
import { createFormBus } from '../src/form';

const boom = new Error('subscriber threw');

function emailForm(onSubmit?: () => Promise<void>) {
  return createFormBus({
    fields: { email: '' },
    rules: { email: (v: string) => (v.includes('@') ? null : 'Invalid email') },
    onSubmit,
  });
}

function state(f: ReturnType<typeof emailForm>) {
  return { values: f.values.value.email, errors: f.errors.value.email, isDirty: f.isDirty.value, isValid: f.isValid.value };
}

/** Await a submit and keep both what it resolved and what it rejected with. */
async function attempt(run: () => Promise<boolean>): Promise<{ resolved: boolean | undefined; rejected: unknown }> {
  try {
    return { resolved: await run(), rejected: undefined };
  } catch (e) {
    return { resolved: undefined, rejected: e };
  }
}

describe('createFormBus: a throwing sync subscriber', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });

  const AFTER_SET_X = { values: 'x', errors: 'Invalid email', isDirty: true, isValid: false };

  it('set(), subscriber on `values`: errors, isDirty and isValid are still written', () => {
    const f = emailForm();
    // Control: the signal is Vue's, so the effect below is a real subscriber.
    expect(isRef(f.values)).toBe(true);
    let threw = 0;
    const runner = effect(() => {
      if (f.values.value.email === 'x') {
        threw++;
        throw boom;
      }
    });
    f.set('email', 'x');
    // Control: the subscriber ran on the write and threw.
    expect(threw).toBe(1);
    expect(state(f)).toEqual(AFTER_SET_X);
    runner.effect.stop();
  });

  it('set(), a subscriber throwing on `errors` or on `isDirty` leaves nothing stale (the form on a store, 4f)', () => {
    const onErrors = emailForm();
    const r1 = effect(() => {
      if (onErrors.errors.value.email) throw boom;
    });
    onErrors.set('email', 'x');
    expect(state(onErrors)).toEqual(AFTER_SET_X);
    r1.effect.stop();

    const onDirty = emailForm();
    const r2 = effect(() => {
      if (onDirty.isDirty.value) throw boom;
    });
    onDirty.set('email', 'x');
    expect(state(onDirty)).toEqual(AFTER_SET_X);
    r2.effect.stop();
  });

  it('submit(), subscriber on `isValidating` becoming true: rejects, and the flag ends false', async () => {
    let submitted = 0;
    const f = emailForm(async () => {
      submitted++;
    });
    f.set('email', 'a@b.c');
    const seen: boolean[] = [];
    const runner = effect(() => {
      seen.push(f.isValidating.value);
      if (f.isValidating.value) throw boom;
    });
    const { resolved, rejected } = await attempt(() => f.submit());
    expect(seen).toContain(true);
    expect({ resolved, rejected }).toEqual({ resolved: undefined, rejected: boom });
    expect({ isValidating: f.isValidating.value, isSubmitting: f.isSubmitting.value, isBusy: f.isBusy.value }).toEqual({
      isValidating: false,
      isSubmitting: false,
      isBusy: false,
    });
    expect(submitted).toBe(0);
    runner.effect.stop();
    expect(await f.submit()).toBe(true);
    expect(submitted).toBe(1);
  });

  it('submit(), subscriber on `isSubmitting` becoming true: rejects, and the flag ends false', async () => {
    let submitted = 0;
    const f = emailForm(async () => {
      submitted++;
    });
    f.set('email', 'a@b.c');
    const seen: boolean[] = [];
    const runner = effect(() => {
      seen.push(f.isSubmitting.value);
      if (f.isSubmitting.value) throw boom;
    });
    const { resolved, rejected } = await attempt(() => f.submit());
    expect(seen).toContain(true);
    expect({ resolved, rejected }).toEqual({ resolved: undefined, rejected: boom });
    expect({ isValidating: f.isValidating.value, isSubmitting: f.isSubmitting.value, isBusy: f.isBusy.value }).toEqual({
      isValidating: false,
      isSubmitting: false,
      isBusy: false,
    });
    expect(submitted).toBe(0);
    runner.effect.stop();
  });

  it('control, no throwing subscriber: the writes a subscriber sees, in order, are unchanged', async () => {
    const events: string[] = [];
    const f = createFormBus({
      fields: { email: '' },
      rules: {
        email: (v: string) => {
          events.push('rule');
          return v.includes('@') ? null : 'Invalid email';
        },
      },
      onSubmit: async () => {
        events.push('onSubmit');
      },
    });
    const runners = [
      effect(() => void events.push(`values:${f.values.value.email}`)),
      effect(() => void events.push(`errors:${f.errors.value.email ?? 'none'}`)),
      effect(() => void events.push(`touched:${Object.keys(f.touched.value).length}`)),
      effect(() => void events.push(`isDirty:${f.isDirty.value}`)),
      effect(() => void events.push(`isValid:${f.isValid.value}`)),
      effect(() => void events.push(`isValidating:${f.isValidating.value}`)),
      effect(() => void events.push(`isSubmitting:${f.isSubmitting.value}`)),
      effect(() => void events.push(`isBusy:${f.isBusy.value}`)),
    ];
    events.length = 0;

    f.set('email', 'x');
    // The rule runs before the writes: a command builds the next state, then writes it once.
    expect(events).toEqual(['rule', 'values:x', 'errors:Invalid email', 'isDirty:true', 'isValid:false']);
    events.length = 0;

    expect(await f.submit()).toBe(false);
    expect(events).toEqual([
      'touched:1',
      'isValidating:true',
      'isBusy:true',
      'rule',
      'errors:Invalid email',
      'isValidating:false',
      'isBusy:false',
    ]);
    events.length = 0;

    f.set('email', 'a@b.c');
    expect(events).toEqual(['rule', 'values:a@b.c', 'errors:none', 'isValid:true']);
    events.length = 0;

    expect(await f.submit()).toBe(true);
    expect(events).toEqual([
      'touched:1',
      'isValidating:true',
      'isBusy:true',
      'rule',
      'errors:none',
      'isValidating:false',
      'isBusy:false',
      'isSubmitting:true',
      'isBusy:true',
      'onSubmit',
      'isSubmitting:false',
      'isBusy:false',
    ]);
    for (const r of runners) r.effect.stop();
  });
});
