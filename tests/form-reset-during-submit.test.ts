/**
 * FormBus - reset() while submit() is still validating.
 *
 * submit() validates a snapshot and awaits the async rules. A reset() in that
 * window restored the initial values and cleared the errors, and then the
 * validation of the discarded snapshot was written over them: a pristine form
 * showed errors for values it no longer held and read invalid. When the
 * snapshot was valid, onSubmit then sent the values the user had discarded.
 *
 * A reset now cancels a submit that has not reached onSubmit: its validation
 * is dropped, onSubmit does not run, and submit() returns false. A submit
 * already in onSubmit is unchanged (first write wins: it may have been sent).
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
