/**
 * The prototype-key invariant, pinned outside the router.
 *
 * One rule (see src/dict.ts): a string that came from outside must never be a
 * key on - or a lookup in - an object inheriting from Object.prototype. This
 * file pins the two non-router sites where breaking it had consequences.
 *
 * Both assertions below were verified to FAIL against the pre-fix code.
 */

import { describe, expect } from 'vitest';
import { commandKey } from '../src/command-bus';
import { createFormBus } from '../src/form';
import { optimistic, validator } from '../src/plugins-core';
import { validateSchemas, validateSchemasAsync } from '../src/plugins-schema';
import { it } from '../src/vitest';

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

/**
 * The plugin layer takes user-authored maps keyed by ACTION NAME and looks them
 * up with `cmd.action` - a string that came from outside. Same rule, four more
 * sites. `mcp.ts` (tools/call) and the router's routes payload are the realistic
 * paths that put an arbitrary string in `cmd.action`.
 */
describe('plugin maps keyed by action name', () => {
  // An action that happens to be named after an Object.prototype member. Every
  // assertion below is about the plugin NOT reacting to a rule/schema/handler
  // it was never given.
  const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

  it('validator() does not run an inherited member as a rule', ({ bus }) => {
    bus.use(validator({ real: () => 'nope' }));
    for (const action of INHERITED) {
      bus.register(action, () => 'ran');
      const result = bus.dispatch(action, {});
      expect(result.ok, `${action} should reach its handler`).toBe(true);
      expect(result.value).toBe('ran');
    }
    // the declared rule still applies
    bus.register('real', () => 'ran');
    expect(bus.dispatch('real', {}).ok).toBe(false);
  });

  it('optimistic() does not treat an inherited member as a handler config', ({ bus }) => {
    bus.use(optimistic({ real: { apply: () => null } }));
    for (const action of INHERITED) {
      bus.register(action, () => 'ran');
      // Pre-fix `handlers['constructor']` was `Object`, whose `.apply` is
      // Function.prototype.apply - called as the optimistic `apply`.
      const result = bus.dispatch(action, {});
      expect(result.ok, `${action} should dispatch normally`).toBe(true);
      expect(result.value).toBe('ran');
    }
  });

  it('validateSchemas() does not validate against an inherited member', ({ bus }) => {
    bus.use(validateSchemas({ real: { '~standard': { version: 1, vendor: 't', validate: () => ({ issues: [{ message: 'bad' }] }) } } } as never));
    for (const action of INHERITED) {
      bus.register(action, () => 'ran');
      // Pre-fix `schemas['toString']` was a function, so the plugin read
      // `fn['~standard'].validate` and THREW out of dispatch - a documented
      // "always returns a result" contract broken by an action name.
      const result = bus.dispatch(action, {});
      expect(result.ok, `${action} should dispatch normally`).toBe(true);
      expect(result.value).toBe('ran');
    }
    bus.register('real', () => 'ran');
    expect(bus.dispatch('real', {})).toFailWith('VC_VALIDATION_FAILED');
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
    expect((await bus.dispatch('real', {}))).toFailWith('VC_VALIDATION_FAILED');
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
