/**
 * useSharedCommandState().dispose() called twice by one holder (by hand, then by the scope stopping).
 * Why: dispose() is public and also hooked to the scope, so a component that unhooks by hand and then unmounts would count its holder out twice, leaving the next holder's pending() unlit or its shared entry deleted and rebuilt.
 * Shows: after the double dispose the next holder still tracks a command in flight, and with nothing in flight later holders share one entry (same errors list).
 * See: log s35.42, src/chamber.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useSharedCommandState, waitForVueDetection } from '../src/chamber';
import { type CommandBus, createAsyncCommandBus } from '../src/command-bus';

// Auto-cleanup hooks the scope only once Vue is detected; without this wait the second dispose may never happen.
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
    a.pending('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    const b = useSharedCommandState({ bus });
    release();
    await p;
    const flag = b.pending('quick');
    const q = bus.dispatch('quick', undefined);
    expect(flag.value).toBe(true);
    await q;
    b.dispose();
  });

  it('manual dispose then scope stop, mid-flight: the next holder still tracks', async () => {
    const { bus, release } = held();
    const scope = effectScope();
    const a = scope.run(() => useSharedCommandState({ bus }))!;
    a.pending('siteCreate');
    const p = bus.dispatch('siteCreate', undefined);
    a.dispose();
    scope.stop(); // auto-cleanup calls dispose a second time
    const b = useSharedCommandState({ bus });
    release();
    await p;
    const flag = b.pending('quick');
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
    scope.stop(); // a's second dispose, after b took the entry
    const c = useSharedCommandState({ bus });
    expect(c.errors).toBe(b.errors);
    b.dispose();
    c.dispose();
  });
});
