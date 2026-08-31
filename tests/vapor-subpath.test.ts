// @vitest-environment happy-dom
/**
 * `vapor-chamber/vapor` - surface and graceful degradation.
 *
 * This file runs under the DEFAULT vitest project, where a bare `vue` resolves
 * to a build with **no Vapor in it** (measured here: 178 exports, and
 * `createVaporApp` / `defineVaporComponent` / `vaporInteropPlugin` all
 * `undefined`). That is not a limitation to work around - it is the more
 * interesting half of the contract, because it is the same shape as a consumer
 * on Vue 3.5 or on a Vue build without the Vapor runtime, and what must happen
 * there is *nothing bad*: the five names resolve as `undefined`,
 * `applyVueModule`'s `typeof` guards skip every one, and the module still
 * imports cleanly and still re-exports its whole surface.
 *
 * The other half - that the same import wires a REAL Vapor registry - needs
 * `vue` aliased to the with-vapor dist and therefore lives in
 * `tests/vapor/vapor-subpath-wiring.test.ts`, under the project that does that
 * aliasing (see `vitest.vapor.config.ts` for why the split exists).
 *
 * Keeping a default-project test is also what keeps `src/vapor.ts` inside the
 * coverage gate: `tests/vapor/**` is excluded from the coverage run, so a module
 * exercised only there would read as 0%.
 */

import { describe, expect, it } from 'vitest';

describe('vapor-chamber/vapor on a Vue build without Vapor', () => {
  it('imports cleanly and wires nothing rather than throwing', async () => {
    const vue = (await import('vue')) as Record<string, unknown>;
    // The premise of this file. If bare `vue` ever starts carrying Vapor under
    // the default project, this assertion fails and the test below stops
    // measuring degradation - at which point this file should move or change,
    // not have its premise quietly deleted.
    expect(vue.createVaporApp).toBeUndefined();

    // Must not throw: the five Vapor names come back `undefined` and
    // `configureVue` skips them.
    const mod = await import('../src/vapor');

    const { isVaporAvailable } = await import('../src/chamber');
    expect(isVaporAvailable()).toBe(false);

    // And the wrappers degrade the documented way rather than crashing.
    expect(mod.defineVaporComponent({})).toBeNull();
    expect(mod.getVaporInteropPlugin()).toBeNull();
  });

  it('is a superset of vapor-chamber/vue', async () => {
    const vapor = await import('../src/vapor');
    const vue = await import('../src/vue');

    // Every name the /vue entry exports must be reachable from /vapor too -
    // that is what lets a Vapor app use ONE import specifier. A name added to
    // `src/vue.ts` and not re-exported here silently splits the surface again.
    const missing = Object.keys(vue).filter((k) => !(k in vapor));
    expect(missing).toEqual([]);

    // Plus the Vapor surface itself.
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
    // Two registries would mean a command registered through one is invisible
    // to the other. Identity is the cheapest possible proof that cannot happen.
    const vapor = await import('../src/vapor');
    const root = await import('../src/index');
    expect(vapor.createVaporChamberApp).toBe(root.createVaporChamberApp);
    expect(vapor.useCommand).toBe(root.useCommand);
  });
});
