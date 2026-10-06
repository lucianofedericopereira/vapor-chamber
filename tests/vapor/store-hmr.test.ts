// @vitest-environment happy-dom
/**
 * FIXTURE - a store module edited under REAL Vue HMR (log s35.101).
 *
 * When a store module changes, Vite re-runs it and the modules that import it,
 * and plugin-vue reloads each importing component with
 * `__VUE_HMR_RUNTIME__.reload(id, component)`: the new setup calls the NEW
 * definition of the store. Two holders, two outcomes before s35.101:
 *
 * - a component (scoped holder): Vue disposes the old instance BEFORE the
 *   reloaded setup runs, so the store's last holder leaves, the store is
 *   disposed and the new definition builds fresh. This worked already, and the
 *   redefinition rule relies on it; pinned here.
 * - a store created at module load (pinned, no scope): nothing disposes it, so
 *   the re-run module's `useStore` got the FIRST definition's store - edited
 *   reducers never applied, a new action was missing. tests/store-redefine.test.ts.
 *
 * Dev-only by nature, like tests/vapor/vapor-outlet-hmr.test.ts, whose harness
 * this follows: the real runtime against a real `createVaporApp`.
 */

import { describe, expect, it, vi } from 'vitest';
import { createVaporApp, defineVaporComponent, nextTick, template } from 'vue';
import { createCommandBus } from '../../src/command-bus';
import { defineChamberStore } from '../../src/store';

type Hmr = { createRecord: (id: string, comp: unknown) => void; reload: (id: string, comp: unknown) => void };

const edit = (factor: number) =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    reducers: { add: (s, n: number) => ({ items: [...s.items, n * factor] }), ...(factor > 1 ? { bump: (s: { items: number[] }) => s } : {}) },
  });

describe('a store module hot update', () => {
  it('a component holding the store: the reloaded setup gets the edited definition', async () => {
    const hmr = (globalThis as { __VUE_HMR_RUNTIME__?: Hmr }).__VUE_HMR_RUNTIME__!;
    // Guard the harness: without the dev runtime this file would measure nothing.
    expect(hmr).toBeTruthy();
    const bus = createCommandBus();
    const order: string[] = [];
    let held: ReturnType<ReturnType<typeof edit>> | undefined;

    const useV1 = edit(1);
    const id = 'fixture-store-hmr-holder';
    const C1 = defineVaporComponent({
      __hmrId: id,
      setup() {
        held = useV1(bus);
        const dispose = held.$dispose;
        held.$dispose = () => { order.push('old store disposed'); dispose(); };
        return (template('<i>v1</i>', 1) as () => Element)();
      },
    } as never);
    hmr.createRecord(id, C1);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(C1 as never);
    app.mount(host);

    const useV2 = edit(10); // the store module re-ran
    const C2 = defineVaporComponent({
      __hmrId: id,
      setup() {
        order.push('reloaded setup');
        held = useV2(bus);
        return (template('<i>v2</i>', 1) as () => Element)();
      },
    } as never);
    hmr.reload(id, C2);
    await nextTick();

    expect(order).toEqual(['old store disposed', 'reloaded setup']);
    expect(host.textContent).toBe('v2');
    held!.add(3);
    expect(held!.state.value.items).toEqual([30]);
    expect(typeof (held as { bump?: unknown }).bump).toBe('function');
    app.unmount();
    host.remove();
    bus.dispose();
  });

  it('a store created at module load: the re-run module gets the edited definition', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const before = edit(1)(bus); // module scope: no effect scope, pinned
    const after = edit(10)(bus); // the module re-ran
    after.add(3);
    expect(after.state.value.items).toEqual([30]);
    expect(typeof (after as { bump?: unknown }).bump).toBe('function');
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });
});
