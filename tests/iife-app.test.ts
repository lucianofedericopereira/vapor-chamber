/**
 * The one createApp and connect shared by the IIFE variants.
 * Why: every IIFE variant would otherwise need its own copy and its own plugin-then-transport install order; with the transport a bus option there is no order to get wrong.
 * Shows: createApp declares the transport at the bus and installs the plugins, onMissing defaults to an error and passes through, and connect() sends over HTTP with the XSRF header and keeps its plugins.
 * See: tests/iife-bundle.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type PluginParts, inspectBus } from '../src/command-bus';
import { connect, createApp } from '../src/iife-app';
import { defineTransport } from '../src/transports';

afterEach(() => { vi.unstubAllGlobals(); });

describe('createApp', () => {
  it('declares the transport at the bus and installs the plugins', async () => {
    const seen: string[] = [];
    const plugin: PluginParts = { started: (cmd) => { seen.push(cmd.action); } };
    const { bus, dispatch } = createApp({ transport: defineTransport(async () => ({ ok: true, value: 'sent' })), plugins: [plugin], retry: false });
    expect(await dispatch('cartAdd', {})).toMatchObject({ ok: true, value: 'sent' });
    expect(seen).toEqual(['cartAdd']);
    expect(inspectBus(bus).transports).toEqual([{ pattern: '*', id: 'transport' }]);
  });

  it("a missing handler fails by default, onMissing: 'error'", async () => {
    const { dispatch } = createApp();
    expect(await dispatch('nobody', {})).toFailWith('core:missing:handler');
  });

  it('passes onMissing through', async () => {
    const { dispatch } = createApp({ onMissing: 'ignore' });
    expect((await dispatch('nobody', {})).ok).toBe(true);
  });
});

describe('connect', () => {
  it('sends over HTTP with csrf on, and keeps the plugins', async () => {
    const posts: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal('document', { cookie: 'XSRF-TOKEN=t1', querySelector: () => null });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      posts.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ state: 2 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const seen: string[] = [];
    const { dispatch } = connect({ endpoint: '/api/vc', retry: false, plugins: [{ started: (cmd) => { seen.push(cmd.action); } }] });
    expect(await dispatch('cartAdd', {})).toMatchObject({ ok: true, value: 2 });
    expect(posts[0].url).toBe('/api/vc');
    expect(posts[0].headers['X-XSRF-TOKEN']).toBe('t1');
    expect(seen).toEqual(['cartAdd']);
  });
});
