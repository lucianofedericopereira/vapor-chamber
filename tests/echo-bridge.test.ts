/**
 * Tests for createEchoBridge — Laravel Echo / Reverb realtime → bus. Uses a
 * mock Echo that mirrors the laravel-echo API (channel/private/join + listen +
 * here/joining/leaving + leave), so no laravel-echo dependency is needed.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createEchoBridge } from '../src/transports';

/** Minimal laravel-echo-shaped mock. Captures listeners so tests can fire broadcasts. */
function makeMockEcho() {
  const channels: Record<string, any> = {};
  const left: string[] = [];
  function chan(name: string, kind: string) {
    const listeners: Record<string, (p: any) => void> = {};
    const presence: Record<string, (m: any) => void> = {};
    const ch = {
      kind,
      listen(event: string, cb: (p: any) => void) { listeners[event] = cb; return ch; },
      here(cb: (m: any) => void) { presence.here = cb; return ch; },
      joining(cb: (m: any) => void) { presence.joining = cb; return ch; },
      leaving(cb: (m: any) => void) { presence.leaving = cb; return ch; },
      _fire(event: string, payload: any) { listeners[event]?.(payload); },
      _presence(kind: 'here' | 'joining' | 'leaving', m: any) { presence[kind]?.(m); },
    };
    channels[name] = ch;
    return ch;
  }
  return {
    channel: (n: string) => chan(n, 'public'),
    private: (n: string) => chan(n, 'private'),
    join: (n: string) => chan(n, 'presence'),
    leave: (n: string) => { left.push(n); },
    _channels: channels,
    _left: left,
  };
}

describe('createEchoBridge', () => {
  it('routes public-channel broadcasts to bus.emit', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const got: any[] = [];
    bus.on('OrderShipped', (cmd) => got.push(cmd.target));

    const bridge = createEchoBridge({
      echo,
      channels: [{ name: 'orders', events: ['OrderShipped'] }],
    });
    bridge.install(bus);

    echo._channels.orders._fire('OrderShipped', { id: 7 });
    expect(got).toEqual([{ id: 7 }]);
    expect(echo._channels.orders.kind).toBe('public');
  });

  it('uses private() for private channels and listens to multiple events', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const seen: string[] = [];
    bus.on('*', (cmd) => seen.push(cmd.action));

    createEchoBridge({
      echo,
      channels: [{ name: 'orders', type: 'private', events: ['A', 'B'] }],
    }).install(bus);

    expect(echo._channels.orders.kind).toBe('private');
    echo._channels.orders._fire('A', 1);
    echo._channels.orders._fire('B', 2);
    expect(seen).toEqual(['A', 'B']);
  });

  it('emits presence membership events (here/joining/leaving)', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const events: Array<[string, any]> = [];
    bus.on('*', (cmd) => events.push([cmd.action, cmd.target]));

    createEchoBridge({
      echo,
      channels: [{ name: 'lobby', type: 'presence', events: [] }],
    }).install(bus);

    expect(echo._channels.lobby.kind).toBe('presence');
    echo._channels.lobby._presence('here', [{ id: 1 }]);
    echo._channels.lobby._presence('joining', { id: 2 });
    echo._channels.lobby._presence('leaving', { id: 1 });
    expect(events).toEqual([
      ['lobby:here', [{ id: 1 }]],
      ['lobby:joining', { id: 2 }],
      ['lobby:leaving', { id: 1 }],
    ]);
  });

  it('onBroadcast can dispatch a command instead of emitting', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const handled: any[] = [];
    bus.register('applyShipment', (cmd) => { handled.push(cmd.target); });

    createEchoBridge({
      echo,
      channels: [{ name: 'orders', events: ['OrderShipped'] }],
      onBroadcast: ({ payload }, b) => b.dispatch('applyShipment', payload),
    }).install(bus);

    echo._channels.orders._fire('OrderShipped', { id: 9 });
    expect(handled).toEqual([{ id: 9 }]);
  });

  it('a broadcast handler error is caught (does not throw out of Echo)', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.on('Boom', () => { throw new Error('listener blew up'); });

    createEchoBridge({ echo, channels: [{ name: 'c', events: ['Boom'] }] }).install(bus);
    expect(() => echo._channels.c._fire('Boom', {})).not.toThrow();
    err.mockRestore();
  });

  it('teardown leaves every joined channel', () => {
    const echo = makeMockEcho();
    const bus = createCommandBus();
    const bridge = createEchoBridge({
      echo,
      channels: [
        { name: 'orders', type: 'private', events: ['X'] },
        { name: 'lobby', type: 'presence', events: [] },
      ],
    });
    bridge.install(bus);
    bridge.teardown();
    expect(echo._left.sort()).toEqual(['lobby', 'orders']);
  });
});
