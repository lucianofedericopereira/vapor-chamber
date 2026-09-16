// A4: the documented `types: ["vapor-chamber/vitest"]` line types the matchers
// from the received bus's CommandMap. Compiled by tests/vitest-consumer.test.ts
// on an installed package, strict, without skipLibCheck. Each expected-error
// directive below must meet an error: an unused one fails the compile.
import { expect } from 'vitest';
import { createAsyncCommandBus, createCommandBus, getCommandBus } from 'vapor-chamber';
import { tap } from 'vapor-chamber/vitest/pure';

type Shop = {
  cartAdd: { target: { id: number }; payload: { qty: number }; result: number };
  cartClear: { target: null; result: void };
};

const bus = tap(createCommandBus<Shop>());
expect(bus).toHaveBeenDispatched('cartAdd');
expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
expect(bus).not.toHaveBeenDispatched('cartClear');
expect(bus).toHaveFailedWith('cartAdd', 'VC_CORE_NO_HANDLER');
// A handler's own domain code is a legitimate code.
expect(bus).toHaveFailedWith('cartAdd', 'OUT_OF_STOCK');
// @ts-expect-error a typo in the action
expect(bus).toHaveBeenDispatched('cartAd');
// @ts-expect-error a wrong payload shape
expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 'two' });
// @ts-expect-error an action the map does not have
expect(bus).toHaveFailedWith('orderCreate', 'VC_CORE_NO_HANDLER');

const result = bus.dispatch('cartAdd', { id: 1 }, { qty: 2 });
expect(result).toSucceedWith();
expect(result).toSucceedWith(3);
expect(result).toFailWith('VC_CORE_NO_HANDLER');
// @ts-expect-error the value is the action's result type
expect(result).toSucceedWith('three');

const asyncBus = tap(createAsyncCommandBus<Shop>());
expect(asyncBus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
// @ts-expect-error the async bus is typed the same way
expect(asyncBus).toHaveBeenDispatched('cartAd');

// Untyped buses accept any action and payload.
expect(tap(createCommandBus())).toHaveBeenDispatchedWith('anything at all', { any: 'thing' });
expect(getCommandBus()).toHaveBeenDispatched('anything');

// stubEnv takes what vi.stubEnv takes: booleans for DEV, PROD and SSR.
import { stubEnv } from 'vapor-chamber/vitest/pure';
stubEnv('PROD', true);
stubEnv('NODE_ENV', undefined);
// @ts-expect-error DEV is a boolean, not a string
stubEnv('DEV', 'yes');
// @ts-expect-error NODE_ENV is a string, not a boolean
stubEnv('NODE_ENV', true);

// The MCP tool-result matchers.
import { mcpClient } from 'vapor-chamber/vitest/pure';
const mcp = mcpClient(async () => null);
export async function tools() {
  const result = await mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } });
  expect(result).toBeToolResult({ count: 2 });
  expect(result).toBeToolError(/not permitted/);
  expect(result).toBeToolError('locked');
  // @ts-expect-error the expectation is a string or a RegExp
  expect(result).toBeToolError(42);
  const names: string[] = await mcp.toolNames();
  return names;
}

// The spy-family matchers: counts and positions, typed the same way.
expect(bus).toHaveBeenDispatchedTimes('cartAdd', 2);
expect(bus).toHaveBeenDispatchedOnce('cartClear');
expect(bus).toHaveBeenNthDispatchedWith(1, 'cartAdd', { qty: 1 });
expect(bus).toHaveBeenLastDispatchedWith('cartAdd', { qty: 2 });
// @ts-expect-error a typo in the action
expect(bus).toHaveBeenDispatchedTimes('cartAd', 2);
// @ts-expect-error the payload is the action's payload type
expect(bus).toHaveBeenLastDispatchedWith('cartAdd', { qty: 'two' });
// @ts-expect-error toHaveBeenDispatchedWith requires the payload
expect(bus).toHaveBeenDispatchedWith('cartAdd');

// vc holds the same functions as the named exports.
import { vc } from 'vapor-chamber/vitest';
export const tapped = vc.tap(createCommandBus<Shop>());
expect(tapped).toHaveBeenDispatchedOnce('cartAdd');

// The fixtures: `bus` is a CommandBus and `asyncBus` an AsyncCommandBus.
import type { AsyncCommandBus, CommandBus } from 'vapor-chamber';
import { it, test } from 'vapor-chamber/vitest';
export function fixtures() {
  it('bus and asyncBus are typed', async ({ bus, asyncBus }) => {
    const sync: CommandBus = bus;
    const other: AsyncCommandBus = asyncBus;
    expect(sync.dispatch('a', null)).toSucceedWith();
    expect(await other.dispatch('a', null)).toFailWith('VC_CORE_NO_HANDLER');
    // @ts-expect-error asyncBus is not the sync bus
    const wrong: CommandBus = asyncBus;
    void wrong;
  });
  // A snippet built with Vitest's own .extend is typed from what it returns.
  const shopTest = test.extend('shop', ({ bus }) => {
    bus.register('cartAdd', () => 1);
    return bus;
  });
  shopTest('a snippet on bus', ({ shop }) => {
    const typed: CommandBus = shop;
    expect(typed).toHaveBeenDispatched('cartAdd');
  });
  // @ts-expect-error no fixture of that name
  it('a fixture that does not exist', ({ busy }) => {
    void busy;
  });
}
