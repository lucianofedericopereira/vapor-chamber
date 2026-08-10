/**
 * Fast lane — correctness tests.
 *
 * Locks the v1.2.x behavior: minimal-allocation dispatch with NO
 * envelope, NO result wrapper, NO plugin/hook/listener machinery. The
 * point of the fast lane is to be deliberately narrow — these tests
 * verify the narrow shape stays correct.
 *
 * Performance is verified separately in tests/perf.bench.ts under
 * `describe('fast lane — single-handler hot dispatch')`.
 */
import { describe, it, expect, vi } from 'vitest';
import { createFastLane } from '../src/fast-lane';

describe('createFastLane — compile / dispatch', () => {
  it('compile returns a function that calls the handler with raw data', () => {
    const lane = createFastLane();
    const handler = vi.fn((n: number) => n * 2);
    const dispatch = lane.compile<number, number>('double', handler);

    const result = dispatch(21);

    expect(result).toBe(42);
    expect(handler).toHaveBeenCalledWith(21);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('handler receives data directly — no Command envelope, no Result wrapping', () => {
    const lane = createFastLane();
    let captured: unknown ;
    const dispatch = lane.compile('any', (data: any) => { captured = data; return 'done'; });

    dispatch({ deeply: { nested: 'object' } });
    expect(captured).toEqual({ deeply: { nested: 'object' } });

    // Return value is whatever the handler returned — no { ok, value } envelope.
    expect(dispatch('plain string')).toBe('done');
  });

  it('compile twice for the same action overwrites (last write wins)', () => {
    const lane = createFastLane();
    const dispatch = lane.compile<number, number>('act', (n) => n + 1);
    expect(dispatch(10)).toBe(11);

    // Re-compile with a new handler. The previously-returned dispatcher
    // routes to the new handler on subsequent calls.
    lane.compile<number, number>('act', (n) => n * 100);
    expect(dispatch(10)).toBe(1000);
  });

  it('dispatcher returns undefined after remove()', () => {
    const lane = createFastLane();
    const dispatch = lane.compile<number, number>('act', (n) => n);

    expect(dispatch(5)).toBe(5);
    lane.remove('act');
    expect(dispatch(5)).toBeUndefined();
  });

  it('handler errors propagate — no try/catch wrapping', () => {
    const lane = createFastLane();
    const dispatch = lane.compile('boom', () => { throw new Error('uncaught'); });

    expect(() => dispatch(null)).toThrow('uncaught');
  });
});

describe('createFastLane — on / emit / off', () => {
  it('emit fans out to all subscribers in registration order', () => {
    const lane = createFastLane();
    const calls: string[] = [];
    lane.on('e', (d: string) => calls.push('a:' + d));
    lane.on('e', (d: string) => calls.push('b:' + d));
    lane.on('e', (d: string) => calls.push('c:' + d));

    lane.emit('e', 'X');

    expect(calls).toEqual(['a:X', 'b:X', 'c:X']);
  });

  it('emit with no listeners is a no-op (no throw, no allocations)', () => {
    const lane = createFastLane();
    expect(() => lane.emit('nobody', 42)).not.toThrow();
  });

  it('on() returns an unsubscribe closure', () => {
    const lane = createFastLane();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const off1 = lane.on('e', fn1);
    lane.on('e', fn2);

    lane.emit('e', 1);
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();

    off1();
    lane.emit('e', 2);
    expect(fn1).toHaveBeenCalledOnce();   // not called again
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  it('compile and on are independent — same action key, different dispatch paths', () => {
    const lane = createFastLane();
    const handlerCalls: number[] = [];
    const listenerCalls: number[] = [];

    const dispatch = lane.compile<number, void>('mixed', (n) => { handlerCalls.push(n); });
    lane.on<number>('mixed', (n) => { listenerCalls.push(n); });

    // dispatch only invokes the compile()-bound handler
    dispatch(1);
    expect(handlerCalls).toEqual([1]);
    expect(listenerCalls).toEqual([]);

    // emit only fans out to on() subscribers
    lane.emit('mixed', 2);
    expect(handlerCalls).toEqual([1]);
    expect(listenerCalls).toEqual([2]);
  });
});

describe('createFastLane — diagnostics', () => {
  it('registeredActions returns compiled action names', () => {
    const lane = createFastLane();
    lane.compile('a', () => {});
    lane.compile('b', () => {});
    lane.on('c', () => {});  // on() doesn't add to registeredActions — only compile does

    expect(lane.registeredActions().sort()).toEqual(['a', 'b']);
  });

  it('clear() resets all bindings', () => {
    const lane = createFastLane();
    const dispatchA = lane.compile<number, number>('a', (n) => n);
    const fnB = vi.fn();
    lane.on('b', fnB);

    lane.clear();

    expect(lane.registeredActions()).toEqual([]);
    expect(dispatchA(7)).toBeUndefined();  // handler was cleared
    lane.emit('b', 1);
    expect(fnB).not.toHaveBeenCalled();
  });
});

describe('createFastLane — isolation between instances', () => {
  it('two lanes do not share handlers or listeners', () => {
    const a = createFastLane();
    const b = createFastLane();
    const handlerA = vi.fn();
    const handlerB = vi.fn();
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    a.compile('act', handlerA);
    b.compile('act', handlerB);
    a.on('evt', listenerA);
    b.on('evt', listenerB);

    a.emit('evt', 1);
    expect(listenerA).toHaveBeenCalledOnce();
    expect(listenerB).not.toHaveBeenCalled();

    a.remove('act');
    expect(b.registeredActions()).toEqual(['act']);
  });
});

describe('fast-lane unsubscribe edge cases', () => {
  it('unsubscribing twice is safe, and the bucket is dropped when it empties', () => {
    const lane = createFastLane();
    const seen: number[] = [];
    const off = lane.on<number>('tick', (n) => seen.push(n));

    lane.emit('tick', 1);
    off();
    lane.emit('tick', 2); // no listeners left
    expect(() => off()).not.toThrow(); // bucket already deleted → early return
    lane.emit('tick', 3);

    expect(seen).toEqual([1]);
  });

  // The gap this block looked like it covered but didn't: unsubscribe DURING
  // an emit, which shifts the array under the loop.
  it('a listener that unsubscribes itself mid-emit does not skip its neighbour', () => {
    const lane = createFastLane();
    const seen: string[] = [];

    lane.on<number>('tick', () => seen.push('first'));
    const off = lane.on<number>('tick', () => {
      seen.push('second');
      off(); // the once-pattern
    });
    lane.on<number>('tick', () => seen.push('third'));

    lane.emit('tick', 1);
    expect(seen).toEqual(['first', 'second', 'third']); // 'third' was skipped

    seen.length = 0;
    lane.emit('tick', 2);
    expect(seen).toEqual(['first', 'third']); // and the once-listener is gone
  });

  it('a listener that removes a peer mid-emit does not skip another', () => {
    const lane = createFastLane();
    const seen: string[] = [];

    let offSecond = () => {};
    lane.on<number>('tick', () => {
      seen.push('first');
      offSecond(); // remove a LATER peer
    });
    offSecond = lane.on<number>('tick', () => seen.push('second'));
    lane.on<number>('tick', () => seen.push('third'));

    lane.emit('tick', 1);
    // 'second' is gone before its turn; 'third' must still fire.
    expect(seen).toEqual(['first', 'third']);
  });

  it('unsubscribing a listener that is no longer in a live bucket is a no-op', () => {
    // The bucket still exists (another listener holds it open) but this
    // listener is already gone — indexOf returns -1 and nothing is spliced.
    const lane = createFastLane();
    const kept: number[] = [];
    const off = lane.on<number>('tick', () => {});
    lane.on<number>('tick', (n) => kept.push(n));

    off();
    expect(() => off()).not.toThrow();
    lane.emit('tick', 1);
    expect(kept).toEqual([1]);
  });

  it('removing one of several listeners keeps the rest', () => {
    const lane = createFastLane();
    const a: number[] = [];
    const b: number[] = [];
    const offA = lane.on<number>('tick', (n) => a.push(n));
    lane.on<number>('tick', (n) => b.push(n));

    lane.emit('tick', 1);
    offA();
    lane.emit('tick', 2);

    expect(a).toEqual([1]);
    expect(b).toEqual([1, 2]);
  });
});

// ---------------------------------------------------------------------------
// removal: 'snapshot' vs 'live' — the mid-emit unsubscribe CONTRACT per mode.
// These two suites assert DIFFERENT outcomes for the same scenario on
// purpose: the divergence IS the documented difference between the modes.
// ---------------------------------------------------------------------------

describe("removal: 'live' (default) — bus-parity semantics", () => {
  it('a peer removed mid-emit does NOT run in that emit', () => {
    const lane = createFastLane(); // default = live
    const seen: string[] = [];
    let offSecond: () => void = () => {};
    lane.on('tick', () => { seen.push('first'); offSecond(); });
    offSecond = lane.on('tick', () => seen.push('second'));
    lane.on('tick', () => seen.push('third'));

    lane.emit('tick', 1);
    expect(seen).toEqual(['first', 'third']);
  });

  it('single-listener fast path: self-removal during the call still completes and unsubscribes', () => {
    const lane = createFastLane();
    const seen: number[] = [];
    const off = lane.on<number>('tick', (n) => { seen.push(n); off(); });
    lane.emit('tick', 1);
    lane.emit('tick', 2); // listener gone — bucket dropped, no-op
    expect(seen).toEqual([1]);
  });
});

describe("removal: 'snapshot' — copy-on-write semantics", () => {
  it('a peer removed mid-emit STILL runs once in that emit (the documented divergence)', () => {
    const lane = createFastLane({ removal: 'snapshot' });
    const seen: string[] = [];
    let offSecond: () => void = () => {};
    lane.on('tick', () => { seen.push('first'); offSecond(); });
    offSecond = lane.on('tick', () => seen.push('second'));
    lane.on('tick', () => seen.push('third'));

    lane.emit('tick', 1);
    // Snapshot: the emit fans out to the list as of emit start.
    expect(seen).toEqual(['first', 'second', 'third']);
    seen.length = 0;
    lane.emit('tick', 2);
    // The removal is fully visible from the NEXT emit on.
    expect(seen).toEqual(['first', 'third']);
  });

  it('a listener added mid-emit does not run until the next emit', () => {
    const lane = createFastLane({ removal: 'snapshot' });
    const seen: string[] = [];
    lane.on('tick', () => {
      seen.push('a');
      if (!seen.includes('late-registered')) {
        seen.push('late-registered');
        lane.on('tick', () => seen.push('late'));
      }
    });
    lane.emit('tick', 1);
    expect(seen).not.toContain('late');
    lane.emit('tick', 2);
    expect(seen).toContain('late');
  });

  it('self-removal works and the bucket drops when it empties', () => {
    const lane = createFastLane({ removal: 'snapshot' });
    const seen: number[] = [];
    const off = lane.on<number>('tick', (n) => { seen.push(n); off(); });
    lane.emit('tick', 1); // runs once (snapshot), then removed
    lane.emit('tick', 2);
    expect(seen).toEqual([1]);
    expect(() => off()).not.toThrow(); // idempotent on a dropped bucket
  });

  it('double-unsubscribe is a no-op and leaves peers intact', () => {
    const lane = createFastLane({ removal: 'snapshot' });
    const seen: number[] = [];
    const fn = (n: number) => seen.push(n);
    const off = lane.on<number>('tick', fn);
    lane.on<number>('tick', (n) => seen.push(n * 10));
    off();
    off();
    lane.emit('tick', 1);
    expect(seen).toEqual([10]);
  });
});
