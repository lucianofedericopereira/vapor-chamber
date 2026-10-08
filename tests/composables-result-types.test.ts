// A composable's dispatch result type follows the bus it runs on; rationale at the end.
import { describe, expect, expectTypeOf } from 'vitest';
import { effect, isRef } from 'vue';
import {
  createAsyncCommandBus,
  defineVaporCommand,
  waitForVueDetection,
  useCommand,
  useCommandGroup,
  useCommandQuery,
  useSharedCommandState,
  type AsyncCommandBus,
  type BaseBus,
  type CommandBus,
  type CommandResult,
} from '../src/index';
import { it } from '../src/vitest';

declare const syncBus: CommandBus;
declare const asyncBus: AsyncCommandBus;
declare const baseBus: BaseBus;

type R = CommandResult;
type P = Promise<CommandResult>;

// Never called. tsconfig.tests.json type-checks it; at runtime it is only defined.
function resultTypes(): void {
  // No bus: the shared bus, whose static type is CommandBus.
  expectTypeOf(useCommand().dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandQuery().query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g').dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g').query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useSharedCommandState().dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(defineVaporCommand('a', () => 1).dispatch(null)).toEqualTypeOf<R>();

  // A sync bus: the result.
  expectTypeOf(useCommand({ bus: syncBus }).dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandQuery({ bus: syncBus }).query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g', { bus: syncBus }).dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g', { bus: syncBus }).query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useSharedCommandState({ bus: syncBus }).dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(defineVaporCommand('a', () => 1, { bus: syncBus }).dispatch(null)).toEqualTypeOf<R>();

  // An async bus: a promise of it.
  expectTypeOf(useCommand({ bus: asyncBus }).dispatch('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useCommandQuery({ bus: asyncBus }).query('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useCommandGroup('g', { bus: asyncBus }).dispatch('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useCommandGroup('g', { bus: asyncBus }).query('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useSharedCommandState({ bus: asyncBus }).dispatch('a', null)).toEqualTypeOf<P>();
  expectTypeOf(defineVaporCommand('a', () => 1, { bus: asyncBus }).dispatch(null)).toEqualTypeOf<P>();

  // A bus typed only as BaseBus: either.
  expectTypeOf(useCommand({ bus: baseBus }).dispatch('a', null)).toEqualTypeOf<R | P>();
  expectTypeOf(useCommandGroup('g', { bus: baseBus }).dispatch('a', null)).toEqualTypeOf<R | P>();
  expectTypeOf(defineVaporCommand('a', () => 1, { bus: baseBus }).dispatch(null)).toEqualTypeOf<R | P>();
}

describe('dispatch result types', () => {
  it('are checked by the type checker, not at runtime', () => {
    expect(typeof resultTypes).toBe('function');
  });

  it('on an async bus, a dispatch failed by a throwing subscriber is still a promise', async () => {
    await waitForVueDetection();
    const bus = createAsyncCommandBus();
    bus.register('save', async () => 'saved');
    const { dispatch, loading } = useCommand({ bus });
    // Control: the signal is Vue's, so the effect is a real subscriber.
    expect(isRef(loading)).toBe(true);
    const boom = new Error('subscriber threw');
    const runner = effect(() => { if (loading.value) throw boom; });
    const result = dispatch('save', {});
    runner.effect.stop();
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({ ok: false, error: boom });
  });
});

/*
 * Why this file exists. Every bus composable takes `bus`, sync or async
 * (log s35.221). Before 1.29.0 useCommandGroup's dispatch and query, and
 * defineVaporCommand's dispatch, were typed as returning a CommandResult on
 * any bus. On an async bus they return a promise, so `result.ok` type-checked
 * with no `await` and read undefined. useCommand, useCommandQuery and
 * useSharedCommandState returned the union, which made a sync caller narrow
 * a promise it never gets. Now the type follows the bus passed: the result on
 * a sync bus, a promise on an async one, either on a bus typed only as
 * BaseBus. With no bus it is the shared bus's static type, CommandBus.
 *
 * The checks sit in a function that is never called: the calls would need
 * real buses at runtime, and the claim is about types, which only `npm run
 * typecheck` (tsconfig.tests.json) can check.
 */
