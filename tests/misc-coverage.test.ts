/**
 * Narrow behaviours of several modules: observe unsubscribe, validateSchemasAsync warn mode, createWorkflow and createReaction with a throwing dispatch, nested query params, useVaporAsyncCommand on a rejection.
 * Why: a second unsubscribe that detaches twice, a warn-mode schema that blocks the dispatch, or a thrown dispatch that escapes a workflow, reaction or composable would crash callers instead of reporting a failed result. Also the only file reaching nested query params, the second unsubscribe, and a thrown dispatch in createWorkflow and createReaction, so the 100% floor needs it.
 * Shows: a second `unsubscribe()` does not call the detach again; warn mode logs once and the handler still runs; a thrown step or compensation dispatch becomes a failed result; a thrown reaction target is logged, not rethrown; nested params expand to `key[sub]=value` as strings; a rejected dispatch returns `{ ok: false, error }`.
 */
import { describe, expect, vi } from 'vitest';
import { observe } from '../src/observable';
import { validateSchemasAsync, type StandardSchemaV1 } from '../src/plugins-schema';
import { createWorkflow, createReaction } from '../src/utilities';
import { buildFullUrl } from '../src/http-query';
import { useVaporAsyncCommand } from '../src/chamber-vapor';
import { it } from '../src/vitest';

describe('observe - idempotent unsubscribe', () => {
  it('a second unsubscribe() is a no-op and does not re-detach the listener', ({ bus }) => {
    bus.register('act', () => 'ok');

    // Wrap bus.on so the detach function is a counted spy.
    const off = vi.fn();
    const realOn = bus.on.bind(bus);
    const onSpy = vi.spyOn(bus, 'on').mockImplementation((pattern: any, listener: any) => {
      realOn(pattern, listener);
      return off;
    });

    const sub = observe(bus, 'act').subscribe(() => {});
    expect(sub.closed).toBe(false);

    sub.unsubscribe();
    expect(sub.closed).toBe(true);
    expect(off).toHaveBeenCalledTimes(1);

    sub.unsubscribe();
    expect(sub.closed).toBe(true);
    expect(off).toHaveBeenCalledTimes(1);

  });
});

function fakeAsync<T>(predicate: (v: unknown) => v is T, message: string): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: 'fake-async',
      validate: async (value) => (predicate(value) ? { value } : { issues: [{ message }] }),
    },
  };
}
const isPositive = (v: unknown): v is number => typeof v === 'number' && v > 0;

describe('validateSchemasAsync - warn mode', () => {
  it('logs a warning and lets the dispatch through instead of rejecting', async () => {
    const { createAsyncCommandBus } = await import('../src/command-bus');
    const bus = createAsyncCommandBus();
    let handlerRan = false;
    bus.register('inc', async () => { handlerRan = true; return 'ok'; });
    bus.use(validateSchemasAsync(
      { inc: fakeAsync(isPositive, 'must be positive') },
      { onInvalid: 'warn' },
    ));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await bus.dispatch('inc', -1);

    expect(result.ok).toBe(true);
    expect(handlerRan).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/must be positive/);
  });
});

describe('createWorkflow - dispatch throws', () => {
  it('catches a thrown step dispatch and reports it as a failed result (line 135)', async () => {
    // The real bus returns {ok:false} instead of throwing, so these tests hand-roll a bus whose dispatch throws.
    const bus = {
      on() { return () => {}; },
      dispatch(action: string) {
        if (action === 'boom') throw new Error('dispatch exploded');
        return { ok: true, value: action };
      },
    } as any;

    const wf = createWorkflow([{ action: 'boom' }]);
    const result = await wf.run(bus, {});

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(0);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe('dispatch exploded');
    expect(result.results[0]!.ok).toBe(false);
  });

  it('catches a thrown compensation dispatch and records it as a failed compensation (line 149)', async () => {
    const bus = {
      on() { return () => {}; },
      dispatch(action: string) {
        if (action === 'release') throw new Error('compensation exploded');
        if (action === 'charge') return { ok: false, error: new Error('declined') };
        return { ok: true, value: action };
      },
    } as any;

    const wf = createWorkflow([
      { action: 'reserve', compensate: 'release' },
      { action: 'charge' },
    ]);

    const result = await wf.run(bus, {});

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(result.compensations).toHaveLength(1);
    expect(result.compensations![0].ok).toBe(false);
    expect((result.compensations![0].error as Error).message).toBe('compensation exploded');
  });
});

describe('createReaction - target dispatch throws', () => {
  it('logs an error (does not rethrow) when the reaction dispatch throws', ({ bus }) => {
    // Stub dispatch so only the reaction's target action throws; the source dispatch stays real.
    bus.register('src', () => 1);

    const realDispatch = bus.dispatch.bind(bus);
    vi.spyOn(bus, 'dispatch').mockImplementation((action: any, target: any, payload?: any) => {
      if (action === 'dst') throw new Error('reaction target boom');
      return realDispatch(action, target, payload);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createReaction('src', 'dst').install(bus);

    expect(() => bus.dispatch('src', {})).not.toThrow();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]![0]).toMatch(/^\[vapor-chamber\] \[ FAIL \] reaction:failed:dispatch: Reaction "src" -> "dst" threw/);
    expect(errorSpy.mock.calls[0]![1]).toBeInstanceOf(Error);
    expect((errorSpy.mock.calls[0]![1] as Error).message).toBe('reaction target boom');

  });
});

describe('buildFullUrl - nested object params', () => {
  it('expands a nested object value into key[subkey] query entries', () => {
    const url = buildFullUrl('/api/search', undefined, {
      filter: { status: 'active', tier: 'gold' },
    });

    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('filter[status]')).toBe('active');
    expect(parsed.searchParams.get('filter[tier]')).toBe('gold');
  });

  it('coerces nested object values to strings', () => {
    const url = buildFullUrl('/api/search', undefined, {
      range: { min: 1, max: 100 },
    });

    const parsed = new URL(url, 'http://localhost');
    expect(parsed.searchParams.get('range[min]')).toBe('1');
    expect(parsed.searchParams.get('range[max]')).toBe('100');
  });
});

describe('useVaporAsyncCommand - dispatch rejects', () => {
  it('catches a rejected dispatch and returns { ok: false, error }', async () => {
    // The bus's dispatch promise rejects, rather than resolving {ok:false}.
    const thrown = new Error('transport rejected');
    const bus = {
      dispatch: vi.fn(async () => { throw thrown; }),
    };

    const { dispatch } = useVaporAsyncCommand(bus);

    const result = await dispatch('orderCreate', { items: [1] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(thrown);
    expect(bus.dispatch).toHaveBeenCalledOnce();
  });
});
