/** Schema keys: the camelCase name the bus validates is a typed name too; a raw one still compiles and warns in development (log s35.175). Two keys with one camel name throw at creation (D13 G8). Rationale at the end. */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createAsyncSchemaCommandBus, createSchemaCommandBus, ERROR_CODE_REGISTRY, type InferMap } from '../src/schema';
import { stubEnv } from '../src/vitest-pure';

afterEach(() => vi.restoreAllMocks());

const schema = { cart_add: { target: { id: 'number' } }, 'user.get': { target: {} }, cartClear: { target: {} } } as const;
const warnings = () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return () => warn.mock.calls.map((c) => String(c[0]));
};

describe('types', () => {
  it('InferMap has the camelCase name, and keeps the raw one', () => {
    type M = InferMap<typeof schema>;
    expectTypeOf<M['cartAdd']['target']['id']>().toEqualTypeOf<number>();
    expectTypeOf<M['userGet']>().not.toBeNever();
    expectTypeOf<M['cart_add']['target']['id']>().toEqualTypeOf<number>();
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

/*
 * normalizeSchema camel-cases every key at run time (`cart_add` becomes
 * `cartAdd`), but InferMap typed the bus with the raw keys. The typed code
 * registered and dispatched `cart_add`, which the validator, getSchema and
 * MCP know as `cartAdd`: validation was skipped, and MCP listed a tool the
 * code never registered (audit B12, probe P11). InferMap now carries each
 * key's camelCase name too (ToCamel, toCamel's rules at the type level), so
 * the name that validates is typed, and the raw name still compiles (1.26 code).
 * The one warning stays where the rename happens, at bus creation, and now
 * says to register and dispatch the camel name. It printed in production
 * and is DEV-only now. No register wrapper: one fact, one place. Log s35.175.
 */
