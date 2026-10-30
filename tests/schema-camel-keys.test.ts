/**
 * Schema keys: the camelCase name the bus validates is the typed name, and two keys with one camel name are refused.
 * Why: if the typed name differed from the run-time name, typed code would register a name the validator and MCP do not know, so validation would be skipped; a lost key definition would go unnoticed.
 * Shows: InferMap has the camel names only; a raw key validates under its camel name; development warns once per raw key at creation and production does not; colliding keys throw schema:already:action on both buses in development and production, naming both keys, and the code is catalogued.
 * See: log s35.175
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createAsyncSchemaCommandBus, createSchemaCommandBus, type InferMap } from '../src/schema';
import { ERROR_CODE_REGISTRY } from '../src/error-registry';
import { stubEnv } from '../src/vitest-pure';

afterEach(() => vi.restoreAllMocks());

const schema = { cart_add: { target: { id: 'number' } }, 'user.get': { target: {} }, cartClear: { target: {} } } as const;
const warnings = () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => warn.mock.calls.map((c) => String(c[0]));
};

describe('types', () => {
  it('InferMap has the camelCase name only', () => {
    type M = InferMap<typeof schema>;
    expectTypeOf<M['cartAdd']['target']['id']>().toEqualTypeOf<number>();
    expectTypeOf<M['userGet']>().not.toBeNever();
    expectTypeOf<keyof M>().toEqualTypeOf<'cartAdd' | 'userGet' | 'cartClear'>();
    expectTypeOf<M['cartClear']>().not.toBeNever();
  });
});

describe('runtime', () => {
  it('the camel name is typed, and it validates', () => {
    const bus = createSchemaCommandBus(schema);
    bus.register('cartAdd', () => 'ran');
    expect(bus.dispatch('cartAdd', { id: 'nope' } as never).ok).toBe(false);
    expect(bus.dispatch('cartAdd', { id: 1 }).ok).toBe(true);
  });

  it('in development the one warning, at creation, says to register and dispatch the camel name', () => {
    const seen = warnings();
    createSchemaCommandBus(schema);
    expect(seen()).toEqual([
      expect.stringContaining('Schema key "cart_add" is "cartAdd" on the bus: register and dispatch it as "cartAdd"'),
      expect.stringContaining('Schema key "user.get" is "userGet" on the bus'),
    ]);
  });

  it('control: a camelCase schema warns about nothing', () => {
    const seen = warnings();
    createSchemaCommandBus({ cartAdd: { target: {} } });
    expect(seen()).toEqual([]);
  });

  it('production: no warning', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const seen = warnings();
    const { createSchemaCommandBus: make } = await import('../src/schema');
    make(schema);
    expect(seen()).toEqual([]);
    vi.resetModules();
  });
});

describe('two keys, one camel name', () => {
  const colliding = { 'cart.add': { target: { id: 'number' } }, cart_add: { target: { id: 'string' } } } as const;
  const thrown = (f: () => unknown): { code?: string; message?: string } | 'no throw' => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { f(); } catch (e) { return e as { code?: string; message?: string }; }
    return 'no throw';
  };

  it('the sync schema bus throws at creation, naming both keys and the name', () => {
    const e = thrown(() => createSchemaCommandBus(colliding));
    expect(e).toMatchObject({ code: 'schema:already:action' });
    expect((e as { message: string }).message).toContain('"cart.add" and "cart_add"');
    expect((e as { message: string }).message).toContain('"cartAdd"');
  });

  it('the async schema bus throws the same', () => {
    expect(thrown(() => createAsyncSchemaCommandBus(colliding))).toMatchObject({ code: 'schema:already:action' });
  });

  it('a raw key and its camel name collide too', () => {
    expect(thrown(() => createSchemaCommandBus({ cartAdd: { target: {} }, cart_add: { target: {} } }))).toMatchObject({ code: 'schema:already:action' });
  });

  it('control: keys with distinct camel names do not throw', () => {
    expect(thrown(() => createSchemaCommandBus(schema))).toBe('no throw');
  });

  it('production throws too: a lost definition is not a development hint', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { createSchemaCommandBus: make } = await import('../src/schema');
    expect(thrown(() => make(colliding))).toMatchObject({ code: 'schema:already:action' });
    vi.resetModules();
  });

  it('the code is catalogued', () => {
    expect(ERROR_CODE_REGISTRY.some((e) => e.code === 'schema:already:action')).toBe(true);
  });
});
