/** P1: a plugin declares `actions`; the bus runs it only on those (log s35.141). */
import { describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Plugin } from '../src/command-bus';
import { metrics } from '../src/plugins-extra';

const declared = (actions: string[], seen: string[], name: string): Plugin =>
  Object.assign((cmd: { action: string }, next: () => unknown) => { seen.push(`${name}:${cmd.action}`); return next(); }, { actions }) as never;

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
    bus.use((cmd, next) => { seen.push(`all:${cmd.action}`); return next(); });
    expect(bus.dispatch('cartAdd', 0).value).toBe(1);
    expect(bus.dispatch('userSave', 0).value).toBe(2);
    expect(seen).toEqual(['p1:cartAdd', 'p2:cartAdd', 'all:cartAdd', 'p2:userSave', 'all:userSave']);
  });

  it('a plugin used after a dispatch joins the chain of an action already seen', () => {
    const seen: string[] = [];
    const bus = createCommandBus();
    bus.register('cartAdd', () => 1);
    bus.dispatch('cartAdd', 0);
    bus.use(declared(['cart*'], seen, 'late'));
    bus.dispatch('cartAdd', 0);
    expect(seen).toEqual(['late:cartAdd']);
  });

  it('a throw reports the plugin\'s place in the whole chain', () => {
    const bus = createCommandBus();
    bus.register('userSave', () => 1);
    bus.use(declared(['cart*'], [], 'skip'));
    bus.use(Object.assign(() => { throw new Error('x'); }, { actions: ['user*'] }) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = bus.dispatch('userSave', 0);
    expect((r.error as { context?: { index?: number } }).context?.index).toBe(1);
  });

  it('the async bus too', async () => {
    const seen: string[] = [];
    const bus = createAsyncCommandBus();
    bus.register('userSave', async () => 2);
    bus.use(declared(['cart*'], seen, 'p1') as never);
    expect((await bus.dispatch('userSave', 0)).value).toBe(2);
    expect(seen).toEqual([]);
  });

  it('past 512 actions the chains start over and still run the right plugins', () => {
    const seen: string[] = [];
    const bus = createCommandBus({ onMissing: 'ignore' });
    bus.use(declared(['hit*'], seen, 'p'));
    for (let i = 0; i < 520; i++) bus.dispatch(`miss${i}`, 0);
    bus.dispatch('hit1', 0);
    expect(seen).toEqual(['p:hit1']);
  });

  it('on the async bus, a throw or a rejection reports the place in the whole chain', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bus = createAsyncCommandBus();
    bus.register('userSave', async () => 1);
    bus.use(declared(['cart*'], [], 'skip') as never);
    bus.use(Object.assign(() => { throw new Error('sync'); }, { actions: ['userSave'] }) as never);
    const sync = await bus.dispatch('userSave', 0);
    expect((sync.error as { context?: { index?: number } }).context?.index).toBe(1);
    const bus2 = createAsyncCommandBus();
    bus2.register('userSave', async () => 1);
    bus2.use(declared(['cart*'], [], 'skip') as never);
    bus2.use(Object.assign(() => Promise.reject(new Error('async')), { actions: ['userSave'] }) as never);
    const rejected = await bus2.dispatch('userSave', 0);
    expect((rejected.error as { context?: { index?: number } }).context?.index).toBe(1);
  });
});
