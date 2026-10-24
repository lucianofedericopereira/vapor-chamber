// useCommand on an async bus that cannot reject adds no promise to a dispatch. The long note is at the end.
import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { createAsyncCommandBus } from '../src/command-bus';
import { useCommand } from '../src/chamber';

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

const composable = (bus: ReturnType<typeof createAsyncCommandBus>) => effectScope().run(() => useCommand({ bus }))!;

describe('useCommand on an async bus', () => {
  it('a bus that cannot reject: the dispatch settles in the turns of bus.dispatch', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('go', async (cmd) => cmd.target);
    const { dispatch } = composable(bus);
    expect(await turns(dispatch('go', 1) as Promise<unknown>)).toBe(await turns(bus.dispatch('go', 1)));
  });

  it('control: on a bus that declares onMissing: \'throw\', the rejection still settles as a failed result', async () => {
    const bus = createAsyncCommandBus({ retry: false, onMissing: 'throw' });
    const { dispatch } = composable(bus);
    const r = await (dispatch('nobody' as never, 1) as Promise<{ ok: boolean; error?: { code?: string } }>);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('core:missing:handler');
  });

  it('a naming rule that throws: the rejection settles as a failed result too', async () => {
    const bus = createAsyncCommandBus({ retry: false, naming: { pattern: /^[a-z]+$/, onViolation: 'throw' } });
    bus.register('go', async () => 1);
    const { dispatch } = composable(bus);
    const r = await (dispatch('Bad_Name' as never, 1) as Promise<{ ok: boolean }>);
    expect(r.ok).toBe(false);
  });

  it('every other outcome resolves on a bus that cannot reject: a value, a throw, a refusal, a missing handler', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('go', async () => 1);
    bus.register('boom', async () => { throw new Error('no'); });
    bus.use({ authorize: () => (cmd) => (cmd.action === 'go' && cmd.target === -1 ? { ok: false, value: undefined, error: new Error('refused') } : undefined) });
    const { dispatch } = composable(bus);
    const all = await Promise.allSettled([dispatch('go', 1), dispatch('boom' as never, 1), dispatch('go', -1), dispatch('nobody' as never, 1)] as Promise<unknown>[]);
    expect(all.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(all.map((x) => (x as PromiseFulfilledResult<{ ok: boolean }>).value.ok)).toEqual([true, false, false, false]);
  });
});

// Why: useCommand's dispatch put `.then(undefined, rejected)` on every async
// dispatch, a promise and a turn, to turn a rejection into a failed result. An
// async bus rejects only when it declares `onMissing: 'throw'` or a naming rule
// with `onViolation: 'throw'`, both set at creation, so the composable decides
// once whether its bus can reject. The turn count pins the claim against
// bus.dispatch itself. The controls pin both rejecting buses, still settled as
// failed results, and the last case pins that every other outcome of a bus that
// cannot reject resolves on its own, so nothing needed the `.then`.
