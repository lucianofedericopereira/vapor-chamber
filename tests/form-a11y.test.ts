/**
 * FormBus: errors from outside its rules, and the accessibility facts per field.
 *
 * Most real form errors come from the server, not from client rules. A 422
 * problem carries them as `errors: [{ pointer, detail }]`, the pointer into the
 * envelope the client sent (`/payload/<field>`, RFC 6901): the wire contract's
 * one shape (docs/plan-failures-and-contract.md 4.4); the backend localizes the
 * messages and converts its own field map to pointers. So what to say and which field it is
 * about are DATA: the form shows them, and exposes what an element needs to
 * make them accessible (WCAG 3.3.1 errors identify the field, 4.1.2 state is
 * exposed): `aria-invalid`, `aria-describedby` pointing at the message, and the
 * first invalid field to focus after a failed submit.
 * docs/plan-failures-and-contract.md, section 8e.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createHttpBridge } from '../src/transports';
import { createFormBus } from '../src/form';

const fields = { email: '', name: '', 'address.city': '' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('FormBus - errors from outside its rules', () => {
  it('takes a problem\'s errors: a pointer into the payload, nested segments as a dotted field', () => {
    const form = createFormBus({ fields });
    form.setErrors([
      { pointer: '/payload/email', detail: 'The email field must be a valid email address.' },
      { pointer: '/payload/address/city', detail: 'The city is required.' },
    ]);
    expect(form.errors.value).toEqual({
      email: 'The email field must be a valid email address.',
      'address.city': 'The city is required.',
    });
    expect(form.isValid.value).toBe(false);
  });

  it('one spelling: the first per field wins; outside the payload or to no field is dropped', () => {
    const form = createFormBus({ fields });
    form.setErrors([
      { pointer: '/payload/name', detail: 'Name is taken.' },
      { pointer: '/payload/name', detail: 'a second one' },  // same field again: the first wins
      { pointer: '/payload/nickname', detail: 'no such field' },
      { pointer: '/name', detail: 'not into the payload' },
      { pointer: '#/payload/name', detail: 'a URI fragment, not the contract\'s spelling' },
    ]);
    expect(form.errors.value).toEqual({ name: 'Name is taken.' });
  });

  it('unescapes RFC 6901: ~1 is a slash and ~0 a tilde in a field name', () => {
    const form = createFormBus({ fields: { 'a/b': '', 'c~d': '' } });
    form.setErrors([{ pointer: '/payload/a~1b', detail: 'slash' }, { pointer: '/payload/c~0d', detail: 'tilde' }]);
    expect(form.errors.value).toEqual({ 'a/b': 'slash', 'c~d': 'tilde' });
  });

  it('clears an outside error when ITS field changes, and keeps the others', () => {
    const form = createFormBus({ fields });
    form.setErrors([{ pointer: '/payload/email', detail: 'taken' }, { pointer: '/payload/name', detail: 'required' }]);
    form.set('email', 'new@example.com');
    expect(form.errors.value).toEqual({ name: 'required' });
  });

  it('a rule still applies once the outside error is gone', () => {
    const form = createFormBus({ fields, rules: { email: (v) => (v.includes('@') ? null : 'Invalid email') } });
    form.setErrors([{ pointer: '/payload/email', detail: 'taken' }]);
    form.set('email', 'nope');
    expect(form.errors.value).toEqual({ email: 'Invalid email' });
  });

  it('reset() clears outside errors too', () => {
    const form = createFormBus({ fields });
    form.setErrors([{ pointer: '/payload/email', detail: 'taken' }]);
    form.reset();
    expect(form.errors.value).toEqual({});
    expect(form.isValid.value).toBe(true);
  });

  it('submit() lands a backend problem\'s field errors on the fields and resolves false', async () => {
    // The real path: the command goes through the bridge, the backend answers a
    // 422 problem, and onSubmit throws the failure it got back.
    const problem = { status: 422, code: 'validation_failed', detail: 'The given data was invalid.',
      errors: [{ pointer: '/payload/email', detail: 'The email has already been taken.' }] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(problem), { status: 422, headers: { 'content-type': 'application/problem+json' } }));
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const form = createFormBus({
      fields,
      onSubmit: async (values) => { const r = await bus.dispatch('signup', {}, values); if (!r.ok) throw r.error; },
    });
    await expect(form.submit()).resolves.toBe(false);
    expect(form.errors.value).toEqual({ email: 'The email has already been taken.' });
  });

  it('any other failure from onSubmit still rejects, as before', async () => {
    const form = createFormBus({ fields, onSubmit: async () => { throw new Error('network down'); } });
    await expect(form.submit()).rejects.toThrow('network down');
  });
});

describe('FormBus - accessibility facts per field', () => {
  it('aria(field) marks a shown error invalid and points at its message', () => {
    const form = createFormBus({ fields });
    expect(form.aria('email')).toEqual({ 'aria-invalid': undefined, 'aria-describedby': undefined });
    form.setErrors([{ pointer: '/payload/email', detail: 'taken' }]);
    expect(form.aria('email')).toEqual({ 'aria-invalid': 'true', 'aria-describedby': form.errorId('email') });
  });

  it('a rule error is not announced before the field is touched', () => {
    const form = createFormBus({ fields, rules: { name: (v) => (v ? null : 'Required') } });
    form.set('name', '');
    expect(form.aria('name')['aria-invalid']).toBeUndefined();
    form.touch('name');
    expect(form.aria('name')['aria-invalid']).toBe('true');
  });

  it('errorId is stable per field and unique across forms (no duplicate ids on a page)', () => {
    const a = createFormBus({ fields });
    const b = createFormBus({ fields });
    expect(a.errorId('email')).toBe(a.errorId('email'));
    expect(a.errorId('email')).not.toBe(b.errorId('email'));
    expect(a.errorId('address.city')).toMatch(/^[A-Za-z][\w-]*$/); // a valid id, no dots
  });

  it('firstInvalid() names the first invalid field in declaration order', () => {
    const form = createFormBus({ fields });
    expect(form.firstInvalid()).toBeUndefined();
    form.setErrors([{ pointer: '/payload/address/city', detail: 'required' }, { pointer: '/payload/name', detail: 'required' }]);
    expect(form.firstInvalid()).toBe('name');
  });
});
