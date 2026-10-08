// A throwing subscriber on useSharedCommandState's opening writes fails the dispatch, leaves nothing lit; rationale at the end.
import { beforeAll, describe, expect } from 'vitest';
import { effect, isRef } from 'vue';
import { createAsyncCommandBus, createCommandBus, useSharedCommandState, waitForVueDetection } from '../src/index';
import { it } from '../src/vitest';

/** Run a dispatch and keep both what it returned and what escaped it. */
function attempt(run: () => unknown): { result: unknown; escaped: unknown } {
  try {
    return { result: run(), escaped: undefined };
  } catch (e) {
    return { result: undefined, escaped: e };
  }
}

describe('useSharedCommandState: a throwing subscriber on its opening writes', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });

  for (const signalName of ['inFlight', 'isAnyLoading'] as const) {
    it(`on \`${signalName}\`, sync bus: a failed result, the handler does not run, nothing stays lit`, () => {
      const bus = createCommandBus();
      let handled = 0;
      bus.register('save', () => { handled++; return 1; });
      const s = useSharedCommandState({ bus });
      // Control: the signal is Vue's, so the effect is a real subscriber.
      expect(isRef(s[signalName])).toBe(true);
      const boom = new Error('subscriber threw');
      const runner = effect(() => { if (s[signalName].value) throw boom; });
      const { result, escaped } = attempt(() => s.dispatch('save', null));
      runner.effect.stop();
      expect({ escaped, inFlight: s.inFlight.value, isAnyLoading: s.isAnyLoading.value, handled })
        .toEqual({ escaped: undefined, inFlight: 0, isAnyLoading: false, handled: 0 });
      expect(result).toEqual({ ok: false, error: boom });
      expect(s.lastError.value).toBe(boom);
      s.dispose();
    });
  }

  it('async bus: the failure is a promise, as its type says', async () => {
    const bus = createAsyncCommandBus();
    bus.register('save', async () => 1);
    const s = useSharedCommandState({ bus });
    const boom = new Error('subscriber threw');
    const runner = effect(() => { if (s.isAnyLoading.value) throw boom; });
    const { result, escaped } = attempt(() => s.dispatch('save', null));
    runner.effect.stop();
    expect(escaped).toBeUndefined();
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({ ok: false, error: boom });
    expect(s.inFlight.value).toBe(0);
    s.dispose();
  });
});

/*
 * Why this file exists. useSharedCommandState's dispatch wrote `inFlight` and
 * `isAnyLoading` before its try. A synchronous subscriber that throws on one
 * of them escaped the dispatch as a throw, and left the count at 1, so every
 * reader of `isAnyLoading` stayed lit. runDispatch had the same shape and was
 * fixed for useCommand (tests/rundispatch-throwing-subscriber.test.ts). This
 * is the same rule here: the throw is a failed result, the handler does not
 * run, and the count returns to 0. On an async bus the failure is a promise,
 * since the dispatch is typed as one there (log s35.222, s35.227).
 */
