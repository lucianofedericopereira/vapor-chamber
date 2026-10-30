/**
 * The errors the library builds match ERROR_CODE_REGISTRY: each carries a catalogued code, with the owner the wiring minted it for.
 * Why: a site filling code and owner by hand drifts from the catalogue, and an uncoded failure cannot be queried.
 * Shows: validator, pace, abort, schemaValidator, synthesize and the directive's timeout each fail with their catalogue code; a schema rejection precedes the outbox; src/ wraps no uncoded Error.
 * See: docs/contract.md section 5.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect } from 'vitest';
import { conditionOf, createAsyncCommandBus, createCommandBus, ownerOf } from '../src/command-bus';
import { _timedOut } from '../src/directives';
import { createOutbox } from '../src/outbox';
import { defineTransport } from '../src/transports';
import { validator } from '../src/plugins-core';
import { pace } from '../src/pace';
import { schemaValidator, synthesize, type BusSchema } from '../src/schema';
import { ERROR_CODE_REGISTRY } from '../src/error-registry';
import type { BusError } from '../src/command-bus';
import { it } from '../src/vitest';

const entry = (code: string) => ERROR_CODE_REGISTRY.find((e) => e.code === code)!;

function matchesCatalogue(error: unknown): void {
  const e = error as BusError;
  expect(e.code, 'the error carries a catalogue code').toBeDefined();
  expect(entry(e.code), `${e.code} is catalogued`).toBeDefined();
  expect(e.code.split(':')[0]).toBe(ownerOf(e));
}

describe('errors match the catalogue', () => {
  it('validator() refuses as its own invalid:payload, keeping the rule\'s own message', ({ bus }) => {
    bus.use(validator({ save: () => 'The name is required.' }));
    bus.register('save', () => 'saved');
    const result = bus.dispatch('save', {});
    expect(result).toFailWith('validator:invalid:payload');
    expect(result.error?.message).toBe('The name is required.');
    matchesCatalogue(result.error);
  });

  it('pace() refuses a throttled call and supersedes a debounced one as the catalogue says', async ({ bus }) => {
    bus.register('save', () => 'saved');
    const throttled = pace(bus.dispatch, { throttle: 10_000 });
    await throttled('save', {});
    const second = await throttled('save', {});
    expect(second).toFailWith('pace:limited:dispatch');
    matchesCatalogue(second.error);
    const debounced = pace(bus.dispatch, { debounce: 10_000 });
    const first = debounced('save', {});
    debounced.dispose();
    const superseded = await first;
    expect(superseded).toFailWith('pace:aborted:dispatch');
    matchesCatalogue(superseded.error);
  });

  it('an aborted dispatch refuses as the catalogue says', async () => {
    const bus = createAsyncCommandBus();
    bus.register('save', async () => 'saved');
    const ac = new AbortController();
    ac.abort();
    const result = await bus.dispatch('save', {}, undefined, { signal: ac.signal });
    expect(result).toFailWith('core:aborted:dispatch');
    matchesCatalogue(result.error);
  });
});

describe('every library failure is coded (shape rule 2)', () => {
  const cartSchema: BusSchema = { cartAdd: { description: 'Add', target: { id: 'number' } } };

  it('schemaValidator() refuses as its own invalid:payload, message unchanged', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    bus.use(schemaValidator(cartSchema));
    const r = bus.dispatch('cartAdd', { id: 'x' });
    expect(r).toFailWith('schemaValidator:invalid:payload');
    expect(r.error?.message).toMatch(/^\[vapor-chamber\] Validation failed for "cartAdd": /);
    matchesCatalogue(r.error);
  });

  it('a schema rejection is refused before the outbox holds anything', async () => {
    // The outbox holds at the work step, below every plugin, so the validator
    // refuses an invalid command at once, offline too, with its own code.
    const outbox = createOutbox({
      storage: null,
      isOnline: () => false,
      autoFlush: false,
    });
    const bus = createAsyncCommandBus({ transport: defineTransport(async () => ({ ok: true, value: 1, error: undefined })), outbox });
    bus.use(schemaValidator(cartSchema));
    const r = await bus.dispatch('cartAdd', { id: 'x' });
    expect(r).toFailWith('schemaValidator:invalid:payload');
    matchesCatalogue(r.error);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });

  it('synthesize() without an adapter refuses as schema:missing:adapter', async () => {
    const r = await synthesize(cartSchema, createCommandBus(), 'add one');
    expect(r).toFailWith('schema:missing:adapter');
    matchesCatalogue(r.error);
  });

  it('a directive dispatch that times out is directive:timeout:dispatch, condition timeout', () => {
    const r = _timedOut('cartAdd', 5);
    expect(r).toFailWith('directive:timeout:dispatch');
    expect(r.error?.message).toBe('Directive dispatch "cartAdd" timed out after 5ms');
    expect(conditionOf(r.error)).toBe('timeout');
    expect((r.error as BusError).context).toMatchObject({ timeout: 5 });
    matchesCatalogue(r.error);
  });

  it('src/ wraps no uncoded Error in a result', () => {
    // A plain Error passes through only when it is someone else's (a
    // handler's throw, Fetch's TypeError); one the library builds is coded.
    const root = resolve(__dirname, '../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('testing.ts')) {
          readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
            if (/rrResult\(\s*new (Type)?Error\(/.test(line)) offenders.push(`${p.slice(root.length + 1)}:${i + 1}`);
          });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
