/**
 * Tests for the schema layer: toTools, schemaLogger, synthesize, createSchemaCommandBus
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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
  type BusSchema,
} from '../src/schema';
import { createCommandBus } from '../src/command-bus';

afterEach(() => vi.restoreAllMocks());

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

// ---------------------------------------------------------------------------
// toTools
// ---------------------------------------------------------------------------

describe('toAnthropicTools', () => {
  it('converts schema to Anthropic tool definitions', () => {
    const tools = toAnthropicTools(cartSchema);

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('cartAdd');
    expect(tools[0].description).toBe('Add item to cart');
    expect(tools[0].input_schema.type).toBe('object');
    expect(tools[0].input_schema.properties.target).toEqual({
      type: 'object', properties: { id: { type: 'number' } },
    });
    expect(tools[0].input_schema.properties.payload).toEqual({
      type: 'object', properties: { qty: { type: 'number' } },
    });
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

// ---------------------------------------------------------------------------
// schemaLogger
// ---------------------------------------------------------------------------

describe('schemaLogger', () => {
  it('logs action with description', () => {
    const bus = createCommandBus();
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema));
    bus.register('cartAdd', () => 'ok');
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(group).toHaveBeenCalledWith(expect.stringContaining('cartAdd'));
    expect(group).toHaveBeenCalledWith(expect.stringContaining('Add item to cart'));
  });

  it('validates target fields and marks ✓ when valid', () => {
    const bus = createCommandBus();
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema));
    bus.register('cartAdd', () => null);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    const targetCall = log.mock.calls.find(c => c[0] === 'target:');
    expect(targetCall?.[2]).toBe('✓');
  });

  it('marks ⚠ when field is wrong type', () => {
    const bus = createCommandBus();
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema));
    bus.register('cartAdd', () => null);
    bus.dispatch('cartAdd', { id: 'wrong-type' }, { qty: 2 });

    const targetCall = log.mock.calls.find(c => c[0] === 'target:');
    expect(targetCall?.[2]).toContain('⚠');
  });

  it('uses console.group when collapsed: false', () => {
    const bus = createCommandBus();
    const group = vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger(cartSchema, { collapsed: false }));
    bus.register('cartAdd', () => null);
    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });

    expect(group).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// synthesize — mocked LLM
// ---------------------------------------------------------------------------

describe('synthesize', () => {
  function makeFetchMock(toolName: string, input: Record<string, any>) {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input }],
      }),
    });
  }

  it('dispatches the tool selected by the LLM', async () => {
    const bus = createCommandBus();
    const handler = vi.fn(() => 'added');
    bus.register('cartAdd', handler);

    // LLM returns nested { target, payload } — no splitting needed
    const fetchMock = makeFetchMock('cartAdd', { target: { id: 5 }, payload: { qty: 2 } });
    const result = await synthesize(cartSchema, bus, 'add 2 of item 5', {
      apiKey: 'test-key',
      fetch: fetchMock,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe('added');
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'cartAdd', target: { id: 5 }, payload: { qty: 2 } })
    );
  });

  it('sends Anthropic tool definitions in the request body', async () => {
    const bus = createCommandBus();
    bus.register('cartClear', () => null);
    const fetchMock = makeFetchMock('cartClear', { target: { force: true } });

    await synthesize(cartSchema, bus, 'clear my cart', { apiKey: 'k', fetch: fetchMock });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].name).toBe('cartAdd');
    expect(body.tools[0].input_schema.properties.target).toBeDefined();
    expect(body.tool_choice).toEqual({ type: 'any' });
  });

  it('returns error when apiKey is missing', async () => {
    const bus = createCommandBus();
    const result = await synthesize(cartSchema, bus, 'anything');
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('apiKey');
  });

  it('returns error when LLM response is not ok', async () => {
    const bus = createCommandBus();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await synthesize(cartSchema, bus, 'test', { apiKey: 'k', fetch: fetchMock });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('401');
  });

  it('returns error when LLM does not select a tool', async () => {
    const bus = createCommandBus();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'I cannot help with that.' }] }),
    });

    const result = await synthesize(cartSchema, bus, 'tell me a joke', { apiKey: 'k', fetch: fetchMock });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('tool');
  });
});

// ---------------------------------------------------------------------------
// createSchemaCommandBus
// ---------------------------------------------------------------------------

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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createSchemaCommandBus({ 'cart_add': { description: 'Add' } });
    expect(bus.getSchema()).toHaveProperty('cartAdd');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cart_add'));
    warn.mockRestore();
  });

  it('dispatch works normally', () => {
    const bus = createSchemaCommandBus(cartSchema);
    bus.register('cartAdd', (cmd) => cmd.target.id * 10);

    const result = bus.dispatch('cartAdd', { id: 3 }, { qty: 1 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(30);
  });

  it('synthesize dispatches through the embedded bus', async () => {
    const bus = createSchemaCommandBus(cartSchema);
    const handler = vi.fn(() => 'cleared');
    bus.register('cartClear', handler);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'cartClear', input: { target: { force: true } } }],
      }),
    });

    const result = await bus.synthesize('clear the cart', { apiKey: 'k', fetch: fetchMock });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createAsyncSchemaCommandBus
// ---------------------------------------------------------------------------

describe('createAsyncSchemaCommandBus', () => {
  it('dispatch is async', async () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    bus.register('cartAdd', async (cmd) => cmd.target.id * 2);

    const result = await bus.dispatch('cartAdd', { id: 5 }, { qty: 1 });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(10);
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

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'cartAdd', input: { target: { id: 3 }, payload: { qty: 1 } } }],
      }),
    });

    const result = await bus.synthesize('add item 3', { apiKey: 'k', fetch: fetchMock });
    expect(result.ok).toBe(true);
    expect(handler).toHaveBeenCalled();
  });

  it('normalizes schema keys to camelCase', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncSchemaCommandBus({ 'cart_add': { description: 'Add' } });
    expect(bus.getSchema()).toHaveProperty('cartAdd');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// schemaValidator
// ---------------------------------------------------------------------------

describe('schemaValidator', () => {
  it('passes command when fields match schema', () => {
    const bus = createCommandBus();
    bus.use(schemaValidator(cartSchema));
    bus.register('cartAdd', () => 'ok');

    const result = bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    expect(result.ok).toBe(true);
  });

  it('blocks command with wrong target field type', () => {
    const bus = createCommandBus();
    bus.use(schemaValidator(cartSchema));
    bus.register('cartAdd', () => 'ok');

    const result = bus.dispatch('cartAdd', { id: 'not-a-number' }, { qty: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('cartAdd');
    expect(result.error?.message).toContain('id');
  });

  it('blocks command with wrong payload field type', () => {
    const bus = createCommandBus();
    bus.use(schemaValidator(cartSchema));
    bus.register('cartAdd', () => 'ok');

    const result = bus.dispatch('cartAdd', { id: 1 }, { qty: 'not-a-number' });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('qty');
  });

  it('passes unknown actions through without validation', () => {
    const bus = createCommandBus();
    bus.use(schemaValidator(cartSchema));
    bus.register('unknownAction', () => 'ok');

    const result = bus.dispatch('unknownAction', { anything: true });
    expect(result.ok).toBe(true);
  });

  it('handler is not called when validation fails', () => {
    const bus = createCommandBus();
    bus.use(schemaValidator(cartSchema));
    const handler = vi.fn(() => 'ok');
    bus.register('cartAdd', handler);

    bus.dispatch('cartAdd', { id: 'wrong' }, { qty: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// describeSchema
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// fromToolCall
// ---------------------------------------------------------------------------

describe('fromToolCall (sync bus)', () => {
  it('dispatches from a tool_use block', () => {
    const bus = createSchemaCommandBus(cartSchema);
    const handler = vi.fn((cmd) => cmd.target.id * 3);
    bus.register('cartAdd', handler);

    const result = bus.fromToolCall({
      name: 'cartAdd',
      input: { target: { id: 4 }, payload: { qty: 1 } },
    });

    expect(result.ok).toBe(true);
    expect(result.value).toBe(12);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ target: { id: 4 }, payload: { qty: 1 } })
    );
  });

  it('handles missing input gracefully (defaults to empty target)', () => {
    const bus = createSchemaCommandBus(cartSchema);
    bus.register('cartClear', () => 'cleared');

    const result = bus.fromToolCall({ name: 'cartClear' });
    expect(result.ok).toBe(true);
    expect(result.value).toBe('cleared');
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

    expect(result.ok).toBe(true);
    expect(result.value).toBe(15);
  });
});
