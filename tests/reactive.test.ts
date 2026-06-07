/**
 * Tests for vapor-chamber/reactive — the opt-in DEEP reactivity companion.
 *
 * Proves the "best of both worlds" contract:
 *   - the core stays shallow + fast (covered in chamber.test.ts);
 *   - this companion adds deep reactivity where direct nested mutation triggers;
 *   - command-driven whole-value replacement still works;
 *   - dispatch/coalesce/cleanup semantics match useCommandState (shared core).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isShallow, isReactive, effectScope, watchEffect } from 'vue';
import { deepSignal, useDeepCommandState } from '../src/reactive';
import {
  getCommandBus,
  setCommandBus,
  resetCommandBus,
  waitForVueDetection,
} from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

describe('vapor-chamber/reactive', () => {
  beforeEach(() => { setCommandBus(createCommandBus()); });
  afterEach(() => { resetCommandBus(); });

  describe('deepSignal', () => {
    it('returns a DEEP (non-shallow) Vue ref once Vue is detected', async () => {
      await waitForVueDetection();
      const s = deepSignal({ nested: { n: 1 } });
      expect(isShallow(s)).toBe(false);
      // deep ⇒ nested value is a reactive proxy
      expect(isReactive(s.value.nested)).toBe(true);
    });

    it('triggers reactivity on direct nested mutation (the whole point)', async () => {
      await waitForVueDetection();
      const s = deepSignal({ profile: { name: '' } });

      const seen: string[] = [];
      const scope = effectScope();
      scope.run(() => { watchEffect(() => { seen.push(s.value.profile.name); }); });

      s.value.profile.name = 'Ada'; // direct nested mutation — no reassignment
      await Promise.resolve();

      expect(seen[0]).toBe('');
      expect(seen[seen.length - 1]).toBe('Ada');
      scope.stop();
    });
  });

  describe('useDeepCommandState', () => {
    it('updates via commands AND exposes deep reactivity', async () => {
      await waitForVueDetection();
      const { state } = useDeepCommandState(
        { items: [] as number[], meta: { total: 0 } },
        {
          add: (s, cmd) => ({
            items: [...s.items, cmd.target as number],
            meta: { total: s.meta.total + 1 },
          }),
        },
      );

      // command-driven whole-value replacement
      const bus = getCommandBus();
      bus.dispatch('add', 1);
      bus.dispatch('add', 2);
      expect(state.value.items).toEqual([1, 2]);
      expect(state.value.meta.total).toBe(2);

      // deep reactivity: the nested object is a reactive proxy
      expect(isShallow(state)).toBe(false);
      expect(isReactive(state.value.meta)).toBe(true);
    });

    it('reacts to direct nested mutation of command state', async () => {
      await waitForVueDetection();
      const { state } = useDeepCommandState(
        { draft: { title: '' } },
        { reset: () => ({ draft: { title: '' } }) },
      );

      const seen: string[] = [];
      const scope = effectScope();
      scope.run(() => { watchEffect(() => { seen.push(state.value.draft.title); }); });

      // mutate in place (e.g. a v-model field) — deep ref makes this reactive
      state.value.draft.title = 'Hello';
      await Promise.resolve();

      expect(seen[seen.length - 1]).toBe('Hello');
      scope.stop();
    });

    it('supports coalesce like useCommandState (shared core)', async () => {
      await waitForVueDetection();
      const { state } = useDeepCommandState(
        [] as number[],
        { push: (s, cmd) => [...s, cmd.target as number] },
        { coalesce: true },
      );

      const bus = getCommandBus();
      bus.dispatch('push', 1);
      bus.dispatch('push', 2);
      bus.dispatch('push', 3);

      // coalesced: signal not yet written synchronously
      expect(state.value).toEqual([]);
      await Promise.resolve();
      expect(state.value).toEqual([1, 2, 3]);
    });

    it('unregisters handlers on dispose', async () => {
      await waitForVueDetection();
      const { state, dispose } = useDeepCommandState(
        { n: 0 },
        { inc: (s) => ({ n: s.n + 1 }) },
      );
      const bus = getCommandBus();
      bus.dispatch('inc', null);
      expect(state.value.n).toBe(1);

      dispose();
      const result = bus.dispatch('inc', null);
      expect(result.ok).toBe(false);
    });
  });
});
