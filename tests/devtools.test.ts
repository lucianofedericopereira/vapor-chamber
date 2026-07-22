/**
 * Tests for src/devtools.ts — Vue DevTools integration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setupDevtools } from '../src/devtools';
import { createCommandBus } from '../src/command-bus';

describe('setupDevtools', () => {
  beforeEach(() => {
    // Ensure non-production environment
    vi.stubGlobal('process', { env: { NODE_ENV: 'test' } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an unsubscribe function', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const unsub = setupDevtools(bus, {});
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('no-ops in production mode', () => {
    vi.stubGlobal('process', { env: { NODE_ENV: 'production' } });
    const bus = createCommandBus({ onMissing: 'ignore' });
    const unsub = setupDevtools(bus, {});
    expect(typeof unsub).toBe('function');
    // Should not throw when called
    unsub();
  });

  it('records commands via onAfter hook', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const unsub = setupDevtools(bus, {});

    // Dispatch something — should not throw even without devtools API
    bus.dispatch('testAction', { id: 1 }, { qty: 2 });
    bus.dispatch('testAction2', { id: 2 });

    // Cleanup
    unsub();
  });

  it('unsubscribe stops recording', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const afterHookSpy = vi.fn();

    // Subscribe our own hook to verify timing
    bus.onAfter(afterHookSpy);
    const unsub = setupDevtools(bus, {});

    bus.dispatch('before', {});
    expect(afterHookSpy).toHaveBeenCalledTimes(1);

    unsub();

    // After unsub, devtools hook should be removed but our spy remains
    bus.dispatch('after', {});
    expect(afterHookSpy).toHaveBeenCalledTimes(2);
  });
});

/**
 * The devtools-api half: everything above only exercises the bus-side buffer,
 * because the `import('@vue/devtools-api')` callback never ran without the
 * optional peer installed. It is a devDependency now, so the plugin body —
 * timeline layer, inspector, and the two inspector callbacks — is reachable.
 *
 * v1.9 promotes this module to the public `vapor-chamber/devtools` subpath, and
 * a published entry point should be measured, not assumed.
 */
describe('setupDevtools — the @vue/devtools-api integration', () => {
  /** Capture the api object the plugin registers, plus its callbacks. */
  async function withDevtools(): Promise<{
    bus: ReturnType<typeof createCommandBus>;
    api: any;
    stop: () => void;
  }> {
    const handlers: Record<string, (payload: any) => void> = {};
    const api = {
      addTimelineLayer: vi.fn(),
      addInspector: vi.fn(),
      addTimelineEvent: vi.fn(),
      sendInspectorTree: vi.fn(),
      on: {
        getInspectorTree: (fn: (p: any) => void) => { handlers.tree = fn; },
        getInspectorState: (fn: (p: any) => void) => { handlers.state = fn; },
      },
    };
    vi.doMock('@vue/devtools-api', () => ({
      setupDevtoolsPlugin: (_descriptor: unknown, cb: (api: unknown) => void) => cb(api),
    }));
    vi.resetModules();
    const { setupDevtools: fresh } = await import('../src/devtools');
    const bus = createCommandBus({ onMissing: 'ignore' });
    const stop = fresh(bus, {});
    await new Promise((r) => setTimeout(r, 0)); // let the dynamic import settle
    return { bus, api: Object.assign(api, { handlers }), stop };
  }

  afterEach(() => {
    vi.doUnmock('@vue/devtools-api');
    vi.resetModules();
  });

  it('registers the Commands timeline layer and the inspector panel', async () => {
    const { api, stop } = await withDevtools();
    expect(api.addTimelineLayer).toHaveBeenCalledWith(expect.objectContaining({ label: 'Commands' }));
    expect(api.addInspector).toHaveBeenCalledWith(expect.objectContaining({ id: expect.any(String) }));
    stop();
  });

  it('pushes a timeline event per dispatch, tagged ok or error', async () => {
    const { bus, api, stop } = await withDevtools();
    bus.register('ok', () => 'fine');
    bus.register('bad', () => { throw new Error('nope'); });

    bus.dispatch('ok', { id: 1 }, { q: 2 });
    bus.dispatch('bad', {});

    expect(api.addTimelineEvent).toHaveBeenCalledTimes(2);
    const [first] = api.addTimelineEvent.mock.calls[0];
    expect(first.event.title).toBe('ok');
    expect(first.event.data).toMatchObject({ action: 'ok', target: { id: 1 }, payload: { q: 2 }, ok: true });
    const [second] = api.addTimelineEvent.mock.calls[1];
    expect(second.event.logType).toBe('error');
    expect(second.event.data.error).toBe('nope');
    expect(api.sendInspectorTree).toHaveBeenCalled();
    stop();
  });

  it('builds the inspector tree, and filters it by action', async () => {
    const { bus, api, stop } = await withDevtools();
    bus.register('cartAdd', () => 1);
    bus.register('userLogin', () => 2);
    bus.dispatch('cartAdd', {});
    bus.dispatch('userLogin', {});

    const payload: any = { inspectorId: 'vapor-chamber', filter: '' };
    api.handlers.tree(payload);
    expect(payload.rootNodes.map((n: any) => n.label).sort()).toEqual(['cartAdd', 'userLogin']);
    expect(payload.rootNodes[0].tags[0].label).toBe('ok');

    const filtered: any = { inspectorId: 'vapor-chamber', filter: 'cart' };
    api.handlers.tree(filtered);
    expect(filtered.rootNodes.map((n: any) => n.label)).toEqual(['cartAdd']);
    stop();
  });

  it('ignores payloads addressed to a different inspector', async () => {
    const { bus, api, stop } = await withDevtools();
    bus.register('x', () => 1);
    bus.dispatch('x', {});

    const other: any = { inspectorId: 'someone-elses-panel', filter: '' };
    api.handlers.tree(other);
    expect(other.rootNodes).toBeUndefined();

    const otherState: any = { inspectorId: 'someone-elses-panel', nodeId: '0' };
    api.handlers.state(otherState);
    expect(otherState.state).toBeUndefined();
    stop();
  });

  it('fills inspector state for a selected node, and no-ops for an unknown one', async () => {
    const { bus, api, stop } = await withDevtools();
    bus.register('cartAdd', () => ({ count: 1 }));
    bus.dispatch('cartAdd', { id: 7 }, { qty: 2 });

    const tree: any = { inspectorId: 'vapor-chamber', filter: '' };
    api.handlers.tree(tree);
    const nodeId = tree.rootNodes[0].id;

    const state: any = { inspectorId: 'vapor-chamber', nodeId };
    api.handlers.state(state);
    expect(state.state.command).toEqual(
      expect.arrayContaining([
        { key: 'action', value: 'cartAdd' },
        { key: 'target', value: { id: 7 } },
        { key: 'payload', value: { qty: 2 } },
      ]),
    );

    const missing: any = { inspectorId: 'vapor-chamber', nodeId: 'does-not-exist' };
    api.handlers.state(missing);
    expect(missing.state).toBeUndefined();
    stop();
  });

  it('unsubscribing stops further timeline events', async () => {
    const { bus, api, stop } = await withDevtools();
    bus.register('x', () => 1);
    bus.dispatch('x', {});
    const before = api.addTimelineEvent.mock.calls.length;

    stop();
    bus.dispatch('x', {});
    expect(api.addTimelineEvent.mock.calls.length).toBe(before);
  });
});
