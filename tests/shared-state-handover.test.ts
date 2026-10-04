/** useSharedCommandState().isLoading across its last holder leaving, and on a sealed bus. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { useSharedCommandState } from '../src/chamber';
import { type CommandBus, createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';

function held() {
  const bus = createAsyncCommandBus() as unknown as CommandBus;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bus.register('siteCreate', async () => {
    await gate;
    return 1;
  });
  return { bus, release };
}

const hooks = (bus: Parameters<typeof inspectBus>[0]) => {
  const i = inspectBus(bus);
  return [i.beforeHookCount, i.listenerPatterns.length];
};

describe('isLoading across the last holder leaving', () => {
  it('control: a second holder while the first still holds reads the key lit', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.isLoading('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    const b = useSharedCommandState({ bus });
    expect(b.isLoading('siteCreate').value).toBe(true);
    a.dispose();
    release();
    await p;
    expect(b.isLoading('siteCreate').value).toBe(false);
    b.dispose();
  });

  it('handover: the first holder leaves mid-flight, the next one reads it lit, then settled', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.isLoading('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    const b = useSharedCommandState({ bus });
    const flag = b.isLoading('siteCreate');
    expect(flag.value).toBe(true);
    release();
    await p;
    expect(flag.value).toBe(false);
    b.dispose();
    expect(hooks(bus)).toEqual([0, 0]);
  });

  it('nobody holds it: the entry is released when the last key in flight settles', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.isLoading('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    expect(hooks(bus)).toEqual([1, 1]);
    release();
    await p;
    expect(hooks(bus)).toEqual([0, 0]);
  });

  it('nothing in flight: the last holder leaving releases the entry at once', () => {
    const bus = createCommandBus();
    const a = useSharedCommandState({ bus });
    a.isLoading('x');
    expect(hooks(bus)).toEqual([1, 1]);
    a.dispose();
    expect(hooks(bus)).toEqual([0, 0]);
  });
});

describe('isLoading on a sealed bus', () => {
  it('armed, sealed, every holder leaves: the next holder tracks, the bus stays sealed', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.isLoading('siteCreate');
    bus.seal();
    a.dispose();
    const b = useSharedCommandState({ bus });
    const flag = b.isLoading('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    expect(flag.value).toBe(true);
    release();
    await p;
    expect(flag.value).toBe(false);
    expect(bus.isSealed()).toBe(true);
    expect(() => bus.onBefore(() => {})).toThrow();
    b.dispose();
  });

  it('first asked after seal(): tracks, the bus stays sealed', () => {
    const bus = createCommandBus();
    let lit: boolean | undefined;
    bus.register('x', () => {
      lit = s.isLoading('x').value;
    });
    bus.seal();
    const s = useSharedCommandState({ bus });
    s.isLoading('x');
    bus.dispatch('x', undefined);
    expect(lit).toBe(true);
    expect(s.isLoading('x').value).toBe(false);
    expect(bus.isSealed()).toBe(true);
    s.dispose();
  });
});

/*
 * External item 2 of the 1.26 evaluation, and what was found reproducing it
 * (log s35.41).
 *
 * The handover. The shared entry was dropped, and its before-hook and
 * observer unhooked, the moment the last holder left. A dispatch still in
 * flight then had nobody to settle it, and the next holder (the page a route
 * change mounts) built a fresh entry that had not seen it start: the key read
 * false while the command ran. The entry now outlives its last holder only
 * while a command it started is in flight; the settle that ends the last one
 * releases it (third test), and with nothing in flight the release is
 * immediate (fourth). Keeping the entry armed for ever was measured and
 * declined: an unheld bus would pay the tracking on every dispatch, 6.5x.
 *
 * The sealed bus. Tracking is a before-hook, and a sealed bus refuses
 * `onBefore`, so `isLoading()` threw `core:refused:bus` whenever the entry
 * had to be built after `seal()`: on the first call, and again after every
 * holder had left (a route change). The old advice, "call isLoading() before
 * sealing", cannot be met by an app whose holders unmount. The library now
 * installs its own hook past the seal (unseal, add, seal again); the bus is
 * still sealed for the app, as the last assertions of both tests show.
 */
