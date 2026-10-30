/**
 * Schema layer: toTools, schemaLogger, schemaValidator, synthesize, describeSchema, createSchemaCommandBus.
 * Why: a wrong tool definition, or a validator that lets a malformed LLM call through, would hand handlers bad data.
 * Shows: tool definitions match the schema, bad target/payload shapes are rejected before the handler, validate: false skips the check, retry metadata follows the retry rule; an action with no fields asks for no validate step.
 * See: src/schema.ts, src/tool-schema.ts
 */

import { describe, expect, vi } from 'vitest';
import {
  toTools,
  toAnthropicTools,
  toOpenAITools,
  schemaLogger,
  schemaValidator,
  synthesize,
  describeSchema,
  createSchemaCommandBus,
  createAsyncSchemaCommandBus,
  type AnthropicTool,
  type BusSchema,
} from '../src/schema';
import { ERROR_CODE_REGISTRY, isRetryableCode } from '../src/error-registry';
import { RETRYABLE_CONDITIONS } from '../src/command-bus';
import { _failures, retryClass, type FailCode } from '../src/failure';
import { it } from '../src/vitest';


const cartSchema: BusSchema = {
  cartAdd: {
    description: 'Add item to cart',
    target: { id: 'number' },
    payload: { qty: 'number' },
  },
  cartClear: {
    description: 'Empty the cart',
    target: { force: 'boolean' },
  },
};

describe('toAnthropicTools', () => {
  it('converts schema to Anthropic tool definitions', () => {
    const tools = toAnthropicTools(cartSchema);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('cartAdd');
    expect(tools[0].description).toBe('Add item to cart');
    expect(tools[0].input_schema.type).toBe('object');
    // Typed fields are required, as in the MCP tool schema.
    expect(tools[0].input_schema.properties.target).toEqual({
      type: 'object', properties: { id: { type: 'number' } }, required: ['id'],
    });
    expect(tools[0].input_schema.properties.payload).toEqual({
      type: 'object', properties: { qty: { type: 'number' } }, required: ['qty'],
    });
    expect(tools[0].input_schema.required).toEqual(['target', 'payload']);
  });

  it('keeps target and payload as separate nested objects', () => {
    const tools = toAnthropicTools(cartSchema);
    const cartAdd = tools.find(t => t.name === 'cartAdd')!;

    expect(Object.keys(cartAdd.input_schema.properties)).toEqual(['target', 'payload']);
  });

  it('handles actions with no target or payload', () => {
    const schema: BusSchema = { ping: { description: 'Ping the bus' } };
    const tools = toAnthropicTools(schema);

    expect(tools[0].name).toBe('ping');
    expect(tools[0].input_schema.properties).toEqual({});
  });
});

describe('toOpenAITools', () => {
  it('wraps in function format', () => {
    const tools = toOpenAITools(cartSchema);

    expect(tools[0].type).toBe('function');
    expect(tools[0].function.name).toBe('cartAdd');
    expect(tools[0].function.description).toBe('Add item to cart');
    expect(tools[0].function.parameters.type).toBe('object');
  });
});

describe('toTools provider switch', () => {
  it('defaults to anthropic', () => {
    const tools = toTools(cartSchema) as any[];
    expect(tools[0]).toHaveProperty('input_schema');
  });

  it('returns openai format when requested', () => {
    const tools = toTools(cartSchema, 'openai') as any[];
    expect(tools[0]).toHaveProperty('function');
  });
});

describe('schemaLogger', () => {
  it('logs action with description', ({ bus }) => {
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema));
    bus.register('cartAdd', () => 'ok');
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(group).toHaveBeenCalledWith(expect.stringContaining('cartAdd'));
    expect(group).toHaveBeenCalledWith(expect.stringContaining('Add item to cart'));
  });

  it('validates target fields and marks ✓ when valid', ({ bus }) => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema));
    bus.register('cartAdd', () => null);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    const targetCall = log.mock.calls.find(c => c[0] === 'target:');
    expect(targetCall?.[2]).toBe('✓');
  });

  it('marks ⚠ when field is wrong type', ({ bus }) => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema));
    bus.register('cartAdd', () => null);
    bus.dispatch('cartAdd', { id: 'wrong-type' }, { qty: 2 });

    const targetCall = log.mock.calls.find(c => c[0] === 'target:');
    expect(targetCall?.[2]).toContain('⚠');
  });

  it('uses console.group when collapsed: false', ({ bus }) => {
    const group = vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema, { collapsed: false }));
    bus.register('cartAdd', () => null);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(group).toHaveBeenCalled();
  });
});

