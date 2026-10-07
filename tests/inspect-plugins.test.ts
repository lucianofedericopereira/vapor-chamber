/** `inspectBus().plugins`: each installed plugin's declared id, priority and scope, in run order. Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createActionFilter } from '../src/action-filter';
import { createAsyncCommandBus, createCommandBus, inspectBus, type BaseBus, type Command, type CommandResult } from '../src/command-bus';
import { logger } from '../src/plugins-core';
import { cache, metrics } from '../src/plugins-extra';
import { createTestBus } from '../src/testing';
import { createHttpBridge } from '../src/transports';

/** An app plugin with no id, recording that it ran. */
const recording = (seen: string[], name: string) => (_cmd: Command, next: () => CommandResult) => { seen.push(name); return next(); };

describe('inspectBus().plugins', () => {
  it('names each plugin by its declared id, with its priority and scope, in the order the chain runs', () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    bus.use(logger(), { priority: 1 });
    bus.use(metrics({ actions: ['cart*'] }), { priority: 5 });
    bus.use(cache({ actionFilter: createActionFilter([{ prefix: { action: 'get' } }]) }) as never);
    bus.use(recording(seen, 'app') as never, { priority: 10 });
    expect(inspectBus(bus).plugins).toEqual([
      { id: undefined, priority: 10, actions: undefined, actionFilter: false, transport: false },
      { id: 'metrics', priority: 5, actions: ['cart*'], actionFilter: false, transport: false },
      { id: 'logger', priority: 1, actions: undefined, actionFilter: false, transport: false },
      { id: 'cache', priority: 0, actions: undefined, actionFilter: true, transport: false },
    ]);
    // The order reported is the order run: the app plugin, outermost, first.
    bus.register('x', () => 1);
    bus.dispatch('x', null);
    expect(seen).toEqual(['app']);
  });

  it('a bridge reports transport, on the async bus', () => {
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/vc', actions: ['order*'] }));
    expect(inspectBus(bus).plugins).toEqual([{ id: 'transport', priority: 0, actions: ['order*'], actionFilter: false, transport: true }]);
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
      bus.use(logger(), { priority: 2 });
      bus.use(metrics({ actions: ['cart*'] }) as never);
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

/*
 * A tracer or a DevTools panel had to patch `bus.use` to learn what is
 * installed and on which actions: `inspectBus` answered only `pluginCount` and
 * `pluginPriorities`. Log 10.3 W2 called it not cheap while a plugin's scope
 * was a closure. Since 1.27 a plugin declares `id`, `actions` and
 * `actionFilter` as properties the bus reads (s35.141, s35.152), and every
 * built-in factory declares its id (tests/plugin-ids.test.ts), so the bus
 * reports what it already holds. `id` is the declared one, never
 * `Function.name` (a minifier renames it, contract 4.5). `actionFilter` is
 * reported as present or not: the snapshot is documented as safe to
 * serialize, and a function is not. The list is built only when inspectBus is
 * called: dispatch and use() do no new work.
 */
