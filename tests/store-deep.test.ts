/** `deep: true` on the Vue store: `state.value` is Vue's reactive view, the library keeps the raw state. Rationale at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, isReactive } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { shareTabs } from '../src/store-share';
import { listen, quiet } from './tabs-quiet';

type Form = { profile: { name: string }; tags: string[] };
const state = (): Form => ({ profile: { name: '' }, tags: [] });
const seen: unknown[] = [];
const reducers = {
  rename: (s: Form, name: string) => { seen.push(s); return { ...s, profile: { name } }; },
};

afterEach(() => { seen.length = 0; vi.unstubAllGlobals(); });

describe('deep: true', () => {
  it('a nested mutation through state.value is tracked by a Vue reader', () => {
    const form = defineChamberStore('form', { state, reducers, deep: true })(createCommandBus());
    const name = computed(() => form.state.value.profile.name);
    expect(name.value).toBe('');
    form.state.value.profile.name = 'Ada';
    expect(name.value).toBe('Ada');
    form.rename('Grace');
    expect(name.value).toBe('Grace');
    form.$dispose();
  });

  it('reducers get the raw state, and a tab gets a state it can clone', async () => {
    vi.stubGlobal('window', {});
    const name = `deep-${Math.random()}`;
    const make = () => defineChamberStore('form', { state, reducers, deep: true, share: shareTabs(name) })(createCommandBus());
    const wire = listen(name);
    const a = make();
    const b = make();
    expect(isReactive(a.state.value)).toBe(true);
    a.rename('Ada');
    expect(isReactive(seen[0])).toBe(false);
    await quiet(wire.heard);
    wire.close();
    expect(b.state.value.profile.name).toBe('Ada');
    a.$dispose();
    b.$dispose();
  });

  it('control: without deep, state.value is the raw state', () => {
    const form = defineChamberStore('form', { state, reducers })(createCommandBus());
    expect(isReactive(form.state.value)).toBe(false);
    form.$dispose();
  });
});

/*
 * `useDeepCommandState` was `useCommandState` over a deep `ref`: its state's
 * nested fields, mutated in place by a `v-model`, were tracked by Vue. It folds
 * into the store (plan 1.32 4e) as `deep: true`, Vue entry only. The plan said
 * the cell is a `ref`; a ref's value is a reactive Proxy, and a Proxy fails
 * the structured clone a shared store sends (`DataCloneError`, measured
 * 2026-10-19, Vue 3.6.0-rc.12), and it would reach reducers, persist and the
 * field events too. So the cell stays raw and only the public `state.value`
 * getter, picked at definition, returns Vue's `reactive()` view of it, the
 * one cached proxy per object. A mutation through the view changes the raw in
 * place: the library, which follows writes by identity, does not see it.
 */
