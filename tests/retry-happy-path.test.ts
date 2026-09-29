/**
 * The bus's retry on a SUCCESS builds nothing that exists for failures.
 *
 * An Error built up front for "no attempts made" would capture a stack on every
 * dispatch, success included, for a result that can never be returned
 * (`countOption(..., 3, 1)` guarantees at least one attempt). Measured: retry
 * alone 48,857 ns per successful dispatch against 5,635 bare, 6,031 without
 * it. The rule: the happy path builds no failure machinery (the fuse,
 * docs/plan-failures-and-contract.md 7.1 item 14).
 */
import { expect } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

/** Count Error constructions made while `run` executes. */
async function errorsBuiltDuring(run: () => Promise<unknown>): Promise<number> {
  const Real = globalThis.Error;
  let built = 0;
  globalThis.Error = new Proxy(Real, {
    construct(target, args, newTarget) {
      built += 1;
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    await run();
  } finally {
    globalThis.Error = Real;
  }
  return built;
}

it('a successful dispatch under the default retry builds no Error', async ({ asyncBus: bus }) => {
  bus.register('save', async () => 'saved');
  const built = await errorsBuiltDuring(() => bus.dispatch('save', { id: 1 }));
  expect(built).toBe(0);
  expect(bus).toHaveBeenDispatchedTimes('save', 1);
});

it('a failure is still reported, after its attempts', async () => {
  const bus = createAsyncCommandBus({ retry: { maxAttempts: 2, baseDelay: 0 } });
  let calls = 0;
  bus.register('save', async () => { calls += 1; throw Object.assign(new Error('down'), { response: { status: 503 } }); });
  const result = await bus.dispatch('save', { id: 1 });
  expect(result.ok).toBe(false);
  expect(calls).toBe(2);
});
