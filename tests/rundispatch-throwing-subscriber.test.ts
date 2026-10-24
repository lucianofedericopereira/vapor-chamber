/**
 * FIXTURE - a synchronous subscriber that THROWS on `runDispatch`'s opening
 * write must not leave `loading` stuck on true. Real Vue `effect`s on the real
 * `useCommandQuery` signal. The long note is at the end.
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
    // Control: the signal is Vue's, so the effect below is a real subscriber.
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

/*
 * Why this file exists. runDispatch wrote `loading` before its try. A
 * synchronous subscriber that threw on that write escaped the call as a throw
 * and left `loading` true for every reader. The write is inside the try now:
 * the throw is a failed result, the handler does not run, and the count
 * returns to 0. useCommand once had the same writes (its own `loading` and
 * `lastError`); its busy state is the bus's `pending` now
 * (tests/usecommand-pending.test.ts), so the query composable is the one
 * writer left.
 */
