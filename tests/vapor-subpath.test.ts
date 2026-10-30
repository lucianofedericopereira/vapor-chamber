// @vitest-environment happy-dom
/**
 * `vapor-chamber/vapor` surface and graceful degradation, under the default vitest project where a bare `vue` has no Vapor.
 * Why: a consumer on Vue 3.5, or on a Vue build without the Vapor runtime, imports `/vapor` and nothing bad must happen: it imports without throwing, the Vapor wrappers return null, and the module still re-exports the whole `/vue` surface and the same function identities as the root.
 * Shows: bare `vue` has no `createVaporApp`, `isVaporAvailable()` is false, `defineVaporComponent({})` and `getVaporInteropPlugin()` return null; every name `/vue` exports is also exported from `/vapor` plus seven Vapor functions; `/vapor` re-exports the root's `defineVaporCommand` and `useCommand` and `chamber-vapor`'s `createVaporChamberApp` by identity.
 * See: tests/vapor/vapor-subpath-wiring.test.ts, vitest.vapor.config.ts
 */

import { describe, expect, it } from 'vitest';

describe('vapor-chamber/vapor on a Vue build without Vapor', () => {
  it('imports cleanly and wires nothing rather than throwing', async () => {
    const vue = (await import('vue')) as Record<string, unknown>;
    // Premise: if bare `vue` carries Vapor here, this test no longer measures degradation.
    expect(vue.createVaporApp).toBeUndefined();

    const mod = await import('../src/vapor');

    const { isVaporAvailable } = await import('../src/chamber');
    expect(isVaporAvailable()).toBe(false);

    expect(mod.defineVaporComponent({})).toBeNull();
    expect(mod.getVaporInteropPlugin()).toBeNull();
  });

  it('is a superset of vapor-chamber/vue', async () => {
    const vapor = await import('../src/vapor');
    const vue = await import('../src/vue');

    // A Vapor app uses one import specifier: every `/vue` name must be reachable from `/vapor`.
    const missing = Object.keys(vue).filter((k) => !(k in vapor));
    expect(missing).toEqual([]);

    for (const name of [
      'createVaporChamberApp',
      'getVaporInteropPlugin',
      'defineVaporCommand',
      'defineVaporCustomElement',
      'defineVaporComponent',
      'defineVaporAsyncComponent',
      'useVaporAsyncCommand',
    ]) {
      expect(typeof (vapor as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('re-exports the same function identities as the root, not copies', async () => {
    // Identity: copies would mean two registries, and a command registered through one is invisible to the other.
    const vapor = await import('../src/vapor');
    const root = await import('../src/index');
    const chamberVapor = await import('../src/chamber-vapor');
    expect(vapor.createVaporChamberApp).toBe(chamberVapor.createVaporChamberApp);
    expect(vapor.defineVaporCommand).toBe(root.defineVaporCommand);
    expect(vapor.useCommand).toBe(root.useCommand);
  });
});
