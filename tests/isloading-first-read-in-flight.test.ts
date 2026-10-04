/** isLoading() first read while its key is already in flight: lit, then dark at the settle. The long note is at the end. */
import { describe, expect, it } from 'vitest';
import { useSharedCommandState } from '../src/chamber';
import { type CommandBus, createAsyncCommandBus } from '../src/command-bus';

function held() {
  const bus = createAsyncCommandBus() as unknown as CommandBus;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bus.register('siteCreate', async () => { await gate; return 1; });
  return { bus, release };
}

describe('isLoading read for the first time mid-flight', () => {
  it('control: read before the dispatch, lit while it runs, dark after', async () => {
    const { bus, release } = held();
    const s = useSharedCommandState({ bus });
    const flag = s.isLoading('siteCreate', 'a');
    const p = bus.dispatch('siteCreate', 'a');
    expect(flag.value).toBe(true);
    release();
    await p;
    expect(flag.value).toBe(false);
    s.dispose();
  });

  it('tracking armed by another key; this key read only once it is in flight', async () => {
    const { bus, release } = held();
    const s = useSharedCommandState({ bus });
    s.isLoading('other');
    const p = bus.dispatch('siteCreate', 'a');
    const flag = s.isLoading('siteCreate', 'a');
    expect(flag.value).toBe(true);
    expect(s.isLoading('siteCreate', 'b').value).toBe(false);
    release();
    await p;
    expect(flag.value).toBe(false);
    s.dispose();
  });
});

/*
 * perf-1.26 (log s35.44), item d. A loading slot used to carry its signal from
 * the moment a dispatch first counted into it, read or not, so every dispatch
 * of a key nobody asked about allocated a shallowRef and wrote it twice. The
 * slot now gets its signal on the first isLoading() read, created from the
 * count. The second test is the case that change could break: the key is
 * counted (tracking is armed by another key) before anyone reads it, so the
 * signal is created mid-flight and must start lit, and the settle must then
 * write that same signal dark. A seeded `signal(false)` in place of the count
 * turns it red.
 */
