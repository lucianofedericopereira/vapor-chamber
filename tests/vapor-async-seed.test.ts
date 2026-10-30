/**
 * src/vapor.ts's defineVaporAsyncComponent wrapper and its registry seed, run against the source.
 * Why: the /vapor wrapper must hand the loader to Vue's function, and the root wrapper must still find Vue's function in every build except a /vapor-wired one, or async components would not resolve there. Also the only file reaching the wrapper and both arms of the seed, so the 100% floor needs it.
 * Shows: the wrapper returns Vue's result for the loader; importing src/vapor seeds the registry with Vue's function, and seeds nothing under __VC_WIRED_VAPOR__.
 * See: log s35.109, tests/vapor-async-wire.test.ts, tests/vapor-subpath.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const vueAsync = vi.hoisted(() => (loader: unknown) => ({ asyncOf: loader }));
// The default project's vue carries no Vapor, so Vue's function is stood in for; the two other names /vapor imports are absent too, and a mock must still name them.
vi.mock('vue', async (original) => ({
  ...(await original<object>()),
  createVaporApp: undefined,
  defineVaporComponent: undefined,
  defineVaporAsyncComponent: vueAsync,
}));

afterEach(() => {
  delete (globalThis as { __VC_WIRED_VAPOR__?: boolean }).__VC_WIRED_VAPOR__;
  vi.resetModules();
});

describe("/vapor's defineVaporAsyncComponent", () => {
  it("calls Vue's directly, reading no registry", async () => {
    const { defineVaporAsyncComponent } = await import('../src/vapor');
    const loader = () => Promise.resolve({});
    expect(defineVaporAsyncComponent(loader)).toEqual({ asyncOf: loader });
  });

  it("seeds the registry with Vue's for the root wrapper in every build but a /vapor-wired one", async () => {
    await import('../src/vapor');
    const { getDefineVaporAsyncComponentFn } = await import('../src/chamber');
    expect(getDefineVaporAsyncComponentFn()).toBe(vueAsync);
  });

  it('seeds nothing under __VC_WIRED_VAPOR__, where the root name is the wrapper above', async () => {
    (globalThis as { __VC_WIRED_VAPOR__?: boolean }).__VC_WIRED_VAPOR__ = true;
    await import('../src/vapor');
    const { getDefineVaporAsyncComponentFn } = await import('../src/chamber');
    expect(getDefineVaporAsyncComponentFn()).not.toBe(vueAsync);
  });
});
