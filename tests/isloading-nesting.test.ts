/**
 * pending()'s pairing of each start with its settle on every nesting path of a sync bus, and out-of-order settles on the async bus.
 * Why: a settle with no start (a query, an emit, a command already running when tracking was armed) must take nothing from the pairing, and a start whose settle never arrives must not stop the commands below it from settling; otherwise a flag stays lit or lights wrongly, and entries leak.
 * Shows: through handlers, started parts, after-hooks, listeners, a refusing rule and the depth limit each key is lit while its level runs and dark after, and released() confirms no entry is held once every start settled; async settles in any order darken only their own key.
 * See: log s35.61, log s35.66.
 */
import { describe, expect, it } from 'vitest';
import { useSharedCommandState } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus, type BaseBus } from '../src/command-bus';

type Shared = ReturnType<typeof useSharedCommandState>;

/** Read each [action, target] key's flag now. */
const lit = (s: Shared, keys: Array<[string, unknown?]>) => keys.map(([a, t]) => s.pending(a, t).value);

/**
 * Every start settled: with no holder left the entry is released, so the next
 * holder gets a new signal for `action`. A start left open keeps `pending`
 * above 0 and the entry, so the same signal comes back.
 */
function released(bus: BaseBus, s: Shared, action: string): boolean {
  const before = s.pending(action);
  s.dispose();
  const next = useSharedCommandState({ bus: bus as never });
  const after = next.pending(action);
  next.dispose();
  return before !== after;
}

