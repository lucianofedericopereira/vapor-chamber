/**
 * FIXTURE - a synchronous subscriber that THROWS on one of
 * `useVaporAsyncCommand`'s two opening writes must not reject the dispatch or
 * leave `loading` stuck on true. Real Vue `effect`s. The long note is at the end.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { effect, isRef } from 'vue';
import { waitForVueDetection } from '../src/chamber';
import { useVaporAsyncCommand } from '../src/chamber-vapor';
import { createAsyncCommandBus } from '../src/command-bus';

type Outcome = { ok: boolean; error?: Error; value?: unknown };

/** Await a dispatch and keep both what it resolved and what it rejected with. */
async function attempt(run: () => Promise<unknown>): Promise<{ result: Outcome; rejected: unknown }> {
  try {
    return { result: (await run()) as Outcome, rejected: undefined };
  } catch (e) {
    return { result: { ok: true }, rejected: e };
  }
}

describe('useVaporAsyncCommand: a throwing sync subscriber on its opening writes', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });

  it('on `loading`: resolves a failed result with the subscriber\'s error, the handler does not run, loading ends false', async () => {
    const bus = createAsyncCommandBus();
    let handled = 0;
    bus.register('save', async () => {
      handled++;
      return 'saved';
    });
    const { dispatch, loading, lastError } = useVaporAsyncCommand(bus as never);
    // Control: the signal is Vue's, so the effect below is a real subscriber.
    expect(isRef(loading)).toBe(true);

    const boom = new Error('subscriber threw');
    const seen: boolean[] = [];
    const runner = effect(() => {
      seen.push(loading.value);
      if (loading.value) throw boom;
    });

    const { result, rejected } = await attempt(() => dispatch('save', {}));

    // Control: the subscriber did see the write to true.
    expect(seen).toContain(true);
    expect({ loading: loading.value, rejected }).toEqual({ loading: false, rejected: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
    expect(lastError.value).toBe(boom);
    expect(handled).toBe(0);
    runner.effect.stop();
  });

  it('on `lastError` being cleared: the same, and loading ends false', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    const { dispatch, loading, lastError } = useVaporAsyncCommand(bus as never);
    // A first, failing dispatch leaves an error for the next one to clear.
    await dispatch('missing', {});
    expect(lastError.value).toBeInstanceOf(Error);

    const boom = new Error('subscriber threw');
    let armed = false;
    const runner = effect(() => {
      if (lastError.value === null && armed) throw boom;
    });
    armed = true;

    const { result, rejected } = await attempt(() => dispatch('missing', {}));

    expect({ loading: loading.value, rejected }).toEqual({ loading: false, rejected: undefined });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(boom);
    expect(lastError.value).toBe(boom);
    runner.effect.stop();
  });

  it('control, no throwing subscriber: the writes a subscriber sees, in order, are unchanged', async () => {
    const bus = createAsyncCommandBus();
    bus.register('save', async () => 'saved');
    const { dispatch, loading, lastError } = useVaporAsyncCommand(bus as never);
    const events: string[] = [];
    const a = effect(() => {
      events.push(`loading:${loading.value}`);
    });
    const b = effect(() => {
      events.push(`error:${lastError.value === null ? 'null' : 'set'}`);
    });
    events.length = 0;

    const ok = (await dispatch('save', {})) as Outcome;
    const bad = (await dispatch('nope', {})) as Outcome;

    expect(ok).toMatchObject({ ok: true, value: 'saved' });
    expect(bad.ok).toBe(false);
    expect(events).toEqual([
      // dispatch 1, succeeds: lastError was already null, so its write is silent.
      'loading:true',
      'loading:false',
      // dispatch 2, no handler: the error is set before loading drops.
      'loading:true',
      'error:set',
      'loading:false',
    ]);
    a.effect.stop();
    b.effect.stop();
  });
});

/*
 * Why this file exists. `useVaporAsyncCommand` is hand-rolled (it does not go
 * through `runDispatch`) and had the shape `runDispatch` had before log s35.17:
 * `loading.value = true` and `lastError.value = null` stood before the `try`
 * of an `async` function. A Vue effect runs synchronously inside the write
 * that triggers it, so a subscriber that throws there made the returned
 * promise REJECT with the subscriber's error, skipped the `finally`, and left
 * `loading` true for good; the handler never ran. Measured on Vue 3.6.0-rc.10
 * (log s35.17, then s35.23).
 *
 * With both writes inside the `try`, the subscriber's error takes the path
 * every other failure takes: a failed `CommandResult`, `lastError` set,
 * `loading` false. The third test is the control for the move: with no
 * throwing subscriber the sequence of writes a subscriber observes is the one
 * listed, and it was the same list before the move.
 */
