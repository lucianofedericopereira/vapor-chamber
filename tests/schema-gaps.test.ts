/**
 * Supplemental coverage for src/schema.ts.
 *
 * `defineSchema` is the headline: an exported public API with no test calling
 * it at all — the identity helper every typed-bus consumer starts from.
 *
 * Also here:
 *  - toProps' absent-FieldMap guard (168) — an action with only a target, or
 *    only a payload.
 *  - schemaLogger's validated-payload arm and its result line (330, 335).
 *  - synthesize with a tool_use block carrying no `input` (397).
 *  - describeSchema for a bare action (no target/payload/description) and for
 *    a fully-specified one (409, 417-418).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  defineSchema,
  describeSchema,
  schemaLogger,
  synthesize,
  toAnthropicTools,
  createSchemaCommandBus,
} from '../src/schema';
import type { BusSchema } from '../src/schema';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// defineSchema (105-107)
// ---------------------------------------------------------------------------

describe('defineSchema', () => {
  it('returns the schema object it was given, by identity (106)', () => {
    const schema = {
      cartAdd: { description: 'Add an item', target: { id: 'number' }, payload: { qty: 'number' } },
    } as const;

    const defined = defineSchema(schema);
    expect(defined).toBe(schema); // identity helper — no copying, no mutation
  });

  it('feeds the rest of the schema surface unchanged', () => {
    const schema = defineSchema({ ping: { description: 'health check' } } as const);
    expect(toAnthropicTools(schema as unknown as BusSchema)[0]!.name).toBe('ping');
    expect(describeSchema(schema as unknown as BusSchema)).toContain('ping');
  });
});

// ---------------------------------------------------------------------------
// toProps — absent FieldMap (168)
// ---------------------------------------------------------------------------

describe('tool mapping with a partial action', () => {
  it('gives an empty properties object for an action with no target (168)', () => {
    const [tool] = toAnthropicTools({ save: { payload: { qty: 'number' } } } as unknown as BusSchema);
    expect(tool!.input_schema.properties.target).toBeUndefined();
    expect(tool!.input_schema.properties.payload).toEqual({
      type: 'object',
      properties: { qty: { type: 'number' } },
    });
  });

  it('gives an empty properties object for an action with no payload', () => {
    const [tool] = toAnthropicTools({ read: { target: { id: 'number' } } } as unknown as BusSchema);
    expect(tool!.input_schema.properties.payload).toBeUndefined();
    expect(tool!.input_schema.properties.target.properties.id).toEqual({ type: 'number' });
  });
});

// ---------------------------------------------------------------------------
// schemaLogger (313-338)
// ---------------------------------------------------------------------------

describe('schemaLogger', () => {
  it('validates and logs a schema-declared payload, then the result (330, 335)', () => {
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const schema = { cartAdd: { target: { id: 'number' }, payload: { qty: 'number' } } } as unknown as BusSchema;
    const bus = createSchemaCommandBus(schema as any);
    bus.use(schemaLogger(schema));
    bus.register('cartAdd', () => 'added');

    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(group).toHaveBeenCalledTimes(1);
    const lines = log.mock.calls.map(c => `${c[0]} ${JSON.stringify(c[1])} ${c[2] ?? ''}`);
    expect(lines.some(l => l.startsWith('payload:') && l.includes('✓'))).toBe(true);
    expect(lines.some(l => l.startsWith('result:'))).toBe(true);
  });

  it('flags a payload that violates the declared field types (330)', () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const schema = { cartAdd: { target: { id: 'number' }, payload: { qty: 'number' } } } as unknown as BusSchema;
    // Validator off — the logger is what reports here, so the dispatch lands.
    const bus = createSchemaCommandBus(schema as any, { validate: false } as any);
    bus.use(schemaLogger(schema));
    bus.register('cartAdd', () => 'added');

    bus.dispatch('cartAdd', { id: 1 }, { qty: 'not-a-number' });

    const payloadLine = log.mock.calls.find(c => c[0] === 'payload:');
    expect(String(payloadLine?.[2])).toContain('⚠');
  });

  it('logs the error branch of the result line (335)', () => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const schema = { boom: { target: { id: 'number' } } } as unknown as BusSchema;
    const bus = createSchemaCommandBus(schema as any);
    bus.use(schemaLogger(schema));
    bus.register('boom', () => { throw new Error('handler down'); });

    bus.dispatch('boom', { id: 1 });

    const resultLine = log.mock.calls.find(c => c[0] === 'result:');
    expect(String((resultLine?.[1] as Error)?.message)).toBe('handler down');
  });
});

// ---------------------------------------------------------------------------
// synthesize — tool_use with no input (397)
// ---------------------------------------------------------------------------

describe('synthesize', () => {
  const schema = { cartAdd: { target: { id: 'number' }, payload: { qty: 'number' } } } as unknown as BusSchema;

  it('defaults target to {} when the tool_use block carries no input (397)', async () => {
    const bus = { dispatch: vi.fn(() => ({ ok: true, value: 'dispatched' })) } as any;
    const adapter = vi.fn(async () => ({ name: 'cartAdd' })) as any; // no `input` key

    const result = await synthesize(schema, bus, 'add something', { adapter });

    expect(result.ok).toBe(true);
    expect(bus.dispatch).toHaveBeenCalledWith('cartAdd', {}, undefined);
  });

  it('passes target and payload through when present', async () => {
    const bus = { dispatch: vi.fn(() => ({ ok: true, value: 1 })) } as any;
    const adapter = vi.fn(async () => ({ name: 'cartAdd', input: { target: { id: 5 }, payload: { qty: 2 } } })) as any;

    await synthesize(schema, bus, 'add 2 of item 5', { adapter });
    expect(bus.dispatch).toHaveBeenCalledWith('cartAdd', { id: 5 }, { qty: 2 });
  });

  it('requires an adapter', async () => {
    const result = await synthesize(schema, { dispatch: vi.fn() } as any, 'hi');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('adapter is required');
  });
});

// ---------------------------------------------------------------------------
// describeSchema (405-421)
// ---------------------------------------------------------------------------

describe('describeSchema', () => {
  it('omits the signature and description for a bare action (409, 417-418)', () => {
    const text = describeSchema({ ping: {} } as unknown as BusSchema);
    expect(text).toBe('Available commands:\n- ping');
  });

  it('renders description and both field groups when declared', () => {
    const text = describeSchema({
      cartAdd: { description: 'Add an item', target: { id: 'number' }, payload: { qty: 'number' } },
    } as unknown as BusSchema);
    expect(text).toContain('- cartAdd: Add an item (target: id:number, payload: qty:number)');
  });

  it('renders a payload-only action', () => {
    const text = describeSchema({ save: { payload: { body: 'string' } } } as unknown as BusSchema);
    expect(text).toContain('- save (payload: body:string)');
  });
});
