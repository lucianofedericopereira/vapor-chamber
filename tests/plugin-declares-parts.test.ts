/** A plugin declares its parts and the bus places them: no part holds `next`. The long note is at the end. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { type BaseBus, type PluginParts, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { authGuard, logger, validator } from '../src/plugins-core';
import { cache, circuitBreaker, idempotent, metrics, rateLimit, supersede } from '../src/plugins-extra';
import { validateSchemas, validateSchemasAsync } from '../src/plugins-schema';
import { schemaLogger, schemaValidator } from '../src/schema';
import { createTestBus } from '../src/testing';

const PARTS = ['started', 'settled', 'authorize', 'validate', 'reuse', 'admit', 'begin', 'attach'] as const;
/** Every built-in plugin, each with the parts it declares. */
const BUILT_INS: Array<[string, () => PluginParts, readonly string[]]> = [
  ['logger', () => logger(), ['settled']],
  ['schemaLogger', () => schemaLogger({}), ['settled']],
  ['metrics', () => metrics(), ['started', 'settled']],
  ['validator', () => validator({}), ['validate']],
  ['schemaValidator', () => schemaValidator({}), ['validate']],
  ['validateSchemas', () => validateSchemas({}), ['validate']],
  ['validateSchemasAsync', () => validateSchemasAsync({}), ['validate']],
  ['authGuard', () => authGuard({ isAuthenticated: () => true, protected: [] }), ['authorize']],
  ['cache', () => cache(), ['reuse', 'begin', 'attach']],
  ['idempotent', () => idempotent(), ['reuse', 'begin']],
  ['rateLimit', () => rateLimit(), ['admit', 'begin']],
  ['circuitBreaker', () => circuitBreaker(), ['admit', 'begin']],
  ['supersede', () => supersede(), ['begin', 'attach']],
];
const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus({ retry: false })],
  ['test', () => createTestBus()],
];

describe('a plugin declares its parts', () => {
  it.each(BUILT_INS)('%s is a parts object, never a function', (_name, make, parts) => {
    const plugin = make();
    expect(typeof plugin).toBe('object');
    expect(PARTS.filter((p) => typeof plugin[p] === 'function')).toEqual(parts);
  });

  it.each(BUSES)('the %s bus refuses a function, and an object with no part', (_name, make) => {
    const bus = make();
    const code = (f: () => unknown) => { try { f(); return 'no throw'; } catch (e) { return (e as { code?: string }).code; } };
    expect(code(() => bus.use(((_c: unknown, next: () => unknown) => next()) as never))).toBe('core:invalid:plugin');
    expect(code(() => bus.use({ id: 'empty' } as never))).toBe('core:invalid:plugin');
    // Control: each part alone is a plugin.
    for (const p of PARTS) expect(code(() => bus.use({ [p]: () => undefined } as PluginParts))).toBe('no throw');
  });

  it('no part takes next: each one is called with the command (or the action), never a continuation', () => {
    expectTypeOf<Parameters<NonNullable<PluginParts['reuse']>>>().toEqualTypeOf<[cmd: import('../src/command-bus').Command]>();
    expectTypeOf<Parameters<NonNullable<PluginParts['begin']>>>().toEqualTypeOf<[cmd: import('../src/command-bus').Command]>();
    expectTypeOf<Parameters<NonNullable<PluginParts['started']>>>().toEqualTypeOf<[cmd: import('../src/command-bus').Command]>();
    expectTypeOf<Parameters<NonNullable<PluginParts['authorize']>>>().toEqualTypeOf<[action: string]>();
  });
});

/*
 * Plan 1.32 step 1 left one acceptance row for its step 8: "a plugin declares
 * its parts" (log 36.43, its API decided at step 8). Plan 2's one decision is
 * that no extension holds `next`: the bus owns the flow, and each part has
 * the power its purpose needs and nothing more (plan-transport-owned.md
 * revision 20). So every built-in is an object of parts the bus places, and
 * `use()` refuses a function (a chain level) or an object that declares
 * nothing to place. The types say no part is handed a continuation.
 * Step 8d (log 36.108) removed the chain, its runners and `priority`.
 */
