// @vitest-environment happy-dom
/**
 * The client does no versioning: no manifest read at runtime, no build stored on an outbox record.
 * Why: a tab left open across a deploy is invalidated by HTTP (the server's refusal or redirect); a client that also reads a deployed manifest would second-guess the server and could drop or redirect a replay the server would accept.
 * Shows: with the build defines present and a deployed manifest that says `cartAdd` broke, the root exports no stale-tab API, an outbox record has no `build` and its flush replays without a fetch, the router fetches nothing and does not call `location.assign` on start, visibility change or push, and the package exports no `./vite-manifest`.
 * See: log s36.44.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as root from '../src/index';
import { createAsyncCommandBus } from '../src/index';
import { createOutbox } from '../src/outbox';
import { queueStorage } from './outbox-storage';
import { defineTransport } from '../src/transports';
import pkg from '../package.json';

const OWN = 'ni:///sha-256-128;own';
const NEW = 'ni:///sha-256-128;new';

/** A deployed manifest that says this build's `cartAdd` broke. */
function deployBroken() {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ $id: NEW, history: [{ $id: OWN, broken: ['cartAdd'] }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

// The build defines are present, so a manifest read would be reachable.
beforeEach(() => {
  vi.stubGlobal('__VC_MANIFEST__', OWN);
  vi.stubGlobal('__VC_MANIFEST_URL__', '/build/vc-manifest.json');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('no versioning in the client', () => {
  it('the root exports no stale-tab API', () => {
    for (const name of ['checkForUpdate', 'isStale', 'onStale', 'UPDATE_CHECK_INTERVAL_MS']) expect(name in root).toBe(false);
  });

  it('the outbox stores no build, and a flush reads no manifest: the server answers the replay', async () => {
    const fetchSpy = deployBroken();
    // Its own name: an outbox in a page opens tabs, and Node shares them across vitest's workers.
    const name = 'vc:outbox:no-versioning';
    const storage = queueStorage(null, { key: name });
    const ran: string[] = [];
    let online = false;
    const outbox = createOutbox({ name, storage, autoFlush: false, isOnline: () => online });
    const transport = defineTransport(async (cmd) => { ran.push(cmd.action); return { ok: true, value: 'added', error: undefined }; });
    const bus = createAsyncCommandBus({ transport, outbox });
    await bus.dispatch('cartAdd', { id: 1 });
    expect('build' in storage.rows()[0]).toBe(false);
    online = true;
    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 0 });
    expect(ran).toEqual(['cartAdd']);
    expect(fetchSpy).not.toHaveBeenCalled();
    outbox.dispose();
  });

  it('the router reads no manifest, on start or in view, and navigates in place', async () => {
    const fetchSpy = deployBroken();
    const { createRouter } = await import('@router/index');
    const { createWebHistory } = await import('@router/history');
    window.history.replaceState({ __vr: 0 }, '', '/');
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    const rows = [{ name: 'home', path: '/', component: 'Home' }, { name: 'list', path: '/list', component: 'List' }];
    const router = createRouter({ history: createWebHistory(''), routes: rows, components: { Home: { name: 'Home' }, List: { name: 'List' } } });
    await router.isReady();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await router.push('/list');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(router.currentRoute.value.location.name).toBe('list');
    router.dispose();
  });

  it('the package ships no manifest plugin', () => {
    expect('./vite-manifest' in pkg.exports).toBe(false);
  });
});
