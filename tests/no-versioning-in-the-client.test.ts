// @vitest-environment happy-dom
/** A stale tab is HTTP invalidation, not the library's: no manifest read at runtime, no build on a record. The long note is at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as root from '../src/index';
import { createAsyncCommandBus } from '../src/index';
import { createOutbox } from '../src/outbox';
import { queueStorage } from './outbox-storage';
import { defineTransport } from '../src/transports';
import pkg from '../package.json';

const OWN = 'ni:///sha-256-128;own';
const NEW = 'ni:///sha-256-128;new';

/** A deployed manifest that says this build's `cartAdd` broke: what the removed check acted on. */
function deployBroken() {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ $id: NEW, history: [{ $id: OWN, broken: ['cartAdd'] }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

// The build defines present, as in a build with vaporChamberManifest(): the case the removed code acted on.
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

/*
 * Step 2 of .probes/plan-1.32.md (revision 13 of plan-transport-owned.md):
 * a tab left open across a deploy is a cached copy of the app, and its
 * invalidation is HTTP's (the document revalidated at its next load, hashed
 * assets, the router's hard navigation on a chunk that is gone). "You are old"
 * is the server's answer, a redirect or a refusal, which the wire already
 * carries; an outbox record is a request like any other, and the server's
 * answer is its verdict. So the client reads no deployed manifest and stores
 * no build: stale.ts and the outbox's build check go. So does the manifest
 * plugin (vapor-chamber/vite-manifest) whole: its breaking check judged what
 * "an old tab sends the old input to the new server" (its own header), the
 * same edge case, and its emitted file, defines, history and
 * `toolOutputSchema` had no reader but the removed code (owner: "what
 * external?", "again keep what can be discarded?"). Each test runs with the
 * build defines present and a deployed manifest that says `cartAdd` broke,
 * the case the removed code acted on, so each is red before the removal.
 */
