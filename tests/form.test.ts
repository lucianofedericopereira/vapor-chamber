import { describe, it, expect, vi } from 'vitest';
import { createFormBus } from '../src/form';
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
