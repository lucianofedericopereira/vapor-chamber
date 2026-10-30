/**
 * The alien-signals connector, against the real published alien-signals package.
 * Why: the adapter must work on the real package, not on a hand-rolled stub.
 * Shows: the adapter reads and writes through alien-signals; configureAlienSignals switches signal() and the composables; effect and computed propagate over a raw alien signal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { signal as alienSignal, computed, effect } from 'alien-signals';
import { signal, configureSignal, type CreateSignal } from '../src/signal';
import { alienSignalAdapter, configureAlienSignals } from '../src/alien-signals';

// Restore the default signal, so files that do not use alien-signals are unaffected.
beforeEach(() => {
  configureSignal((<T>(initial: T) => {
    let v = initial;
    return { get value() { return v; }, set value(next: T) { v = next; } };
  }) as CreateSignal);
});

describe('alienSignalAdapter', () => {
  it('produces a Signal<T> that reads and writes through alien-signals', () => {
    const create = alienSignalAdapter(alienSignal as any);
    const s = create(10);

    expect(s.value).toBe(10);
    s.value = 42;
    expect(s.value).toBe(42);
  });

  it('handles different value types (numbers, strings, objects, null)', () => {
    const create = alienSignalAdapter(alienSignal as any);

    const num = create<number>(0);
    num.value = 7;
    expect(num.value).toBe(7);

    const str = create<string>('hello');
    str.value = 'world';
    expect(str.value).toBe('world');

    const obj = create<{ x: number } | null>(null);
    expect(obj.value).toBeNull();
    obj.value = { x: 1 };
    expect(obj.value).toEqual({ x: 1 });
  });
});

describe('configureAlienSignals', () => {
  it('flips signal() to produce alien-signals-backed Signals', () => {
    configureAlienSignals(alienSignal as any);

    const s = signal(1);
    s.value = 2;
    expect(s.value).toBe(2);
  });

  it('reactive propagation: an effect re-runs when a vapor-chamber signal changes', async () => {
    configureAlienSignals(alienSignal as any);

    // A raw alien signal for `effect`, written through a .value wrapper like the adapter's.
    const raw = alienSignal(0);
    const wrapped = { get value() { return raw(); }, set value(v: number) { raw(v); } };

    let observed = -1;
    const stop = effect(() => { observed = raw(); });

    expect(observed).toBe(0);

    wrapped.value = 5;
    expect(observed).toBe(5);

    wrapped.value = 10;
    expect(observed).toBe(10);

    stop();
  });

  it('full integration: useSharedCommandState signals propagate via alien-signals', async () => {
    configureAlienSignals(alienSignal as any);

    // Imported after configureAlienSignals, so the composable picks up the switched factory.
    const { useSharedCommandState } = await import('../src/chamber');
    const { createCommandBus, setCommandBus, resetCommandBus } = await import('../src/index');

    resetCommandBus();
    const bus = createCommandBus();
    bus.register('boom', () => { throw new Error('e'); });
    setCommandBus(bus as any);

    const s = useSharedCommandState();
    expect(s.errors.value.length).toBe(0);
    expect(s.anyPending.value).toBe(false);

    bus.dispatch('boom', null);

    // Written through alien-signals, read through the adapter's getter.
    expect(s.errors.value.length).toBe(1);
    expect(s.lastError.value?.message).toBe('e');

    s.dispose();
    resetCommandBus();
  });
});

describe('alien-signals integration with computed', () => {
  it('computed that reads a wrapped signal updates correctly', () => {
    configureAlienSignals(alienSignal as any);

    // A raw alien signal for `computed`, written through a .value wrapper like the adapter's.
    const raw = alienSignal(2);
    const wrapped = { get value() { return raw(); }, set value(v: number) { raw(v); } };

    const doubled = computed(() => raw() * 2);

    expect(doubled()).toBe(4);
    wrapped.value = 5;
    expect(doubled()).toBe(10);
    wrapped.value = 100;
    expect(doubled()).toBe(200);
  });
});
