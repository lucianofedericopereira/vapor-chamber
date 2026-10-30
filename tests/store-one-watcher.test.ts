/**
 * A store runs at most one watcher for its field events and tab sharing; a fast lane with `onError` isolates a throw.
 * Why: a store using both field events and sharing would run a second effect per write, and a throwing field listener would stop the fan-out unless the lane reports it to onError.
 * Shows: a shared store with field subscribers starts one Vue effect, a store with no consumer starts none; on both runtimes each write is sent once per tab and notifies its changed fields, and a late subscriber hears the next write; a lane with onError reports a throw and goes on, and without it the throw reaches the emitter.
 * See: log s35.125, s36.F30.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wraps Vue's real effect so the store mounts the real thing while the test counts effects.
const effects = vi.hoisted(() => ({ count: 0 }));
vi.mock('vue', async (importOriginal) => {
  const vue = await importOriginal<typeof import('vue')>();
  return { ...vue, effect: ((...args: Parameters<typeof vue.effect>) => { effects.count++; return vue.effect(...args); }) as typeof vue.effect };
});

import { createCommandBus } from '../src/command-bus';
import { createFastLane } from '../src/fast-lane';
import { defineChamberStore as defineVue } from '../src/store';
import { defineChamberStore as defineCore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { listen, perTab, quiet } from './tabs-quiet';

type Cart = { items: number[]; n: number };
const state = (): Cart => ({ items: [], n: 0 });
const reducers = { add: (s: Cart, id: number) => ({ items: [...s.items, id], n: s.n + 1 }) };

// A page: shareTabs opens only where there are tabs.
beforeEach(() => { vi.stubGlobal('window', {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Every message the store posts, read as it is sent. */
function posted(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation((m) => { out.push(m as Record<string, unknown>); });
  return out;
}

describe('the Vue store: one watcher', () => {
  it('a shared store with field subscribers starts one effect', () => {
    const before = effects.count;
    const cart = defineVue('cart', { state, reducers, share: shareTabs('watch-one') })(createCommandBus());
    cart.$onField('items', () => {});
    cart.$onField('n', () => {});
    expect(effects.count - before).toBe(1);
    cart.$dispose();
  });

  it('a store with no consumer starts none', () => {
    const before = effects.count;
    const cart = defineVue('cart', { state, reducers })(createCommandBus());
    cart.add(1);
    expect(effects.count - before).toBe(0);
    cart.$dispose();
  });
});

for (const [runtime, define] of [['vue', defineVue], ['core', defineCore]] as const) {
  describe(`${runtime} store: sharing and field events on one watcher`, () => {
    it('with another tab open, each write is sent once and its changed fields notified', async () => {
      const name = `watch-${runtime}`;
      const wire = listen(name);
      const peer = (define as typeof defineCore)('cart', { state, reducers, share: shareTabs(name) })(createCommandBus());
      const cart = (define as typeof defineCore)('cart', { state, reducers, share: shareTabs(name) })(createCommandBus());
      await quiet(wire.heard);
      const fields: number[] = [];
      cart.$onField('n', (v) => { fields.push(v as number); });
      cart.add(1);
      cart.add(2);
      cart.$dispose();
      cart.add(3);
      await quiet(wire.heard);
      expect(fields).toEqual([1, 2]);
      // Each write goes out once from the writer and once from the lock holder, which sends back the ids alone.
      const cmds = wire.heard.filter((m) => m.kind === 'cmd');
      expect(perTab(cmds)).toEqual([2, 2]);
      const full = cmds.filter((m) => 'action' in (m.value as object));
      const back = cmds.filter((m) => !('action' in (m.value as object)));
      expect(full.map((m) => (m.value as { target: number }).target)).toEqual([1, 2]);
      expect(back.map((m) => m.value)).toEqual(full.map((m) => ({ id: (m.value as { id: string }).id })));
      expect(peer.state.value.n).toBe(2);
      wire.close();
      peer.$dispose();
    });

    it('a field subscriber added after a shared write still hears the next one', () => {
      posted();
      const cart = (define as typeof defineCore)('cart', { state, reducers, share: shareTabs(`watch-sub-${runtime}`) })(createCommandBus());
      cart.add(1);
      const got: number[] = [];
      cart.$onField('n', (v) => { got.push(v as number); });
      cart.add(2);
      expect(got).toEqual([2]);
      cart.$dispose();
    });
  });
}

describe('createFastLane({ onError })', () => {
  it('a throwing listener goes to onError and the emit goes on', () => {
    const errors: Array<[unknown, string]> = [];
    const lane = createFastLane({ onError: (e, action) => { errors.push([e, action]); } });
    const boom = new Error('listener');
    const ran: string[] = [];
    lane.on('tick', () => { throw boom; });
    lane.on('tick', () => { ran.push('second'); });
    expect(() => lane.emit('tick', 1)).not.toThrow();
    expect(ran).toEqual(['second']);
    expect(errors).toEqual([[boom, 'tick']]);
  });

  it('one throwing listener alone goes to onError too', () => {
    const errors: unknown[] = [];
    const lane = createFastLane({ onError: (e) => { errors.push(e); } });
    lane.on('tick', () => { throw new Error('alone'); });
    lane.emit('tick', 1);
    expect(errors).toHaveLength(1);
  });

  it("in 'snapshot' mode too", () => {
    const errors: unknown[] = [];
    const lane = createFastLane({ removal: 'snapshot', onError: (e) => { errors.push(e); } });
    const ran: number[] = [];
    lane.on('tick', () => { throw new Error('first'); });
    lane.on('tick', (n: number) => { ran.push(n); });
    lane.emit('tick', 7);
    lane.emit('none', 0);
    expect(ran).toEqual([7]);
    expect(errors).toHaveLength(1);
  });

  it('an emit with no listener does nothing in live mode', () => {
    const lane = createFastLane({ onError: () => { throw new Error('not called'); } });
    expect(() => lane.emit('none', 0)).not.toThrow();
  });

  it('without it a throw still reaches the emitter (the default mode)', () => {
    const lane = createFastLane();
    lane.on('tick', () => { throw new Error('listener'); });
    expect(() => lane.emit('tick', 1)).toThrow('listener');
  });
});
