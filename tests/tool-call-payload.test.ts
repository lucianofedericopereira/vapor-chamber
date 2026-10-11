/**
 * A tool call that leaves out the payload its action declares is checked as
 * an empty payload: the validator names the missing fields. It skipped
 * validation (an absent payload is app code's choice on dispatch()) and the
 * handler got `payload` undefined, while toTools() did not say payload was
 * required. Now the tool schemas say so, and the call is checked either way.
 */
import { describe, expect, it } from 'vitest';
import { createAsyncSchemaCommandBus, createSchemaCommandBus } from '../src/schema';

const schema = { cartAdd: { description: 'Add', target: { id: 'number' }, payload: { qty: 'number' } }, cartClear: { description: 'Clear' } } as const;

describe('fromToolCall - a declared payload left out', () => {
  it('is refused by the validator, naming the field (sync)', () => {
    const bus = createSchemaCommandBus(schema);
    let seen: unknown = 'not called';
    bus.register('cartAdd', (cmd) => { seen = cmd.payload; return 1; });
    const r = bus.fromToolCall({ name: 'cartAdd', input: { target: { id: 1 } } });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('qty: missing');
    expect(seen).toBe('not called');
  });

  it('is refused on the async bus too', async () => {
    const bus = createAsyncSchemaCommandBus(schema);
    bus.register('cartAdd', async () => 1);
    const r = await bus.fromToolCall({ name: 'cartAdd', input: { target: { id: 1 } } });
    expect(r.ok).toBe(false);
  });

  it('an action that declares no payload still dispatches without one', () => {
    const bus = createSchemaCommandBus(schema);
    let seen: unknown = 'not called';
    bus.register('cartClear', (cmd) => { seen = cmd.payload; return 0; });
    expect(bus.fromToolCall({ name: 'cartClear', input: {} }).ok).toBe(true);
    expect(seen).toBeUndefined();
  });

  it('app code may still leave the payload out on dispatch() (unchanged)', () => {
    const bus = createSchemaCommandBus(schema);
    bus.register('cartAdd', () => 1);
    expect(bus.dispatch('cartAdd', { id: 1 }).ok).toBe(true);
  });

  it('toTools says target and payload, and their typed fields, are required', () => {
    const [tool] = createSchemaCommandBus(schema).toTools() as Array<{ input_schema: any }>;
    expect(tool!.input_schema.required).toEqual(['target', 'payload']);
    expect(tool!.input_schema.properties.payload.required).toEqual(['qty']);
  });
});

describe('fromToolCall - a tool the schema does not have', () => {
  it('dispatches as given and fails as an unknown command, payload untouched', () => {
    const bus = createSchemaCommandBus(schema);
    const r = bus.fromToolCall({ name: 'nope', input: {} });
    expect(r.ok).toBe(false);
  });
});
