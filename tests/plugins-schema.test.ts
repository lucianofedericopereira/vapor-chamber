/**
 * validateSchemas and validateSchemasAsync: the Standard Schema v1 validator plugins, tested with hand-rolled fakes.
 * Why: an invalid target or payload must be refused as `validateSchemas:invalid:payload` before the handler runs, and the handler must always get the command as dispatched, never a schema's coerced output; the fakes keep the library independent of any schema package.
 * Shows: reject mode refuses and warn mode logs once and lets the dispatch through, actions without a schema pass, `field` selects payload or a custom slice, an async schema on the sync plugin is refused with an "async schema" message, the async plugin awaits schemas, and neither mode passes the schema output to the handler.
 * See: https://standardschema.dev/.
 */
import { describe, expect } from 'vitest';
import { BusError } from '../src/command-bus';
import { validateSchemas, validateSchemasAsync, type StandardSchemaV1 } from '../src/plugins-schema';

// Minimal fakes exposing the `'~standard'` interop surface real schemas expose.
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

describe('validateSchemas - sync', () => {
  it('rejects dispatches whose target fails the schema', ({ bus }) => {
    bus.register('inc', () => 'ok');
    bus.use(validateSchemas({ inc: fakeSync(isPositiveNumber, 'must be positive') }));

    const ok = bus.dispatch('inc', 5);
    expect(ok.ok).toBe(true);

    const bad = bus.dispatch('inc', -1);
    expect(bad).toFailWith('validateSchemas:invalid:payload');
    expect(bad.error).toBeInstanceOf(BusError);
    expect(bad.error?.message).toMatch(/must be positive/);
  });

  it('actions without a schema pass through untouched', ({ bus }) => {
    bus.register('checked', () => 'a');
    bus.register('unchecked', () => 'b');
    bus.use(validateSchemas({ checked: fakeSync(isPositiveNumber, 'fail') }));

    expect(bus.dispatch('unchecked', 'anything').ok).toBe(true);
  });

  it('"warn" mode logs but lets the dispatch through', ({ bus }) => {
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
  });

  it('field: "payload" validates cmd.payload instead of cmd.target', ({ bus }) => {
    bus.register('act', () => 'ok');
    bus.use(validateSchemas(
      { act: fakeSync(isObjectWithId, 'needs id') },
      { field: 'payload' },
    ));

    const r = bus.dispatch('act', 'whatever-target', { id: 42 });
    expect(r.ok).toBe(true);

    const bad = bus.dispatch('act', 'whatever-target', { not: 'id' });
    expect(bad).toFailWith('validateSchemas:invalid:payload');
  });

  it('field: custom function extracts a slice', ({ bus }) => {
    bus.register('act', () => 'ok');
    bus.use(validateSchemas(
      { act: fakeSync(isPositiveNumber, 'positive') },
      { field: (cmd) => (cmd.target as any).count },
    ));

    expect(bus.dispatch('act', { count: 5 }).ok).toBe(true);
    expect(bus.dispatch('act', { count: -1 })).toFailWith('validateSchemas:invalid:payload');
  });

  it('rejects with a clear error when given an async schema on the sync plugin', ({ bus }) => {
    bus.register('act', () => 'ok');
    bus.use(validateSchemas({
      act: fakeAsync(isPositiveNumber, 'positive'),
    }));

    const r = bus.dispatch('act', 5);
    expect(r).toFailWith('validateSchemas:invalid:payload');
    expect(r.error?.message).toMatch(/async schema/);
  });

  it.for(['reject', 'warn'] as const)('"%s" mode hands the handler the command as dispatched, never the schema output', (onInvalid, { bus }) => {
    let seen: unknown;
    bus.register('cartAdd', (cmd) => { seen = cmd.target; return 'ok'; });
    bus.use(validateSchemas({ cartAdd: fakeCoerce }, { onInvalid }));

    expect(bus.dispatch('cartAdd', { id: '7' }).ok).toBe(true);
    expect(seen).toEqual({ id: '7' });
  });
});

// Coerces a numeric string id to a number, as a schema's output may.
const fakeCoerce: StandardSchemaV1 = {
  '~standard': { version: 1, vendor: 'fake-coerce', validate: (v) => ({ value: { id: Number((v as { id: string }).id) } }) },
};

describe('validateSchemasAsync - async bus', () => {
  it('awaits async schemas and rejects on failure', async ({ asyncBus: bus }) => {
    bus.register('act', async (cmd) => cmd.target);
    bus.use(validateSchemasAsync({ act: fakeAsync(isPositiveNumber, 'positive') }));

    const ok = await bus.dispatch('act', 7);
    expect(ok).toSucceedWith(7);

    const bad = await bus.dispatch('act', -1);
    expect(bad).toFailWith('validateSchemas:invalid:payload');
  });

  it('hands the handler the command as dispatched, never the schema output', async ({ asyncBus: bus }) => {
    bus.register('cartAdd', async (cmd) => cmd.target);
    bus.use(validateSchemasAsync({ cartAdd: fakeCoerce }));

    expect(await bus.dispatch('cartAdd', { id: '7' })).toSucceedWith({ id: '7' });
  });
});

import { vi } from 'vitest';
import { it } from '../src/vitest';
