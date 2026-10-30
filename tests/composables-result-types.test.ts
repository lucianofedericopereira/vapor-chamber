/**
 * A composable's dispatch result type follows the bus it runs on.
 * Why: on an async bus a dispatch returns a promise; typed as a plain result, `result.ok` type-checks with no await and reads undefined.
 * Shows: the result on a sync bus or no bus, a promise on an async one, either on a BaseBus; at runtime an async bus's failures are still promises.
 * See: log s35.221, tests/composables-bus-option.test.ts.
 */
import { describe, expect, expectTypeOf } from 'vitest';
import { effect, isRef } from 'vue';
import {
  createAsyncCommandBus,
  defineVaporCommand,
  waitForVueDetection,
  useCommand,
  useCommandGroup,
  useCommandQuery,
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

// Never called: the claim is about types, which only `npm run typecheck` (tsconfig.tests.json) checks.
function resultTypes(): void {
  // No bus: the shared bus, whose static type is CommandBus.
  expectTypeOf(useCommand().dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandQuery().query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g').dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g').query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(defineVaporCommand('a', () => 1).dispatch(null)).toEqualTypeOf<R>();

  // A sync bus: the result.
  expectTypeOf(useCommand({ bus: syncBus }).dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandQuery({ bus: syncBus }).query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g', { bus: syncBus }).dispatch('a', null)).toEqualTypeOf<R>();
  expectTypeOf(useCommandGroup('g', { bus: syncBus }).query('a', null)).toEqualTypeOf<R>();
  expectTypeOf(defineVaporCommand('a', () => 1, { bus: syncBus }).dispatch(null)).toEqualTypeOf<R>();

  // An async bus: a promise of it.
  expectTypeOf(useCommand({ bus: asyncBus }).dispatch('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useCommandQuery({ bus: asyncBus }).query('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useCommandGroup('g', { bus: asyncBus }).dispatch('a', null)).toEqualTypeOf<P>();
  expectTypeOf(useCommandGroup('g', { bus: asyncBus }).query('a', null)).toEqualTypeOf<P>();
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

  it('on an async bus, a query failed by a throwing subscriber is still a promise', async () => {
    await waitForVueDetection();
    const bus = createAsyncCommandBus();
    bus.register('read', async () => 'read');
    const { query, loading } = useCommandQuery({ bus });
    // Control: the signal is Vue's, so the effect is a real subscriber.
    expect(isRef(loading)).toBe(true);
    const boom = new Error('subscriber threw');
    const runner = effect(() => { if (loading.value) throw boom; });
    const result = query('read', {});
    runner.effect.stop();
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual({ ok: false, error: boom });
  });

  it('on an async bus, a dispatch that throws (onMissing: throw) is still a promise', async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    const result = useCommand({ bus }).dispatch('missing', {});
    expect(result).toBeInstanceOf(Promise);
    expect(await result).toMatchObject({ ok: false });
  });
});
