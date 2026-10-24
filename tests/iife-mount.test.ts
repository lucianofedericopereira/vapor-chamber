// @vitest-environment happy-dom
// `VaporChamber.mount`: an island's stores on its own bus, its element bound, `unmount()` releases both. Rationale at the end.
import { afterEach, describe, expect, it, vi } from 'vitest';
import VaporChamber from '../src/iife';
import { createApp } from '../src/iife-app';
import { bindCommands } from '../src/command-binding';
import { bindDisplay } from '../src/page-bindings';
import { defineChamberStore } from '../src/store/core';

type Period = 'day' | 'week' | 'month';
const useAnalytics = defineChamberStore('analytics', {
  state: () => ({ period: 'week' as Period }),
  reducers: { setPeriod: (_s: { period: Period }, target: { period: Period }) => ({ period: target.period }) },
});

const ISLAND = '<div id="analytics-island"><strong data-vc-text="analytics.period"></strong>'
  + '<button data-vc-command="analyticsSetPeriod" data-vc-target=\'{"period":"day"}\'>Day</button></div>';

const settle = () => new Promise((r) => setTimeout(r, 0));
const page = () => { document.body.innerHTML = ISLAND; };
const text = () => document.querySelector('strong')!.textContent;
const click = () => document.querySelector('button')!.click();

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('VaporChamber.mount', () => {
  it('creates each store of `stores` on the island bus and returns it under its name', async () => {
    page();
    const island = VaporChamber.mount('#analytics-island', { stores: { analytics: useAnalytics } });
    expect(island.stores.analytics.state.value.period).toBe('week');
    await island.dispatch('analyticsSetPeriod', { period: 'month' });
    expect(island.stores.analytics.state.value.period).toBe('month');
    island.unmount();
  });

  it('binds the element: a click writes the store and the text follows', async () => {
    page();
    const island = VaporChamber.mount('#analytics-island', { stores: { analytics: useAnalytics } });
    const before = text();
    click();
    await settle();
    expect({ el: island.el, before, after: text(), period: island.stores.analytics.state.value.period })
      .toEqual({ el: document.getElementById('analytics-island'), before: 'week', after: 'day', period: 'day' });
    island.unmount();
  });

  it('unmount() unbinds the element and disposes the stores', async () => {
    page();
    const island = VaporChamber.mount('#analytics-island', { stores: { analytics: useAnalytics } });
    const store = island.stores.analytics;
    island.unmount();
    click();
    await settle();
    expect(text()).toBe('week');
    expect(await island.dispatch('analyticsSetPeriod', { period: 'day' })).toFailWith('core:missing:handler');
    expect(store.state.value.period).toBe('week');
  });

  it('a selector with no match creates the stores, binds nothing and warns in development', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const island = VaporChamber.mount('#nowhere', { stores: { analytics: useAnalytics } });
    expect({ el: island.el, period: island.stores.analytics.state.value.period })
      .toEqual({ el: null, period: 'week' });
    expect(warn.mock.calls.filter((c) => c.some((a) => String(a).includes('mount:missing:element'))).length).toBe(1);
    island.unmount();
  });

  it('with no document (a server render): the stores, no element', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('document', undefined);
    try {
      const island = VaporChamber.mount('#analytics-island', { stores: { analytics: useAnalytics } });
      expect({ el: island.el, period: island.stores.analytics.state.value.period }).toEqual({ el: null, period: 'week' });
      island.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('with no stores: a bus and an empty record, the element bound', () => {
    page();
    const island = VaporChamber.mount('#analytics-island');
    expect(island.stores).toEqual({});
    island.unmount();
  });

  it('control: the same island wired by hand', async () => {
    page();
    const { bus } = createApp();
    const analytics = useAnalytics(bus);
    const el = document.getElementById('analytics-island')!;
    const unbind = [bindCommands(el, { bus }), bindDisplay(el, { bus })];
    const before = text();
    click();
    await settle();
    expect({ before, after: text(), period: analytics.state.value.period }).toEqual({ before: 'week', after: 'day', period: 'day' });
    for (const u of unbind) u();
    analytics.$dispose();
  });
});

// Rationale. `mount` returned its `state` option as given and never bound its
// element, from the v0.5 draft on (log 36.F38). On 1.32 the store holds every
// state, so the island's state is its stores: the app declares each one, and
// `mount` creates them on the island's bus, binds `data-vc-command` and the
// display attributes, and hands back `unmount()`. The control wires the same
// island by hand, so a red case is mount's, never the harness's click or text.
