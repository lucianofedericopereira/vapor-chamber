// @vitest-environment happy-dom
/**
 * FIXTURE: a renderless component that holds a store, edited under real Vue HMR (`__VUE_HMR_RUNTIME__.reload`) against a real `createVaporApp`.
 * Why: a component that only holds a store renders nothing, so its setup returns `[]`; Vue 3.6.0-rc.14 located a reloaded block's boundary through its last node and threw a TypeError on a block with none, which its HMR runtime logs as "Full reload required", so the store pattern of tests/vapor/store-hmr.test.ts could not be hot-reloaded in its renderless form: the old store was never disposed and the edit never showed. rc.15 places such a block through its parent.
 * Shows: the reload logs no error, the old holder's store is disposed before the reloaded setup runs, the reloaded setup gets the edited definition, and the new content shows.
 * See: vuejs/core#16229, tests/vapor/store-hmr.test.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { createVaporApp, defineVaporComponent, nextTick, template } from 'vue';
import { createCommandBus } from '../../src/command-bus';
import { defineChamberStore } from '../../src/store';

type Hmr = { createRecord: (id: string, comp: unknown) => void; reload: (id: string, comp: unknown) => void };

const edit = (factor: number) =>
  defineChamberStore('cart', {
    state: () => ({ items: [] as number[] }),
    reducers: { add: (s, n: number) => ({ items: [...s.items, n * factor] }) },
  });

describe('a renderless store holder under hot reload', () => {
  it('a setup that returns no node: reloaded, the old store disposed, the new content shown', async () => {
    const hmr = (globalThis as { __VUE_HMR_RUNTIME__?: Hmr }).__VUE_HMR_RUNTIME__!;
    expect(hmr).toBeTruthy();
    const bus = createCommandBus();
    const order: string[] = [];
    const logged: string[] = [];
    const log = (...a: unknown[]) => {
      logged.push(String(a[0]).slice(0, 80));
    };
    vi.spyOn(console, 'error').mockImplementation(log);
    vi.spyOn(console, 'warn').mockImplementation(log);
    let held: ReturnType<ReturnType<typeof edit>> | undefined;

    const useV1 = edit(1);
    const id = 'fixture-store-hmr-no-nodes';
    const C1 = defineVaporComponent({
      __hmrId: id,
      setup() {
        held = useV1(bus);
        const dispose = held.$dispose;
        held.$dispose = () => { order.push('old store disposed'); dispose(); };
        return [];
      },
    } as never);
    hmr.createRecord(id, C1);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(C1 as never);
    app.mount(host);
    expect(host.textContent).toBe('');

    const useV2 = edit(10);
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

    expect(logged).toEqual([]);

    expect(order).toEqual(['old store disposed', 'reloaded setup']);
    expect(host.textContent).toBe('v2');
    held!.add(3);
    expect(held!.state.value.items).toEqual([30]);
    app.unmount();
    host.remove();
    bus.dispose();
  });
});
