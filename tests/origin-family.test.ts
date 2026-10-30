/**
 * The origin marker that travels on the dispatch (`__origin` read by stampMeta), its consumers (MCP, redo, createReaction), and TestBus meta.
 * Why: a module-level flag set before an await and cleared in `finally` is gone when an async bus runs its plugin chain, so a local dispatch would be attributed to the agent, redo() would record twice and a reaction loop would run unbounded.
 * Shows: _withOrigin marks only the first dispatch and does not leak or lose the mark across an await; MCP, redo() and reactions behave on an async bus; TestBus stamps meta like the real bus.
 */
import { describe, expect, vi } from 'vitest';
import {
  createAsyncCommandBus,
  createCommandBus,
  createReaction,
  resetCommandBus,
  setCommandBus,
} from '../src/index';
import { _withOrigin } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { idempotent } from '../src/plugins-extra';
import { useCommandHistory } from '../src/chamber';
import { createMcpHandler } from '../src/mcp';
import { it } from '../src/vitest';

describe('item 18 - MCP origin attribution on an async bus', () => {
  it('stamps the MCP dispatch and only the MCP dispatch', async ({ asyncBus: bus }) => {
    const origins: Array<{ action: string; origin: unknown }> = [];
    bus.use({ started: (cmd) => { origins.push({ action: cmd.action, origin: cmd.meta?.origin }); } });

    let releaseAgentCall: (() => void) | null = null as (() => void) | null;
    bus.register('agentWrite', async () => {
      await new Promise<void>((resolve) => {
        releaseAgentCall = resolve;
      });
      return 'done';
    });
    bus.register('localWrite', async () => 'done');

    const handler = createMcpHandler(
      Object.assign(bus, { getSchema: () => ({ agentWrite: {}, localWrite: {} }) }) as never,
    );

    const agentCall = handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'agentWrite', arguments: { target: {} } },
    });
    await vi.waitFor(() => expect(releaseAgentCall).not.toBeNull());

    // The local dispatch runs while the agent call is parked in its handler.
    await bus.dispatch('localWrite', {});
    releaseAgentCall?.();
    await agentCall;

    expect(origins).toEqual([
      { action: 'agentWrite', origin: 'agent' },
      { action: 'localWrite', origin: undefined },
    ]);
  });
});

describe('item 28 - redo() on an async bus records once', () => {
  afterEach(() => resetCommandBus());

  it('past contains the redone command exactly once', async ({ asyncBus: bus }) => {
    setCommandBus(bus as never);
    bus.register('add', async () => 'ok', { undo: () => {} });

    const history = useCommandHistory();
    await bus.dispatch('add', { id: 1 });
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));

    history.undo();
    expect(history.past.value).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0)); // an undo is a command: async on this bus

    history.redo();
    await new Promise((r) => setTimeout(r, 10)); // let the async dispatch settle

    expect(history.past.value).toHaveLength(1);
    expect(history.canRedo.value).toBe(false);
  });

  it('a PRIMITIVE payload (which cannot carry __origin) still records once - identity fallback', async ({ asyncBus: bus }) => {
    // A primitive payload cannot carry the marker, so redo() arms a one-shot identity match instead.
    setCommandBus(bus as never);
    bus.register('setCount', async () => 'ok', { undo: () => {} });

    const history = useCommandHistory();
    await bus.dispatch('setCount', { id: 1 }, 5); // primitive payload
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));

    history.undo();
    await new Promise((r) => setTimeout(r, 0)); // an undo is a command: async on this bus
    history.redo();
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20)); // grace: a double-record would land here

    expect(history.past.value).toHaveLength(1);
    expect(history.past.value[0]?.payload).toBe(5);
    expect(history.canRedo.value).toBe(false);
  });

  it('the identity fallback is one-shot - a later identical dispatch records normally', async ({ asyncBus: bus }) => {
    setCommandBus(bus as never);
    const target = { id: 1 };
    bus.register('setCount', async () => 'ok', { undo: () => {} });

    const history = useCommandHistory();
    await bus.dispatch('setCount', target, 5);
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));
    history.undo();
    await new Promise((r) => setTimeout(r, 0)); // an undo is a command: async on this bus
    history.redo();
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(history.past.value).toHaveLength(1);

    // Same action/target/payload outside any redo: the consumed fallback must not swallow it.
    await bus.dispatch('setCount', target, 5);
    await vi.waitFor(() => expect(history.past.value).toHaveLength(2));
  });
});

