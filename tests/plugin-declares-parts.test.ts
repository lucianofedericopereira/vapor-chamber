/**
 * A plugin is an object of parts the bus places, and no part holds `next`.
 * Why: if a plugin could be a function or an empty object, the bus would not know what to place and a plugin could own the flow instead of the bus.
 * Shows: every built-in plugin is an object declaring exactly its listed parts; sync, async and test buses refuse a function and an object with no part (`core:invalid:plugin`) and accept each part alone; the part types take the command (or the action), never a continuation.
 * See: log s36.43, s36.108
 */
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
    for (const p of PARTS) expect(code(() => bus.use({ [p]: () => undefined } as PluginParts))).toBe('no throw');
  });

  it('no part takes next: each one is called with the command (or the action), never a continuation', () => {
    expectTypeOf<Parameters<NonNullable<PluginParts['reuse']>>>().toEqualTypeOf<[cmd: import('../src/command-bus').Command]>();
    expectTypeOf<Parameters<NonNullable<PluginParts['begin']>>>().toEqualTypeOf<[cmd: import('../src/command-bus').Command]>();
    expectTypeOf<Parameters<NonNullable<PluginParts['started']>>>().toEqualTypeOf<[cmd: import('../src/command-bus').Command]>();
    expectTypeOf<Parameters<NonNullable<PluginParts['authorize']>>>().toEqualTypeOf<[action: string]>();
  });
});
