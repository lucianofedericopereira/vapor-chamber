// The bus / asyncBus fixtures on the entry's it / test. More at the end of the file.
import { TestRunner, describe, expect as vitestExpect, it as vitestIt, test as vitestTest } from 'vitest';
import { getCommandBus } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';
import { expect, it, test } from '../src/vitest';

type Shop = { cartAdd: { target: null; payload: { qty: number }; result: number } };

describe('the test API', () => {
  it('it and test are one extended API, and expect is Vitest\'s own', () => {
    expect(it).toBe(test);
    expect(expect).toBe(vitestExpect);
  });

  it('Vitest\'s own it and test are not mutated (R16)', () => {
    expect(it).not.toBe(vitestIt);
    expect(test).not.toBe(vitestTest);
  });

  vitestIt('control: a test from Vitest\'s own it gets no bus fixture', (context) => {
    vitestExpect((context as Record<string, unknown>).bus).toBeUndefined();
  });

  it('importing the entry in a test file registers no second hook: the setup file\'s instance is reused', ({ task }) => {
    // Measured control: importing '../src/vitest?second' instead makes 2 and 2.
    const hooks = TestRunner.getSuiteHooks(task.file);
    expect(hooks.beforeEach).toHaveLength(1);
    expect(hooks.afterEach).toHaveLength(1);
  });
});

describe('bus', () => {
  it('is a real createCommandBus() bus, tapped', ({ bus }) => {
    expect(Object.getOwnPropertySymbols(bus).map((s) => s.description)).toContain('vapor-chamber:inspect');
    expect(inspectBus(bus).afterHookCount).toBe(1);
    bus.register('cartAdd', () => 2);
    // The sync bus: a result, not a Promise.
    expect(bus.dispatch('cartAdd', null, { qty: 1 })).toSucceedWith(2);
    expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
  });

  it('comes from the same module instance as this file\'s own import of the library', ({ bus }) => {
    const mine = Object.getOwnPropertySymbols(createCommandBus());
    expect(mine.length).toBeGreaterThan(0);
    for (const symbol of Object.getOwnPropertySymbols(bus)) expect(mine).toContain(symbol);
  });

  it('is not the shared bus: getCommandBus() stays its own tapped bus', ({ bus }) => {
    expect(bus).not.toBe(getCommandBus());
    getCommandBus().dispatch('shared', null);
    expect(getCommandBus()).toHaveBeenDispatched('shared');
    expect(bus).not.toHaveBeenDispatched('shared');
  });

  describe('is fresh in every test', () => {
    let first: object | undefined;

    it('first test registers a handler', ({ bus }) => {
      bus.register('a', () => 1);
      first = bus;
    });

    it('second test gets a different bus, with nothing registered or recorded', ({ bus }) => {
      expect(first).toBeDefined();
      expect(bus).not.toBe(first);
      expect(bus.hasHandler('a')).toBe(false);
      expect(bus).not.toHaveBeenDispatched('a');
    });
  });
});

describe('asyncBus', () => {
  it('is a real createAsyncCommandBus() bus, tapped', async ({ asyncBus }) => {
    expect(inspectBus(asyncBus).afterHookCount).toBe(1);
    asyncBus.register('cartAdd', async () => 3);
    const pending = asyncBus.dispatch('cartAdd', null, { qty: 2 });
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toSucceedWith(3);
    expect(asyncBus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
  });

  it('comes from the same module instance as this file\'s own import', ({ asyncBus }) => {
    const mine = Object.getOwnPropertySymbols(createAsyncCommandBus());
    expect(mine.length).toBeGreaterThan(0);
    for (const symbol of Object.getOwnPropertySymbols(asyncBus)) expect(mine).toContain(symbol);
  });

  it('can be renamed where it is destructured: ({ asyncBus: bus })', async ({ asyncBus: bus }) => {
    bus.register('a', async () => 1);
    expect(await bus.dispatch('a', null)).toSucceedWith(1);
    expect(bus).toHaveBeenDispatchedOnce('a');
  });

  it('bus and asyncBus in one test are two buses', ({ bus, asyncBus }) => {
    expect(bus).not.toBe(asyncBus);
  });
});

describe('a reusable snippet built with Vitest\'s own .extend', () => {
  const shopTest = it.extend('shop', ({ bus }) => {
    bus.register('cartAdd', (cmd) => (cmd.payload as Shop['cartAdd']['payload']).qty + 1);
    return bus;
  });

  shopTest('depends on bus, and the test sees the same bus under both names', ({ shop, bus }) => {
    expect(shop).toBe(bus);
    expect(shop.dispatch('cartAdd', null, { qty: 1 })).toSucceedWith(2);
    expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
  });

  it('control: the base it is not changed by extending it', ({ bus }) => {
    expect(bus.hasHandler('cartAdd')).toBe(false);
  });
});

/**
 * The fixtures `vapor-chamber/vitest` adds to Vitest's own `it` / `test`
 * (plan 11.8 step 1): `bus`, a tapped `createCommandBus()`, and `asyncBus`, a
 * tapped `createAsyncCommandBus()`, built with Vitest 5's `test.extend`.
 *
 * This file imports `it`, `test` and `expect` from the entry the way a
 * consumer's test file does, while vitest.config.ts also loads the entry as a
 * setup file: the two must be one module instance. The packed-consumer half
 * (five configurations, and a second installed copy as the control) is
 * tests/vitest-consumer.test.ts.
 */