describe('synthesize', () => {
  // Adapter that returns one fixed tool call, standing in for the LLM.
  function makeAdapter(toolName: string, input: Record<string, any>) {
    return vi.fn(async (_tools: AnthropicTool[], _text: string) => ({ name: toolName, input }));
  }

  it('dispatches the tool selected by the LLM', async ({ bus }) => {
    const handler = vi.fn(() => 'added');
    bus.register('cartAdd', handler);

    const adapter = makeAdapter('cartAdd', { target: { id: 5 }, payload: { qty: 2 } });
    const result = await synthesize(cartSchema, bus, 'add 2 of item 5', { adapter });

    expect(result).toSucceedWith('added');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cartAdd', target: { id: 5 }, payload: { qty: 2 } })
    );
  });

  it('passes Anthropic tool definitions to the adapter', async ({ bus }) => {
    bus.register('cartClear', () => null);

    const adapter = makeAdapter('cartClear', { target: { force: true } });
    await synthesize(cartSchema, bus, 'clear my cart', { adapter });

    expect(adapter).toHaveBeenCalledTimes(1);
    const tools = adapter.mock.calls[0][0];
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('cartAdd');
    expect(tools[0].input_schema.properties.target).toBeDefined();
  });

  it('returns error when adapter is missing', async ({ bus }) => {
    const result = await synthesize(cartSchema, bus, 'anything');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('adapter');
  });

  it('returns error when adapter throws', async ({ bus }) => {
    const adapter = vi.fn(async () => { throw new Error('LLM returned 401: Unauthorized'); });

    const result = await synthesize(cartSchema, bus, 'test', { adapter });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('401');
  });

  it('returns error when adapter returns invalid result', async ({ bus }) => {
    const adapter = vi.fn(async () => ({ name: 'nonExistent', input: {} }));

    const result = await synthesize(cartSchema, bus, 'tell me a joke', { adapter });
    expect(result).toFailWith('core:missing:handler');
  });
});

describe('createSchemaCommandBus', () => {
  it('exposes toTools() on the bus', () => {
    const bus = createSchemaCommandBus(cartSchema);
    const tools = bus.toTools() as any[];

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('cartAdd');
  });

  it('exposes getSchema() returning normalized schema', () => {
    const bus = createSchemaCommandBus(cartSchema);
    expect(bus.getSchema()).toHaveProperty('cartAdd');
    expect(bus.getSchema()).toHaveProperty('cartClear');
  });

  it('normalizes non-camelCase keys', () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createSchemaCommandBus({ 'cart_add': { description: 'Add' } });
    expect(bus.getSchema()).toHaveProperty('cartAdd');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cart_add'));
  });

  it('dispatch works normally', () => {
    const bus = createSchemaCommandBus(cartSchema);
    bus.register('cartAdd', (cmd) => cmd.target.id * 10);

    const result = bus.dispatch('cartAdd', { id: 3 }, { qty: 1 });
    expect(result).toSucceedWith(30);
  });

  it('synthesize dispatches through the embedded bus', async () => {
    const bus = createSchemaCommandBus(cartSchema);
    const handler = vi.fn(() => 'cleared');
    bus.register('cartClear', handler);

    const adapter = vi.fn(async () => ({ name: 'cartClear', input: { target: { force: true } } }));

    const result = await bus.synthesize('clear the cart', { adapter });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });
});