describe('sync bus: every start settles its own key, on every nesting path', () => {
  it('a handler dispatching, three levels: each key lit while its level runs, dark after', () => {
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['a'], ['b'], ['c']];
    const seen: boolean[][] = [];
    bus.register('a', () => { bus.dispatch('b', undefined); seen.push(lit(s, keys)); });
    bus.register('b', () => { bus.dispatch('c', undefined); seen.push(lit(s, keys)); });
    bus.register('c', () => { seen.push(lit(s, keys)); });
    lit(s, keys);
    bus.dispatch('a', undefined);
    expect(seen).toEqual([[true, true, true], [true, true, false], [true, false, false]]);
    expect(lit(s, keys)).toEqual([false, false, false]);
    expect(released(bus, s, 'a')).toBe(true);
  });

  it('started parts dispatching, added before and after the state: the outer key is lit (its start comes first)', () => {
    const bus = createCommandBus();
    let during: boolean[] = [];
    // Part order: this one is added before the state, the next after it; both see `a` started.
    bus.use({ started: (cmd) => { if (cmd.action === 'a') bus.dispatch('b', undefined); } });
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['a'], ['b'], ['c']];
    lit(s, keys);
    bus.use({ started: (cmd) => { if (cmd.action === 'a') bus.dispatch('c', undefined); } });
    const at: Record<string, boolean[]> = {};
    bus.register('a', () => { during = lit(s, keys); });
    bus.register('b', () => { at.b = lit(s, keys); });
    bus.register('c', () => { at.c = lit(s, keys); });
    bus.dispatch('a', undefined);
    expect(at).toEqual({ b: [true, true, false], c: [true, false, true] });
    expect(during).toEqual([true, false, false]);
    expect(lit(s, keys)).toEqual([false, false, false]);
    expect(released(bus, s, 'a')).toBe(true);
  });

  it('an after-hook dispatching: the outer key is still lit (after-hooks run before the settle)', () => {
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['a'], ['b']];
    lit(s, keys);
    let inB: boolean[] = [];
    bus.onAfter((cmd) => { if (cmd.action === 'a') bus.dispatch('b', undefined); });
    bus.register('a', () => 1);
    bus.register('b', () => { inB = lit(s, keys); });
    bus.dispatch('a', undefined);
    expect(inB).toEqual([true, true]);
    expect(lit(s, keys)).toEqual([false, false]);
    expect(released(bus, s, 'a')).toBe(true);
  });

  it('listeners dispatching, added before and after the state: the outer key is dark (its settle comes first)', () => {
    const bus = createCommandBus();
    bus.on('a', () => { bus.dispatch('b', undefined); });
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['a'], ['b'], ['c']];
    lit(s, keys);
    bus.on('*', (cmd) => { if (cmd.action === 'a') bus.dispatch('c', undefined); });
    const at: Record<string, boolean[]> = {};
    bus.register('a', () => 1);
    bus.register('b', () => { at.b = lit(s, keys); });
    bus.register('c', () => { at.c = lit(s, keys); });
    bus.dispatch('a', undefined);
    // The settle is announced before any listener, exact or wildcard.
    expect(at).toEqual({ b: [false, true, false], c: [false, false, true] });
    expect(lit(s, keys)).toEqual([false, false, false]);
    expect(released(bus, s, 'a')).toBe(true);
  });

  it('a rule refuses: that command settles, the one it is nested in stays lit', () => {
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['outer'], ['a']];
    lit(s, keys);
    bus.use({ authorize: () => (cmd) => (cmd.action === 'a' ? { ok: false, value: undefined, error: new Error('denied') } : undefined) });
    let after: boolean[] = [];
    let r: unknown;
    bus.register('a', () => 1);
    bus.register('outer', () => { r = bus.dispatch('a', undefined); after = lit(s, keys); });
    bus.dispatch('outer', undefined);
    expect(r).toMatchObject({ ok: false });
    expect(after).toEqual([true, false]);
    expect(lit(s, keys)).toEqual([false, false]);
    expect(released(bus, s, 'outer')).toBe(true);
  });

  it('the depth limit: the refused dispatch starts nothing, every level below settles', () => {
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    const keys = Array.from({ length: 17 }, (_, i): [string, unknown] => ['d', i]);
    lit(s, keys);
    let deepest: boolean[] = [];
    let refused: unknown;
    bus.register('d', (cmd) => {
      const r = bus.dispatch('d', cmd.target + 1);
      if (!r.ok && refused === undefined) { refused = r; deepest = lit(s, keys); }
      return cmd.target;
    });
    bus.dispatch('d', 0);
    expect(refused).toFailWith('core:exceeded:depth');
    expect(deepest).toEqual([...Array(16).fill(true), false]);
    expect(lit(s, keys)).toEqual(Array(17).fill(false));
    expect(released(bus, s, 'd')).toBe(true);
  });

  it('tracking armed mid-flight: the command already running settles with no start, ignored', () => {
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    let inB: boolean[] = [];
    let afterB: boolean[] = [];
    bus.register('b', () => { inB = lit(s, [['a'], ['b']]); });
    bus.register('a', () => {
      // The first pending() on the bus starts listening to `started` now.
      s.pending('b');
      bus.dispatch('b', undefined);
      afterB = lit(s, [['a'], ['b']]);
    });
    bus.dispatch('a', undefined);
    expect(inB).toEqual([false, true]);
    expect(afterB).toEqual([false, false]);
    expect(lit(s, [['a'], ['b']])).toEqual([false, false]);
    bus.dispatch('a', undefined);
    expect(inB).toEqual([true, true]);
    expect(released(bus, s, 'a')).toBe(true);
  });

  it('settles with no start (a query, an emit) over two levels in flight take nothing from them', () => {
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['a'], ['b']];
    lit(s, keys);
    let inB: boolean[] = [];
    // A query runs the handler: the payload 'q' returns at once, so a handler
    // that queries itself does not recurse (query has no depth guard).
    bus.register('a', (cmd) => { if (cmd.payload !== 'q') bus.dispatch('b', undefined); });
    bus.register('b', (cmd) => {
      if (cmd.payload === 'q') return;
      bus.query('b', undefined, 'q');
      bus.query('a', undefined, 'q');
      bus.emit('b');
      bus.emit('a');
      inB = lit(s, keys);
    });
    bus.dispatch('a', undefined);
    expect(inB).toEqual([true, true]);
    expect(lit(s, keys)).toEqual([false, false]);
    expect(released(bus, s, 'a')).toBe(true);
  });

  it('listeners removed and added mid-dispatch: every start still settles', () => {
    const bus = createCommandBus();
    // One listener removes an earlier one and adds one in the same call; the tracking listener must still run.
    const offEarly = bus.on('*', () => {});
    let armed = true;
    bus.on('*', (cmd) => {
      if (cmd.action === 'x' && armed) { armed = false; offEarly(); bus.on('*', () => {}); }
    });
    const s = useSharedCommandState({ bus });
    const keys: Array<[string, unknown?]> = [['outer'], ['x']];
    lit(s, keys);
    bus.register('x', () => 1);
    bus.register('outer', () => { bus.dispatch('x', undefined); });
    bus.dispatch('outer', undefined);
    expect(armed).toBe(false);
    expect(lit(s, keys)).toEqual([false, false]);
    expect(released(bus, s, 'outer')).toBe(true);
  });

  it('a start whose settle never arrives: the command below it still settles its own key', () => {
    // No public path leaves a start open on a sync bus, so the test makes one:
    // it finds the pairing stack the way it is filled (a push of a Command
    // and its slot) and puts a start on top of `outer` that never settles.
    const bus = createCommandBus();
    const s = useSharedCommandState({ bus });
    lit(s, [['outer']]);
    const push = Array.prototype.push;
    let stack: unknown[] | undefined;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      if (items.length === 2 && (items[1] as { bucket?: unknown } | null)?.bucket instanceof Map) stack = this;
      return push.apply(this, items);
    };
    const open = { action: 'open', target: undefined };
    let during: boolean[] = [];
    try {
      bus.register('outer', () => { push.call(stack!, open, { key: 'open', n: 1, flag: null, bucket: new Map() }); during = lit(s, [['outer']]); });
      bus.dispatch('outer', undefined);
    } finally {
      Array.prototype.push = push;
    }
    expect(stack, 'the pairing stack was not found').toBeDefined();
    expect(during).toEqual([true]);
    expect(lit(s, [['outer']])).toEqual([false]);
    // Only `outer`'s own pair was removed; the open start is still there.
    expect(stack!.length).toBe(2);
    expect(stack![0]).toBe(open);
    expect(released(bus, s, 'outer')).toBe(true);
  });
});

describe('async bus: settles in any order', () => {
  it('a starts, b starts, a settles first: each key goes dark at its own settle', async () => {
    const bus = createAsyncCommandBus();
    const s = useSharedCommandState({ bus: bus as never });
    const keys: Array<[string, unknown?]> = [['a'], ['b']];
    lit(s, keys);
    const gate: Record<string, () => void> = {};
    const handler = (cmd: { action: string }) => new Promise<void>((r) => { gate[cmd.action] = r; });
    bus.register('a', handler);
    bus.register('b', handler);
    const pa = bus.dispatch('a', undefined);
    const pb = bus.dispatch('b', undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(lit(s, keys)).toEqual([true, true]);
    gate.a();
    await pa;
    expect(lit(s, keys)).toEqual([false, true]);
    gate.b();
    await pb;
    expect(lit(s, keys)).toEqual([false, false]);
    expect(released(bus, s, 'a')).toBe(true);
  });
});
