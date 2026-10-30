/**
 * A handler a transport would shadow is refused at register() with `core:invalid:handler`.
 * Why: a handler for an action a transport sends would never run, so it is refused in every build at the line that registers; it stays allowed where it can run (`optimistic`, or a transport with `localFallback`).
 * Shows: http, ws, outbox-wrapped and test-bus transports refuse a handler while an uncovered action registers and runs; `null` declares a sent action's options (answer, undo, store reducer) and is refused where no transport sends; production messages state the fact; a store function reducer for a sent action is refused naming the action.
 * See: log s35.41, log s35.75, log s36.F25
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type CommandResult } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import { defineChamberStore } from '../src/store';
import { createTestBus } from '../src/testing';
import { defineTransport, httpTransport, wsTransport } from '../src/transports';
import { MockWebSocket } from './backend-stubs';

afterEach(() => { vi.unstubAllGlobals(); });

function countingClient(state: unknown = { n: 1 }) {
  const s = { calls: 0 };
  const httpClient = { post: vi.fn(async () => { s.calls++; return { ok: true, status: 200, headers: {}, data: { state } }; }) } as any;
  return { s, httpClient };
}

const codeOf = (fn: () => unknown): unknown => {
  try { fn(); } catch (e) { return (e as { code?: string }).code; }
  return undefined;
};

describe('register() and an action a transport sends', () => {
  it('CONTROL: without a transport the handler runs', async () => {
    const bus = createAsyncCommandBus();
    let ran = 0;
    bus.register('cartAdd', async () => { ran++; return 1; });
    await bus.dispatch('cartAdd', {});
    expect(ran).toBe(1);
  });

  it('CONTROL: an action no pattern covers registers and runs', async () => {
    const { s, httpClient } = countingClient();
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    let ran = 0;
    bus.register('uiApply', async () => { ran++; return 1; });
    await bus.dispatch('uiApply', {});
    expect(ran).toBe(1);
    expect(s.calls).toBe(0);
  });

  it('httpTransport: a handler is refused with core:invalid:handler', () => {
    const { httpClient } = countingClient();
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    expect(codeOf(() => bus.register('cartAdd', async () => 1))).toBe('core:invalid:handler');
    expect(bus.registeredActions?.() ?? []).not.toContain('cartAdd');
  });

  it('wsTransport: the same', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    const bus = createAsyncCommandBus({ transport: wsTransport({ url: 'ws://test' }) });
    expect(codeOf(() => bus.register('chatSend', async () => 1))).toBe('core:invalid:handler');
  });

  it('through an outbox: the same, and its wrapper keeps the transport\'s localFallback', async () => {
    const outbox = createOutbox({ storage: null, isOnline: () => true });
    const sent = defineTransport(async () => ({ ok: true, value: 'remote', error: undefined }));
    const bus = createAsyncCommandBus({ transport: { 'cart*': sent, 'ui*': defineTransport(async (_c, local) => local(), { localFallback: true }) }, outbox });
    expect(codeOf(() => bus.register('cartAdd', async () => 1))).toBe('core:invalid:handler');
    bus.register('uiApply', async () => 'local');
    expect((await bus.dispatch('uiApply', null)).value).toBe('local');
    outbox.dispose();
  });

  it('the test bus: the same rule', () => {
    const { httpClient } = countingClient();
    const bus = createTestBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    expect(codeOf(() => bus.register('cartAdd', () => 1))).toBe('core:invalid:handler');
    bus.register('cartAdd', null, { undo: () => {} });
    bus.register('uiApply', () => 1);
    expect(codeOf(() => bus.register('uiOther', null))).toBe('core:invalid:handler');
  });

  it('optimistic: the handler is the change shown, so it registers and runs', async () => {
    const { s, httpClient } = countingClient();
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    let ran = 0;
    bus.register('cartAdd', async () => { ran++; return 1; }, { undo: () => {}, optimistic: true });
    const r = await bus.dispatch('cartAdd', {});
    await (r.value as { done: Promise<CommandResult> }).done;
    expect(ran).toBe(1);
    expect(s.calls).toBe(1);
  });

  it('a transport that declares localFallback: the handler registers, and local() runs it', async () => {
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async (cmd, local) => (cmd.target === 'offline' ? local() : { ok: true, value: 'remote', error: undefined }), { localFallback: true }) });
    bus.register('cartAdd', async () => 'local');
    expect((await bus.dispatch('cartAdd', 'offline')).value).toBe('local');
    expect((await bus.dispatch('cartAdd', 'online')).value).toBe('remote');
  });

  it("null declares a sent action's options with no handler: its answer lands", async () => {
    const { httpClient } = countingClient({ items: [7] });
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    const answers: unknown[] = [];
    bus.register('cartAdd', null, { answer: (_cmd, value) => { answers.push(value); } });
    const r = await bus.dispatch('cartAdd', {});
    expect(r.ok).toBe(true);
    expect(answers).toEqual([{ items: [7] }]);
  });

  it("null under a localFallback transport: local() gives the missing-handler outcome", async () => {
    const bus = createAsyncCommandBus({ retry: false, transport: defineTransport(async (_c, local) => local(), { localFallback: true }) });
    bus.register('cartAdd', null);
    expect((await bus.dispatch('cartAdd', null)).error).toMatchObject({ code: 'core:missing:handler' });
  });

  it('null on an action no transport sends is refused, on either bus', () => {
    expect(codeOf(() => createAsyncCommandBus().register('cartAdd', null))).toBe('core:invalid:handler');
    // @ts-expect-error the sync bus type takes no null: a JavaScript caller meets the refusal.
    expect(codeOf(() => createCommandBus().register('cartAdd', null))).toBe('core:invalid:handler');
  });

  it('a handler that is neither a function nor null is refused', () => {
    // @ts-expect-error a JavaScript caller can pass anything.
    expect(codeOf(() => createCommandBus().register('cartAdd', 'nope'))).toBe('core:invalid:handler');
  });

  it('optimistic with null is refused: there is no change to show', () => {
    const { httpClient } = countingClient();
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient }) });
    expect(codeOf(() => bus.register('cartAdd', null, { undo: () => {}, optimistic: true }))).toBe('core:invalid:option');
  });

  it('a register over a library local action follows the app rule', async () => {
    const { s, httpClient } = countingClient();
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient }) });
    const { history } = await import('../src/plugins-core');
    history({ bus, undoAction: 'historyUndo' });
    expect(codeOf(() => bus.register('historyUndo', async () => 1))).toBe('core:invalid:handler');
    bus.register('historyUndo', null);
    await bus.dispatch('historyUndo', null);
    expect(s.calls).toBe(1);
  });
});

describe('production', () => {
  it('each refusal carries the fact, the advice is DEV only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const fresh = await import('../src/command-bus');
      const messageOf = (fn: () => unknown): string => {
        try { fn(); } catch (e) { return (e as Error).message; }
        return '';
      };
      const sent = fresh.createAsyncCommandBus({ transport: { send: async () => ({ ok: true, value: 1, error: undefined }) } });
      expect(messageOf(() => sent.register('cartAdd', async () => 1))).toBe('register("cartAdd"): a transport sends "cartAdd", so this handler would never run.');
      expect(messageOf(() => fresh.createAsyncCommandBus().register('cartAdd', null))).toBe('register("cartAdd"): null declares the options of an action a transport sends, and no transport sends "cartAdd".');
      expect(messageOf(() => sent.register('cartAdd', null, { undo: () => {}, optimistic: true }))).toBe('register("cartAdd"): optimistic needs a handler.');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('a store behind a transport', () => {
  it('a null reducer gives the method and the action, and the answer is the state', async () => {
    const { s, httpClient } = countingClient({ items: [3] });
    const bus = createAsyncCommandBus({ transport: { cartAdd: httpTransport({ endpoint: '/api/vc', httpClient }) } });
    const cart = defineChamberStore('cart', {
      state: () => ({ items: [] as number[] }),
      reducers: { add: null, local: (st: { items: number[] }) => ({ items: [...st.items, 0] }) },
      answer: (_st, value) => value as { items: number[] },
    })(bus);
    await cart.add(3);
    expect(s.calls).toBe(1);
    expect(cart.state.value).toEqual({ items: [3] });
    await cart.local();
    expect(cart.state.value).toEqual({ items: [3, 0] });
    expect(s.calls).toBe(1);
    cart.$dispose();
  });

  it('a function reducer for a sent action is refused at useStore, naming the action', () => {
    const { httpClient } = countingClient();
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    const useCart = defineChamberStore('cart', { state: () => ({ n: 0 }), reducers: { add: (st: { n: number }) => ({ n: st.n + 1 }) } });
    let err: { code?: string; action?: string } | undefined;
    try { useCart(bus); } catch (e) { err = e as typeof err; }
    expect(err?.code).toBe('core:invalid:handler');
    expect(err?.action).toBe('cartAdd');
  });

  it('the same store with optimistic: true registers: the reducer is the change shown', async () => {
    const { httpClient } = countingClient({ n: 5 });
    const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc', httpClient }) } });
    const cart = defineChamberStore('cart', { state: () => ({ n: 0 }), reducers: { add: (st: { n: number }) => ({ n: st.n + 1 }), sync: null }, optimistic: true, answer: (_st, v) => v as { n: number } })(bus);
    const r = await cart.add();
    expect(cart.state.value).toEqual({ n: 1 });
    await (r as { value: { done: Promise<CommandResult> } }).value.done;
    expect(cart.state.value).toEqual({ n: 5 });
    await cart.sync();
    cart.$dispose();
  });
});
