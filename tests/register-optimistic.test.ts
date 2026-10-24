/** `register(action, handler, { undo, optimistic: true })`: the dispatch answers at once and a failure of the work runs the undo. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { BusError, type Command, type CommandResult, createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { rateLimit } from '../src/plugins-extra';
import { createTestBus } from '../src/testing';
import { defineTransport } from '../src/transports';

const doneOf = async (r: Promise<CommandResult>): Promise<CommandResult> => ((await r).value as Accepted).done;
const codeOf = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return (e as { code?: string }).code; } return undefined; };

afterEach(() => { vi.restoreAllMocks(); });

describe('optimistic on the async bus', () => {
  it('answers an Accepted before the work settles; done settles with its result', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let release!: () => void;
    const items: number[] = [];
    bus.register('cartAdd', async (cmd: Command) => {
      items.push(cmd.target);
      await new Promise<void>((r) => { release = r; });
      return items.length;
    }, { undo: (cmd: Command) => { items.splice(items.indexOf(cmd.target), 1); }, optimistic: true });
    const r = bus.dispatch('cartAdd', 7);
    expect((await r).value).toBeInstanceOf(Accepted);
    expect(items).toEqual([7]);
    release();
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 1 });
  });

  it('a failure of the work runs the undo, then done settles with the failure', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const items: number[] = [];
    const heard: string[] = [];
    bus.on('*', (cmd) => { heard.push(cmd.action); });
    bus.register('cartAdd', async (cmd: Command) => { items.push(cmd.target); throw new Error('down'); },
      { undo: (cmd: Command) => { items.splice(items.indexOf(cmd.target), 1); }, optimistic: true });
    const r = bus.dispatch('cartAdd', 7);
    const end = await doneOf(r);
    expect(end.ok).toBe(false);
    expect(items).toEqual([]);
    expect(heard).toEqual(['cartAdd$undo', 'cartAdd']);
  });

  it("a transport's failure runs the undo of the app's own local change", async () => {
    let count = 0;
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => ({ ok: false, value: undefined, error: new Error('refused') })) });
    bus.register('cartAdd', async () => 'local', { undo: () => { count--; }, optimistic: true });
    count++;
    expect((await doneOf(bus.dispatch('cartAdd', 1))).ok).toBe(false);
    expect(count).toBe(0);
  });

  it('a sent action: its handler is the change shown, run once, also as the transport\'s local fallback', async () => {
    let runs = 0;
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async (_cmd: unknown, local: () => Promise<CommandResult>) => local()) });
    bus.register('cartAdd', async () => ++runs, { undo: () => {}, optimistic: true });
    const r = bus.dispatch('cartAdd', 1);
    expect(runs).toBe(1);
    expect(await doneOf(r)).toMatchObject({ ok: true, value: 1 });
    expect(runs).toBe(1);
  });

  it('a rule that refuses before the work: the dispatch answers the refusal, and no undo runs', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let undone = 0;
    bus.use({ id: 'gate', authorize: () => async () => ({ ok: false, value: undefined, error: new Error('no') }) });
    bus.register('cartAdd', async () => 1, { undo: () => { undone++; }, optimistic: true });
    expect((await bus.dispatch('cartAdd', 1)).ok).toBe(false);
    expect(undone).toBe(0);
  });

  it('listeners and history hear the final result, not the Accepted', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const h = history({ bus });
    const values: unknown[] = [];
    bus.on('cartAdd', (_cmd, res) => { values.push(res.value); });
    bus.register('cartAdd', async () => 'saved', { undo: () => {}, optimistic: true });
    await doneOf(bus.dispatch('cartAdd', 1));
    expect(values).toEqual(['saved']);
    expect(h.getState().past.map((c) => c.action)).toEqual(['cartAdd']);
  });
});

describe('beside a plugin that refuses, and with exclusive (from tests/same-in-any-order.test.ts)', () => {
  it('rateLimit: a refused command is never applied, and never undone', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(rateLimit({ max: 1, window: 1000 }));
    let applied = 0;
    let undone = 0;
    bus.register('save', async () => { applied++; return 'ok'; }, { undo: () => { undone++; }, optimistic: true });
    await doneOf(bus.dispatch('save', { id: 1 }));
    expect((await doneOf(bus.dispatch('save', { id: 1 }))).ok).toBe(false);
    expect({ applied, undone }).toEqual({ applied: 1, undone: 0 });
  });

  it('exclusive: the change shows at dispatch, not when the turn frees', async () => {
    let shown = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async () => { await gate; return { ok: true, value: 1, error: undefined }; }) });
    bus.register('save', async () => { shown++; return 1; }, { undo: () => {}, optimistic: true, exclusive: {} });
    const one = bus.dispatch('save', 1);
    const two = bus.dispatch('save', 2);
    await new Promise((r) => setTimeout(r, 1));
    expect(shown).toBe(2);
    release();
    await Promise.all([doneOf(one), doneOf(two)]);
  });
});

describe('optimistic: edges', () => {
  it("the bus's retry re-sends it without showing the change twice", async () => {
    let shown = 0;
    let sends = 0;
    const bus = createAsyncCommandBus({ retry: { baseDelay: 1, maxDelay: 2 }, transport: defineTransport(async () => {
      sends++;
      return sends === 1 ? { ok: false, value: undefined, error: new BusError('limited:busy', 'busy', { context: { retryIn: 1 } }) } : { ok: true, value: 'saved', error: undefined };
    }) });
    bus.register('save', async () => { shown++; return 1; }, { undo: () => {}, optimistic: true });
    expect(await doneOf(bus.dispatch('save', 1))).toMatchObject({ ok: true, value: 'saved' });
    expect({ shown, sends }).toEqual({ shown: 1, sends: 2 });
  });

  it('with exclusive, a key that throws: done settles with the failure, and no undo runs', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let undone = 0;
    bus.register('save', async () => 1, { undo: () => { undone++; }, optimistic: true, exclusive: { key: () => { throw new Error('no key'); } } });
    const end = await doneOf(bus.dispatch('save', 1));
    expect(end.ok).toBe(false);
    expect(undone).toBe(0);
  });

  it('a sent action whose handler a later register removed: the transport sends it, and a failure still runs the undo', async () => {
    let undone = 0;
    const sent: string[] = [];
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async (cmd: { action: string }) => { sent.push(cmd.action); return { ok: false, value: undefined, error: new Error('refused') }; }) });
    bus.register('save', async () => 1, { undo: () => { undone++; }, optimistic: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.register('save', null)(); // null removes the handler, its cleanup leaves the rest: the declaration and undo stay
    expect((await doneOf(bus.dispatch('save', 1))).ok).toBe(false);
    expect(sent).toEqual(['save']);
    expect(undone).toBe(1);
  });

  it('production: the refusal carries the fact, the advice is DEV only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const fresh = await import('../src/command-bus');
      let message = '';
      try { fresh.createAsyncCommandBus().register('save', async () => 1, { optimistic: true }); } catch (e) { message = (e as Error).message; }
      expect(message).toBe('register("save"): optimistic needs an undo.');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('optimistic on the sync bus', () => {
  it('a throw of the handler runs the undo and returns the failure', () => {
    const bus = createCommandBus();
    const items: number[] = [];
    bus.register('cartAdd', (cmd: Command) => { items.push(cmd.target); throw new Error('down'); },
      { undo: (cmd: Command) => { items.splice(items.indexOf(cmd.target), 1); }, optimistic: true });
    expect(bus.dispatch('cartAdd', 7).ok).toBe(false);
    expect(items).toEqual([]);
  });

  it('a success returns its result as before', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 2, { undo: () => {}, optimistic: true });
    expect(bus.dispatch('cartAdd', 1)).toMatchObject({ ok: true, value: 2 });
  });
});

describe('the test bus', () => {
  it('runs the undo on a throw, as the sync bus does, and refuses optimistic without an undo', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    const items: number[] = [];
    bus.register('cartAdd', (cmd: Command) => { items.push(cmd.target); throw new Error('down'); },
      { undo: (cmd: Command) => { items.splice(items.indexOf(cmd.target), 1); }, optimistic: true });
    expect(bus.dispatch('cartAdd', 7).ok).toBe(false);
    expect(items).toEqual([]);
    expect(codeOf(() => createTestBus().register('x', () => 1, { optimistic: true }))).toBe('core:invalid:option');
  });
});

describe('declared without an undo', () => {
  it('is refused at register, on either bus', () => {
    expect(codeOf(() => createAsyncCommandBus().register('cartAdd', async () => 1, { optimistic: true }))).toBe('core:invalid:option');
    expect(codeOf(() => createCommandBus().register('cartAdd', () => 1, { optimistic: true }))).toBe('core:invalid:option');
  });
});

describe('control: an action without it', () => {
  it('answers its result, and a failure runs no undo', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    let undone = 0;
    bus.register('cartAdd', async () => { throw new Error('down'); }, { undo: () => { undone++; } });
    const r = await bus.dispatch('cartAdd', 1);
    expect(r.ok).toBe(false);
    expect(r.value).not.toBeInstanceOf(Accepted);
    expect(undone).toBe(0);
  });
});

/*
 * Plan 1.32 step 4k, owner 2026-10-20 ("Go: register options optimistic and exclusive"). The
 * `optimistic` and `optimisticUndo` plugins go; the action declares it, beside its `undo`.
 * The async dispatch answers an `Accepted` at once, as a held outbox command does, and the
 * listeners, the after-hooks and history hear the final result when it lands. A failure runs
 * the undo (`<action>$undo`) only when the work ran: a plugin that refuses first leaves
 * nothing to take back, where optimisticUndo undid a handler that never ran
 * (plan-architecture row 99). `predict` is gone: the screen already shows the local change.
 */
