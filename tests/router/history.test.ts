// @vitest-environment happy-dom
/**
 * Tests for router/history.ts — createWebHistory (browser path, exercised under
 * happy-dom) and the createMemoryHistory state()/destroy() branches.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createWebHistory } from '../../src/router/history';

describe('createWebHistory (happy-dom)', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/admin/');
  });

  it('reads location stripped of base, pushes/replaces, and builds hrefs', () => {
    const h = createWebHistory('/admin');

    h.push('/list?page=2', { a: 1 });
    expect(window.location.pathname).toBe('/admin/list');
    expect(h.location()).toBe('/list?page=2');
    expect(h.createHref('/x')).toBe('/admin/x');
    expect(h.state()).toMatchObject({ a: 1 });

    h.replace('/other');
    expect(h.location()).toBe('/other');

    h.destroy();
  });

  it('notifies listeners on popstate with a computed delta', () => {
    const h = createWebHistory('/admin');
    const cb = vi.fn();
    const off = h.listen(cb);

    h.push('/a'); // position 1
    h.push('/b'); // position 2
    window.dispatchEvent(new PopStateEvent('popstate', { state: { __vr: 1 } }));

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][1].delta).toBe(-1);

    off();
    // after unlisten, further popstates are ignored
    window.dispatchEvent(new PopStateEvent('popstate', { state: { __vr: 0 } }));
    expect(cb).toHaveBeenCalledTimes(1);

    h.destroy();
  });

  it('go delegates to window.history.go', () => {
    const h = createWebHistory('/admin');
    const spy = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    h.go(-2);
    expect(spy).toHaveBeenCalledWith(-2);
    spy.mockRestore();
    h.destroy();
  });
});

describe('createMemoryHistory — state() and destroy()', () => {
  it('exposes committed state and clears listeners on destroy', () => {
    const h = createMemoryHistory('/admin', '/start');
    expect(h.location()).toBe('/start');

    h.push('/next', { k: 1 });
    expect(h.location()).toBe('/next');
    expect(h.state()).toEqual({ k: 1 });

    const cb = vi.fn();
    h.listen(cb);
    h.destroy(); // clears listeners
    h.go(-1); // no listeners left → cb never fires
    expect(cb).not.toHaveBeenCalled();
  });
});
