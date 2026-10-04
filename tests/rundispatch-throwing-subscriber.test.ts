/**
 * FIXTURE - a synchronous subscriber that THROWS on one of `runDispatch`'s two
 * opening writes must not leave `loading` stuck on true. Real Vue `effect`s on
 * the real `useCommand` signals. The long note is at the end.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { effect, isRef } from 'vue';
import { resetCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

type Outcome = { ok: boolean; error?: Error };

/** Run a dispatch and keep both what it returned and what escaped it. */
function attempt(run: () => unknown): { result: Outcome; escaped: unknown } {
  try {
    return { result: run() as Outcome, escaped: undefined };
  } catch (e) {
    return { result: { ok: true }, escaped: e };
  }
}

describe('runDispatch: a throwing sync subscriber on its opening writes', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });
  afterEach(() => resetCommandBus());

  it('on `loading`: the dispatch fails with the subscriber\'s error, the handler does not run, loading ends false', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    let handled = 0;
    bus.register('save', () => {
      handled++;
      return 'saved';
    });
    const { dispatch, loading, lastError } = useCommand();
    // Control: the signal is Vue's, so the effect below is a real subscriber.
    expect(isRef(loading)).toBe(true);

    const boom = new Error('subscriber threw');
    const seen: boolean[] = [];
    const runner = effect(() => {
      seen.push(loading.value);
      if (loading.value) throw boom;
    });

    const { result, escaped } = attempt(() => dispatch('save' as never, {} as never));

    // Control: the subscriber did see the write to true.
    expect(seen).toContain(true);
    expect({ loading: loading.value, escaped }).toEqual({ loading: false, escaped: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
    expect(lastError.value).toBe(boom);
    expect(handled).toBe(0);
    runner.effect.stop();
  });

  it('on `lastError` being cleared: the same, and loading ends false', () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    setCommandBus(bus);
    const { dispatch, loading, lastError } = useCommand();
    // A first, failing dispatch leaves an error for the next one to clear.
    dispatch('missing' as never, {} as never);
    expect(lastError.value).toBeInstanceOf(Error);

    const boom = new Error('subscriber threw');
    let armed = false;
    const runner = effect(() => {
      if (lastError.value === null && armed) throw boom;
    });
    armed = true;

    const { result, escaped } = attempt(() => dispatch('missing' as never, {} as never));

    expect({ loading: loading.value, escaped }).toEqual({ loading: false, escaped: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
    expect(lastError.value).toBe(boom);
    runner.effect.stop();
  });
});
