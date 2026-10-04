/** persist() without getState throws at setup. The long note is at the end. */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function storage() {
  const s = { stored: null as string | null };
  return { s, api: { getItem: () => s.stored, setItem: (_k: string, v: string) => { s.stored = v; }, removeItem: () => { s.stored = null; } } };
}

describe('persist() requires getState', () => {
  it('control: with getState, a successful dispatch saves', async () => {
    const { persist } = await import('../src/plugins-io');
    const { createCommandBus } = await import('../src/command-bus');
    const { s, api } = storage();
    const bus = createCommandBus();
    bus.use(persist({ key: 'k', getState: () => ({ n: 1 }), storage: api }));
    bus.register('x', () => 1);
    bus.dispatch('x', undefined);
    expect(s.stored).toBe('{"n":1}');
  });

  it('without it: a TypeError at setup that names getState and says why, in dev', async () => {
    const { persist } = await import('../src/plugins-io');
    const { api } = storage();
    expect(() => persist({ key: 'k', storage: api } as never)).toThrow(TypeError);
    expect(() => persist({ key: 'k', storage: api } as never)).toThrow(/getState.*function returning the state/);
  });

  it('without it in production: the same TypeError, the short text', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const { persist } = await import('../src/plugins-io');
    const { api } = storage();
    let thrown: unknown;
    try {
      persist({ key: 'k', storage: api } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toBe('persist: getState');
  });
});

/*
 * Found by the 1.26 evaluation (external item 19, log s35.41). `getState` is
 * required by the type, so only a JavaScript caller or a cast reaches this,
 * and such an app persisted nothing: `persist({ key })` built a plugin whose
 * `save()` called `undefined` after every successful dispatch, caught the
 * TypeError and warned "failed to save key", and the record never moved. The
 * owner's decision (2026-10-01): a configuration mistake throws at setup
 * (docs/plan-failures-and-contract.md, rule 10), so `persist()` now throws a
 * TypeError when `getState` is not a function. The error is unconditional;
 * the explanation is dev-only, as elsewhere, and production keeps the two
 * words that name the option. An optional `getState` (item 19) would remove
 * this throw.
 */
