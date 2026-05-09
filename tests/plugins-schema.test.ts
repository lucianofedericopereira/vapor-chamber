/**
 * Standard Schema validator plugin — works with any schema lib that
 * implements [Standard Schema v1](https://standardschema.dev/) — Zod,
 * Valibot, ArkType, Effect Schema. We test with hand-rolled fakes so the
 * lib stays schema-lib-agnostic and the test doesn't depend on any of
 * those packages being installed.
 */
import { describe, it, expect } from 'vitest';
import { createCommandBus, createAsyncCommandBus, BusError } from '../src/command-bus';
import { validateSchemas, validateSchemasAsync, type StandardSchemaV1 } from '../src/plugins-schema';

// Minimal Standard-Schema-shaped fake. Real schemas (Zod, Valibot, …)
// expose the same `'~standard'` interop surface.
function fakeSync<T>(predicate: (v: unknown) => v is T, message: string): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake',
      validate: (value) => predicate(value) ? { value } : { issues: [{ message, path: ['target'] }] },
    },
  };
}

function fakeAsync<T>(predicate: (v: unknown) => v is T, message: string): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake-async',
      validate: async (value) => predicate(value) ? { value } : { issues: [{ message }] },
    },
  };
}

const isPositiveNumber = (v: unknown): v is number => typeof v === 'number' && v > 0;
const isObjectWithId = (v: unknown): v is { id: number } =>
  typeof v === 'object' && v !== null && typeof (v as any).id === 'number';

describe('validateSchemas — sync', () => {
  it('rejects dispatches whose target fails the schema', () => {
    const bus = createCommandBus();
    bus.register('inc', () => 'ok');
    bus.use(validateSchemas({ inc: fakeSync(isPositiveNumber, 'must be positive') }));

    const ok = bus.dispatch('inc', 5);
    expect(ok.ok).toBe(true);

    const bad = bus.dispatch('inc', -1);
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeInstanceOf(BusError);
    expect((bad.error as BusError).code).toBe('VC_VALIDATION_FAILED');
    expect(bad.error?.message).toMatch(/must be positive/);
  });

  it('actions without a schema pass through untouched', () => {
    const bus = createCommandBus();
    bus.register('checked', () => 'a');
    bus.register('unchecked', () => 'b');
    bus.use(validateSchemas({ checked: fakeSync(isPositiveNumber, 'fail') }));

    expect(bus.dispatch('unchecked', 'anything').ok).toBe(true);
  });

  it('"warn" mode logs but lets the dispatch through', () => {
    const bus = createCommandBus();
    let calledHandler = false;
    bus.register('inc', () => { calledHandler = true; return 'ok'; });
    bus.use(validateSchemas(
      { inc: fakeSync(isPositiveNumber, 'must be positive') },
      { onInvalid: 'warn' },
    ));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = bus.dispatch('inc', -1);
    expect(result.ok).toBe(true);
    expect(calledHandler).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('field: "payload" validates cmd.payload instead of cmd.target', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(validateSchemas(
      { act: fakeSync(isObjectWithId, 'needs id') },
      { field: 'payload' },
    ));

    const r = bus.dispatch('act', 'whatever-target', { id: 42 });
    expect(r.ok).toBe(true);

    const bad = bus.dispatch('act', 'whatever-target', { not: 'id' });
    expect(bad.ok).toBe(false);
  });

  it('field: custom function extracts a slice', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(validateSchemas(
      { act: fakeSync(isPositiveNumber, 'positive') },
      { field: (cmd) => (cmd.target as any).count },
    ));

    expect(bus.dispatch('act', { count: 5 }).ok).toBe(true);
    expect(bus.dispatch('act', { count: -1 }).ok).toBe(false);
  });

  it('rejects with a clear error when given an async schema on the sync plugin', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(validateSchemas({
      act: fakeAsync(isPositiveNumber, 'positive'),
    }));

    const r = bus.dispatch('act', 5);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/async schema/);
  });
});

describe('validateSchemasAsync — async bus', () => {
  it('awaits async schemas and rejects on failure', async () => {
    const bus = createAsyncCommandBus();
    bus.register('act', async (cmd) => cmd.target);
    bus.use(validateSchemasAsync({ act: fakeAsync(isPositiveNumber, 'positive') }));

    const ok = await bus.dispatch('act', 7);
    expect(ok.ok).toBe(true);
    expect(ok.value).toBe(7);

    const bad = await bus.dispatch('act', -1);
    expect(bad.ok).toBe(false);
    expect((bad.error as BusError).code).toBe('VC_VALIDATION_FAILED');
  });
});

// Pull vi for the warn spy
import { vi } from 'vitest';
