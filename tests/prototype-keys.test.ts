/**
 * The prototype-key invariant outside the router: commandKey, plugin maps keyed by action name, and form rules.
 * Why: a string from outside (a parsed response, an MCP tool name) must never be a key on, or a lookup in, an object inheriting from Object.prototype; otherwise distinct commands would collapse into one key and an action named `toString` would throw out of dispatch.
 * Shows: an own `__proto__` key stays in the command key; inherited member names are not run as validator rules or schemas and dispatch normally; a form rule for an absent field named `toString` is skipped while present fields still validate; a form's own __proto__ field keeps its server error across a set.
 * See: src/dict.ts
 */

import { describe, expect } from 'vitest';
import { commandKey } from '../src/command-bus';
import { createFormBus } from '../src/form';
import { validator } from '../src/plugins-core';
import { validateSchemas, validateSchemasAsync } from '../src/plugins-schema';
import { it } from '../src/vitest';

describe('commandKey - an own __proto__ key must not be swallowed', () => {
  // `JSON.parse` produces an own `__proto__` property, as a parsed server response would.
  const a = JSON.parse('{"__proto__":"A","id":1}');
  const b = JSON.parse('{"__proto__":"B","id":1}');

  it('gives different targets different keys', () => {
    expect(Object.hasOwn(a, '__proto__')).toBe(true);
    // The key backs idempotent, cache and supersede: equal keys would merge two distinct commands.
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

describe('plugin maps keyed by action name', () => {
  // Action names that match Object.prototype members; a plugin must not react to a rule or schema it was never given.
  const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

  it('validator() does not run an inherited member as a rule', ({ bus }) => {
    bus.use(validator({ real: () => 'nope' }));
    for (const action of INHERITED) {
      bus.register(action, () => 'ran');
      const result = bus.dispatch(action, {});
      expect(result.ok, `${action} should reach its handler`).toBe(true);
      expect(result.value).toBe('ran');
    }
    bus.register('real', () => 'ran');
    expect(bus.dispatch('real', {}).ok).toBe(false);
  });

  it('validateSchemas() does not validate against an inherited member', ({ bus }) => {
    bus.use(validateSchemas({ real: { '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ message: 'bad' }] }) } } } as never));
    for (const action of INHERITED) {
      bus.register(action, () => 'ran');
      // dispatch always returns a result: an inherited function must not be read as a schema.
      const result = bus.dispatch(action, {});
      expect(result.ok, `${action} should dispatch normally`).toBe(true);
      expect(result.value).toBe('ran');
    }
    bus.register('real', () => 'ran');
    expect(bus.dispatch('real', {})).toFailWith('validateSchemas:invalid:payload');
  });

  it('validateSchemasAsync() does not validate against an inherited member', async ({ asyncBus: bus }) => {
    bus.use(validateSchemasAsync({ real: { '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ message: 'bad' }] }) } } } as never));
    for (const action of INHERITED) {
      bus.register(action, async () => 'ran');
      const result = await bus.dispatch(action, {});
      expect(result.ok, `${action} should dispatch normally`).toBe(true);
      expect(result.value).toBe('ran');
    }
    bus.register('real', async () => 'ran');
    expect((await bus.dispatch('real', {}))).toFailWith('validateSchemas:invalid:payload');
  });
});

describe('form rules - absent fields named after Object.prototype members', () => {
  it('skips a rule whose field is not actually present', async () => {
    let sawToString = false;
    const form = createFormBus({
      fields: { name: '' } as Record<string, unknown>,
      rules: {
        // A rule for a field the form does not have; `'toString' in values` is true through the prototype.
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

describe('createFormBus - an own __proto__ field keeps its server error', () => {
  it('stays an own error key across a set, and the form reads invalid', () => {
    const form = createFormBus({ fields: JSON.parse('{"__proto__":"","name":""}') as Record<string, string> });
    form.setErrors([{ pointer: '/payload/__proto__', detail: 'refused' }]);
    form.set('name', 'x');
    const errors = form.errors.value;
    expect(Object.hasOwn(errors, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(errors, '__proto__')?.value).toBe('refused');
    expect(Object.getPrototypeOf(errors)).toBe(Object.prototype);
    expect(form.isValid.value).toBe(false);
    form.dispose();
  });

  it('an enumerable key on Object.prototype does not read as an error', () => {
    const form = createFormBus({ fields: { name: '' } });
    let valid = false;
    Object.defineProperty(Object.prototype, 'polluted', { value: 1, enumerable: true, configurable: true });
    try {
      form.set('name', 'x');
      valid = form.isValid.value;
    } finally {
      // Before any expect: it walks objects with the same for...in.
      delete (Object.prototype as Record<string, unknown>).polluted;
      form.dispose();
    }
    expect(valid).toBe(true);
  });
});
