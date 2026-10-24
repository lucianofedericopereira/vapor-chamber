/** An action's rules run before every chain plugin and the work: a refusal is the command's one answer. The long note is at the end. */
import { describe, expect, it, vi } from 'vitest';
import { _failures, createAsyncCommandBus, createCommandBus, type AsyncCommandBus, type BaseBus, type CommandResult } from '../src/command-bus';
import { authGuard, validator } from '../src/plugins-core';
import { circuitBreaker, rateLimit } from '../src/plugins-extra';
import { validateSchemasAsync } from '../src/plugins-schema';
import { createTestBus } from '../src/testing';

const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.message);
const bad = validator({ save: (cmd) => (cmd.target === 'bad' ? 'bad' : null) });

const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus({ retry: false })],
  ['test', () => createTestBus({ passthroughHandlers: true })],
];

describe.each(BUSES)('rules on the %s bus', (_name, make) => {
  it('a refused command takes no rateLimit slot', async () => {
    const bus = make();
    bus.register('save', () => 1);
    bus.use(rateLimit({ max: 1, window: 60_000 }));
    bus.use(validator({ save: (cmd) => (cmd.target === 'bad' ? 'bad' : null) }));
    expect(code(await bus.dispatch('save', 'bad'))).toBe('validator:invalid:payload');
    expect(code(await bus.dispatch('save', 'ok'))).toBe('ok');
  });

  it('a refused command is no failure to circuitBreaker', async () => {
    const bus = make();
    bus.register('save', () => 1);
    bus.use(circuitBreaker({ threshold: 1 }));
    bus.use(validator({ save: (cmd) => (cmd.target === 'bad' ? 'bad' : null) }));
    await bus.dispatch('save', 'bad');
    expect(code(await bus.dispatch('save', 'ok'))).toBe('ok');
  });

  it('a rule part is resolved once per action', async () => {
    let asked = 0;
    const bus = make();
    bus.register('save', () => 1);
    bus.use({ authorize: () => { asked++; return undefined; } } as never);
    await bus.dispatch('save', 1);
    await bus.dispatch('save', 2);
    expect(asked).toBe(1);
  });

  it('authorization answers before validation, whatever the install order', async () => {
    const bus = make();
    bus.register('save', () => 1);
    bus.use(validator({ save: () => 'bad' }));
    bus.use(authGuard({ isAuthenticated: () => false, protected: ['save'] }));
    expect(code(await bus.dispatch('save', 1))).toBe('authGuard:unauthenticated:action');
  });

  it('a query is refused (control)', async () => {
    const bus = make();
    bus.register('save', () => 1);
    bus.use(bad);
    expect(code(await bus.query('save', 'bad'))).toBe('validator:invalid:payload');
  });

  it('a query a rule lets through runs the work', async () => {
    const bus = make();
    bus.register('save', () => 7);
    bus.use(bad);
    expect(await bus.query('save', 'ok')).toMatchObject({ ok: true, value: 7 });
  });

  it('a request to a responder is refused before the responder runs', async () => {
    let answered = 0;
    const bus = make() as unknown as AsyncCommandBus;
    bus.respond('save', () => { answered++; return 1; });
    bus.use(bad);
    expect(code(await bus.request('save', 'bad'))).toBe('validator:invalid:payload');
    expect(code(await bus.request('save', 'good'))).toBe('ok');
    expect(answered).toBe(1);
  });

  it('the remover drops the rule (control)', async () => {
    const bus = make();
    bus.register('save', () => 1);
    const off = bus.use(validator({ save: () => 'bad' }));
    off();
    expect(code(await bus.dispatch('save', 1))).toBe('ok');
  });

  it("a rule's throw is its plugin's failure (control)", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = make();
    bus.register('save', () => 1);
    bus.use(validator({ save: () => { throw new Error('boom'); } }));
    expect(code(await bus.dispatch('save', 1))).toBe('validator:failed:plugin');
    vi.restoreAllMocks();
  });
});

