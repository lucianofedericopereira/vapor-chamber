/**
 * Coverage tests for the LLM/schema helper functions in src/schema.ts.
 *
 * Targets previously-uncovered lines:
 *   - 90      toCamel: leading-uppercase lowercasing branch (via normalizeSchema)
 *   - 201     schemaLogger: target else-branch (no def.target / no cmd.target)
 *   - 208     schemaLogger: payload else-branch (payload present, no def.payload)
 *   - 383     createAsyncSchemaCommandBus: describe() arrow
 *   - 472-507 getErrorEntry, describeErrorCodes, busApiSchema
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  schemaLogger,
  describeSchema,
  createSchemaCommandBus,
  createAsyncSchemaCommandBus,
  getErrorEntry,
  describeErrorCodes,
  busApiSchema,
  ERROR_CODE_REGISTRY,
  type BusSchema,
} from '../src/schema';
import { createCommandBus } from '../src/command-bus';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// toCamel — leading-uppercase branch (line 90), reached via normalizeSchema
// ---------------------------------------------------------------------------

describe('toCamel leading-uppercase normalization', () => {
  it('lowercases a leading uppercase letter in PascalCase keys', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 'CartAdd' has no separators, so only the /^[A-Z]/ branch fires.
    const bus = createSchemaCommandBus({ CartAdd: { description: 'Add' } });

    expect(bus.getSchema()).toHaveProperty('cartAdd');
    expect(bus.getSchema()).not.toHaveProperty('CartAdd');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('CartAdd'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cartAdd'));
  });

  it('combines separator and leading-uppercase normalization', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 'Cart_Add' exercises both the separator replace and the leading-uppercase replace.
    const bus = createSchemaCommandBus({ Cart_Add: { description: 'Add' } });

    expect(bus.getSchema()).toHaveProperty('cartAdd');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// schemaLogger — else branches (lines 201, 208)
// ---------------------------------------------------------------------------

describe('schemaLogger else branches', () => {
  it('logs raw target without a checkmark when the action has no schema def (line 201)', () => {
    const bus = createCommandBus();
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    // Logger schema knows nothing about 'ping' → def is undefined → else branch.
    bus.use(schemaLogger({ cartAdd: { target: { id: 'number' } } }));
    bus.register('ping', () => 'pong');
    bus.dispatch('ping', { anything: true });

    const targetCall = log.mock.calls.find(c => c[0] === 'target:');
    expect(targetCall).toBeDefined();
    // else branch logs exactly two args: label + raw value, no ✓ / ⚠ marker.
    expect(targetCall).toHaveLength(2);
    expect(targetCall?.[1]).toEqual({ anything: true });
  });

  it('logs raw payload without a checkmark when the action has no payload schema (line 208)', () => {
    const bus = createCommandBus();
    vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});

    // def for 'cartClear' has a target but NO payload → payload else branch fires
    // when a payload is actually supplied on dispatch.
    bus.use(schemaLogger({ cartClear: { target: { force: 'boolean' } } }));
    bus.register('cartClear', () => 'cleared');
    bus.dispatch('cartClear', { force: true }, { reason: 'manual' });

    const payloadCall = log.mock.calls.find(c => c[0] === 'payload:');
    expect(payloadCall).toBeDefined();
    expect(payloadCall).toHaveLength(2);
    expect(payloadCall?.[1]).toEqual({ reason: 'manual' });
  });
});

// ---------------------------------------------------------------------------
// createAsyncSchemaCommandBus.describe() — line 383
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getErrorEntry — lines 471-473
// ---------------------------------------------------------------------------

describe('getErrorEntry', () => {
  it('returns the registry entry for a known code', () => {
    const entry = getErrorEntry('VC_CORE_NO_HANDLER');

    expect(entry).toBeDefined();
    expect(entry?.code).toBe('VC_CORE_NO_HANDLER');
    expect(entry?.severity).toBe('error');
    expect(entry?.emitter).toBe('core');
    expect(entry?.fix).toContain('bus.register');
  });

  it('returns the same frozen object instance held in the registry', () => {
    const entry = getErrorEntry('VC_PLUGIN_RATE_LIMITED');
    const fromRegistry = ERROR_CODE_REGISTRY.find(e => e.code === 'VC_PLUGIN_RATE_LIMITED');

    expect(entry).toBe(fromRegistry);
    expect(entry?.emitter).toBe('plugin');
  });

  it('returns undefined for an unknown code', () => {
    // Cast — intentionally probing a code that is not in the registry.
    const entry = getErrorEntry('VC_NOT_A_REAL_CODE' as any);
    expect(entry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// describeErrorCodes — lines 481-487
// ---------------------------------------------------------------------------

describe('describeErrorCodes', () => {
  it('produces a header followed by one line per registry entry', () => {
    const text = describeErrorCodes();
    const lines = text.split('\n');

    expect(lines[0]).toBe('Error codes (code | severity | emitter | fix):');
    // header line + one line per registry entry
    expect(lines).toHaveLength(ERROR_CODE_REGISTRY.length + 1);
  });

  it('includes every code with its severity, emitter, and fix', () => {
    const text = describeErrorCodes();

    for (const e of ERROR_CODE_REGISTRY) {
      expect(text).toContain(e.code);
      expect(text).toContain(e.fix);
    }
    // spot-check the exact formatting of one row
    expect(text).toContain(
      'VC_CORE_NO_HANDLER | error | core | Register a handler with bus.register(action, handler) before dispatching.'
    );
  });
});

// ---------------------------------------------------------------------------
// busApiSchema — lines 502-579
// ---------------------------------------------------------------------------

describe('busApiSchema', () => {
  it('describes the full bus API surface as a structured object', () => {
    const api = busApiSchema();

    const expectedMethods = [
      'dispatch', 'query', 'emit', 'register', 'use',
      'onBefore', 'onAfter', 'on', 'once',
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

    // emit takes no return value
    expect(api.emit.returns).toBe('void');

    // registeredActions takes no params and returns string[]
    expect(api.registeredActions.params).toEqual({});
    expect(api.registeredActions.returns).toBe('string[]');

    // request is the async path
    expect(api.request.returns).toContain('Promise');
  });
});
