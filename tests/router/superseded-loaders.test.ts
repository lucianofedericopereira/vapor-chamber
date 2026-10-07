/** Three navigations back to back: what each loader's signal says, and how each navigation settles. The long note is at the end. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryHistory } from '@router/history';
import { createRouter, type LoaderHandlers } from '@router/index';
import type { RouteRecord } from '@router/types';
import { createAsyncCommandBus } from '../../src/command-bus';
import { createHttpClient } from '../../src/http';
import { supersede } from '../../src/plugins-extra';
import { fetchLoaders } from '../../src/router-fetch/index';

const tick = () => new Promise((r) => setTimeout(r, 0));
const ms = (n: number) => new Promise((r) => setTimeout(r, n));

let server: Server;
let base = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    }, 30);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ROUTES: RouteRecord[] = [
  { name: 'shell', path: '/', parent: null },
  { name: 'home', path: '/', parent: 'shell', component: 'P' },
  { name: 'a', path: '/a', parent: 'shell', component: 'P', load: 'x:a' },
  { name: 'b', path: '/b', parent: 'shell', component: 'P', load: 'x:b' },
  { name: 'c', path: '/c', parent: 'shell', component: 'P', load: 'x:c' },
];

async function build(loaders: LoaderHandlers, routes = ROUTES) {
  const router = createRouter({
    history: createMemoryHistory('/'),
    routes,
    components: { P: { name: 'P' } },
    loaders,
    scroll: false,
    links: false,
    announce: false,
    onError: () => {},
  });
  await router.isReady();
  return router;
}

/** Abort listeners added and not removed, per signal, while `fn` runs. */
async function countingAbortListeners<T>(fn: (left: (s: AbortSignal) => number, added: (s: AbortSignal) => number) => Promise<T>): Promise<T> {
  const live = new WeakMap<AbortSignal, Set<unknown>>();
  const adds = new WeakMap<AbortSignal, number>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, l: unknown, o?: unknown) {
    if (this instanceof AbortSignal && type === 'abort' && l) {
      const set = live.get(this) ?? new Set();
      set.add(l);
      live.set(this, set);
      adds.set(this, (adds.get(this) ?? 0) + 1);
    }
    return add.call(this, type, l as EventListener, o as AddEventListenerOptions);
  } as typeof add;
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, l: unknown, o?: unknown) {
    if (this instanceof AbortSignal && type === 'abort') live.get(this)?.delete(l);
    return remove.call(this, type, l as EventListener, o as EventListenerOptions);
  } as typeof remove;
  try {
    return await fn((s) => live.get(s)?.size ?? 0, (s) => adds.get(s) ?? 0);
  } finally {
    EventTarget.prototype.addEventListener = add;
    EventTarget.prototype.removeEventListener = remove;
  }
}

