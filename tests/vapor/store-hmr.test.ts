// @vitest-environment happy-dom
/**
 * A store module edited under real Vue HMR (`__VUE_HMR_RUNTIME__.reload`) against a real `createVaporApp`.
 * Why: when a store module changes, the reloaded component's setup must call the new definition of the store; a component holder is disposed before the reloaded setup runs, and a store created at module load has no scope to dispose it, so a stale first definition would apply old reducers and miss a new action. With the plugin's HOT mark set, the reloaded setup must keep the store's state.
 * Shows: the old holder's store is disposed before the reloaded setup runs, and the edited reducer and a new action are present; a module-level store redefined takes the edited definition; a reload under the HOT mark keeps the earlier items and the edited reducer applies to the next add.
 * See: log s35.101, tests/store-redefine.test.ts, tests/vapor/vapor-outlet-hmr.test.ts
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
    const before = edit(1)(bus); // module scope: no effect scope
    const after = edit(10)(bus);
    after.add(3);
    expect(after.state.value.items).toEqual([30]);
    expect(typeof (after as { bump?: unknown }).bump).toBe('function');
    before.$dispose();
    after.$dispose();
    bus.dispose();
  });
});

// The mark vaporChamberHMR's shim sets from `vite:beforeUpdate` to `vite:afterUpdate`.
const HOT = '__VAPOR_CHAMBER_HOT__';

describe('a hot update carries the state (the plugin marks it)', () => {
  it('a component holding the store: the reloaded setup keeps the state', async () => {
    const hmr = (globalThis as { __VUE_HMR_RUNTIME__?: Hmr }).__VUE_HMR_RUNTIME__!;
    expect(hmr).toBeTruthy();
    const bus = createCommandBus();
    let held: ReturnType<ReturnType<typeof edit>> | undefined;
    const useV1 = edit(1);
    const id = 'fixture-store-hmr-carry';
    const C1 = defineVaporComponent({
      __hmrId: id,
      setup() { held = useV1(bus); return (template('<i>v1</i>', 1) as () => Element)(); },
    } as never);
    hmr.createRecord(id, C1);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(C1 as never);
    app.mount(host);
    held!.add(1);

    (globalThis as Record<string, unknown>)[HOT] = new WeakMap();
    const useV2 = edit(10);
    const C2 = defineVaporComponent({
      __hmrId: id,
      setup() { held = useV2(bus); return (template('<i>v2</i>', 1) as () => Element)(); },
    } as never);
    hmr.reload(id, C2);
    await nextTick();
    delete (globalThis as Record<string, unknown>)[HOT];

    expect(host.textContent).toBe('v2');
    expect(held!.state.value.items).toEqual([1]);
    held!.add(3);
    expect(held!.state.value.items).toEqual([1, 30]);
    app.unmount();
    host.remove();
    bus.dispose();
  });
});
