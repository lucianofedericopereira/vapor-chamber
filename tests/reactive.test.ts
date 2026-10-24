/**
 * Tests for vapor-chamber/reactive - the opt-in DEEP reactivity companion.
 *
 * Proves the "best of both worlds" contract:
 *   - the core stays shallow + fast (covered in chamber.test.ts);
 *   - this companion adds deep reactivity where direct nested mutation triggers;
 *   - a store with deep nested fields takes `deep: true` (tests/store-deep.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isShallow, isReactive, effectScope, watchEffect } from 'vue';
import { deepSignal } from '../src/reactive';
import {
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
      // deep => nested value is a reactive proxy
      expect(isReactive(s.value.nested)).toBe(true);
    });

    it('triggers reactivity on direct nested mutation (the whole point)', async () => {
      await waitForVueDetection();
      const s = deepSignal({ profile: { name: '' } });

      const seen: string[] = [];
      const scope = effectScope();
      scope.run(() => { watchEffect(() => { seen.push(s.value.profile.name); }); });

      s.value.profile.name = 'Ada'; // direct nested mutation - no reassignment
      await Promise.resolve();

      expect(seen[0]).toBe('');
      expect(seen[seen.length - 1]).toBe('Ada');
      scope.stop();
    });
  });
});
