/**
 * observe() and dispatchFrom(): the Observable adapter between bus events and Symbol.observable / RxJS.
 * Why: a subscriber that misses events, a leaked listener after unsubscribe, an RxJS `from()` that cannot read the adapter, or a source value whose failed dispatch goes unhandled would break reactive code built on the bus.
 * Shows: subscribers get `{ cmd, result }` per matching dispatch, each with its own listener that unsubscribe drops; the interop returns the same observable and RxJS `from()` reads it; `dispatchFrom` forwards values, reports a rejected async dispatch on `<action>:error` without an unhandled rejection, leaves a sync dispatch alone, and emits `:error` and `:complete` from the source.
 */
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { observe, dispatchFrom } from '../src/observable';
import { it } from '../src/vitest';
import { from as rxFrom, filter as rxFilter } from 'rxjs';

describe('observe(bus, pattern)', () => {
  it('subscribe receives { cmd, result } for each matching dispatch', ({ bus }) => {
    bus.register('cartAdd', (cmd) => cmd.target);
    const observations: Array<{ cmd: any; result: any }> = [];
    observe(bus, 'cartAdd').subscribe((o) => observations.push(o));

    bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('cartAdd', { id: 2 });

    expect(observations).toHaveLength(2);
    expect(observations[0]!.cmd.action).toBe('cartAdd');
    expect(observations[0]!.cmd.target).toEqual({ id: 1 });
    expect(observations[0]!.result).toSucceedWith({ id: 1 });
  });

  it('wildcard pattern receives all matching events', ({ bus }) => {
    bus.register('cartAdd', () => 'a');
    bus.register('cartRemove', () => 'b');
    const seen: string[] = [];
    observe(bus, 'cart*').subscribe(({ cmd }) => seen.push(cmd.action));

    bus.dispatch('cartAdd', null);
    bus.dispatch('cartRemove', null);
    expect(seen).toEqual(['cartAdd', 'cartRemove']);
  });

  it('unsubscribe stops further notifications', ({ bus }) => {
    bus.register('act', () => 'ok');
    const fn = vi.fn();
    const sub = observe(bus, 'act').subscribe(fn);

    bus.dispatch('act', null);
    expect(fn).toHaveBeenCalledOnce();
    expect(sub.closed).toBe(false);

    sub.unsubscribe();
    expect(sub.closed).toBe(true);

    bus.dispatch('act', null);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('multiple subscribers each get their own listener', ({ bus }) => {
    bus.register('act', () => 'ok');
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const obs = observe(bus, 'act');
    obs.subscribe(fn1);
    obs.subscribe(fn2);

    bus.dispatch('act', null);
    expect(fn1).toHaveBeenCalledOnce();
    expect(fn2).toHaveBeenCalledOnce();
  });

  it('Symbol.observable interop returns the same observable', ({ bus }) => {
    const obs = observe(bus, 'evt');
    const symObs = (obs as any)[(Symbol as any).observable ?? Symbol.for('@@observable')];
    expect(typeof symObs).toBe('function');
    expect(symObs()).toBe(obs);
  });

  it("RxJS's from() reads it on a runtime with no Symbol.observable (Node, every browser)", ({ bus }) => {
    // Without Symbol.observable, RxJS falls back to the string key '@@observable'.
    expect((Symbol as any).observable).toBeUndefined();
    bus.register('cartAdd', () => 1);
    const seen: string[] = [];
    rxFrom(observe(bus, 'cart*')).pipe(rxFilter(({ result }) => result.ok)).subscribe(({ cmd }) => seen.push(cmd.action));
    bus.dispatch('cartAdd', {});
    expect(seen).toEqual(['cartAdd']);
  });

  it('observer-object form (next callback)', ({ bus }) => {
    const fn = vi.fn();
    observe(bus, 'evt').subscribe({ next: fn });
    bus.emit('evt', { x: 1 });
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('dispatchFrom(bus, action, source)', () => {
  it('forwards each value emitted by the source as a bus dispatch', ({ bus }) => {
    const handler = vi.fn((cmd) => cmd.target);
    bus.register('tick', handler);

    const source = {
      subscribe(o: any) {
        o.next(1);
        o.next(2);
        o.next(3);
        return { unsubscribe() {}, closed: false };
      },
    };

    dispatchFrom(bus, 'tick', source as any);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[0]![0].target).toBe(1);
    expect(handler.mock.calls[2]![0].target).toBe(3);
  });

  // On an async bus dispatch returns a promise; a discarded rejection would be unhandled, which ends a Node process by default.
  it('reports a rejected async dispatch instead of leaving it unhandled', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => { seen.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    const errors: unknown[] = [];
    bus.on('ping:error', (cmd) => { errors.push(cmd.target); });

    const source = {
      subscribe(o: any) {
        o.next('v1');
        return { unsubscribe() {}, closed: false };
      },
    };

    dispatchFrom(bus, 'ping', source as any);
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', onUnhandled);

    expect(seen).toEqual([]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toMatch(/No handler registered/);
  });

  it('leaves a sync bus dispatch untouched', ({ bus }) => {
    const handler = vi.fn((cmd) => cmd.target);
    bus.register('tick', handler);
    const source = {
      subscribe(o: any) { o.next(7); return { unsubscribe() {}, closed: false }; },
    };

    dispatchFrom(bus, 'tick', source as any);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('emits :error event on source error', ({ bus }) => {
    const onError = vi.fn();
    bus.on('boom:error', (cmd) => onError(cmd.target));

    const source = {
      subscribe(o: any) {
        o.error(new Error('source failed'));
        return { unsubscribe() {}, closed: false };
      },
    };

    dispatchFrom(bus, 'boom', source as any);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0].message).toBe('source failed');
  });

  it('emits :complete event on source complete', ({ bus }) => {
    const onComplete = vi.fn();
    bus.on('done:complete', onComplete);

    const source = {
      subscribe(o: any) {
        o.complete();
        return { unsubscribe() {}, closed: false };
      },
    };

    dispatchFrom(bus, 'done', source as any);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
