import { describe, it, expect, vi } from 'vitest';
import { createFormBus } from '../src/form';
import { createCommandBus } from '../src/command-bus';
import { logger } from '../src/plugins';

// ---------------------------------------------------------------------------
// createFormBus
// ---------------------------------------------------------------------------

describe('createFormBus', () => {
  it('initialises with the provided field values', () => {
    const form = createFormBus({ fields: { email: '', password: '' } });
    expect(form.values.value).toEqual({ email: '', password: '' });
  });

  it('isDirty is false initially and true after a change', () => {
    const form = createFormBus({ fields: { name: '' } });
    expect(form.isDirty.value).toBe(false);
    form.set('name', 'Alice');
    expect(form.isDirty.value).toBe(true);
  });

  it('set() updates the named field only', () => {
    const form = createFormBus({ fields: { a: 1, b: 2 } });
    form.set('a', 99);
    expect(form.values.value.a).toBe(99);
    expect(form.values.value.b).toBe(2);
  });

  it('touch() marks a field as touched', () => {
    const form = createFormBus({ fields: { email: '' } });
    expect(form.touched.value.email).toBeUndefined();
    form.touch('email');
    expect(form.touched.value.email).toBe(true);
  });

  it('reset() restores initial values and clears state', () => {
    const form = createFormBus({ fields: { name: 'Alice' } });
    form.set('name', 'Bob');
    form.touch('name');
    form.reset();
    expect(form.values.value.name).toBe('Alice');
    expect(form.isDirty.value).toBe(false);
    expect(form.touched.value).toEqual({});
    expect(form.errors.value).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('createFormBus — validation', () => {
  const rules = {
    email:    (v: string) => v.includes('@') ? null : 'Invalid email',
    password: (v: string) => v.length >= 8   ? null : 'Too short',
  };

  it('isValid is true when no rules are provided', () => {
    const form = createFormBus({ fields: { x: '' } });
    expect(form.isValid.value).toBe(true);
  });

  it('set() triggers validation and populates errors', () => {
    const form = createFormBus({ fields: { email: '', password: '' }, rules });
    form.set('email', 'not-an-email');
    expect(form.errors.value.email).toBe('Invalid email');
    expect(form.isValid.value).toBe(false);
  });

  it('errors clear when the field passes validation', () => {
    const form = createFormBus({ fields: { email: '' }, rules });
    form.set('email', 'bad');
    expect(form.isValid.value).toBe(false);
    form.set('email', 'good@example.com');
    expect(form.errors.value.email).toBeUndefined();
    expect(form.isValid.value).toBe(true);
  });

  it('submit() returns false and populates all errors when invalid', async () => {
    const onSubmit = vi.fn();
    const form = createFormBus({ fields: { email: '', password: '' }, rules, onSubmit });
    const ok = await form.submit();
    expect(ok).toBe(false);
    expect(form.errors.value.email).toBeDefined();
    expect(form.errors.value.password).toBeDefined();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submit() calls onSubmit with values when valid', async () => {
    const onSubmit = vi.fn();
    const form = createFormBus({
      fields: { email: '', password: '' },
      rules,
      onSubmit,
    });
    form.set('email', 'user@example.com');
    form.set('password', 'supersecret');
    const ok = await form.submit();
    expect(ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({ email: 'user@example.com', password: 'supersecret' });
  });

  it('submit() touches all fields on failure so errors are visible', async () => {
    const form = createFormBus({ fields: { email: '', password: '' }, rules });
    await form.submit();
    expect(form.touched.value.email).toBe(true);
    expect(form.touched.value.password).toBe(true);
  });

  it('isSubmitting is false before and after submit()', async () => {
    const form = createFormBus({
      fields: { email: 'a@b.com', password: '12345678' },
      rules,
      onSubmit: async () => {},
    });
    expect(form.isSubmitting.value).toBe(false);
    await form.submit();
    expect(form.isSubmitting.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Plugin integration
// ---------------------------------------------------------------------------

describe('createFormBus — plugin integration', () => {
  it('plugins receive formSet commands', () => {
    const intercepted: string[] = [];
    const spy = (cmd: any, next: any) => {
      intercepted.push(cmd.action);
      return next();
    };
    const form = createFormBus({ fields: { name: '' } });
    form.use(spy);
    form.set('name', 'Alice');
    expect(intercepted).toContain('formSet');
  });

  it('accepts logger plugin without throwing', () => {
    const form = createFormBus({ fields: { x: '' } });
    expect(() => form.use(logger({ collapsed: true }))).not.toThrow();
    form.set('x', 'hello');
    form.reset();
  });

  it('exposes the underlying bus', () => {
    const form = createFormBus({ fields: { x: '' } });
    expect(form.bus).toBeDefined();
    expect(typeof form.bus.dispatch).toBe('function');
  });

  // -- reactive: false (headless/SSR mode) ----------------------------------

  describe('reactive: false (headless mode)', () => {
    it('works with plain get/set wrappers instead of Vue signals', () => {
      const form = createFormBus({ fields: { email: '', name: '' }, reactive: false });
      expect(form.values.value).toEqual({ email: '', name: '' });

      form.set('email', 'test@example.com');
      expect(form.values.value.email).toBe('test@example.com');
      expect(form.isDirty.value).toBe(true);
    });

    it('validation still works in headless mode', () => {
      const form = createFormBus({
        fields: { age: 0 },
        rules: { age: (v) => v >= 18 ? null : 'Too young' },
        reactive: false,
      });

      form.set('age', 10);
      expect(form.isValid.value).toBe(false);
      expect(form.errors.value.age).toBe('Too young');

      form.set('age', 21);
      expect(form.isValid.value).toBe(true);
    });

    it('submit works in headless mode', async () => {
      const onSubmit = vi.fn();
      const form = createFormBus({
        fields: { x: 'ok' },
        onSubmit,
        reactive: false,
      });

      const result = await form.submit();
      expect(result).toBe(true);
      expect(onSubmit).toHaveBeenCalledWith({ x: 'ok' });
    });

    it('reset restores initial values in headless mode', () => {
      const form = createFormBus({ fields: { a: 1 }, reactive: false });
      form.set('a', 99);
      expect(form.values.value.a).toBe(99);

      form.reset();
      expect(form.values.value.a).toBe(1);
      expect(form.isDirty.value).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createFormBus — bus injection
// ---------------------------------------------------------------------------

describe('createFormBus — bus injection', () => {
  it('uses injected bus instead of creating an isolated one', () => {
    const sharedBus = createCommandBus();
    const seen: string[] = [];
    sharedBus.onAfter((cmd) => seen.push(cmd.action));

    const form = createFormBus({ fields: { name: '' }, bus: sharedBus });
    form.set('name', 'Alice');

    expect(seen).toContain('formSet');
  });

  it('form commands visible to plugins on injected bus', () => {
    const sharedBus = createCommandBus();
    const entries: Array<{ action: string }> = [];
    sharedBus.use((cmd, next) => {
      entries.push({ action: cmd.action });
      return next();
    });

    const form = createFormBus({ fields: { x: 0 }, bus: sharedBus });
    form.set('x', 42);
    form.reset();

    expect(entries.map(e => e.action)).toEqual(['formSet', 'formReset']);
  });

  it('creates isolated bus by default (backward compat)', () => {
    const sharedBus = createCommandBus();
    const seen: string[] = [];
    sharedBus.onAfter((cmd) => seen.push(cmd.action));

    const form = createFormBus({ fields: { y: '' } });
    form.set('y', 'test');

    // sharedBus should NOT see form commands — isolated by default
    expect(seen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// submit() races — `values` is live state, and submit() used to read it twice
// across an await.
// ---------------------------------------------------------------------------

describe('createFormBus — submit() races', () => {
  it('validates and submits the SAME values when a set() lands mid-validation', async () => {
    // set() also runs the rules (live per-field feedback), so every invocation
    // parks — collect all the resolvers and release them together.
    const releases: Array<() => void> = [];
    const validated: string[] = [];
    const submitted: string[] = [];

    const form = createFormBus({
      fields: { email: 'valid@example.com' },
      rules: {
        // The module's own pitch for concurrent rules: a slow server-side check.
        email: async (value: string) => {
          validated.push(value);
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          return null;
        },
      },
      onSubmit: async (values) => {
        submitted.push((values as { email: string }).email);
      },
    });

    const pending = form.submit();
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));

    form.set('email', 'changed-after-validation@example.com'); // lands mid-flight
    for (const release of releases) release();
    await pending;

    expect(validated[0]).toBe('valid@example.com');
    // Was 'changed-after-validation@example.com': the value submitted had
    // never been validated, and the value validated was never submitted.
    expect(submitted).toEqual(['valid@example.com']);
  });

  it('a double-click does not run two overlapping submits', async () => {
    let releaseSubmit: (() => void) | null = null;
    let calls = 0;

    const form = createFormBus({
      fields: { name: 'Alice' },
      onSubmit: async () => {
        calls++;
        await new Promise<void>((resolve) => {
          releaseSubmit = resolve;
        });
      },
    });

    const first = form.submit();
    await vi.waitFor(() => expect(releaseSubmit).not.toBeNull());
    const second = await form.submit(); // the second click

    expect(second).toBe(false); // refused, not queued behind the first
    expect(calls).toBe(1);
    expect(form.isSubmitting.value).toBe(true); // still owned by the first call

    releaseSubmit?.();
    expect(await first).toBe(true);
    expect(form.isSubmitting.value).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formValidate — the internal sync-validation command (dispatchable directly,
// e.g. from a plugin or a toolbar's "check form" affordance)
// ---------------------------------------------------------------------------

describe('formValidate internal command', () => {
  it('touches every field, records sync errors, and reports validity', () => {
    const form = createFormBus({
      fields: { email: '', age: '' },
      rules: {
        email: (v) => (v.includes('@') ? null : 'Invalid email'),
        age: (v) => (v.length > 0 ? null : 'Required'),
      },
    });

    const result = form.bus.dispatch('formValidate', {});

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      valid: false,
      errors: { email: 'Invalid email', age: 'Required' },
    });
    // All fields touched so errors become visible in the UI
    expect(form.touched.value).toEqual({ email: true, age: true });
    expect(form.isValid.value).toBe(false);
    expect(form.errors.value).toEqual({ email: 'Invalid email', age: 'Required' });
  });

  it('reports valid: true and clears errors once fields pass', () => {
    const form = createFormBus({
      fields: { email: '' },
      rules: { email: (v) => (v.includes('@') ? null : 'Invalid email') },
    });
    form.set('email', 'a@b.com');

    const result = form.bus.dispatch('formValidate', {});

    expect(result.value).toEqual({ valid: true, errors: {} });
    expect(form.isValid.value).toBe(true);
  });
});

describe('rule/values mismatch and optional onSubmit', () => {
  it('a rule for a key not present in fields is skipped by sync and async validation', async () => {
    const form = createFormBus({
      fields: { email: 'a@b.com' },
      // `ghost` has a rule but no field — must be ignored, not crash or error
      rules: { email: (v) => (v.includes('@') ? null : 'bad'), ghost: () => 'never' } as never,
    });
    form.set('email', 'x@y.z'); // live sync validation path
    expect(form.errors.value).toEqual({});
    const ok = await form.submit(); // async validation path
    expect(ok).toBe(true);
    expect(form.errors.value).toEqual({});
  });

  it('submit() without an onSubmit resolves true after validation alone', async () => {
    const form = createFormBus({ fields: { name: 'x' } });
    await expect(form.submit()).resolves.toBe(true);
    expect(form.isSubmitting.value).toBe(false);
  });
});
