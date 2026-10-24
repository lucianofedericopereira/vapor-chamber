/**
 * The async bus's retry policy (docs/retry.md): the runner re-sends the
 * call that produced the outcome - a handler's execute, or the bus's
 * transport - by the class rule, bounded, jittered and budgeted per
 * bus, and the plugins outside see one dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BusError, createAsyncCommandBus, createCommandBus, createAsyncSchemaCommandBus,
  type CommandResult,
} from '../src/index';
import { defineTransport } from '../src/transports';

const limited = (retryIn?: number): CommandResult => ({
  ok: false, value: undefined,
  error: new BusError('limited:action', 'Held back.', retryIn === undefined ? {} : { context: { retryIn } }),
});
const invalid = (): CommandResult => ({ ok: false, value: undefined, error: new BusError('invalid:payload', 'Bad.') });

/** A handler that answers each call from `outcomes` in turn, the last one repeating. */
function scripted(outcomes: Array<'ok' | 'limited' | 'throw' | 'invalid' | 'lost'>) {
  const calls: number[] = [];
  const handler = async () => {
    const outcome = outcomes[Math.min(calls.length, outcomes.length - 1)];
    calls.push(Date.now());
    if (outcome === 'ok') return 'done';
    if (outcome === 'throw') throw new Error('handler threw');
    if (outcome === 'lost') throw new TypeError('Failed to fetch');
    if (outcome === 'invalid') throw new BusError('invalid:payload', 'Bad.');
    throw new BusError('limited:action', 'Held back.');
  };
  return { handler, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The top of each jittered wait, so a test reads the ceiling.
  vi.spyOn(Math, 'random').mockReturnValue(1);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe('the class rule', () => {
  it('re-sends a transient failure by default, up to 3 attempts', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited', 'limited', 'ok']);
    bus.register('save', handler);
    const result = await settle(bus.dispatch('save', {}));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('stops at 3 attempts and says how many were made', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    const result = await settle(bus.dispatch('save', {}));
    expect(calls).toHaveLength(3);
    expect((result.error as BusError).context?.attempts).toBe(3);
  });

  it('never re-sends a final failure', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['invalid']);
    bus.register('save', handler);
    const result = await settle(bus.dispatch('save', {}));
    expect(calls).toHaveLength(1);
    expect((result.error as BusError).context?.attempts).toBeUndefined();
  });

  it('never re-sends a library bug', async () => {
    const bus = createAsyncCommandBus();
    let calls = 0;
    bus.use({ admit: () => { calls++; throw new Error('plugin bug'); } });
    bus.register('save', async () => 'done');
    const result = await settle(bus.dispatch('save', {}));
    expect(result.error).toMatchObject({ code: 'plugin:failed:plugin' });
    expect(calls).toBe(1);
  });

  it('does not re-send an uncertain failure of an undeclared action', async () => {
    const bus = createAsyncCommandBus();
    const thrown = scripted(['throw']);
    const lost = scripted(['lost']);
    bus.register('save', thrown.handler);
    bus.register('send', lost.handler);
    await settle(bus.dispatch('save', {}));
    await settle(bus.dispatch('send', {}));
    expect(thrown.calls).toHaveLength(1);
    expect(lost.calls).toHaveLength(1);
  });

  it('re-sends an uncertain failure of an action declared idempotent', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { 'cart*': 'idempotent' } } });
    const { handler, calls } = scripted(['lost', 'throw', 'ok']);
    bus.register('cartAdd', handler);
    const result = await settle(bus.dispatch('cartAdd', {}));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('stamps an idempotent action with one key for every attempt', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { save: 'idempotent' } } });
    const keys: unknown[] = [];
    let id: string | undefined;
    bus.register('save', async (cmd) => {
      keys.push(cmd.meta?.idempotencyKey);
      id = cmd.meta?.id;
      if (keys.length < 2) throw new TypeError('Failed to fetch');
      return 'done';
    });
    await settle(bus.dispatch('save', {}));
    expect(keys).toEqual([id, id]);
  });

  it('re-sends an uncertain failure of a command carrying an idempotency key', async () => {
    const bus = createAsyncCommandBus();
    bus.use({ started: (cmd) => { cmd.meta!.idempotencyKey = 'k1'; } });
    const { handler, calls } = scripted(['lost', 'ok']);
    bus.register('save', handler);
    expect((await settle(bus.dispatch('save', {}))).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('the waits', () => {
  it('backs off with full jitter over 200 * 2^n', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    await settle(bus.dispatch('save', {}));
    expect([calls[1] - calls[0], calls[2] - calls[1]]).toEqual([200, 400]);
  });

  it('draws the wait uniformly under the ceiling', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited', 'ok']);
    bus.register('save', handler);
    await settle(bus.dispatch('save', {}));
    expect(calls[1] - calls[0]).toBe(100);
  });

  it('honours a declared retryIn; one longer than the cap is returned, never sent early', async () => {
    const answers = [limited(1_500), limited(60_000), { ok: true, value: 1 } as CommandResult];
    const at: number[] = [];
    const bus = createAsyncCommandBus({ retry: { maxDelay: 5_000 }, transport: defineTransport(() => { at.push(Date.now()); return answers.shift()!; }) });
    // 60 s declared against a 5 s cap: returned, not re-sent at 5 s
    // (Retry-After is a minimum). tests/retry-after-long.test.ts.
    expect((await settle(bus.dispatch('save', {}))).ok).toBe(false);
    expect(at.map((t) => t - at[0])).toEqual([0, 1_500]);
  });
});

describe('the bounds', () => {
  it('still dispatches once when maxAttempts is unusable', async () => {
    for (const bound of [0, -1, Number.NaN]) {
      const bus = createAsyncCommandBus({ retry: { maxAttempts: bound } });
      const { handler, calls } = scripted(['limited']);
      bus.register('save', handler);
      await settle(bus.dispatch('save', {}));
      expect(calls.length, String(bound)).toBe(Number.isNaN(bound) ? 3 : 1);
    }
  });

  it('caps maxDelay at the setTimeout ceiling, where a longer wait would invert', async () => {
    const bus = createAsyncCommandBus({ retry: { maxDelay: Number.MAX_SAFE_INTEGER, baseDelay: 2 ** 40 } });
    const { handler, calls } = scripted(['limited', 'ok']);
    bus.register('save', handler);
    await settle(bus.dispatch('save', {}));
    expect(calls[1] - calls[0]).toBe(2_147_483_647);
  });
});

describe('the budget', () => {
  it('stops re-sending while half the bus budget is spent', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    const perDispatch: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = calls.length;
      await settle(bus.dispatch('save', {}));
      perDispatch.push(calls.length - before);
    }
    // 10 tokens: 9, 8, 7 (bound reached); 6, 5 (half spent); 4.
    expect(perDispatch).toEqual([3, 2, 1]);
  });

  it('refunds a tenth of a token per success', async () => {
    const bus = createAsyncCommandBus();
    let fail = true;
    let calls = 0;
    bus.register('save', async () => { calls++; if (fail) throw new BusError('limited:action', 'Held back.'); return 'done'; });
    await settle(bus.dispatch('save', {})); // 7 tokens
    await settle(bus.dispatch('save', {})); // 5 tokens
    fail = false;
    for (let i = 0; i < 20; i++) await settle(bus.dispatch('save', {})); // 7 tokens
    fail = true;
    calls = 0;
    await settle(bus.dispatch('save', {}));
    expect(calls).toBe(2); // 6 left after the first failure, 5 after the second
  });

  it('a failure of an action declared false spends a token, though it is never re-sent', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { check: false } } });
    let checks = 0;
    bus.register('check', async () => { checks++; throw new BusError('limited:action', 'Held back.'); });
    const s = scripted(['limited']);
    bus.register('save', s.handler);
    for (let i = 0; i < 3; i++) await settle(bus.dispatch('check', {})); // 7 tokens
    expect(checks).toBe(3);
    await settle(bus.dispatch('save', {})); // 6, 5: half spent
    expect(s.calls).toHaveLength(2);
  });

  it('control: on a fresh bus the same failure is sent 3 times', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { check: false } } });
    const s = scripted(['limited']);
    bus.register('save', s.handler);
    await settle(bus.dispatch('save', {}));
    expect(s.calls).toHaveLength(3);
  });

  it('keeps one budget per bus', async () => {
    const a = createAsyncCommandBus();
    const b = createAsyncCommandBus();
    const sa = scripted(['limited']);
    const sb = scripted(['limited']);
    a.register('save', sa.handler);
    b.register('save', sb.handler);
    for (let i = 0; i < 3; i++) await settle(a.dispatch('save', {}));
    await settle(b.dispatch('save', {}));
    expect(sb.calls).toHaveLength(3);
  });
});

