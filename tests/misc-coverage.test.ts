/**
 * Focused coverage tests for previously-uncovered branches across several
 * modules. Each block drives one specific uncovered line/branch:
 *
 *   - observable.ts:88            — double unsubscribe early-return
 *   - plugins-schema.ts:185-186   — validateSchemasAsync "warn" mode passthrough
 *   - utilities.ts:135            — workflow step dispatch throws
 *   - utilities.ts:149            — workflow compensation dispatch throws
 *   - utilities.ts:209            — createReaction target dispatch throws
 *   - http-query.ts:37-38         — nested-object query param expansion
 *   - chamber-vapor.ts:261-263    — useVaporAsyncCommand catch on rejected dispatch
 */
import { describe, it, expect, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { observe } from '../src/observable';
import { validateSchemasAsync, type StandardSchemaV1 } from '../src/plugins-schema';
import { createWorkflow, createReaction } from '../src/utilities';
import { buildFullUrl } from '../src/http-query';
import { useVaporAsyncCommand } from '../src/chamber-vapor';

// ---------------------------------------------------------------------------
// observable.ts:88 — unsubscribe() is idempotent (second call early-returns)
// ---------------------------------------------------------------------------

describe('observe — idempotent unsubscribe', () => {
  it('a second unsubscribe() is a no-op and does not re-detach the listener', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');

    // Spy on bus.on so we can capture (and count) the off() function.
    const off = vi.fn();
    const realOn = bus.on.bind(bus);
    const onSpy = vi.spyOn(bus, 'on').mockImplementation((pattern: any, listener: any) => {
      realOn(pattern, listener); // keep real wiring so closed flag flips correctly
      return off;                // but hand back a spy as the detach fn
    });

    const sub = observe(bus, 'act').subscribe(() => {});
    expect(sub.closed).toBe(false);

    sub.unsubscribe();
    expect(sub.closed).toBe(true);
    expect(off).toHaveBeenCalledTimes(1);

    // Second unsubscribe hits the `if (closed) return;` guard (line 88):
    sub.unsubscribe();
    expect(sub.closed).toBe(true);
    expect(off).toHaveBeenCalledTimes(1); // not called again

    onSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// plugins-schema.ts:185-186 — async warn mode logs then calls next()
// ---------------------------------------------------------------------------

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

describe('validateSchemasAsync — warn mode', () => {
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
    const result = await bus.dispatch('inc', -1); // fails schema -> warn + next()

    expect(result.ok).toBe(true);        // dispatch passed through (line 186)
    expect(handlerRan).toBe(true);       // handler actually ran
    expect(warn).toHaveBeenCalledOnce(); // warning emitted (line 185)
    expect(warn.mock.calls[0]![0]).toMatch(/must be positive/);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// utilities.ts:135 + 149 — workflow try/catch around bus.dispatch
// The real command bus never throws from dispatch (it returns {ok:false}),
// so we hand-roll a bus whose dispatch THROWS to exercise the catch blocks.
// ---------------------------------------------------------------------------

describe('createWorkflow — dispatch throws', () => {
  it('catches a thrown step dispatch and reports it as a failed result (line 135)', async () => {
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
        return { ok: true, value: action }; // 'reserve' succeeds
      },
    } as any;

    const wf = createWorkflow([
      { action: 'reserve', compensate: 'release' }, // succeeds, registers a compensation
      { action: 'charge' },                          // fails -> triggers compensation of 'release'
    ]);

    const result = await wf.run(bus, {});

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(result.compensations).toHaveLength(1);
    expect(result.compensations![0].ok).toBe(false);
    expect((result.compensations![0].error as Error).message).toBe('compensation exploded');
  });
});

// ---------------------------------------------------------------------------
// utilities.ts:209 — createReaction logs when the target dispatch throws
// ---------------------------------------------------------------------------

describe('createReaction — target dispatch throws', () => {
  it('logs an error (does not rethrow) when the reaction dispatch throws', () => {
    // Real bus to drive the source event; we make the target handler register a
    // listener whose own dispatch throws by stubbing bus.dispatch for the target.
    const bus = createCommandBus();
    bus.register('src', () => 1);

    const realDispatch = bus.dispatch.bind(bus);
    vi.spyOn(bus, 'dispatch').mockImplementation((action: any, target: any, payload?: any) => {
      if (action === 'dst') throw new Error('reaction target boom');
      return realDispatch(action, target, payload);
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    createReaction('src', 'dst').install(bus);

    // Dispatching the source fires the reaction, whose dst dispatch throws.
    expect(() => bus.dispatch('src', {})).not.toThrow();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]![0]).toMatch(/Reaction src → dst error/);
    expect(errorSpy.mock.calls[0]![1]).toBeInstanceOf(Error);
    expect((errorSpy.mock.calls[0]![1] as Error).message).toBe('reaction target boom');

    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// http-query.ts:37-38 — nested object params expand to key[subkey]=value
// ---------------------------------------------------------------------------

describe('buildFullUrl — nested object params', () => {
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

// ---------------------------------------------------------------------------
// chamber-vapor.ts:261-263 — useVaporAsyncCommand catch on a REJECTED dispatch
// The existing test uses an async bus that resolves {ok:false}; here the bus's
// dispatch promise REJECTS, so the try/await throws and the catch runs.
// ---------------------------------------------------------------------------

describe('useVaporAsyncCommand — dispatch rejects', () => {
  it('catches a rejected dispatch, sets lastError, and returns { ok: false, error }', async () => {
    const thrown = new Error('transport rejected');
    const bus = {
      dispatch: vi.fn(async () => { throw thrown; }),
    };

    const { dispatch, loading, lastError } = useVaporAsyncCommand(bus);

    const result = await dispatch('orderCreate', { items: [1] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe(thrown);       // line 263 return value
    expect(lastError.value).toBe(thrown);    // line 262
    expect(loading.value).toBe(false);       // finally still ran
    expect(bus.dispatch).toHaveBeenCalledOnce();
  });
});
