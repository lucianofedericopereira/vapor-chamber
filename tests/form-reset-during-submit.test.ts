/**
 * FormBus reset() while submit() is still validating async rules.
 * Why: submit() validates a snapshot; if its result were written after reset(), a pristine form would show errors for values it no longer holds, and onSubmit would send values the user discarded.
 * Shows: a reset before onSubmit starts drops the validation, never calls onSubmit and makes submit() resolve false; a plain submit sends; a reset after onSubmit started does not cancel it (it may already have been sent).
 */
import { describe, expect, it } from 'vitest';
import { createFormBus } from '../src/form';

const slowRequired = (v: string) => new Promise<string | null>((r) => setTimeout(() => r(v ? null : 'required'), 20));
const read = <T>(s: { value: T }) => s.value;

function form() {
  const sent: string[] = [];
  const f = createFormBus({ fields: { name: 'initial' }, rules: { name: slowRequired }, onSubmit: (v) => { sent.push(v.name); } });
  return { f, sent };
}

describe('FormBus - reset during submit', () => {
  it('drops the validation of the discarded values', async () => {
    const { f } = form();
    f.set('name', '');
    const p = f.submit();
    await new Promise((r) => setTimeout(r, 5));
    f.reset();
    expect(await p).toBe(false);
    expect(read(f.values)).toEqual({ name: 'initial' });
    expect(read(f.errors)).toEqual({});
    expect(read(f.isValid)).toBe(true);
    expect(read(f.isSubmitting)).toBe(false);
    expect(read(f.isValidating)).toBe(false);
  });

  it('does not send the discarded values', async () => {
    const { f, sent } = form();
    f.set('name', 'edited');
    const p = f.submit();
    await new Promise((r) => setTimeout(r, 5));
    f.reset();
    expect(await p).toBe(false);
    expect(sent).toEqual([]);
  });

  it('a submit with no reset is unchanged', async () => {
    const { f, sent } = form();
    f.set('name', 'edited');
    expect(await f.submit()).toBe(true);
    expect(sent).toEqual(['edited']);
  });

  it('a reset after onSubmit started does not cancel it', async () => {
    let release!: () => void;
    const sent: string[] = [];
    const f = createFormBus({ fields: { name: 'a' }, onSubmit: (v) => new Promise<void>((r) => { sent.push(v.name); release = r; }) });
    f.set('name', 'b');
    const p = f.submit();
    await new Promise((r) => setTimeout(r, 5));
    f.reset();
    release();
    expect(await p).toBe(true);
    expect(sent).toEqual(['b']);
  });
});
