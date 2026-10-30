/**
 * pending() read for the first time while its key is already in flight.
 * Why: a loading flag created mid-flight must start from the in-flight count, not from false, or a spinner would stay dark during a running dispatch.
 * Shows: a key counted before anyone reads it (tracking armed by another key) reads lit, a different key stays dark, and the same flag goes dark at the settle; the control reads before the dispatch.
 * See: log s35.44.
 */
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
    const flag = s.pending('siteCreate', 'a');
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
    s.pending('other');
    const p = bus.dispatch('siteCreate', 'a');
    const flag = s.pending('siteCreate', 'a');
    expect(flag.value).toBe(true);
    expect(s.pending('siteCreate', 'b').value).toBe(false);
    release();
    await p;
    expect(flag.value).toBe(false);
    s.dispose();
  });
});
