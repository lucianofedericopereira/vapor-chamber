/**
 * The async bus's handler type: a value or a promise of it.
 * Why: a value is the faster answer and the runtime takes one; a promise-only type steers apps onto the slower `async` handler.
 * Shows: values and promises type-check, the command map rejects a wrong result either way, and a value answers at runtime.
 * See: log 36.F47.
 */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, type AsyncCommandBus, type AsyncHandler } from '../src/command-bus';

type M = { save: { target: number; result: string }; load: { target: string; result: number } };
declare const typed: AsyncCommandBus<M>;
declare const plain: AsyncCommandBus;

// Never called. tsconfig.tests.json type-checks it; at runtime it is only defined.
function handlerTypes(): void {
  // A value, as a store's reducer answers.
  typed.register('save', (cmd) => `saved ${cmd.target}`);
  plain.register('anything', (cmd) => cmd.target);
  const h: AsyncHandler<number, unknown, string> = (cmd) => String(cmd.target);
  void h;
  // A promise.
  typed.register('save', async (cmd) => `saved ${cmd.target}`);
  typed.register('load', (cmd) => Promise.resolve(cmd.target.length));
  // The map decides the result: a wrong one fails either way.
  // @ts-expect-error a number is not the declared string result
  typed.register('save', () => 1);
  // @ts-expect-error nor a promise of one
  typed.register('save', async () => 1);
  // `null` declares a sent action's options.
  typed.register('save', null, {});
}

describe('the async bus handler type', () => {
  it('a handler that returns a value answers at runtime, as its type now says', async () => {
    const bus = createAsyncCommandBus<M>({ retry: false });
    bus.register('save', (cmd) => `saved ${cmd.target}`);
    expect(await bus.dispatch('save', 1)).toEqual({ ok: true, value: 'saved 1', error: undefined });
    expect(typeof handlerTypes).toBe('function');
  });
});
