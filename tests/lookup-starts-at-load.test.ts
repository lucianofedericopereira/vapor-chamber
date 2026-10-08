// The runtime lookup starts when chamber.ts loads, so composables need not start it; rationale at the end.
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

/*
 * Why this file exists. tryAutoCleanup and tryKeepAliveHooks used to call
 * probeVue() on every composable created. Those calls always returned at
 * once: chamber.ts calls probeVue() when it loads, and that call sets the
 * flag the later ones return on. They were removed (log s35.234), so this
 * pins the load-time call they relied on. Seeded: with the load-time call
 * removed, the first case fails.
 */
