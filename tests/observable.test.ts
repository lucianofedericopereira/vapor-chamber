/**
 * Observable adapter — bridges bus events to Symbol.observable / RxJS.
 *
 * Locks v1.2.x behavior: each subscribe creates an independent listener;
 * unsubscribe drops it; Symbol.observable interop returns self; dispatchFrom
 * emits values from a source Observable into the bus.
 */
import { describe, it, expect, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { observe, dispatchFrom } from '../src/observable';

describe('observe(bus, pattern)', () => {
  it('subscribe receives { cmd, result } for each matching dispatch', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', (cmd) => cmd.target);
    const observations: Array<{ cmd: any; result: any }> = [];
    observe(bus, 'cartAdd').subscribe((o) => observations.push(o));

    bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('cartAdd', { id: 2 });

    expect(observations).toHaveLength(2);
    expect(observations[0]!.cmd.action).toBe('cartAdd');
    expect(observations[0]!.cmd.target).toEqual({ id: 1 });
    expect(observations[0]!.result.ok).toBe(true);
    expect(observations[0]!.result.value).toEqual({ id: 1 });
  });

  it('wildcard pattern receives all matching events', () => {
    const bus = createCommandBus();
    bus.register('cartAdd', () => 'a');
    bus.register('cartRemove', () => 'b');
    const seen: string[] = [];
    observe(bus, 'cart*').subscribe(({ cmd }) => seen.push(cmd.action));

    bus.dispatch('cartAdd', null);
    bus.dispatch('cartRemove', null);
    expect(seen).toEqual(['cartAdd', 'cartRemove']);
  });

  it('unsubscribe stops further notifications', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    const fn = vi.fn();
    const sub = observe(bus, 'act').subscribe(fn);

    bus.dispatch('act', null);
    expect(fn).toHaveBeenCalledOnce();
    expect(sub.closed).toBe(false);

    sub.unsubscribe();
    expect(sub.closed).toBe(true);

    bus.dispatch('act', null);
    expect(fn).toHaveBeenCalledOnce(); // not called again
  });

  it('multiple subscribers each get their own listener', () => {
    const bus = createCommandBus();
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

  it('Symbol.observable interop returns the same observable', () => {
    const bus = createCommandBus();
    const obs = observe(bus, 'evt');
    const symObs = (obs as any)[(Symbol as any).observable ?? Symbol.for('@@observable')];
    expect(typeof symObs).toBe('function');
    expect(symObs()).toBe(obs);
  });

  it('observer-object form (next callback)', () => {
    const bus = createCommandBus();
    const fn = vi.fn();
    observe(bus, 'evt').subscribe({ next: fn });
    bus.emit('evt', { x: 1 });
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('dispatchFrom(bus, action, source)', () => {
  it('forwards each value emitted by the source as a bus dispatch', () => {
    const bus = createCommandBus();
    const handler = vi.fn((cmd) => cmd.target);
    bus.register('tick', handler);

    // Build a minimal hand-rolled observable for the test
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

  it('emits :error event on source error', () => {
    const bus = createCommandBus();
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

  it('emits :complete event on source complete', () => {
    const bus = createCommandBus();
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
