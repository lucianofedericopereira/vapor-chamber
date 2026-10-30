/**
 * The bus's retry on a success builds nothing that exists for failures.
 * Why: an Error built up front for "no attempts made" would capture a stack on every dispatch, success included, for a result that can never be returned (at least one attempt is guaranteed). The happy path builds no failure machinery.
 * Shows: a successful dispatch under the default retry constructs no Error; it settles in the same microtask turns as a bus with retry off (dispatch, an async handler, query); the turn counter does see one extra await; a failure is still reported after its 2 attempts.
 * See: ROADMAP.md (the fuse)
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

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(() => { done = true; });
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

it('a success under the default retry settles in the turns of a bus with retry off', async () => {
  const off = createAsyncCommandBus({ retry: false });
  const on = createAsyncCommandBus();
  for (const b of [off, on]) {
    b.register('save', (cmd) => cmd.target);
    b.register('load', async (cmd) => cmd.target);
  }
  expect(await turns(on.dispatch('save', 1))).toBe(await turns(off.dispatch('save', 1)));
  expect(await turns(on.dispatch('load', 1))).toBe(await turns(off.dispatch('load', 1)));
  expect(await turns(on.query('save', 1))).toBe(await turns(off.query('save', 1)));
});

it('control: the counter sees one more await in the handler', async () => {
  const bus = createAsyncCommandBus();
  bus.register('load', async (cmd) => cmd.target);
  bus.register('slow', async (cmd) => { await null; return cmd.target; });
  const load = await turns(bus.dispatch('load', 1));
  const slow = await turns(bus.dispatch('slow', 1));
  expect(slow).toBeGreaterThan(load);
  expect(slow).toBeLessThan(1_000);
});

it('a failure is still reported, after its attempts', async () => {
  const bus = createAsyncCommandBus({ retry: { maxAttempts: 2, baseDelay: 0 } });
  let calls = 0;
  bus.register('save', async () => { calls += 1; throw Object.assign(new Error('down'), { response: { status: 503 } }); });
  const result = await bus.dispatch('save', { id: 1 });
  expect(result.ok).toBe(false);
  expect(calls).toBe(2);
});
