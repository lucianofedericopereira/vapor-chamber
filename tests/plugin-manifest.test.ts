/**
 * A plugin's `actions` manifest: the bus places its parts only on matching actions.
 * Why: a scoped plugin called on an action it did not declare would run rules and steps outside its scope.
 * Shows: metrics() exposes its actions, undeclared actions are never seen while order is kept, a plugin used after a dispatch is placed on an action already seen, a part's throw names the part only inside scope, the async bus behaves the same, and the per-action caches restart past 512 actions and still place the right parts.
 * See: log s35.141.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type PluginParts } from '../src/command-bus';
import { metrics } from '../src/plugins-extra';

const declared = (actions: string[], seen: string[], name: string): PluginParts =>
  ({ actions, started: (cmd) => { seen.push(`${name}:${cmd.action}`); } });

describe('the plugin manifest', () => {
  it('a scoped plugin declares its actions', () => {
    expect(metrics({ actions: ['cart*'] }).actions).toEqual(['cart*']);
    expect(metrics().actions).toBeUndefined();
  });

  it('the bus never calls a plugin on an action it did not declare; order is kept', () => {
    const seen: string[] = [];
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    bus.register('userSave', () => 2);
    bus.use(declared(['cart*'], seen, 'p1'));
    bus.use(declared(['user*', 'cart*'], seen, 'p2'));
    bus.use({ started: (cmd) => { seen.push(`all:${cmd.action}`); } });
    expect(bus.dispatch('cartAdd', 0).value).toBe(1);
    expect(bus.dispatch('userSave', 0).value).toBe(2);
    expect(seen).toEqual(['p1:cartAdd', 'p2:cartAdd', 'all:cartAdd', 'p2:userSave', 'all:userSave']);
  });

  it('a plugin used after a dispatch is placed on an action already seen', () => {
    const seen: string[] = [];
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    bus.dispatch('cartAdd', 0);
    bus.use(declared(['cart*'], seen, 'late'));
    bus.dispatch('cartAdd', 0);
    expect(seen).toEqual(['late:cartAdd']);
  });

  it('a throw names its part, inside the scope only', () => {
    const bus = createCommandBus();
    bus.register('userSave', () => 1);
    bus.register('cartAdd', () => 2);
    bus.use({ actions: ['user*'], admit: () => { throw new Error('x'); } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = bus.dispatch('userSave', 0);
    expect((r.error as { context?: { part?: string } }).context?.part).toBe('admit');
    expect(bus.dispatch('cartAdd', 0).value).toBe(2);
  });

  it('the async bus too', async () => {
    const seen: string[] = [];
    const bus = createAsyncCommandBus();
    bus.register('userSave', async () => 2);
    bus.use(declared(['cart*'], seen, 'p1') as never);
    expect((await bus.dispatch('userSave', 0)).value).toBe(2);
    expect(seen).toEqual([]);
  });

  it('past 512 actions the per-action caches start over and still place the right parts', () => {
    const seen: string[] = [];
    const bus = createCommandBus({ onMissing: 'ignore' });
    bus.use(declared(['hit*'], seen, 'p'));
    for (let i = 0; i < 520; i++) bus.dispatch(`miss${i}`, 0);
    bus.dispatch('hit1', 0);
    expect(seen).toEqual(['p:hit1']);
  });

  it('on the async bus, a throw or a rejection names its part', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('userSave', async () => 1);
    bus.use({ actions: ['userSave'], begin: () => { throw new Error('sync'); } });
    const sync = await bus.dispatch('userSave', 0);
    expect((sync.error as { context?: { part?: string } }).context?.part).toBe('begin');
    const bus2 = createAsyncCommandBus();
    bus2.register('userSave', async () => 1);
    bus2.use({ actions: ['userSave'], reuse: () => Promise.reject(new Error('async')) });
    const rejected = await bus2.dispatch('userSave', 0);
    expect((rejected.error as { context?: { part?: string } }).context?.part).toBe('reuse');
  });
});