describe('three navigations fired back to back', () => {
  it('the two older loaders see an abort, each older navigation answers aborted:navigation, the last commits', async () => {
    const signals: Record<string, AbortSignal> = {};
    const release: Record<string, () => void> = {};
    const router = await build({
      prefixes: {
        'x:': (ref, _l, _r, signal) => {
          signals[ref] = signal;
          // `a` reads its signal; `b` never does (the positive control below); `c` is plain.
          return new Promise((resolve, reject) => {
            release[ref] = () => resolve(ref);
            if (ref === 'a') signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      },
    });
    const navs = [router.push('/a'), router.push('/b'), router.push('/c')];
    await tick();
    const abortedAtStart = { a: signals.a.aborted, b: signals.b.aborted, c: signals.c.aborted };
    release.b();
    release.c();
    const settled = await Promise.all(navs);
    expect({
      abortedAtStart,
      codes: settled.map((e) => e?.code ?? null),
      at: router.currentRoute.value.location.fullPath,
      data: router.currentRoute.value.data.get('c'),
    }).toEqual({
      abortedAtStart: { a: true, b: true, c: false },
      codes: ['router:aborted:navigation', 'router:aborted:navigation', null],
      at: '/c',
      data: 'c',
    });
    router.dispose();
  });

  it('positive control: a loader that never reads its signal is still settled once it returns', async () => {
    let release!: () => void;
    const router = await build({ prefixes: { 'x:': (ref) => (ref === 'a' ? new Promise((r) => (release = () => r('a'))) : ref) } });
    const older = router.push('/a');
    const newer = router.push('/c');
    expect(await newer).toBeNull();
    release();
    expect((await older)?.code).toBe('router:aborted:navigation');
    router.dispose();
  });

  it('a loader that never reads its signal and never returns holds its navigation open; the bus does the same', async () => {
    const router = await build({ prefixes: { 'x:': (ref) => (ref === 'a' ? new Promise(() => {}) : ref) } });
    const older = router.push('/a');
    expect(await router.push('/c')).toBeNull();
    const routerOutcome = await Promise.race([older.then(() => 'settled'), ms(50).then(() => 'open')]);
    router.dispose();

    const bus = createAsyncCommandBus();
    bus.use(supersede({ actions: ['load'] }));
    let calls = 0;
    bus.register('load', async () => (++calls === 1 ? new Promise(() => {}) : 'second'));
    const first = bus.dispatch('load', 'k');
    const second = await bus.dispatch('load', 'k');
    const busOutcome = await Promise.race([first.then(() => 'settled'), ms(50).then(() => 'open')]);
    bus.dispose();

    expect({ routerOutcome, busOutcome, second: second.ok }).toEqual({ routerOutcome: 'open', busOutcome: 'open', second: true });
  });
});

describe('abort listeners left on a signal after its navigation settles', () => {
  it('control: the counter sees a listener a loader leaves behind', async () => {
    await countingAbortListeners(async (left) => {
      let seen!: AbortSignal;
      const router = await build({ prefixes: { 'x:': (ref, _l, _r, signal) => { seen = signal; signal.addEventListener('abort', () => {}); return ref; } } });
      expect(await router.push('/c')).toBeNull();
      expect(left(seen)).toBe(1);
      router.dispose();
    });
  });

  it('fetchLoaders over a real server: none left on the committed navigation, none on the bus under supersede', async () => {
    await countingAbortListeners(async (left, added) => {
      const http = createHttpClient({ baseURL: base, retry: 0 });
      let seen!: AbortSignal;
      const inner = fetchLoaders({ http });
      const router = await build(
        { url: (t, l, r, signal, ctx) => { seen = signal; return inner.url!(t, l, r, signal, ctx); } },
        [{ name: 'shell', path: '/', parent: null }, { name: 'c', path: '/c', parent: 'shell', component: 'P', load: '/c' }],
      );
      const older = router.push('/c?x=1');
      expect(await router.push('/c')).toBeNull();
      await older;
      const routerLeft = left(seen);
      const routerAdded = added(seen);
      router.dispose();

      const bus = createAsyncCommandBus();
      bus.use(supersede({ actions: ['load'] }));
      let busSignal!: AbortSignal;
      bus.register('load', async (cmd) => { busSignal = cmd.signal!; return (await http.get('/c', { signal: cmd.signal })).data; });
      const r = await bus.dispatch('load', 'k');
      const busLeft = left(busSignal);
      const busAdded = added(busSignal);
      bus.dispose();

      expect({ routerAdded, routerLeft, busAdded, busLeft, ok: r.ok }).toEqual({ routerAdded: 1, routerLeft: 0, busAdded: 1, busLeft: 0, ok: true });
    });
  });
});

/*
 * Plan 1.28 item 5 (log s35.207). Superseded navigations use their own
 * AbortController (src/router/engine.ts `navController`, `supersede()`), and
 * the core has the `supersede` plugin with `core:aborted:dispatch`. The probe
 * fires three navigations back to back, each with a loader, and records which
 * loaders see `signal.aborted`, the failure each navigation settles with, and
 * the abort listeners left on a signal once its navigation settled.
 *
 * The two older navigations' loaders see the abort at once. Each older
 * navigation answers `router:aborted:navigation`, whether its loader read the
 * signal or not, and the last one commits with its data. A loader that never
 * reads its signal settles its navigation when it returns (the positive
 * control). One that never returns holds its navigation's promise open, and a
 * bus handler under `supersede` that ignores `cmd.signal` does the same:
 * cancellation inside a started piece of work is cooperative on both sides.
 *
 * Listener counts: the counter wraps EventTarget's add and remove for abort
 * listeners on AbortSignals, and its control sees the one a loader leaves.
 * On the committed navigation's signal and on the bus's `supersede` signal
 * alike, one abort listener is added during the request and none is left
 * once it settled.
 *
 * The router's failure code is its own namespace (`router:aborted:navigation`,
 * src/schema.ts), the bus's is `core:aborted:dispatch`. Different owners by
 * the error model, the same condition (`aborted`).
 */
