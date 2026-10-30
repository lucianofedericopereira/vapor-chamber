/**
 * `onRedirect` on the batching bridge, for a batch result `{ id, redirect }` as the reference controller answers it.
 * Why: the batch options accept `onRedirect`, so a redirect must not resolve as a success; it fires once, since two navigations in one tick race.
 * Shows: a redirected command fails with transport:refused:redirect and its own url, siblings are untouched, one navigation per batch, the single bridge agrees.
 * See: docs/integrations/laravel.md.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusError, createAsyncCommandBus } from '../src/command-bus';
import { httpTransport } from '../src/transports';
import { batchServer, reply } from './backend-stubs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the batching bridge honours onRedirect', () => {
  it('a redirected command fails with transport:refused:redirect and onRedirect navigates', async () => {
    batchServer((command) => (command === 'logout' ? { redirect: '/login' } : { ok: true, state: { saved: true } }));
    const visits: string[] = [];
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', onRedirect: (url) => visits.push(url), batch: {} }) });

    const [logout, save] = await Promise.all([bus.dispatch('logout', {}), bus.dispatch('save', {})]);

    expect(visits).toEqual(['/login']);
    expect(logout.ok).toBe(false);
    expect(logout.error).toBeInstanceOf(BusError);
    expect(logout.error).toMatchObject({ code: 'transport:refused:redirect', context: { url: '/login' } });
    expect(save).toMatchObject({ ok: true, value: { saved: true } });   // the sibling is untouched
  });

  it('two redirects in one batch navigate once; each command still carries its own url', async () => {
    batchServer((command) => ({ redirect: command === 'a' ? '/first' : '/second' }));
    const visits: string[] = [];
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', onRedirect: (url) => visits.push(url), batch: {} }) });

    const [a, b] = await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})]);

    expect(visits).toEqual(['/first']);
    expect(a.error).toMatchObject({ code: 'transport:refused:redirect', context: { url: '/first' } });
    expect(b.error).toMatchObject({ code: 'transport:refused:redirect', context: { url: '/second' } });
  });

  it('without onRedirect the redirect still fails the command, and says why', async () => {
    batchServer(() => ({ redirect: '/login' }));
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }) });

    const result = await bus.dispatch('logout', {});

    expect(result.error).toMatchObject({ code: 'transport:refused:redirect', context: { url: '/login' } });
    expect(result.error?.message).toMatch(/No onRedirect handler is configured/);
  });

  it('CONTROL: the single bridge answers the same field the same way', async () => {
    vi.stubGlobal('fetch', async () => reply(200, { redirect: '/login' }));
    const visits: string[] = [];
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', onRedirect: (url) => visits.push(url) }) });

    const result = await bus.dispatch('logout', {});

    expect(visits).toEqual(['/login']);
    expect(result.error).toMatchObject({ code: 'transport:refused:redirect', context: { url: '/login' } });
  });
});
