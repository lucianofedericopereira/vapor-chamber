/**
 * The runtime Vue lookup starts when chamber.ts loads, so composables need not start it.
 * Why: tryAutoCleanup and tryKeepAliveHooks rely on the load-time probeVue() call; if it did not run
 * at load, a composable created before any other wiring would find no Vue and arm no cleanup.
 * Shows: after the module loads, with no composable and no wait, the registry holds the app's Vue `ref`,
 * and a composable created afterwards arms its cleanup in a scope.
 * See: log s35.234
 */
import { afterEach, describe, expect, vi } from 'vitest';
import { it } from '../src/vitest';

afterEach(() => {
  vi.resetModules();
});

describe('the runtime lookup', () => {
  it('has wired Vue once the module has loaded, with no composable and no wait', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    const vue = await import('vue');
    await new Promise((r) => setTimeout(r, 50));
    expect(chamber.getVueDeepRefFn()).toBe(vue.ref);
  });

  it('a composable created after that arms its cleanup in a scope', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    const vue = await import('vue');
    await new Promise((r) => setTimeout(r, 50));
    let ran = false;
    const scope = vue.effectScope();
    scope.run(() => chamber.useCommand().on('x', () => {}));
    scope.run(() => chamber.tryAutoCleanup(() => { ran = true; }));
    scope.stop();
    expect(ran).toBe(true);
  });
});
