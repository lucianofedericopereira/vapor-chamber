// A store's actions and $reset are typed by the bus they run on; rationale at the end.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createAsyncCommandBus,
  createCommandBus,
  type AsyncCommandBus,
  type BaseBus,
  type CommandBus,
  type CommandResult,
} from '../src/command-bus';
import { defineChamberStore as defineVueStore } from '../src/store';
import { defineChamberStore } from '../src/store/core';

declare const syncBus: CommandBus;
declare const asyncBus: AsyncCommandBus;
declare const baseBus: BaseBus;

type R = CommandResult;
type P = Promise<CommandResult>;

const reducers = { add: (s: { items: number[] }, id: number) => ({ items: [...s.items, id] }) };
const useCart = defineChamberStore('cart', { state: () => ({ items: [] as number[] }), reducers });
const useVueCart = defineVueStore('vueCart', { state: () => ({ items: [] as number[] }), reducers });

// Never called. tsconfig.tests.json type-checks it; at runtime it is only defined.
function resultTypes(): void {
  // A sync bus: the result.
  expectTypeOf(useCart(syncBus).add(1)).toEqualTypeOf<R>();
  expectTypeOf(useCart(syncBus).$reset()).toEqualTypeOf<R>();
  expectTypeOf(useVueCart(syncBus).add(1)).toEqualTypeOf<R>();
  if (useCart(syncBus).add(1).ok) { /* the plain sync call reads the result */ }

  // An async bus: a promise of it.
  expectTypeOf(useCart(asyncBus).add(1)).toEqualTypeOf<P>();
  expectTypeOf(useCart(asyncBus).$reset()).toEqualTypeOf<P>();
  expectTypeOf(useVueCart(asyncBus).add(1)).toEqualTypeOf<P>();

  // A bus typed only as BaseBus: either.
  expectTypeOf(useCart(baseBus).add(1)).toEqualTypeOf<R | P>();
  expectTypeOf(useCart(baseBus).$reset()).toEqualTypeOf<R | P>();
}

describe('store result types', () => {
  it('are checked by the type checker, not at runtime', () => {
    expect(typeof resultTypes).toBe('function');
  });

  it('match the call: a sync bus answers the result, an async bus a promise', async () => {
    const sync = useCart(createCommandBus());
    const r = sync.add(1);
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.ok).toBe(true);
    expect(sync.$reset()).not.toBeInstanceOf(Promise);
    sync.$dispose();
    const async = useCart(createAsyncCommandBus());
    const p = async.add(1);
    expect(p).toBeInstanceOf(Promise);
    expect((await p).ok).toBe(true);
    expect(async.$reset()).toBeInstanceOf(Promise);
    async.$dispose();
  });
});

/*
 * Why this file exists. A store's actions and `$reset` dispatch on the bus the
 * store was given, so they return what that bus's dispatch returns. They were
 * typed `CommandResult | Promise<CommandResult>` on every bus, so on a sync bus
 * `cart.add(x).ok` failed the type check while the call never returned a
 * promise (log 36.F37 finding 3, B3 (a), log 36.F41). The type now follows the
 * bus by `ResultOn`, the rule the composables use
 * (tests/composables-result-types.test.ts): the result on a sync bus, a promise
 * on an async one, either on a bus typed only as BaseBus.
 *
 * The type checks sit in a function that is never called: the claim is about
 * types, which only `npm run typecheck` (tsconfig.tests.json) can check. The
 * runtime case shows the types describe what the call does.
 */
