/**
 * useSharedCommandState().pending across its last holder leaving, and on a sealed bus.
 * Why: the shared entry must outlive its last holder while a command it started is in flight, or the next holder (the page a route change mounts) reads the key false while the command runs; tracking must not use a seal-guarded hook, or pending() would throw core:refused:bus on a sealed bus.
 * Shows: the next holder reads the key lit and then settled, the entry is released when the last key settles or at once with nothing in flight, no hooks or listeners remain, and on a sealed bus tracking works and the bus stays sealed.
 * See: log s35.41, log s35.42
 */
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

/** Is the entry still held? A fresh holder reads the same key's signal only then. */
const heldEntry = (bus: CommandBus, flag: object, action: string): boolean => {
  const probe = useSharedCommandState({ bus });
  const same = probe.pending(action) === flag;
  probe.dispose();
  return same;
};

/** Nothing of the state is on the user's hooks or listeners. */
const hooks = (bus: Parameters<typeof inspectBus>[0]) => {
  const i = inspectBus(bus);
  return [i.afterHookCount, i.listenerPatterns.length];
};

describe('pending across the last holder leaving', () => {
  it('control: a second holder while the first still holds reads the key lit', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.pending('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    const b = useSharedCommandState({ bus });
    expect(b.pending('siteCreate').value).toBe(true);
    a.dispose();
    release();
    await p;
    expect(b.pending('siteCreate').value).toBe(false);
    b.dispose();
  });

  it('handover: the first holder leaves mid-flight, the next one reads it lit, then settled', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.pending('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    const b = useSharedCommandState({ bus });
    const flag = b.pending('siteCreate');
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
    const flag = a.pending('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    expect({ held: heldEntry(bus, flag, 'siteCreate'), hooks: hooks(bus) }).toEqual({ held: true, hooks: [0, 0] });
    release();
    await p;
    expect(heldEntry(bus, flag, 'siteCreate')).toBe(false);
  });

  it('nothing in flight: the last holder leaving releases the entry at once', () => {
    const bus = createCommandBus();
    const a = useSharedCommandState({ bus });
    const flag = a.pending('x');
    expect(hooks(bus)).toEqual([0, 0]);
    a.dispose();
    expect(heldEntry(bus, flag, 'x')).toBe(false);
  });
});

describe('pending on a sealed bus', () => {
  it('armed, sealed, every holder leaves: the next holder tracks, the bus stays sealed', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.pending('siteCreate');
    bus.seal();
    a.dispose();
    const b = useSharedCommandState({ bus });
    const flag = b.pending('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    expect(flag.value).toBe(true);
    release();
    await p;
    expect(flag.value).toBe(false);
    expect(bus.isSealed()).toBe(true);
    expect(() => bus.onAfter(() => {})).toThrow();
    b.dispose();
  });

  it('first asked after seal(): tracks, the bus stays sealed', () => {
    const bus = createCommandBus();
    let lit: boolean | undefined;
    bus.register('x', () => {
      lit = s.pending('x').value;
    });
    bus.seal();
    const s = useSharedCommandState({ bus });
    s.pending('x');
    bus.dispatch('x', undefined);
    expect(lit).toBe(true);
    expect(s.pending('x').value).toBe(false);
    expect(bus.isSealed()).toBe(true);
    s.dispose();
  });
});