describe('item 33 - createReaction cycles', () => {
  it('refuses a directly self-matching reaction at install', () => {
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    let runs = 0;
    bus.register('cartRecalculate', () => {
      runs++;
      return 1;
    });

    createReaction('cart*', 'cartRecalculate').install(bus);
    bus.dispatch('cartRecalculate', {});

    expect(error).toHaveBeenCalledWith(expect.stringContaining('matches its own target'));
    expect(runs).toBe(1); // the dispatch itself, with no reaction feedback
  });

  it('allowSelfMatch still caps the chain at maxHops on an async bus', async () => {
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    let runs = 0;
    bus.register('cartRecalculate', async () => {
      runs++;
      return 1;
    });

    createReaction('cart*', 'cartRecalculate', { allowSelfMatch: true, maxHops: 3 }).install(bus);
    await bus.dispatch('cartRecalculate', {});
    await new Promise((r) => setTimeout(r, 50)); // an unbounded loop would still be going

    expect(runs).toBeLessThanOrEqual(4); // original + 3 hops
    expect(error).toHaveBeenCalledWith(expect.stringContaining('maxHops'));
  });

  // The hop counter rides `__reactionHops` in the payload, which a primitive or array cannot carry.
  // Sync bus so the run ends either way (depth 16 backstops it); the assertion is which bound stopped it.
  it.each([
    ['a number', () => 42],
    ['an array', () => [1, 2]],
    ['a string', () => 'x'],
  ])('caps the chain at maxHops when mapPayload returns %s', (_label, mapPayload) => {
    using error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createCommandBus();
    let runs = 0;
    bus.register('cartRecalculate', () => {
      runs++;
      return 1;
    });

    createReaction('cart*', 'cartRecalculate', {
      allowSelfMatch: true,
      maxHops: 3,
      mapPayload,
    }).install(bus);
    bus.dispatch('cartRecalculate', {});

    expect(runs).toBeLessThanOrEqual(4); // original + 3 hops
    expect(error).toHaveBeenCalledWith(expect.stringContaining('maxHops'));
  });

  it('propagates causation even when mapPayload returns a primitive', ({ bus }) => {
    const seen: Array<{ causationId?: string }> = [];
    bus.register('cartAdd', () => 1);
    bus.register('inventoryCheck', (cmd) => {
      seen.push({ causationId: cmd.meta?.causationId });
      return 1;
    });

    createReaction('cartAdd', 'inventoryCheck', { mapPayload: () => 7 }).install(bus);
    bus.dispatch('cartAdd', {});

    expect(seen).toHaveLength(1);
    expect(seen[0].causationId).toBeDefined();
  });

  it('a normal (non-self-matching) reaction is unaffected', ({ bus }) => {
    const dst = vi.fn(() => 1);
    bus.register('cartAdd', () => 1);
    bus.register('inventoryCheck', dst);

    createReaction('cartAdd', 'inventoryCheck').install(bus);
    bus.dispatch('cartAdd', {});

    expect(dst).toHaveBeenCalledTimes(1);
  });
});

describe('item 19 - TestBus commands carry meta', () => {
  it('stamps the same meta the real bus does', () => {
    const bus = createTestBus();
    let seen: unknown;
    bus.use({ started: (cmd) => { seen = cmd.meta; } });
    bus.dispatch('act', {});

    expect(seen).toMatchObject({ ts: expect.any(Number), id: expect.any(String) });
  });

  it('meta-dependent plugins actually run instead of no-opping', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.use(idempotent());
    const seen: Array<string | undefined> = [];
    // The key is stamped at the work's step, so the work reads it.
    bus.register('save', (cmd) => { seen.push(cmd.meta?.idempotencyKey); });

    bus.dispatch('save', { id: 1 });

    // `idempotent` guards on `cmd.meta`; without meta it would take its no-op branch.
    expect(seen[0]).toBeTypeOf('string');
  });

  it('query() stamps meta too', () => {
    const bus = createTestBus();
    let seen: unknown;
    bus.use({ started: (cmd) => { seen = cmd.meta; } });
    bus.query('read', {});
    expect(seen).toMatchObject({ id: expect.any(String) });
  });
});

describe('_withOrigin - slot discipline', () => {
  it('is one-shot: only the FIRST dispatch inside the callback is marked', ({ bus }) => {
    const origins: unknown[] = [];
    bus.register('a', (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    _withOrigin('sync', () => {
      bus.dispatch('a', {});
      bus.dispatch('a', {}); // slot already consumed
    });
    bus.dispatch('a', {}); // well after the callback

    expect(origins).toEqual(['sync', undefined, undefined]);
  });

  it('does not leak when the callback throws BEFORE any dispatch stamps meta', () => {
    // `validateNaming` throws before stampMeta runs; without the `finally` the slot would survive to the next dispatch.
    const strict = createCommandBus({
      naming: { pattern: /^[a-z][a-zA-Z0-9]*$/, onViolation: 'throw' },
    });
    const origins: unknown[] = [];
    strict.register('goodName', (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    expect(() => _withOrigin('agent', () => strict.dispatch('Bad Name!', {}))).toThrow();

    strict.dispatch('goodName', {});
    expect(origins).toEqual([undefined]);
  });

  it('survives an await: the slot is consumed in the synchronous prologue', async ({ asyncBus: bus }) => {
    const origins: unknown[] = [];
    bus.register('a', async (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    await _withOrigin('agent', () => bus.dispatch('a', {}));
    await bus.dispatch('a', {});

    expect(origins).toEqual(['agent', undefined]);
  });

  it('an explicit __origin payload key still works (public convention)', ({ bus }) => {
    const origins: unknown[] = [];
    bus.register('a', (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    bus.dispatch('a', {}, { __origin: 'custom' });
    // The slot wins when both are present.
    _withOrigin('sync', () => bus.dispatch('a', {}, { __origin: 'custom' }));

    expect(origins).toEqual(['custom', 'sync']);
  });
});
