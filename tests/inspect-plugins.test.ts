/**
 * inspectBus().plugins: each installed plugin's declared id and scope, in install order.
 * Why: a tracer or DevTools panel would otherwise have to patch bus.use to learn what is installed; the id must be the declared one, never Function.name which a minifier renames, and actionFilter must be reported as a flag because the snapshot has to serialize.
 * Shows: ids, actions, actionFilter and parts per plugin in install order, transports are not plugins, the list follows use() and its removal, the snapshot is serializable and detached, the test bus matches the real bus, and a foreign bus reports none.
 * See: log s35.141, log s35.152, tests/plugin-ids.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createActionFilter } from '../src/action-filter';
import { createAsyncCommandBus, createCommandBus, inspectBus, type BaseBus, type PluginParts } from '../src/command-bus';
import { logger } from '../src/plugins-core';
import { cache, metrics } from '../src/plugins-extra';
import { createTestBus } from '../src/testing';
import { httpTransport } from '../src/transports';

/** An app plugin with no id, recording that it ran. */
const recording = (seen: string[], name: string): PluginParts => ({ started: () => { seen.push(name); } });

describe('inspectBus().plugins', () => {
  it('names each plugin by its declared id, with its scope, in install order', () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    bus.use(logger());
    bus.use(metrics({ actions: ['cart*'] }));
    bus.use(cache({ actionFilter: createActionFilter([{ prefix: { action: 'get' } }]) }));
    bus.use(recording(seen, 'app'));
    expect(inspectBus(bus).plugins).toEqual([
      { id: 'logger', actions: undefined, actionFilter: false, parts: ['settled'] },
      { id: 'metrics', actions: ['cart*'], actionFilter: false, parts: ['started', 'settled'] },
      { id: 'cache', actions: undefined, actionFilter: true, parts: ['reuse', 'begin', 'attach'] },
      { id: undefined, actions: undefined, actionFilter: false, parts: ['started'] },
    ]);
    bus.register('x', () => 1);
    bus.dispatch('x', null);
    expect(seen).toEqual(['app']);
  });

  it('a transport is not a plugin: the async bus reports it under transports', () => {
    const bus = createAsyncCommandBus({ transport: { 'order*': httpTransport({ endpoint: '/vc' }) } });
    expect(inspectBus(bus).plugins).toEqual([]);
    expect(inspectBus(bus).transports).toEqual([{ pattern: 'order*', id: 'transport' }]);
  });

  it('follows use() and its removal', () => {
    const bus = createCommandBus();
    const off = bus.use(logger());
    expect(inspectBus(bus).plugins.map((p) => p.id)).toEqual(['logger']);
    off();
    expect(inspectBus(bus).plugins).toEqual([]);
  });

  it('is a snapshot: serializable, and changing it changes no plugin', () => {
    const bus = createCommandBus();
    bus.use(metrics({ actions: ['cart*'] }));
    const info = inspectBus(bus);
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
    (info.plugins[0].actions as string[]).push('order*');
    expect(inspectBus(bus).plugins[0].actions).toEqual(['cart*']);
  });

  it('the test bus reports the same list as the real bus', () => {
    const install = (bus: BaseBus) => {
      bus.use(logger());
      bus.use(metrics({ actions: ['cart*'] }));
    };
    const real = createCommandBus();
    const test = createTestBus();
    install(real);
    install(test);
    expect(inspectBus(real).plugins.map((p) => p.id)).toEqual(['logger', 'metrics']);
    expect(test.inspect().plugins).toEqual(inspectBus(real).plugins);
  });

  it('control: a bus this module did not make reports no plugins', () => {
    const foreign = { registeredActions: () => [], isSealed: () => false } as unknown as BaseBus;
    expect(inspectBus(foreign).plugins).toEqual([]);
  });
});
