/**
 * A synchronous subscriber that throws on the opening write of `useCommandQuery`'s `loading` signal.
 * Why: a throw there must become a failed result with `loading` back to false, never escape the call and leave every reader seeing `loading` stuck on true.
 * Shows: with a real Vue `effect` that throws when `loading` turns true, the query returns the subscriber's error as a failed result, the handler does not run, `loading` ends false and nothing escapes.
 * See: log s35.17, tests/usecommand-pending.test.ts
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { effect, isRef } from 'vue';
import { resetCommandBus, setCommandBus, useCommandQuery, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

type Outcome = { ok: boolean; error?: Error };

/** Run a query and keep both what it returned and what escaped it. */
function attempt(run: () => unknown): { result: Outcome; escaped: unknown } {
  try {
    return { result: run() as Outcome, escaped: undefined };
  } catch (e) {
    return { result: { ok: true }, escaped: e };
  }
}

describe('runDispatch: a throwing sync subscriber on its opening write', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });
  afterEach(() => resetCommandBus());

  it('on `loading`: the query fails with the subscriber\'s error, the handler does not run, loading ends false', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    let handled = 0;
    bus.register('cartRead', () => {
      handled++;
      return 'read';
    });
    const { query, loading } = useCommandQuery();
    // Control: `loading` is a Vue ref, so the effect below is a real subscriber.
    expect(isRef(loading)).toBe(true);

    const boom = new Error('subscriber threw');
    const seen: boolean[] = [];
    const runner = effect(() => {
      seen.push(loading.value);
      if (loading.value) throw boom;
    });

    const { result, escaped } = attempt(() => query('cartRead', {}));

    // Control: the subscriber did see the write to true.
    expect(seen).toContain(true);
    expect({ loading: loading.value, escaped }).toEqual({ loading: false, escaped: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
    expect(handled).toBe(0);
    runner.effect.stop();
  });
});
