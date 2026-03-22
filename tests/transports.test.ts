/**
 * Tests for the transport layer: createHttpBridge, createWsBridge, createSseBridge
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAsyncCommandBus, invalidateCsrfCache } from '../src/index';
import { createHttpBridge } from '../src/transports';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// createHttpBridge
// ---------------------------------------------------------------------------

describe('createHttpBridge', () => {
  it('sends command envelope to endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ state: { count: 3 } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('cartAdd', { id: 1 }, { quantity: 2 });

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ count: 3 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/vc');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body);
    expect(body.command).toBe('cartAdd');
    expect(body.target).toEqual({ id: 1 });
    expect(body.payload).toEqual({ quantity: 2 });
  });

  it('returns error on HTTP failure status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'Unprocessable',
    }));

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));

    const result = await bus.dispatch('fail', {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('422');
  });

  it('reads XSRF-TOKEN cookie when csrf: true', async () => {
    invalidateCsrfCache();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    vi.stubGlobal('document', {
      cookie: 'XSRF-TOKEN=abc123',
      querySelector: () => null,
    });

    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));
    await bus.dispatch('test', {});

    const init = (fetch as any).mock.calls[0][1];
    expect(init.headers['X-XSRF-TOKEN']).toBe('abc123');

    invalidateCsrfCache();
    vi.unstubAllGlobals();
  });

  it('actions filter skips non-matching commands', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    const bus = createAsyncCommandBus({ onMissing: 'ignore' });
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'] }));

    await bus.dispatch('userLogin', {});
    expect(fetchMock).not.toHaveBeenCalled();

    await bus.dispatch('cartAdd', {});
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
