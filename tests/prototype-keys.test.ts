/**
 * The prototype-key invariant, pinned outside the router.
 *
 * One rule (see src/dict.ts): a string that came from outside must never be a
 * key on - or a lookup in - an object inheriting from Object.prototype. This
 * file pins the two non-router sites where breaking it had consequences.
 *
 * Both assertions below were verified to FAIL against the pre-fix code.
 */

import { describe, expect, it } from 'vitest';
import { commandKey } from '../src/command-bus';
import { createFormBus } from '../src/form';

describe('commandKey - an own __proto__ key must not be swallowed', () => {
  // `JSON.parse` produces an OWN `__proto__` property; an HTTP bridge handing a
  // parsed server response to dispatch is the realistic path here.
  const a = JSON.parse('{"__proto__":"A","id":1}');
  const b = JSON.parse('{"__proto__":"B","id":1}');

  it('gives different targets different keys', () => {
    expect(Object.hasOwn(a, '__proto__')).toBe(true);
    // Pre-fix both produced `act:{"id":1}` - the key backing idempotent, cache,
    // serialize and supersede, so two distinct commands collapsed into one.
    expect(commandKey('act', a)).not.toBe(commandKey('act', b));
  });

  it('keeps the key in the serialization', () => {
    expect(commandKey('act', a)).toContain('__proto__');
  });

  it('is still order-independent and stable for ordinary targets', () => {
    expect(commandKey('act', { b: 2, a: 1 })).toBe(commandKey('act', { a: 1, b: 2 }));
    expect(commandKey('act', { q: { page: 2 } })).not.toBe(commandKey('act', { q: { page: 3 } }));
    expect(commandKey('act', 'plain')).toBe('act:plain');
    expect(commandKey('act', null)).toBe('act:null');
  });
});

describe('form rules - absent fields named after Object.prototype members', () => {
  it('skips a rule whose field is not actually present', async () => {
    let sawToString = false;
    const form = createFormBus({
      fields: { name: '' } as Record<string, unknown>,
      rules: {
        // A rule for a field the form does not have. Pre-fix, `'toString' in
        // values` was true, so the rule ran against the inherited function.
        toString: (v: unknown) => {
          sawToString = true;
          return typeof v === 'function' ? 'validated a function' : null;
        },
      } as never,
    });

    await form.submit();
    expect(sawToString).toBe(false);
  });

  it('still runs rules for fields that are present', async () => {
    let ran = false;
    const form = createFormBus({
      fields: { name: '' },
      rules: { name: () => { ran = true; return 'required'; } },
    });
    await form.submit();
    expect(ran).toBe(true);
    expect(form.errors.value.name).toBe('required');
  });
});