describe('createAsyncSchemaCommandBus', () => {
  it('dispatch is async', async () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    bus.register('cartAdd', async (cmd) => cmd.target.id * 2);

    const result = await bus.dispatch('cartAdd', { id: 5 }, { qty: 1 });
    expect(result).toSucceedWith(10);
  });

  it('exposes toTools()', () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    const tools = bus.toTools() as any[];
    expect(tools[0].name).toBe('cartAdd');
  });

  it('synthesize dispatches through async bus', async () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    const handler = vi.fn(async () => 'async-added');
    bus.register('cartAdd', handler);

    const adapter = vi.fn(async () => ({ name: 'cartAdd', input: { target: { id: 3 }, payload: { qty: 1 } } }));

    const result = await bus.synthesize('add item 3', { adapter });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('normalizes schema keys to camelCase', () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncSchemaCommandBus({ 'cart_add': { description: 'Add' } });
    expect(bus.getSchema()).toHaveProperty('cartAdd');
  });
});

describe('schemaValidator', () => {
  it('passes command when fields match schema', ({ bus }) => {
    bus.use(schemaValidator(cartSchema));
    bus.register('cartAdd', () => 'ok');

    const result = bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(result.ok).toBe(true);
  });

  it('blocks command with wrong target field type', ({ bus }) => {
    bus.use(schemaValidator(cartSchema));
    bus.register('cartAdd', () => 'ok');

    const result = bus.dispatch('cartAdd', { id: 'not-a-number' }, { qty: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('cartAdd');
    expect(result.error?.message).toContain('id');
  });

  it('blocks command with wrong payload field type', ({ bus }) => {
    bus.use(schemaValidator(cartSchema));
    bus.register('cartAdd', () => 'ok');

    const result = bus.dispatch('cartAdd', { id: 1 }, { qty: 'not-a-number' });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('qty');
  });

  it('passes unknown actions through without validation', ({ bus }) => {
    bus.use(schemaValidator(cartSchema));
    bus.register('unknownAction', () => 'ok');

    const result = bus.dispatch('unknownAction', { anything: true });
    expect(result.ok).toBe(true);
  });

  it('handler is not called when validation fails', ({ bus }) => {
    bus.use(schemaValidator(cartSchema));
    const handler = vi.fn(() => 'ok');
    bus.register('cartAdd', handler);

    bus.dispatch('cartAdd', { id: 'wrong' }, { qty: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  // A non-object target/payload must fail, not skip the check: an LLM caller sends a string where an object belongs.
  describe('non-object target/payload (item 32a)', () => {
    const cases: Array<[string, unknown]> = [
      ['null', null],
      ['a number', 42],
      ['a string', 'oops'],
      ['an array', [1, 2]],
    ];

    for (const [label, value] of cases) {
      it(`rejects ${label} target against a fielded schema`, ({ bus }) => {
        bus.use(schemaValidator(cartSchema));
        const handler = vi.fn(() => 'ok');
        bus.register('cartAdd', handler);

        const result = bus.dispatch('cartAdd', value, { qty: 1 });
        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('target: expected object');
        expect(handler).not.toHaveBeenCalled();
      });

      it(`rejects ${label} payload against a fielded schema`, ({ bus }) => {
        bus.use(schemaValidator(cartSchema));
        const handler = vi.fn(() => 'ok');
        bus.register('cartAdd', handler);

        const result = bus.dispatch('cartAdd', { id: 1 }, value);
        expect(result.ok).toBe(false);
        expect(result.error?.message).toContain('payload: expected object');
        expect(handler).not.toHaveBeenCalled();
      });
    }

    it('an ABSENT payload still passes when the schema declares one', ({ bus }) => {
      // undefined means "not provided", not a wrong shape, so it is skipped.
      bus.use(schemaValidator(cartSchema));
      bus.register('cartClear', () => 'ok');

      expect(bus.dispatch('cartClear', { force: true }).ok).toBe(true);
    });
  });

  describe("'object' fields are type-checked (item 32b)", () => {
    const searchSchema: BusSchema = {
      search: { target: { q: 'string' }, payload: { filters: 'object' } },
    };

    it('rejects a number where an object is declared', ({ bus }) => {
      bus.use(schemaValidator(searchSchema));
      bus.register('search', () => 'ok');

      const result = bus.dispatch('search', { q: 'shoes' }, { filters: 42 });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('filters: expected object, got number');
    });

    it('rejects an array where an object is declared (JSON Schema semantics)', ({ bus }) => {
      bus.use(schemaValidator(searchSchema));
      bus.register('search', () => 'ok');

      const result = bus.dispatch('search', { q: 'shoes' }, { filters: [1, 2] });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('filters: expected object, got array');
    });

    it('rejects null where an object is declared', ({ bus }) => {
      bus.use(schemaValidator(searchSchema));
      bus.register('search', () => 'ok');

      const result = bus.dispatch('search', { q: 'shoes' }, { filters: null });
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain('filters: expected object, got null');
    });

    it('accepts a plain object', ({ bus }) => {
      bus.use(schemaValidator(searchSchema));
      bus.register('search', () => 'ok');

      expect(bus.dispatch('search', { q: 'shoes' }, { filters: { color: 'red' } }).ok).toBe(true);
    });
  });
});

describe('describeSchema', () => {
  it('produces a plain-text summary', () => {
    const text = describeSchema(cartSchema);
    expect(text).toContain('Available commands:');
    expect(text).toContain('cartAdd');
    expect(text).toContain('Add item to cart');
    expect(text).toContain('id:number');
    expect(text).toContain('qty:number');
  });

  it('includes all actions', () => {
    const text = describeSchema(cartSchema);
    expect(text).toContain('cartAdd');
    expect(text).toContain('cartClear');
  });

  it('bus.describe() returns same output', () => {
    const bus = createSchemaCommandBus(cartSchema);
    expect(bus.describe()).toBe(describeSchema(cartSchema));
  });
});

describe('fromToolCall (sync bus)', () => {
  it('dispatches from a tool_use block', () => {
    const bus = createSchemaCommandBus(cartSchema);
    const handler = vi.fn((cmd) => cmd.target.id * 3);
    bus.register('cartAdd', handler);

    const result = bus.fromToolCall({
      name: 'cartAdd',
      input: { target: { id: 4 }, payload: { qty: 1 } },
    });

    expect(result).toSucceedWith(12);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ target: { id: 4 }, payload: { qty: 1 } })
    );
  });

  it('handles missing input gracefully (defaults to empty target)', () => {
    const bus = createSchemaCommandBus(cartSchema);
    bus.register('cartClear', () => 'cleared');

    const invalid = bus.fromToolCall({ name: 'cartClear' });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.message).toContain('force');

    const valid = bus.fromToolCall({ name: 'cartClear', input: { target: { force: true } } });
    expect(valid).toSucceedWith('cleared');
  });
});

describe('fromToolCall (async bus)', () => {
  it('dispatches from a tool_use block', async () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    bus.register('cartAdd', async (cmd) => cmd.target.id + 10);

    const result = await bus.fromToolCall({
      name: 'cartAdd',
      input: { target: { id: 5 }, payload: { qty: 1 } },
    });

    expect(result).toSucceedWith(15);
  });
});

describe('createSchemaCommandBus auto-validation', () => {
  const schema: BusSchema = {
    cartAdd: {
      description: 'Add item',
      target: { id: 'number' },
      payload: { qty: 'number' },
    },
  };

  it('rejects invalid target fields by default (validate: true)', () => {
    const bus = createSchemaCommandBus(schema);
    bus.register('cartAdd', (cmd) => cmd.target.id);

    const result = bus.dispatch('cartAdd', { id: 'not-a-number' as any }, { qty: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Validation failed');
    expect(result.error?.message).toContain('id');
  });

  it('rejects invalid payload fields by default', () => {
    const bus = createSchemaCommandBus(schema);
    bus.register('cartAdd', (cmd) => cmd.target.id);

    const result = bus.dispatch('cartAdd', { id: 1 }, { qty: 'two' as any });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Validation failed');
    expect(result.error?.message).toContain('qty');
  });

  it('allows valid data through', () => {
    const bus = createSchemaCommandBus(schema);
    bus.register('cartAdd', (cmd) => cmd.target.id * cmd.payload.qty);

    const result = bus.dispatch('cartAdd', { id: 3 }, { qty: 4 });
    expect(result).toSucceedWith(12);
  });

  it('skips validation when validate: false', () => {
    const bus = createSchemaCommandBus(schema, { validate: false });
    bus.register('cartAdd', (cmd) => cmd.target.id);

    const result = bus.dispatch('cartAdd', { id: 'not-a-number' as any }, { qty: 1 });
    expect(result).toSucceedWith('not-a-number');
  });
});

describe('createAsyncSchemaCommandBus auto-validation', () => {
  const schema: BusSchema = {
    cartAdd: {
      description: 'Add item',
      target: { id: 'number' },
    },
  };

  it('rejects invalid data by default', async () => {
    const bus = createAsyncSchemaCommandBus(schema);
    bus.register('cartAdd', async (cmd) => cmd.target.id);

    const result = await bus.dispatch('cartAdd', { id: 'bad' as any });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Validation failed');
  });

  it('skips validation with validate: false', async () => {
    const bus = createAsyncSchemaCommandBus(schema, { validate: false });
    bus.register('cartAdd', async (cmd) => cmd.target.id);

    const result = await bus.dispatch('cartAdd', { id: 'string-ok' as any });
    expect(result).toSucceedWith('string-ok');
  });
});

describe('ERROR_CODE_REGISTRY retry metadata', () => {
  const CATEGORIES = ['general', 'network', 'validation', 'internal', 'logic'];

  it('every entry declares retryable and a valid category', () => {
    for (const e of ERROR_CODE_REGISTRY) {
      expect(typeof e.retryable, `${e.code} retryable`).toBe('boolean');
      expect(CATEGORIES, `${e.code} category`).toContain(e.category);
    }
  });

  it('a row is retryable exactly when the retry rule reads its code as transient (the column is an outcome)', () => {
    for (const e of ERROR_CODE_REGISTRY) {
      const owner = e.code.slice(0, e.code.indexOf(':'));
      const transient = retryClass(_failures(owner)(e.code.slice(owner.length + 1) as FailCode, '')) === 'transient';
      expect(e.retryable, e.code).toBe(transient);
      // Except a transport timeout, the condition alone decides via RETRYABLE_CONDITIONS.
      if (!e.code.startsWith('transport:timeout:')) expect(e.retryable, e.code).toBe(RETRYABLE_CONDITIONS.has(e.code.split(':')[1]));
    }
  });


  it('isRetryableCode consults the registry, undefined for unknown codes', () => {
    expect(isRetryableCode('pace:limited:dispatch')).toBe(true);
    expect(isRetryableCode('core:exceeded:depth')).toBe(false);
    expect(isRetryableCode('NOT_A_CODE')).toBeUndefined();
  });
});

describe('schemaValidator: a side with nothing to check', () => {
  it('asks for no step when the action declares no fields, and for one when it does', () => {
    const v = schemaValidator({
      none: { description: 'x' },
      emptied: { description: 'x', target: {}, payload: {} },
      fielded: { description: 'x', target: { id: 'number' } },
      paid: { description: 'x', payload: { n: 'number' } },
    });
    expect(v.validate?.('none')).toBeUndefined();
    expect(v.validate?.('emptied')).toBeUndefined();
    expect(v.validate?.('unknown')).toBeUndefined();
    expect(v.validate?.('fielded')).toBeTypeOf('function');
    expect(v.validate?.('paid')).toBeTypeOf('function');
  });

  it('an action with only a payload leaves the target alone and checks the payload', () => {
    const bus = createSchemaCommandBus({ paid: { description: 'x', payload: { n: 'number' } } });
    bus.register('paid', () => 'ok');
    expect(bus.dispatch('paid', 'any target', { n: 1 }).ok).toBe(true);
    expect(bus.dispatch('paid', 'any target', { n: 'one' } as never).ok).toBe(false);
    expect(bus.dispatch('paid', 'any target').ok).toBe(true);
  });
});