describe('rules on the async bus', () => {
  it('a refused optimistic command answers the refusal, not an Accepted', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const shown: unknown[] = [];
    bus.register('save', async (cmd) => { shown.push(cmd.target); return 1; }, { undo: () => {}, optimistic: true });
    bus.use(validator({ save: () => 'bad' }));
    const r = await bus.dispatch('save', 1);
    expect(code(r)).toBe('validator:invalid:payload');
    expect(shown).toEqual([]);
  });

  it('a rule runs once, never per retry (control)', async () => {
    let asked = 0;
    let calls = 0;
    const bus = createAsyncCommandBus({ retry: { maxAttempts: 3, baseDelay: 0, maxDelay: 0 } });
    bus.register('save', async () => {
      calls++;
      if (calls < 3) throw _failures('test')('timeout:save', 'busy');
      return 1;
    });
    bus.use(validator({ save: () => { asked++; return null; } }));
    const r = await bus.dispatch('save', 1);
    expect({ result: code(r), calls, asked }).toEqual({ result: 'ok', calls: 3, asked: 1 });
  });

  it('a query an async rule lets through runs the work', async () => {
    const passing = { '~standard': { version: 1, vendor: 'test', validate: async () => ({ value: 1 }) } } as never;
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 7);
    bus.use(validateSchemasAsync({ save: passing }));
    expect(await bus.query('save', 1)).toMatchObject({ ok: true, value: 7 });
  });

  it('an async rule that rejects answers its own failed:plugin', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    bus.use({ id: 'late', validate: () => async () => { throw new Error('boom'); } } as never);
    expect(code(await bus.dispatch('save', 1))).toBe('late:failed:plugin');
    vi.restoreAllMocks();
  });

  it('an async rule that lets it through hands on to the next rule', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    bus.use({ id: 'slow', validate: () => async () => undefined } as never);
    bus.use(validator({ save: () => 'bad' }));
    expect(code(await bus.dispatch('save', 1))).toBe('validator:invalid:payload');
  });

  it('a query refused by an async rule settles its async after-hook', async () => {
    const rejecting = { '~standard': { version: 1, vendor: 'test', validate: async () => ({ issues: [{ message: 'bad' }] }) } } as never;
    const bus = createAsyncCommandBus({ retry: false });
    const heard: string[] = [];
    bus.register('save', async () => 1);
    bus.onAfter(async (cmd) => { heard.push(cmd.action); });
    bus.use(validateSchemasAsync({ save: rejecting }));
    expect(code(await bus.query('save', 1))).toBe('validateSchemas:invalid:payload');
    expect(heard).toEqual(['save']);
  });

  it('keeps its answers after the per-action cache fills and clears (control: 513 actions)', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    for (let i = 0; i <= 512; i++) bus.register(`a${i}`, async () => 1);
    bus.use(validator({ a0: () => 'bad' }));
    expect(code(await bus.dispatch('a0', 1))).toBe('validator:invalid:payload');
    for (let i = 1; i <= 512; i++) await bus.dispatch(`a${i}`, 1);
    expect(code(await bus.dispatch('a0', 1))).toBe('validator:invalid:payload');
    expect(code(await bus.dispatch('a512', 1))).toBe('ok');
  });

  it('runs before a responder (control)', async () => {
    let answered = 0;
    const bus = createAsyncCommandBus({ retry: false });
    bus.respond('save', () => { answered++; return 1; });
    bus.use(bad);
    expect(code(await bus.request('save', 'bad'))).toBe('validator:invalid:payload');
    expect(answered).toBe(0);
  });

  it('an async rule refuses (control)', async () => {
    const rejecting = { '~standard': { version: 1, vendor: 'test', validate: async () => ({ issues: [{ message: 'bad' }] }) } } as never;
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async () => 1);
    bus.use(validateSchemasAsync({ save: rejecting }));
    expect(code(await bus.dispatch('save', 1))).toBe('validateSchemas:invalid:payload');
  });
});

/*
 * Plan 1.32 step 7b (.probes/step-7-pickup.md). Validation and authorization
 * are the command's own (plan-transport-owned.md revision 17): `validator`,
 * `authGuard`, `schemaValidator` and `validateSchemas(Async)` declare a
 * `validate` or `authorize` part, and the bus runs every authorize rule, then
 * every validate rule, after the before-hooks and before every chain plugin
 * and the work. So a refused command never reaches a limit (rateLimit,
 * circuitBreaker), a substitute (cache) or a retry, and an optimistic one is
 * never shown. A rule part is asked once per action. The controls show the
 * paths that already refused before this step: a query, a responder, an
 * async rule, a rule's throw.
 */
