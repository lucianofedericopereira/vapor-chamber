// @vitest-environment happy-dom
/**
 * FIXTURE: what `createVaporChamberApp(App).mount(host)` returns, with and without `expose()` in the root's setup.
 * Why: the app is Vue's own, passed through, so its `mount()` return is Vue's: since Vue 3.6.0-rc.15 a root that exposes nothing returns an empty object, where rc.14 returned `undefined`, and a caller that tests the return for truth reads the opposite answer.
 * Shows: a root whose setup exposes nothing returns an object with no keys; a root that exposes `{ n: 1 }` returns it, `n` reading 1, on either version.
 * See: vuejs/core#16227, src/chamber-vapor.ts (createVaporChamberApp), tests/vapor/vapor-subpath-wiring.test.ts
 */

import { describe, expect, it } from 'vitest';
import { createVaporChamberApp, defineVaporComponent } from '../../src/vapor';

function mountRoot(setup: (props: unknown, ctx: { expose: (api: object) => void }) => unknown) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createVaporChamberApp(defineVaporComponent({ setup }) as object);
  const returned = app.mount(host) as unknown;
  return {
    returned,
    done: () => {
      app.unmount();
      host.remove();
    },
  };
}

describe('the value a Vapor app mount returns', () => {
  it('a root that exposes nothing: an object with no keys', () => {
    const { returned, done } = mountRoot(() => []);
    expect(typeof returned).toBe('object');
    expect(returned).not.toBeNull();
    expect(Object.keys(returned as object)).toEqual([]);
    done();
  });

  it('control: a root that exposes `n` returns it', () => {
    const { returned, done } = mountRoot((_props, { expose }) => {
      expose({ n: 1 });
      return [];
    });
    expect((returned as { n?: number }).n).toBe(1);
    done();
  });
});
