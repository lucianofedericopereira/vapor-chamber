/**
 * FormBus.setErrors with server pointers, and the per-field aria facts (aria, errorId, firstInvalid).
 * Why: server errors arrive as `/payload/<field>` pointers; if they land on the wrong field, or a field lacks aria-invalid, aria-describedby or a unique error id, users and assistive tech cannot tell which field failed.
 * Shows: pointers map to (dotted) fields with the first per field winning and foreign pointers dropped, RFC 6901 escapes decode, outside errors clear on field change and reset, a 422 problem from submit() lands on fields, aria/errorId/firstInvalid report as expected.
 * See: docs/contract.md, docs/accessibility.md, RFC 6901, log 36.F42.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { httpTransport } from '../src/transports';
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
      { pointer: '/payload/name', detail: 'a second one' },
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
    // Real path: bus -> httpTransport -> 422 problem; onSubmit throws the failure it got back.
    const problem = { status: 422, code: 'validation_failed', detail: 'The given data was invalid.',
      errors: [{ pointer: '/payload/email', detail: 'The email has already been taken.' }] };
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(problem), { status: 422, headers: { 'content-type': 'application/problem+json' } }));
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
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
