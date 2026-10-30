/**
 * The LLM-facing schema helpers in src/schema.ts and src/error-registry.ts: key normalization, schemaLogger, describe(), error-code lookup and the bus API schema.
 * Why: these feed the logs, prompts and tool lists a developer or model reads, so a wrong camel name, a mislabelled log line or a wrong description would mislead them. Also the only file reaching describeErrorCodes, busApiSchema, describe() and the camel-case replace, so the 100% floor needs it.
 * Shows: PascalCase keys normalize to camelCase, schemaLogger prints raw target and payload without a marker when the schema has none and prints the settled result on an async bus, describe() matches describeSchema(), getErrorEntry and describeErrorCodes read the registry, busApiSchema lists the bus methods with signatures.
 */

import { describe, expect, vi } from 'vitest';
import {
  schemaLogger,
  describeSchema,
  createSchemaCommandBus,
  createAsyncSchemaCommandBus,
  busApiSchema,
  type BusSchema,
} from '../src/schema';
import { ERROR_CODE_REGISTRY, describeErrorCodes, getErrorEntry } from '../src/error-registry';
import { it } from '../src/vitest';

describe('toCamel leading-uppercase normalization', () => {
  it('lowercases a leading uppercase letter in PascalCase keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // No separators in 'CartAdd': only the leading-uppercase rule applies.
    const bus = createSchemaCommandBus({ CartAdd: { description: 'Add' } });

    expect(bus.getSchema()).toHaveProperty('cartAdd');
    expect(bus.getSchema()).not.toHaveProperty('CartAdd');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CartAdd'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cartAdd'));
  });

  it('combines separator and leading-uppercase normalization', () => {
    using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 'Cart_Add' needs both the separator rule and the leading-uppercase rule.
    const bus = createSchemaCommandBus({ Cart_Add: { description: 'Add' } });

    expect(bus.getSchema()).toHaveProperty('cartAdd');
  });
});

describe('schemaLogger else branches', () => {
  it('logs raw target without a checkmark when the action has no schema def (line 201)', ({ bus }) => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    // The logger's schema does not know 'ping'.
    bus.use(schemaLogger({ cartAdd: { target: { id: 'number' } } }));
    bus.register('ping', () => 'pong');
    bus.dispatch('ping', { anything: true });

    const targetCall = log.mock.calls.find(c => c[0] === 'target:');
    expect(targetCall).toBeDefined();
    // Exactly two args: label and raw value, no marker.
    expect(targetCall).toHaveLength(2);
    expect(targetCall?.[1]).toEqual({ anything: true });
  });

  it('logs raw payload without a checkmark when the action has no payload schema (line 208)', ({ bus }) => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    // 'cartClear' declares a target but no payload; the dispatch supplies one.
    bus.use(schemaLogger({ cartClear: { target: { force: 'boolean' } } }));
    bus.register('cartClear', () => 'cleared');
    bus.dispatch('cartClear', { force: true }, { reason: 'manual' });

    const payloadCall = log.mock.calls.find(c => c[0] === 'payload:');
    expect(payloadCall).toBeDefined();
    expect(payloadCall).toHaveLength(2);
    expect(payloadCall?.[1]).toEqual({ reason: 'manual' });
  });

  it('logs the settled value on an async bus, not a pending promise', async ({ asyncBus: bus }) => {
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    bus.use(schemaLogger({ cartAdd: { target: { id: 'number' } } }));
    bus.register('cartAdd', async () => 'added');
    await bus.dispatch('cartAdd', { id: 1 });

    // On the async bus next() returns a promise; the logger must read its settled value.
    const resultCall = log.mock.calls.find(c => c[0] === 'result:');
    expect(resultCall?.[1]).toBe('added');
  });
});

describe('createAsyncSchemaCommandBus describe()', () => {
  const schema: BusSchema = {
    cartAdd: {
      description: 'Add item to cart',
      target: { id: 'number' },
      payload: { qty: 'number' },
    },
  };

  it('describe() returns the same plain-text summary as describeSchema()', () => {
    const bus = createAsyncSchemaCommandBus(schema);

    const text = bus.describe();
    expect(text).toBe(describeSchema(schema));
    expect(text).toContain('Available commands:');
    expect(text).toContain('cartAdd');
    expect(text).toContain('Add item to cart');
    expect(text).toContain('id:number');
  });
});

describe('getErrorEntry', () => {
  it('returns the registry entry for a known code', () => {
    const entry = getErrorEntry('core:missing:handler');

    expect(entry).toBeDefined();
    expect(entry?.code).toBe('core:missing:handler');
    expect(entry?.severity).toBe('error');
    expect(entry?.fix).toContain('bus.register');
  });

  it('returns the same frozen object instance held in the registry', () => {
    const entry = getErrorEntry('rateLimit:limited:action');
    const fromRegistry = ERROR_CODE_REGISTRY.find(e => e.code === 'rateLimit:limited:action');

    expect(entry).toBe(fromRegistry);
  });

  it('returns undefined for an unknown code', () => {
    // The cast probes a code that is not in the registry.
    const entry = getErrorEntry('VC_NOT_A_REAL_CODE' as any);
    expect(entry).toBeUndefined();
  });
});

describe('describeErrorCodes', () => {
  it('produces a header followed by one line per registry entry', () => {
    const text = describeErrorCodes();
    const lines = text.split('\n');

    expect(lines[0]).toBe('Error codes (code | severity | fix):');
    expect(lines).toHaveLength(ERROR_CODE_REGISTRY.length + 1);
  });

  it('includes every code with its severity and fix', () => {
    const text = describeErrorCodes();

    for (const e of ERROR_CODE_REGISTRY) {
      expect(text).toContain(e.code);
      expect(text).toContain(e.fix);
    }
    // The exact format of one row.
    expect(text).toContain(
      'core:missing:handler | error | Register a handler with bus.register(action, handler) before dispatching.'
    );
  });
});

describe('busApiSchema', () => {
  it('describes the full bus API surface as a structured object', () => {
    const api = busApiSchema();

    const expectedMethods = [
      'dispatch', 'query', 'emit', 'register', 'use',
      'onAfter', 'on', 'once',
      'request', 'respond', 'hasHandler', 'registeredActions', 'clear',
    ];
    expect(Object.keys(api).sort()).toEqual([...expectedMethods].sort());
  });

  it('gives every method a description, params object, and returns string', () => {
    const api = busApiSchema();

    for (const [method, def] of Object.entries(api)) {
      expect(typeof def.description, method).toBe('string');
      expect(def.description.length, method).toBeGreaterThan(0);
      expect(def.params, method).toBeTypeOf('object');
      expect(typeof def.returns, method).toBe('string');
    }
  });

  it('captures specific signatures used by LLM code generation', () => {
    const api = busApiSchema();

    expect(api.dispatch.params).toHaveProperty('action');
    expect(api.dispatch.params).toHaveProperty('target');
    expect(api.dispatch.params).toHaveProperty('payload');
    expect(api.dispatch.returns).toContain('CommandResult');

    expect(api.emit.returns).toBe('void');

    expect(api.registeredActions.params).toEqual({});
    expect(api.registeredActions.returns).toBe('string[]');

    expect(api.request.returns).toContain('Promise');
  });
});
