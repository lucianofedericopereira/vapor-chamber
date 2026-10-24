// A Vue subscriber that throws on a command-state write is logged; the dispatch runs and nothing stays lit. Rationale at the end.
import { beforeAll, describe, expect, vi } from 'vitest';
import { effect, isRef } from 'vue';
import { createAsyncCommandBus, createCommandBus, useSharedCommandState, waitForVueDetection } from '../src/index';
import { it } from '../src/vitest';

describe('useSharedCommandState: a subscriber that throws on a write', () => {
  beforeAll(async () => {
    await waitForVueDetection();
  });

  for (const read of ['anyPending', 'pending'] as const) {
    it(`on \`${read}\`, sync bus: the dispatch runs, the throw is logged, nothing stays lit`, () => {
      const bus = createCommandBus();
      let handled = 0;
      bus.register('save', () => { handled++; return 1; });
      const s = useSharedCommandState({ bus });
      const flag = read === 'anyPending' ? s.anyPending : s.pending('save', null);
      // Control: the signal is Vue's, so the effect is a real subscriber.
      expect(isRef(flag)).toBe(true);
      const boom = new Error('subscriber threw');
      const runner = effect(() => { if (flag.value) throw boom; });
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = bus.dispatch('save', null);
      const logged = err.mock.calls.some((c) => c.includes(boom));
      err.mockRestore();
      runner.effect.stop();
      expect({ result, handled, lit: flag.value, any: s.anyPending.value, logged })
        .toEqual({ result: { ok: true, value: 1, error: undefined }, handled: 1, lit: false, any: false, logged: true });
      s.dispose();
    });
  }

  it('on the settle\'s write: logged, the next dispatch lights and settles the key again', () => {
    const bus = createCommandBus();
    bus.register('save', () => 1);
    const s = useSharedCommandState({ bus });
    const flag = s.pending('save', null);
    const boom = new Error('subscriber threw');
    let armed = false;
    const seen: boolean[] = [];
    const runner = effect(() => { seen.push(flag.value); if (armed && !flag.value) throw boom; });
    armed = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = bus.dispatch('save', null);
    armed = false;
    const second = bus.dispatch('save', null);
    const logged = err.mock.calls.some((c) => c.includes(boom));
    err.mockRestore();
    runner.effect.stop();
    expect({ ok: first.ok && second.ok, seen, lit: flag.value, logged })
      .toEqual({ ok: true, seen: [false, true, false, true, false], lit: false, logged: true });
    s.dispose();
  });

  it("a key's throwing reader leaves anyPending right", () => {
    const bus = createCommandBus();
    let during = false;
    bus.register('save', () => { during = any.value; return 1; });
    const s = useSharedCommandState({ bus });
    const flag = s.pending('save', null);
    const any = s.anyPending;
    const runner = effect(() => { if (flag.value) throw new Error('subscriber threw'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.dispatch('save', null);
    err.mockRestore();
    runner.effect.stop();
    expect({ during, after: any.value }).toEqual({ during: true, after: false });
    s.dispose();
  });

  it('on the failure\'s write: logged, the error still lands in the ring', () => {
    const bus = createCommandBus();
    bus.register('save', () => { throw new Error('refused'); });
    const s = useSharedCommandState({ bus });
    const boom = new Error('subscriber threw');
    const runner = effect(() => { if (s.lastError.value) throw boom; });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = bus.dispatch('save', null);
    const logged = err.mock.calls.some((c) => c.includes(boom));
    err.mockRestore();
    runner.effect.stop();
    expect({ ok: result.ok, last: s.lastError.value?.message, ring: s.errors.value.length, logged }).toEqual({ ok: false, last: 'refused', ring: 1, logged: true });
    s.dispose();
  });

  it('async bus: the dispatch settles with its own result', async () => {
    const bus = createAsyncCommandBus();
    bus.register('save', async () => 1);
    const s = useSharedCommandState({ bus });
    const boom = new Error('subscriber threw');
    const runner = effect(() => { if (s.anyPending.value) throw boom; });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await bus.dispatch('save', null);
    err.mockRestore();
    runner.effect.stop();
    expect({ ok: result.ok, value: result.value, any: s.anyPending.value }).toEqual({ ok: true, value: 1, any: false });
    s.dispose();
  });
});

/*
 * Why this file exists. The command state's writes once ran inside a
 * before-hook or a dispatch wrapper, so a synchronous subscriber that threw on
 * one cancelled the dispatch, or escaped it and left a count at 1, lighting
 * every reader for ever (log s35.222, s35.227). It is now the bus's
 * internal facts observer (plan 1.32 4.4) and catches its writes: the throw is
 * logged, the dispatch runs with its own result, and the counts move before any write
 * (`lit` and `ended` in src/command-state.ts), so the settle still ends the
 * start.
 */