describe('the boundary', () => {
  it('shows the plugins outside one dispatch', async () => {
    const bus = createAsyncCommandBus();
    let seen = 0;
    bus.use({ started: (cmd) => { seen++; } });
    const { handler, calls } = scripted(['limited', 'limited', 'ok']);
    bus.register('save', handler);
    const outcomes: boolean[] = [];
    bus.onAfter((cmd, r) => { outcomes.push(r.ok); });
    await settle(bus.dispatch('save', {}));
    expect(calls).toHaveLength(3);
    expect(seen).toBe(1);
    expect(outcomes).toEqual([true]);
  });

  it("re-sends through the bus's transport", async () => {
    const sent: number[] = [];
    let outside = 0;
    const bus = createAsyncCommandBus({ transport: defineTransport(() => { sent.push(1); return sent.length < 3 ? limited() : { ok: true, value: 'wire' } as CommandResult; }) });
    bus.use({ started: (cmd) => { outside++; } });
    const result = await settle(bus.dispatch('save', {}));
    expect(result).toMatchObject({ ok: true, value: 'wire' });
    expect(sent).toHaveLength(3);
    expect(outside).toBe(1);
  });

  it('re-sends the whole send of a transport that answers with its local handler', async () => {
    let transportCalls = 0;
    const bus = createAsyncCommandBus({ transport: defineTransport((cmd, local) => { transportCalls++; return local(); }, { localFallback: true }) });
    const { handler, calls } = scripted(['limited']);
    bus.register('local', handler);
    await settle(bus.dispatch('local', {}));
    // The transport is the work: each attempt asks it again, and it runs the handler.
    expect(transportCalls).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('turns a transport throw into its failed:send result, not re-sent', async () => {
    let calls = 0;
    const bus = createAsyncCommandBus({ transport: defineTransport(() => { calls++; throw new Error('transport bug'); }) });
    const result = await settle(bus.dispatch('save', {}));
    expect(result.error).toMatchObject({ code: 'transport:failed:send' });
    expect(calls).toBe(1);
  });

  it("leaves a replay to its scheduler (the outbox's)", async () => {
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    bus.use({ started: (cmd) => { (cmd.meta as { origin?: string }).origin = 'replay'; } });
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    await settle(bus.dispatch('save', {}));
    expect(calls).toHaveLength(1);
  });

  it('does not retry on the sync bus', () => {
    const bus = createCommandBus();
    let calls = 0;
    bus.register('save', () => { calls++; throw new BusError('limited:action', 'Held back.'); });
    bus.dispatch('save', {});
    expect(calls).toBe(1);
  });

  it('retries a query the same way', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited', 'ok']);
    bus.register('read', handler);
    expect((await settle(bus.query('read', {}))).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

describe('the declarations', () => {
  it('retry: false turns the default off', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    await settle(bus.dispatch('save', {}));
    expect(calls).toHaveLength(1);
  });

  it('an action declared false is sent once', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { pay: false } } });
    const { handler, calls } = scripted(['limited']);
    bus.register('pay', handler);
    await settle(bus.dispatch('pay', {}));
    expect(calls).toHaveLength(1);
  });

  it('an action declared n makes up to n attempts', async () => {
    const bus = createAsyncCommandBus({ retry: { actionPolicies: { save: 2 } } });
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    await settle(bus.dispatch('save', {}));
    expect(calls).toHaveLength(2);
  });

  it('a schema action declares its own retry', async () => {
    const bus = createAsyncSchemaCommandBus({
      cartAdd: { retry: 'idempotent' },
      pay: { retry: false },
    });
    const add = scripted(['lost', 'ok']);
    const pay = scripted(['limited']);
    bus.register('cartAdd', add.handler);
    bus.register('pay', pay.handler);
    await settle(bus.dispatch('cartAdd', {}));
    await settle(bus.dispatch('pay', {}));
    expect(add.calls).toHaveLength(2);
    expect(pay.calls).toHaveLength(1);
  });
});

describe('the schema bus options', () => {
  it('retry: false turns off the schema declarations too', async () => {
    const bus = createAsyncSchemaCommandBus({ cartAdd: { retry: 'idempotent' } }, { retry: false });
    const add = scripted(['limited']);
    bus.register('cartAdd', add.handler);
    await settle(bus.dispatch('cartAdd', {}));
    expect(add.calls).toHaveLength(1);
  });

  it("an option's declaration for the same name wins over the schema's", async () => {
    const bus = createAsyncSchemaCommandBus({ cartAdd: { retry: 'idempotent' } }, { retry: { actionPolicies: { cartAdd: false } } });
    const add = scripted(['limited']);
    bus.register('cartAdd', add.handler);
    await settle(bus.dispatch('cartAdd', {}));
    expect(add.calls).toHaveLength(1);
  });
});

describe('ending a wait', () => {
  it('dispose() ends a wait and the dispatch settles aborted', async () => {
    const bus = createAsyncCommandBus();
    const { handler, calls } = scripted(['limited']);
    bus.register('save', handler);
    const pending = bus.dispatch('save', {});
    await vi.advanceTimersByTimeAsync(0);
    bus.dispose();
    const result = await pending;
    expect(result.error).toMatchObject({ code: 'core:aborted:dispatch' });
    expect(calls).toHaveLength(1);
  });

  it("the dispatch's own signal ends its wait, not another's", async () => {
    const bus = createAsyncCommandBus();
    const mine = scripted(['limited']);
    const other = scripted(['limited', 'ok']);
    bus.register('mine', mine.handler);
    bus.register('other', other.handler);
    const ac = new AbortController();
    const pending = bus.dispatch('mine', {}, undefined, { signal: ac.signal });
    const theirs = bus.dispatch('other', {});
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    expect((await pending).error).toMatchObject({ code: 'core:aborted:dispatch' });
    expect(mine.calls).toHaveLength(1);
    expect((await settle(theirs)).ok).toBe(true);
  });
});
