/**
 * The errors the library builds match its own catalogue (ERROR_CODE_REGISTRY):
 * each carries a catalogued code, and the owner in that code is the one the
 * wiring minted it for. Before the factory, every site filled code, emitter and
 * severity by hand and drifted from the catalogue (validator() refused with no
 * code at all). docs/plan-failures-and-contract.md, 2.1 and 4.5.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, vi } from 'vitest';
import { conditionOf, createAsyncCommandBus, createCommandBus, ownerOf } from '../src/command-bus';
import { _timedOut } from '../src/directives';
import { createOutbox } from '../src/outbox';
import { throttle, validator } from '../src/plugins-core';
import { ERROR_CODE_REGISTRY, schemaValidator, synthesize, type BusSchema } from '../src/schema';
import { rehydrate } from '../src/ssr';
import type { BusError } from '../src/command-bus';
import { it } from '../src/vitest';

const entry = (code: string) => ERROR_CODE_REGISTRY.find((e) => e.code === code)!;

function matchesCatalogue(error: unknown): void {
  // The catalogue documents every code the library raises; the owner in the
  // code is the one the wiring stamped (plan 4.5).
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

  it('throttle() refuses as its own limited:handler', ({ bus }) => {
    bus.use(throttle(['save'], 10_000));
    bus.register('save', () => 'saved');
    bus.dispatch('save', {});
    const second = bus.dispatch('save', {});
    expect(second).toFailWith('throttle:limited:handler');
    matchesCatalogue(second.error);
  });

  it('a throttled handler refuses as the catalogue says', ({ bus }) => {
    bus.register('save', () => 'saved', { throttle: 10_000 });
    bus.dispatch('save', {});
    const second = bus.dispatch('save', {});
    expect(second).toFailWith('core:limited:handler');
    matchesCatalogue(second.error);
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

  it('a schema rejection reads invalid, so the outbox drops it instead of blocking', async () => {
    // As a plain Error the rejection read `failed`, a bug, which the outbox
    // keeps. Coded, it reads `invalid`, the one library condition the outbox's
    // default rule treats as final (outbox.ts, isRetryable).
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 1);
    bus.use(schemaValidator(cartSchema));
    let online = false;
    const outbox = createOutbox({
      storage: { load: () => null, save: () => {}, clear: () => {} },
      isOnline: () => online,
      autoFlush: false,
    });
    outbox.install(bus);
    await bus.dispatch('cartAdd', { id: 'x' });
    expect(outbox.pending.value).toBe(1);
    online = true;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 0, rejected: 1 });
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });

  it('rehydrate() on an async bus refuses as ssr:invalid:bus', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('cartAdd', async () => 1);
    const [r] = rehydrate(bus, [{ action: 'cartAdd', target: {} }]);
    warn.mockRestore();
    expect(r).toFailWith('ssr:invalid:bus');
    expect(r.error?.message).toContain('rehydrateAsync');
    matchesCatalogue(r.error);
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
