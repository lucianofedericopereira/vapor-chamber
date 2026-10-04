/**
 * src/vapor.ts's async wrapper and its seed, against the source (decision 6).
 * tests/vapor-async-wire.test.ts proves them in real builds of the dist; this
 * file is what keeps src/vapor.ts inside the coverage gate. The default
 * project's `vue` carries no Vapor (tests/vapor-subpath.test.ts), so Vue's
 * `defineVaporAsyncComponent` is stood in for.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const vueAsync = vi.hoisted(() => (loader: unknown) => ({ asyncOf: loader }));
// The two other names /vapor imports are absent from this `vue` too; a mock
// must still name them.
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
