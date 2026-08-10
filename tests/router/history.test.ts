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

  it('falls back to a full navigation when pushState throws (Safari throttle)', () => {
    const h = createWebHistory('/admin');
    const pushSpy = vi.spyOn(window.history, 'pushState').mockImplementation(() => {
      throw new DOMException('Safari 100 pushState/30s limit', 'SecurityError');
    });
    const assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});

    h.push('/throttled');

    expect(assignSpy).toHaveBeenCalledWith('/admin/throttled');
    pushSpy.mockRestore();
    assignSpy.mockRestore();
    h.destroy();
  });

  it('falls back to location.replace when replaceState throws', () => {
    const h = createWebHistory('/admin');
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('Safari 100 pushState/30s limit', 'SecurityError');
    });
    const replaceSpy = vi.spyOn(window.location, 'replace').mockImplementation(() => {});

    h.replace('/throttled-too');

    expect(replaceSpy).toHaveBeenCalledWith('/admin/throttled-too');
    replaceStateSpy.mockRestore();
    replaceSpy.mockRestore();
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

// ---------------------------------------------------------------------------
// Previously uncovered branches: outside-base fallback, non-__vr state,
// resolveBase window-pathname default
// ---------------------------------------------------------------------------

describe('createWebHistory — fallback branches', () => {
  it('location() falls back to "/" when the current pathname is outside the base', () => {
    window.history.replaceState(null, '', '/elsewhere/page');
    const history = createWebHistory('/app');
    // '/elsewhere/page' does not start with '/app' → stripBase null → '/'
    expect(history.location()).toBe('/');
    history.destroy();
  });

  it('a popstate whose state carries no __vr computes delta against position 0', () => {
    window.history.replaceState(null, '', '/x');
    const history = createWebHistory('');
    const seen: Array<{ delta: number }> = [];
    history.listen((_p, info) => seen.push({ delta: info.delta }));

    history.push('/a'); // position 1
    // Simulate a popstate to an entry created OUTSIDE the router (no __vr):
    window.dispatchEvent(new PopStateEvent('popstate', { state: { foreign: true } }));

    expect(seen).toHaveLength(1);
    expect(seen[0].delta).toBe(-1); // 0 (no __vr) minus lastPosition 1
    history.destroy();
  });

  it('boot on a history entry that already has __vr does not restamp position 0', () => {
    window.history.replaceState({ __vr: 3 }, '', '/deep');
    const history = createWebHistory('');
    history.push('/next'); // 3 → 4
    expect((window.history.state as { __vr: number }).__vr).toBe(4);
    history.destroy();
  });
});

describe('resolveBase — window-pathname default (happy-dom)', () => {
  it('reads window.location.pathname when no pathname option is given', async () => {
    const { resolveBase } = await import('../../src/router/history');
    window.history.replaceState(null, '', '/en/checkout');
    expect(resolveBase({ locales: ['en', 'it'] })).toBe('/en');
  });
});
