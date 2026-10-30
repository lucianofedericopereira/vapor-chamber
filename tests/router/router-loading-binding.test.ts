// @vitest-environment happy-dom
/**
 * The router's loading and revalidating flags reach plain HTML as bus facts, and `data-vc-router` follows them without importing the router.
 * Why: a plain-HTML shell around the router's island would show no navigation loading or background refresh, or would keep reacting after unbind, if the flags did not reach the bus.
 * Shows: routerFacts emits routerLoading true then false around a loader; `data-vc-router="loading"` and `"revalidating"` toggle `vc-loading` with the flag; an unknown flag is unbound, warned in development and silent in production; after unbind and stop nothing is heard.
 * See: examples/router-demo/index.html
 */
import { describe, expect, it, vi } from 'vitest';
import { createCommandBus } from '../../src/command-bus';
import { bindDisplay } from '../../src/page-bindings';
import { routerFacts } from '@router/index';
import type { LoaderHandlers } from '@router/loaders';
import type { RouteRecord } from '@router/types';
import { makeRouter } from './fixture';

const ROWS: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'Home' },
  { name: 'slow', path: '/slow', parent: 'shell', component: 'Slow', load: 'rows:slow' },
];

/** A router whose `/slow` loader waits for `release()`. */
function setup() {
  let release!: () => void;
  const handlers: LoaderHandlers = {
    prefixes: { 'rows:': () => new Promise((resolve) => { release = () => resolve({ rows: [] }); }) },
  };
  const router = makeRouter({ routes: ROWS, loaders: handlers, links: false, components: { Home: { name: 'Home' }, Slow: { name: 'Slow' } } });
  const bus = createCommandBus();
  const heard: Array<[string, boolean]> = [];
  bus.on('router*', (cmd) => { if (cmd.action !== 'routerNavigated') heard.push([cmd.action, (cmd.target as { value: boolean }).value]); });
  const stop = routerFacts(router, bus);
  return { router, bus, heard, stop, release: () => release() };
}

describe("the router's loading as facts and a display binding", () => {
  it('routerFacts emits routerLoading true while a loader runs, then false', async () => {
    const { router, heard, release, stop } = setup();
    await router.isReady();
    const going = router.push('/slow');
    await Promise.resolve();
    expect(heard).toEqual([['routerLoading', true]]);
    release();
    await going;
    expect(heard).toEqual([['routerLoading', true], ['routerLoading', false]]);
    stop();
  });

  it('data-vc-router="loading" carries vc-loading exactly while the router loads', async () => {
    const { router, bus, release, stop } = setup();
    await router.isReady();
    document.body.innerHTML = '<p id="busy" data-vc-router="loading">Loading...</p>';
    const el = document.getElementById('busy')!;
    const unbind = bindDisplay(document.body, { bus });
    expect(el.classList.contains('vc-loading')).toBe(false);
    const going = router.push('/slow');
    await Promise.resolve();
    expect(el.classList.contains('vc-loading')).toBe(true);
    release();
    await going;
    expect(el.classList.contains('vc-loading')).toBe(false);
    unbind();
    stop();
  });

  it('data-vc-router="revalidating" follows a background refresh of the page', async () => {
    let refreshed!: (data: unknown) => void;
    const handlers: LoaderHandlers = {
      prefixes: {
        'rows:': (_ref, _location, _record, _signal, ctx) => {
          ctx?.revalidate(new Promise((resolve) => { refreshed = resolve; }));
          return { rows: ['stale'] };
        },
      },
    };
    const router = makeRouter({ routes: ROWS, loaders: handlers, links: false, components: { Home: { name: 'Home' }, Slow: { name: 'Slow' } } });
    const bus = createCommandBus();
    const stop = routerFacts(router, bus);
    await router.isReady();
    document.body.innerHTML = '<p id="refresh" data-vc-router="revalidating">Refreshing...</p>';
    const el = document.getElementById('refresh')!;
    const unbind = bindDisplay(document.body, { bus });
    await router.push('/slow');
    expect(el.classList.contains('vc-loading')).toBe(true);
    refreshed({ rows: ['fresh'] });
    await vi.waitFor(() => expect(el.classList.contains('vc-loading')).toBe(false));
    unbind();
    stop();
  });

  it('a flag the router has not is not bound, and development says so', () => {
    const bus = createCommandBus();
    document.body.innerHTML = '<p id="busy" data-vc-router="busy">Loading...</p>';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unbind = bindDisplay(document.body, { bus });
    bus.emit('routerLoading', { value: true });
    expect(document.getElementById('busy')!.classList.contains('vc-loading')).toBe(false);
    expect(String(warn.mock.calls[0]?.[0])).toContain('bind:invalid:router');
    warn.mockRestore();
    unbind();
  });

  it('in production a flag the router has not is not bound, and nothing is said', async () => {
    vi.resetModules();
    vi.stubGlobal('__VC_DEV__', false);
    const prod = await import('../../src/page-bindings');
    const bus = createCommandBus();
    document.body.innerHTML = '<p id="busy" data-vc-router="busy">Loading...</p>';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prod.bindDisplay(document.body, { bus })();
    vi.unstubAllGlobals();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('after unbind and stop nothing more is heard', async () => {
    const { router, bus, heard, release, stop } = setup();
    await router.isReady();
    document.body.innerHTML = '<p id="busy" data-vc-router="loading">Loading...</p>';
    const el = document.getElementById('busy')!;
    bindDisplay(document.body, { bus })();
    stop();
    const going = router.push('/slow');
    await Promise.resolve();
    expect([heard, el.classList.contains('vc-loading')]).toEqual([[], false]);
    release();
    await going;
  });
});
