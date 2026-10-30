/**
 * FormBus's accessibility facts on real elements: an input bound to form.aria(field), a message with form.errorId(field).
 * Why: assistive technology must read an invalid textbox described by the server's message (WCAG 3.3.1, 4.1.2); Playwright's role engine is the reader.
 * Shows: no aria-invalid before an error; a server error makes the field invalid and described by its message; editing the field clears it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createFormBus } from '../../src/form';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('FormBus errors as assistive technology reads them (real Chromium)', () => {
  it('a server error makes the field invalid and describes it with the message', async () => {
    const form = createFormBus({ fields: { email: '' } });
    const label = document.createElement('label');
    label.htmlFor = 'email';
    label.textContent = 'Email';
    const input = document.createElement('input');
    input.id = 'email';
    const message = document.createElement('p');
    message.id = form.errorId('email');
    document.body.append(label, input, message);

    const bind = () => {
      for (const [k, v] of Object.entries(form.aria('email'))) {
        if (v === undefined) input.removeAttribute(k);
        else input.setAttribute(k, v);
      }
      message.textContent = form.aria('email')['aria-invalid'] ? (form.errors.value.email ?? '') : '';
    };

    bind();
    await expect.element(page.getByRole('textbox', { name: 'Email' })).not.toHaveAttribute('aria-invalid');

    form.setErrors([{ pointer: '/payload/email', detail: 'The email has already been taken.' }]);
    bind();
    const field = page.getByRole('textbox', { name: 'Email' });
    await expect.element(field).toHaveAttribute('aria-invalid', 'true');
    await expect.element(field).toHaveAccessibleDescription('The email has already been taken.');

    form.set('email', 'other@example.com');
    bind();
    await expect.element(field).not.toHaveAttribute('aria-invalid');
  });
});
