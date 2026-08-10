/**
 * Tests for ssr.ts — createSSRPlugin + rehydrate
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, setCommandBus, resetCommandBus } from '../src';
import { createSSRPlugin, rehydrate, rehydrateAsync } from '../src/ssr';

describe('createSSRPlugin', () => {
  let bus: ReturnType<typeof createCommandBus>;

  beforeEach(() => {
    bus = createCommandBus();
    setCommandBus(bus);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('records successful dispatches', () => {
    bus.register('cartAdd', () => 'added');
    const ssr = createSSRPlugin();
    bus.use(ssr.plugin);

    bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
    bus.dispatch('cartAdd', { id: 2 });

    const commands = ssr.dehydrate();
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual({ action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 } });
    expect(commands[1]).toEqual({ action: 'cartAdd', target: { id: 2 } });
  });

  it('does not record failed dispatches', () => {
    bus.register('fail', () => { throw new Error('boom'); });
    const ssr = createSSRPlugin();
    bus.use(ssr.plugin);

    bus.dispatch('fail', {});

    expect(ssr.dehydrate()).toHaveLength(0);
  });

  it('filter option excludes matching commands', () => {
    bus.register('cartAdd', () => 'ok');
    bus.register('analyticsTrack', () => 'ok');
    const ssr = createSSRPlugin({
      filter: (cmd) => !cmd.action.startsWith('analytics'),
    });
    bus.use(ssr.plugin);

    bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('analyticsTrack', { event: 'page_view' });

    expect(ssr.dehydrate()).toHaveLength(1);
    expect(ssr.dehydrate()[0].action).toBe('cartAdd');
  });

  it('maxCommands limits recording', () => {
    bus.register('cmd', () => 'ok');
    const ssr = createSSRPlugin({ maxCommands: 3 });
    bus.use(ssr.plugin);

    for (let i = 0; i < 10; i++) bus.dispatch('cmd', { i });

    expect(ssr.dehydrate()).toHaveLength(3);
    expect(ssr.size()).toBe(3);
  });

  it('clear() resets recorded commands', () => {
    bus.register('cmd', () => 'ok');
    const ssr = createSSRPlugin();
    bus.use(ssr.plugin);

    bus.dispatch('cmd', {});
    expect(ssr.size()).toBe(1);

    ssr.clear();
    expect(ssr.size()).toBe(0);
    expect(ssr.dehydrate()).toHaveLength(0);
  });

  it('dehydrate() returns a copy, not a reference', () => {
    bus.register('cmd', () => 'ok');
    const ssr = createSSRPlugin();
    bus.use(ssr.plugin);

    bus.dispatch('cmd', { x: 1 });

    const a = ssr.dehydrate();
    const b = ssr.dehydrate();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it('omits payload key when payload is undefined', () => {
    bus.register('cmd', () => 'ok');
    const ssr = createSSRPlugin();
    bus.use(ssr.plugin);

    bus.dispatch('cmd', { x: 1 });

    const cmd = ssr.dehydrate()[0];
    expect(Object.keys(cmd)).toEqual(['action', 'target']);
  });
});

describe('rehydrate', () => {
  let bus: ReturnType<typeof createCommandBus>;

  beforeEach(() => {
    bus = createCommandBus();
    setCommandBus(bus);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('replays commands on the client bus', () => {
    const received: Array<{ action: string; target: any }> = [];
    bus.register('cartAdd', (cmd) => { received.push({ action: cmd.action, target: cmd.target }); });
    bus.register('cartClear', (cmd) => { received.push({ action: cmd.action, target: cmd.target }); });

    const commands = [
      { action: 'cartAdd', target: { id: 1 }, payload: { qty: 2 } },
      { action: 'cartAdd', target: { id: 2 } },
      { action: 'cartClear', target: {} },
    ];

    const results = rehydrate(bus, commands);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.ok)).toBe(true);
    expect(received).toHaveLength(3);
  });

  it('skips commands without handlers by default', () => {
    bus.register('cartAdd', () => 'ok');
    // 'orderCreate' has no handler

    const commands = [
      { action: 'cartAdd', target: { id: 1 } },
      { action: 'orderCreate', target: {} },
    ];

    const results = rehydrate(bus, commands);
    expect(results).toHaveLength(1); // only cartAdd
  });

  it('ignoreUnhandled: false dispatches all commands', () => {
    bus.register('cartAdd', () => 'ok');

    const commands = [
      { action: 'cartAdd', target: { id: 1 } },
      { action: 'orderCreate', target: {} },
    ];

    const results = rehydrate(bus, commands, { ignoreUnhandled: false });
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false); // no handler → error
  });

  it('filter option skips matching commands', () => {
    bus.register('cartAdd', () => 'ok');
    bus.register('analyticsTrack', () => 'ok');

    const commands = [
      { action: 'cartAdd', target: { id: 1 } },
      { action: 'analyticsTrack', target: { event: 'view' } },
    ];

    const results = rehydrate(bus, commands, {
      filter: (cmd) => !cmd.action.startsWith('analytics'),
    });

    expect(results).toHaveLength(1);
  });

  it('handles handler errors gracefully', () => {
    bus.register('boom', () => { throw new Error('handler error'); });

    const results = rehydrate(bus, [{ action: 'boom', target: {} }]);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error?.message).toBe('handler error');
  });

  it('handles empty command list', () => {
    const results = rehydrate(bus, []);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The async bus — the common case as soon as a handler hits a transport, and
// the one `rehydrate()` silently mishandled: `BaseBus.dispatch` returns `any`,
// so an AsyncCommandBus type-checks, and pending promises were pushed into
// `results` typed as CommandResult (`result.ok` → undefined).
// ---------------------------------------------------------------------------

describe('rehydrate on an async bus', () => {
  it('refuses instead of pushing pending promises as results', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    let ran = 0;
    bus.register('setUser', async () => {
      ran++;
      return 'ok';
    });

    const results = rehydrate(bus, [{ action: 'setUser', target: { id: 1 } }]);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false); // was `undefined` — neither true nor false
    expect(results[0].error?.message).toContain('rehydrateAsync');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rehydrateAsync'));
    warn.mockRestore();
    await vi.waitFor(() => expect(ran).toBe(1)); // the dispatch itself still ran
  });

  it('rehydrateAsync replays in order and resolves real results', async () => {
    const bus = createAsyncCommandBus();
    const order: string[] = [];
    bus.register('first', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('first');
      return 1;
    });
    bus.register('second', async () => {
      order.push('second');
      return 2;
    });

    const results = await rehydrateAsync(bus, [
      { action: 'first', target: {} },
      { action: 'second', target: {} },
    ]);

    expect(order).toEqual(['first', 'second']); // sequential, not raced
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results.map((r) => r.value)).toEqual([1, 2]);
  });

  it('rehydrateAsync turns a rejected replay into { ok: false }, not an unhandled rejection', async () => {
    const bus = createAsyncCommandBus();
    bus.register('boom', async () => {
      throw new Error('transport down');
    });

    const results = await rehydrateAsync(bus, [{ action: 'boom', target: {} }]);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error?.message).toBe('transport down');
  });
});

// ---------------------------------------------------------------------------
// maxCommands: the cap dropped everything past it with no warning and no
// signal — the client rehydrated partial state and nothing said so.
// ---------------------------------------------------------------------------

describe('createSSRPlugin — maxCommands truncation', () => {
  it('warns once and counts what it dropped', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const ssr = createSSRPlugin({ maxCommands: 2 });
    bus.use(ssr.plugin);
    bus.register('inc', () => 'ok');

    for (let i = 0; i < 5; i++) bus.dispatch('inc', { i });

    expect(ssr.size()).toBe(2);
    expect(ssr.dehydrate()).toHaveLength(2);
    expect(ssr.dropped()).toBe(3);
    expect(warn).toHaveBeenCalledTimes(1); // once, not once per dropped command
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maxCommands'));
    warn.mockRestore();
  });

  it('dropped() is 0 under the cap, and clear() resets it', () => {
    const bus = createCommandBus();
    const ssr = createSSRPlugin({ maxCommands: 10 });
    bus.use(ssr.plugin);
    bus.register('inc', () => 'ok');

    bus.dispatch('inc', {});
    expect(ssr.dropped()).toBe(0);

    ssr.clear();
    expect(ssr.size()).toBe(0);
    expect(ssr.dropped()).toBe(0);
  });
});
