/**
 * The flag-across-await family (TODO items 18, 24, 28, 33) and the TestBus meta
 * gap (19) — five consumers of one fix: a marker that travels ON the dispatch
 * (`__origin` read by stampMeta) instead of a module-level flag set before an
 * await and cleared in `finally`.
 *
 * Every one of these passes on a sync bus, which is why the whole family
 * survived a green suite: on a sync bus the dispatch completes inside the
 * `try`, so the flag holds. On an async bus the plugin chain runs a microtask
 * later, after `finally` already fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAsyncCommandBus,
  createCommandBus,
  createReaction,
  resetCommandBus,
  setCommandBus,
} from '../src/index';
import { sync } from '../src/plugins';
import { createTestBus } from '../src/testing';
import { idempotent } from '../src/plugins-extra';
import { useCommandHistory } from '../src/chamber';
import { createMcpHandler } from '../src/mcp';

// ---------------------------------------------------------------------------
// 18 — agentOrigin across an await
// ---------------------------------------------------------------------------

describe('item 18 — MCP origin attribution on an async bus', () => {
  it('stamps the MCP dispatch and only the MCP dispatch', async () => {
    const bus = createAsyncCommandBus();
    const origins: Array<{ action: string; origin: unknown }> = [];
    bus.use(async (cmd, next) => {
      origins.push({ action: cmd.action, origin: cmd.meta?.origin });
      return next();
    });

    let releaseAgentCall: (() => void) | null = null;
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
      { action: 'localWrite', origin: undefined }, // was 'agent' — misattributed
    ]);
  });
});

// ---------------------------------------------------------------------------
// 24 — sync() echo suppression across an await
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
    // Real BroadcastChannel never echoes to the sender — that is precisely why
    // one tab looked fine and two tabs ping-ponged.
    for (const peer of FakeChannel.channels.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) peer.onmessage?.({ data: structuredClone(data) });
    }
  }
  close(): void {
    this.closed = true;
  }
}

describe('item 24 — sync() on an async bus does not loop', () => {
  beforeEach(() => {
    FakeChannel.channels.clear();
    vi.stubGlobal('BroadcastChannel', FakeChannel);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('one dispatch produces exactly one broadcast per tab', async () => {
    const busA = createAsyncCommandBus();
    const busB = createAsyncCommandBus();
    const runsA: string[] = [];
    const runsB: string[] = [];
    busA.register('setCount', async (cmd) => {
      runsA.push(cmd.action);
      return 1;
    });
    busB.register('setCount', async (cmd) => {
      runsB.push(cmd.action);
      return 1;
    });

    const syncA = sync({ channel: 'tabs' }, { dispatch: busA.dispatch });
    const syncB = sync({ channel: 'tabs' }, { dispatch: busB.dispatch });
    busA.use(syncA);
    busB.use(syncB);

    await busA.dispatch('setCount', { n: 1 });
    // Let any ping-pong run: without the fix each hop schedules the next.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));

    expect(runsA).toHaveLength(1); // the original
    expect(runsB).toHaveLength(1); // the mirrored copy, dispatched once
    syncA.close();
    syncB.close();
  });
});

// ---------------------------------------------------------------------------
// 28 — redo() double-record across an await
// ---------------------------------------------------------------------------

describe('item 28 — redo() on an async bus records once', () => {
  afterEach(() => resetCommandBus());

  it('past contains the redone command exactly once', async () => {
    const bus = createAsyncCommandBus();
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

  it('a PRIMITIVE payload (which cannot carry __origin) still records once — identity fallback', async () => {
    // The marker rides the payload object; a primitive payload has nowhere
    // to put it. redo() arms a one-shot identity match instead. Without it,
    // the hook records the redo a second time on BOTH bus types.
    const bus = createAsyncCommandBus();
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

  it('the identity fallback is one-shot — a later identical dispatch records normally', async () => {
    const bus = createAsyncCommandBus();
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

    // Same action/target/payload dispatched AGAIN, outside any redo — the
    // consumed fallback must not swallow it.
    await bus.dispatch('setCount', target, 5);
    await vi.waitFor(() => expect(history.past.value).toHaveLength(2));
  });
});

// ---------------------------------------------------------------------------
// 33 — self-matching reactions
// ---------------------------------------------------------------------------

describe('item 33 — createReaction cycles', () => {
  it('refuses a directly self-matching reaction at install', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    error.mockRestore();
  });

  it('allowSelfMatch still caps the chain at maxHops on an async bus', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    error.mockRestore();
  });

  it('a normal (non-self-matching) reaction is unaffected', () => {
    const bus = createCommandBus();
    const dst = vi.fn(() => 1);
    bus.register('cartAdd', () => 1);
    bus.register('inventoryCheck', dst);

    createReaction('cartAdd', 'inventoryCheck').install(bus);
    bus.dispatch('cartAdd', {});

    expect(dst).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 19 — TestBus meta
// ---------------------------------------------------------------------------

describe('item 19 — TestBus commands carry meta', () => {
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
    bus.use(idempotent());
    const seen: Array<string | undefined> = [];
    bus.use((cmd, next) => {
      seen.push(cmd.meta?.idempotencyKey);
      return next();
    });

    bus.dispatch('save', { id: 1 });

    // `idempotent` guards on `cmd.meta` and silently took its no-op branch —
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
