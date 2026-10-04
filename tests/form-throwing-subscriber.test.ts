/**
 * FIXTURE - a synchronous subscriber that THROWS on one of the form's signal
 * writes must not leave the other signals stale (`set`) or a busy flag stuck
 * on true (`submit`). Real Vue `effect`s. The long note is at the end.
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

  it('set(), TODAY and not fixed: a subscriber throwing on `errors` or on `isDirty` leaves the writes after it stale', () => {
    const onErrors = emailForm();
    const r1 = effect(() => {
      if (onErrors.errors.value.email) throw boom;
    });
    onErrors.set('email', 'x');
    expect(state(onErrors)).toEqual({ ...AFTER_SET_X, isDirty: false, isValid: true });
    r1.effect.stop();

    const onDirty = emailForm();
    const r2 = effect(() => {
      if (onDirty.isDirty.value) throw boom;
    });
    onDirty.set('email', 'x');
    expect(state(onDirty)).toEqual({ ...AFTER_SET_X, isValid: true });
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
    // The form is usable again: the next submit goes through.
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
    expect(events).toEqual(['values:x', 'rule', 'errors:Invalid email', 'isDirty:true', 'isValid:false']);
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
    expect(events).toEqual(['values:a@b.c', 'rule', 'errors:none', 'isValid:true']);
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

/*
 * Why this file exists. Found by reading `form.ts` against Vue `ef5ff106`
 * (log s35.18) and fixed in s35.23: the shape `runDispatch` had.
 *
 * `set`. The `formSet` handler writes four signals in a row: `values`,
 * `errors`, `isDirty`, `isValid`. A Vue effect runs inside the write that
 * triggers it, so a subscriber that throws on one write skipped the writes
 * after it. The bus turns the handler's throw into a failed result, which
 * `set()` drops, so `set()` returned normally with `values` new and the rest
 * stale: an invalid value read as valid. The `values` write now sits in a
 * `try` whose `finally` makes the other three, so they land and the
 * subscriber's error still leaves the handler the way it did.
 *
 * What is NOT fixed, and is pinned as today's behaviour by the second test: a
 * subscriber that throws on `errors` or on `isDirty` still skips the writes
 * after it. The shape that covers those too, and its cost per `set`, are in
 * log s35.23 b; it was not landed.
 *
 * `submit`. `isValidating = true` and `isSubmitting = true` each stood one
 * line above the `try` whose `finally` clears it. A subscriber throwing on
 * either rejected `submit()` and left the flag true for good. Both are now the
 * first statement inside their `try`. `submit()` still rejects with the
 * subscriber's error, as it does for a rule or an `onSubmit` that throws.
 *
 * The last test is the control for both moves. It records every write eight
 * effects see, and each call of the rule and of `onSubmit`, across an invalid
 * set, a failed submit, a valid set and a successful submit. The lists are the
 * ones this test produced before the move.
 */
