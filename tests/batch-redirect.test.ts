/**
 * `onRedirect` on the batching bridge.
 *
 * `BatchingHttpBridgeOptions` is `HttpBridgeOptions & { window }`, so it has
 * always ACCEPTED `onRedirect` - and never read it: a redirect result was
 * resolved as a success whose value was the redirect. The single bridge has
 * handled the same body field since `onRedirect` shipped.
 *
 * The body is what the reference controller answers once an action returns
 * `['redirect' => url]` (docs/integrations/laravel.md): each batch result is
 * `{ id, redirect }`, the same field the single endpoint puts at the top of
 * its envelope.
 *
 * `onRedirect` fires ONCE per batch, with the first URL: it navigates, and two
 * navigations in one tick race. Every redirected command still fails on its
 * own, with its own `context.url`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusError, createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';
import { batchServer, reply } from './backend-stubs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the batching bridge honours onRedirect', () => {
  it('a redirected command fails with VC_TRANSPORT_REDIRECT and onRedirect navigates', async () => {
    batchServer((command) => (command === 'logout' ? { redirect: '/login' } : { ok: true, state: { saved: true } }));
    const visits: string[] = [];
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', onRedirect: (url) => visits.push(url) }));

    const [logout, save] = await Promise.all([bus.dispatch('logout', {}), bus.dispatch('save', {})]);

    expect(visits).toEqual(['/login']);
    expect(logout.ok).toBe(false);
    expect(logout.error).toBeInstanceOf(BusError);
    expect(logout.error).toMatchObject({ code: 'VC_TRANSPORT_REDIRECT', emitter: 'transport', context: { url: '/login' } });
    expect(save).toMatchObject({ ok: true, value: { saved: true } });   // the sibling is untouched
  });

  it('two redirects in one batch navigate once; each command still carries its own url', async () => {
    batchServer((command) => ({ redirect: command === 'a' ? '/first' : '/second' }));
    const visits: string[] = [];
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch', onRedirect: (url) => visits.push(url) }));

    const [a, b] = await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);

    expect(visits).toEqual(['/first']);
    expect(a.error).toMatchObject({ code: 'VC_TRANSPORT_REDIRECT', context: { url: '/first' } });
    expect(b.error).toMatchObject({ code: 'VC_TRANSPORT_REDIRECT', context: { url: '/second' } });
  });

  it('without onRedirect the redirect still fails the command, and says why', async () => {
    batchServer(() => ({ redirect: '/login' }));
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));

    const result = await bus.dispatch('logout', {});

    expect(result.error).toMatchObject({ code: 'VC_TRANSPORT_REDIRECT', context: { url: '/login' } });
    expect(result.error?.message).toMatch(/no onRedirect handler configured/);
  });

  it('CONTROL: the single bridge answers the same field the same way', async () => {
    vi.stubGlobal('fetch', async () => reply(200, { redirect: '/login' }));
    const visits: string[] = [];
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', onRedirect: (url) => visits.push(url) }));

    const result = await bus.dispatch('logout', {});

    expect(visits).toEqual(['/login']);
    expect(result.error).toMatchObject({ code: 'VC_TRANSPORT_REDIRECT', context: { url: '/login' } });
  });
});
