/** useSharedCommandState().dispose() called twice by one holder. */
import { beforeAll, describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useSharedCommandState, waitForVueDetection } from '../src/chamber';
import { type CommandBus, createAsyncCommandBus } from '../src/command-bus';

// The scope's dispose() reaches the holder only once Vue is detected (see the note at the end).
beforeAll(() => waitForVueDetection());

function held() {
  const bus = createAsyncCommandBus() as unknown as CommandBus;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  bus.register('siteCreate', async () => { await gate; return 1; });
  bus.register('quick', async () => 1);
  return { bus, release };
}

describe('dispose twice', () => {
  it('control: one dispose per holder, a later holder keeps tracking', async () => {
    const { bus, release } = held();
    const a = useSharedCommandState({ bus });
    a.isLoading('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    const b = useSharedCommandState({ bus });
    release();
    await p;
    const flag = b.isLoading('quick');
    const q = bus.dispatch('quick', undefined);
    expect(flag.value).toBe(true);
    await q;
    b.dispose();
  });

  it('manual dispose then scope stop, mid-flight: the next holder still tracks', async () => {
    const { bus, release } = held();
    const scope = effectScope();
    const a = scope.run(() => useSharedCommandState({ bus }))!;
    a.isLoading('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    scope.stop(); // the auto-cleanup calls dispose again
    const b = useSharedCommandState({ bus });
    release();
    await p;
    const flag = b.isLoading('quick');
    const q = bus.dispatch('quick', undefined);
    expect(flag.value).toBe(true);
    await q;
    b.dispose();
  });

  it('manual dispose then scope stop, nothing in flight: later holders share one entry', () => {
    const { bus } = held();
    const scope = effectScope();
    const a = scope.run(() => useSharedCommandState({ bus }))!;
    a.dispose();
    const b = useSharedCommandState({ bus });
    scope.stop(); // a's second dispose
    const c = useSharedCommandState({ bus });
    expect(c.errors).toBe(b.errors);
    b.dispose();
    c.dispose();
  });
});

/*
 * Found by the perf-1.26 audit of 615c5fc (B3). A holder's dispose() is
 * public ("manually unhook") and is also registered with the scope by
 * tryAutoCleanup, so a component that unhooks by hand and then unmounts
 * calls it twice. Each call took the holder out of refCount again.
 * Mid-flight (the second test): refCount went to -1, the next holder brought
 * it to 0, and the settle that ended the last command released the entry
 * under that holder; its isLoading() never lit again (before-hooks 0).
 * Nothing in flight (the third test, older than B3): the second call deleted
 * the NEWER holder's entry from the map, so the holder after it built a
 * second entry: two on('*') observers, two error lists. dispose() now counts
 * each holder out once.
 * The second call comes from scope.stop() through tryAutoCleanup, which hooks
 * the scope only once the async Vue probe has resolved. Without the
 * beforeAll, a run where the probe was late never made the second call: the
 * tests passed without reaching the guard (seen as a coverage gap at the
 * guard in one full run).
 */
