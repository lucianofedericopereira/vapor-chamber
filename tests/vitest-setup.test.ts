/**
 * src/vitest.ts's own branches, driven through a stand-in for the three Vitest
 * APIs it calls at load: `inject`, `expect.extend`, `beforeEach`.
 *
 * The real thing is covered elsewhere: this repository's suite runs with the
 * entry as its setup file, and tests/vitest-consumer.test.ts runs it from a
 * packed install. What neither reaches from inside one configuration is the
 * other configuration - no plugin (nothing provided) versus an exclude list -
 * and what the hook does for a file on that list.
 *
 * Its own file, and the fresh registry is the last thing it creates, because a
 * reset registry gives every later shared bus a new module instance.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

type Hook = (ctx: { task: { file: { filepath: string } } }) => Promise<void>;

async function loadSetup(provided: unknown) {
  const hooks: Hook[] = [];
  const afterHooks: unknown[] = [];
  const extend = vi.fn();
  const fixtures: string[] = [];
  const test: { extend(name: string): unknown } = {
    extend(name) {
      fixtures.push(name);
      return test;
    },
  };
  vi.resetModules();
  vi.doMock('vitest', () => ({
    afterEach: (fn: unknown) => afterHooks.push(fn),
    beforeEach: (fn: Hook) => hooks.push(fn),
    chai: {},
    expect: { extend },
    inject: () => provided,
    test,
  }));
  const entry = await import('../src/vitest');
  vi.doUnmock('vitest');
  const vc = await import('../src/index');
  return { hook: hooks[0], hooks, afterHooks, extend, fixtures, entry, test, vc };
}

afterAll(() => {
  vi.resetModules();
});

describe('src/vitest.ts at load and in beforeEach', () => {
  it('registers the matchers, exactly one beforeEach and exactly one afterEach', async () => {
    const { hooks, afterHooks, extend } = await loadSetup(undefined);
    expect(hooks).toHaveLength(1);
    expect(afterHooks).toHaveLength(1);
    expect(extend).toHaveBeenCalledOnce();
    expect(Object.keys(extend.mock.calls[0][0]).sort()).toEqual(['toBeToolError', 'toBeToolResult', 'toFailWith', 'toHaveBeenDispatched', 'toHaveBeenDispatchedOnce', 'toHaveBeenDispatchedTimes', 'toHaveBeenDispatchedWith', 'toHaveBeenLastDispatchedWith', 'toHaveBeenNthDispatchedWith', 'toHaveFailedWith', 'toSucceedWith']);
  });

  it('extends Vitest\'s test with bus and asyncBus, and exports that one API as it and test', async () => {
    const { fixtures, entry, test } = await loadSetup(undefined);
    expect(fixtures).toEqual(['bus', 'asyncBus']);
    expect(entry.test).toBe(test);
    expect(entry.it).toBe(test);
  });

  it('without the plugin nothing is provided and every file gets a fresh tapped bus', async () => {
    const { hook, vc } = await loadSetup(undefined);
    await hook({ task: { file: { filepath: '/app/tests/any.test.ts' } } });
    const first = vc.getCommandBus();
    expect(vc.inspectBus(first).afterHookCount).toBe(1);
    await hook({ task: { file: { filepath: '/app/tests/any.test.ts' } } });
    expect(vc.getCommandBus()).not.toBe(first);
  });

  it('a file the provided exclude list matches is left alone', async () => {
    const { hook, vc } = await loadSetup({ exclude: ['/tests/detection\\.test\\.ts$'] });
    await hook({ task: { file: { filepath: '/app/tests/detection.test.ts' } } });
    // Nothing installed: the lazily created default bus, untapped.
    expect(vc.inspectBus(vc.getCommandBus()).afterHookCount).toBe(0);
    // Control: a file the list does not match is tapped.
    await hook({ task: { file: { filepath: '/app/tests/other.test.ts' } } });
    expect(vc.inspectBus(vc.getCommandBus()).afterHookCount).toBe(1);
  });
});
