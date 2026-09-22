/**
 * The flag-across-await family (TODO items 18, 24, 28, 33) and the TestBus meta
 * gap - five consumers of one fix: a marker that travels ON the dispatch
 * (`__origin` read by stampMeta) instead of a module-level flag set before an
 * await and cleared in `finally`.
 *
 * Every one of these passes on a sync bus, which is why the whole family
 * survived a green suite: on a sync bus the dispatch completes inside the
 * `try`, so the flag holds. On an async bus the plugin chain runs a microtask
 * later, after `finally` already fired.
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

// ---------------------------------------------------------------------------
// 18 - agentOrigin across an await
// ---------------------------------------------------------------------------

describe('item 18 - MCP origin attribution on an async bus', () => {
  it('stamps the MCP dispatch and only the MCP dispatch', async ({ asyncBus: bus }) => {
    const origins: Array<{ action: string; origin: unknown }> = [];
    bus.use(async (cmd, next) => {
      origins.push({ action: cmd.action, origin: cmd.meta?.origin });
      return next();
    });

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

    // MCP call goes in flight and parks inside its handler...
    const agentCall = handler({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'agentWrite', arguments: { target: {} } },
    });
    await vi.waitFor(() => expect(releaseAgentCall).not.toBeNull());

    // ...and a LOCAL dispatch enters the chain during exactly that window.
    await bus.dispatch('localWrite', {});
    releaseAgentCall?.();
    await agentCall;

    expect(origins).toEqual([
      { action: 'agentWrite', origin: 'agent' },
      { action: 'localWrite', origin: undefined }, // was 'agent' - misattributed
    ]);
  });
});

// ---------------------------------------------------------------------------
// 24 - sync() echo suppression across an await
// ---------------------------------------------------------------------------

class FakeChannel {
  static channels = new Map<string, FakeChannel[]>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public name: string) {
    const peers = FakeChannel.channels.get(name) ?? [];
    peers.push(this);
    FakeChannel.channels.set(name, peers);
  }
  postMessage(data: unknown): void {
    // Real BroadcastChannel never echoes to the sender - that is precisely why
    // one tab looked fine and two tabs ping-ponged.
    for (const peer of FakeChannel.channels.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) peer.onmessage?.({ data: structuredClone(data) });
    }
  }
  close(): void {
    this.closed = true;
  }
}

// ---------------------------------------------------------------------------
// 28 - redo() double-record across an await
// ---------------------------------------------------------------------------

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

    history.redo();
    await new Promise((r) => setTimeout(r, 10)); // let the async dispatch settle

    expect(history.past.value).toHaveLength(1); // was 2
    expect(history.canRedo.value).toBe(false);
  });

  it('a PRIMITIVE payload (which cannot carry __origin) still records once - identity fallback', async ({ asyncBus: bus }) => {
    // The marker rides the payload object; a primitive payload has nowhere
    // to put it. redo() arms a one-shot identity match instead. Without it,
    // the hook records the redo a second time on BOTH bus types.
    setCommandBus(bus as never);
    bus.register('setCount', async () => 'ok', { undo: () => {} });

    const history = useCommandHistory();
    await bus.dispatch('setCount', { id: 1 }, 5); // primitive payload
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));

    history.undo();
    history.redo();
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20)); // grace: a double-record would land here

    expect(history.past.value).toHaveLength(1); // double-recorded before the fallback
    expect(history.past.value[0]?.payload).toBe(5); // handler saw the primitive untouched
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
    history.redo();
    await vi.waitFor(() => expect(history.past.value).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(history.past.value).toHaveLength(1);

    // Same action/target/payload dispatched AGAIN, outside any redo - the
    // consumed fallback must not swallow it.
    await bus.dispatch('setCount', target, 5);
    await vi.waitFor(() => expect(history.past.value).toHaveLength(2));
  });
});

// ---------------------------------------------------------------------------
// 33 - self-matching reactions
// ---------------------------------------------------------------------------

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

  // The hop counter rides `__reactionHops` in the payload - the same convention
  // `__origin` was MOVED OFF for this exact reason: a primitive or an array
  // cannot carry a key. When `mapPayload` returns one, the marker is dropped,
  // every hop reads as hop 1, and the cap that bounds an unbounded async loop
  // never fires. Sync bus here so the run terminates either way (depth 16
  // backstops it) and the assertion is about which bound did the stopping.
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

    // Without the marker the chain runs until MAX_DISPATCH_DEPTH (16) instead.
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

// ---------------------------------------------------------------------------
// 19 - TestBus meta
// ---------------------------------------------------------------------------

describe('item 19 - TestBus commands carry meta', () => {
  it('stamps the same meta the real bus does', () => {
    const bus = createTestBus();
    let seen: unknown;
    bus.use((cmd, next) => {
      seen = cmd.meta;
      return next();
    });
    bus.dispatch('act', {});

    expect(seen).toMatchObject({ ts: expect.any(Number), id: expect.any(String) });
  });

  it('meta-dependent plugins actually run instead of no-opping', () => {
    const bus = createTestBus();
    bus.use(idempotent() as never); // AsyncPlugin on a TestBus, on purpose - see the title
    const seen: Array<string | undefined> = [];
    bus.use((cmd, next) => {
      seen.push(cmd.meta?.idempotencyKey);
      return next();
    });

    bus.dispatch('save', { id: 1 });

    // `idempotent` guards on `cmd.meta` and silently took its no-op branch -
    // a test wiring it to the TestBus passed while verifying nothing.
    expect(seen[0]).toBeTypeOf('string');
  });

  it('query() stamps meta too', () => {
    const bus = createTestBus();
    let seen: unknown;
    bus.use((cmd, next) => {
      seen = cmd.meta;
      return next();
    });
    bus.query('read', {});
    expect(seen).toMatchObject({ id: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// _withOrigin - the one-shot slot the three marker sites share
// ---------------------------------------------------------------------------

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
    // Leak protection, not a settlement guard. `validateNaming` throws inside
    // dispatch before stampMeta runs, so without the `finally` the slot would
    // survive and mis-attribute whatever dispatched next.
    const strict = createCommandBus({
      naming: { pattern: /^[a-z][a-zA-Z0-9]*$/, onViolation: 'throw' },
    });
    const origins: unknown[] = [];
    strict.register('goodName', (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    expect(() => _withOrigin('agent', () => strict.dispatch('Bad Name!', {}))).toThrow();

    // The next, unrelated dispatch must be unattributed.
    strict.dispatch('goodName', {});
    expect(origins).toEqual([undefined]);
  });

  it('survives an await: the slot is consumed in the synchronous prologue', async ({ asyncBus: bus }) => {
    const origins: unknown[] = [];
    bus.register('a', async (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    // The mcp.ts shape - await the result of the wrapped dispatch.
    await _withOrigin('agent', () => bus.dispatch('a', {}));
    await bus.dispatch('a', {});

    expect(origins).toEqual(['agent', undefined]);
  });

  it('an explicit __origin payload key still works (public convention)', ({ bus }) => {
    const origins: unknown[] = [];
    bus.register('a', (cmd: any) => { origins.push(cmd.meta?.origin); return 1; });

    bus.dispatch('a', {}, { __origin: 'custom' });
    // ...and the slot wins when both are present.
    _withOrigin('sync', () => bus.dispatch('a', {}, { __origin: 'custom' }));

    expect(origins).toEqual(['custom', 'sync']);
  });
});
