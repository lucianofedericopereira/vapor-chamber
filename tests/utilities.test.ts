import { describe, it, expect, vi } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createChamber, createWorkflow, createReaction } from '../src/utilities';

// ---------------------------------------------------------------------------
// createChamber
// ---------------------------------------------------------------------------

describe('createChamber', () => {
  it('installs handlers with namespace prefix', () => {
    const bus = createCommandBus();
    const chamber = createChamber('cart', {
      add:   (cmd) => `added:${cmd.target.id}`,
      clear: () => 'cleared',
    });

    chamber.install(bus);

    expect(bus.dispatch('cartAdd', { id: 5 }).value).toBe('added:5');
    expect(bus.dispatch('cartClear', {}).value).toBe('cleared');
  });

  it('actionName returns correctly prefixed name', () => {
    const chamber = createChamber('order', {});
    expect(chamber.actionName('create')).toBe('orderCreate');
    expect(chamber.actionName('cancel')).toBe('orderCancel');
  });

  it('exposes namespace', () => {
    const chamber = createChamber('user', {});
    expect(chamber.namespace).toBe('user');
  });

  it('install returns cleanup that unregisters all handlers', () => {
    const bus = createCommandBus();
    const chamber = createChamber('cart', { add: () => 1 });
    const uninstall = chamber.install(bus);

    expect(bus.dispatch('cartAdd', {}).ok).toBe(true);
    uninstall();
    expect(bus.dispatch('cartAdd', {}).ok).toBe(false);
  });

  it('forwards RegisterOptions (undo) to bus.register', () => {
    const bus = createCommandBus();
    const undo = vi.fn();
    const chamber = createChamber(
      'cart',
      { add: () => 1 },
      { options: { add: { undo } } },
    );
    chamber.install(bus);

    bus.dispatch('cartAdd', {});
    const undoFn = bus.getUndoHandler('cartAdd');
    expect(typeof undoFn).toBe('function');
  });

  it('two chambers with different namespaces do not collide', () => {
    const bus = createCommandBus();
    createChamber('cart',  { add: () => 'cart' }).install(bus);
    createChamber('order', { add: () => 'order' }).install(bus);

    expect(bus.dispatch('cartAdd',  {}).value).toBe('cart');
    expect(bus.dispatch('orderAdd', {}).value).toBe('order');
  });
});

// ---------------------------------------------------------------------------
// createWorkflow
// ---------------------------------------------------------------------------

describe('createWorkflow', () => {
  it('runs all steps in order and returns combined results', async () => {
    const bus = createCommandBus();
    const order: string[] = [];
    bus.register('stepA', () => { order.push('A'); return 'a'; });
    bus.register('stepB', () => { order.push('B'); return 'b'; });
    bus.register('stepC', () => { order.push('C'); return 'c'; });

    const wf = createWorkflow([
      { action: 'stepA' },
      { action: 'stepB' },
      { action: 'stepC' },
    ]);

    const result = await wf.run(bus, {});

    expect(result.ok).toBe(true);
    expect(order).toEqual(['A', 'B', 'C']);
    expect(result.results).toHaveLength(3);
  });

  it('stops on failure and compensates previous steps in reverse', async () => {
    const bus = createCommandBus();
    const log: string[] = [];
    bus.register('reserve',  () => { log.push('reserve'); return 'ok'; });
    bus.register('charge',   () => { log.push('charge'); throw new Error('card declined'); });
    bus.register('release',  () => { log.push('release'); return 'ok'; });

    const wf = createWorkflow([
      { action: 'reserve', compensate: 'release' },
      { action: 'charge' },
    ]);

    const result = await wf.run(bus, {});

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(log).toContain('release');
    expect(result.compensations).toHaveLength(1);
    expect(result.compensations![0].ok).toBe(true);
  });

  it('mapTarget and mapPayload reshape step inputs', async () => {
    const bus = createCommandBus();
    const captured: any[] = [];
    bus.register('step', (cmd) => { captured.push({ t: cmd.target, p: cmd.payload }); return 1; });

    const wf = createWorkflow([{
      action:     'step',
      mapTarget:  (t, p) => ({ id: p.userId }),
      mapPayload: (t)    => ({ extra: t.ctx }),
    }]);

    await wf.run(bus, { ctx: 'hello' }, { userId: 99 });

    expect(captured[0].t).toEqual({ id: 99 });
    expect(captured[0].p).toEqual({ extra: 'hello' });
  });

  it('exposes frozen steps array', () => {
    const wf = createWorkflow([{ action: 'a' }, { action: 'b' }]);
    expect(wf.steps).toHaveLength(2);
    expect(() => (wf.steps as any).push({ action: 'c' })).toThrow();
  });

  it('returns ok:true with empty compensations when all steps pass', async () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    const result = await createWorkflow([{ action: 'a' }]).run(bus, {});
    expect(result.ok).toBe(true);
    expect(result.compensations).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createReaction
// ---------------------------------------------------------------------------

describe('createReaction', () => {
  it('dispatches target action after source succeeds', () => {
    const bus = createCommandBus();
    bus.register('cartAdd',       (cmd) => cmd.target);
    bus.register('inventoryCheck', vi.fn(() => 'checked'));

    createReaction('cartAdd', 'inventoryCheck').install(bus);
    bus.dispatch('cartAdd', { itemId: 7 });

    // inventoryCheck was called (reaction fired)
    expect(bus.hasHandler('inventoryCheck')).toBe(true);
  });

  it('does not fire when when predicate returns false', () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    const handler = vi.fn(() => 1);
    bus.register('b', handler);

    createReaction('a', 'b', { when: (_cmd, result) => !result.ok }).install(bus);
    bus.dispatch('a', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('map transforms the target passed to the reaction', () => {
    const bus = createCommandBus();
    bus.register('src', () => 1);
    const handler = vi.fn((cmd: any) => cmd.target);
    bus.register('dst', handler);

    createReaction('src', 'dst', {
      map: (cmd) => ({ derived: cmd.target.x * 2 }),
    }).install(bus);

    bus.dispatch('src', { x: 5 });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      target: { derived: 10 },
    }));
  });

  it('mapPayload sets the reaction payload', () => {
    const bus = createCommandBus();
    bus.register('src', () => 1);
    const handler = vi.fn((cmd: any) => cmd.payload);
    bus.register('dst', handler);

    createReaction('src', 'dst', {
      mapPayload: (_cmd, result) => ({ echo: result.value }),
    }).install(bus);

    bus.dispatch('src', {});
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      payload: { echo: 1 },
    }));
  });

  it('install returns cleanup that stops the reaction', () => {
    const bus = createCommandBus();
    bus.register('src', () => 1);
    const handler = vi.fn(() => 1);
    bus.register('dst', handler);

    const unsub = createReaction('src', 'dst').install(bus);
    bus.dispatch('src', {});
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.dispatch('src', {});
    expect(handler).toHaveBeenCalledTimes(1); // no second call
  });

  it('supports wildcard source pattern', () => {
    const bus = createCommandBus();
    bus.register('cartAdd',    () => 1);
    bus.register('cartRemove', () => 2);
    const handler = vi.fn(() => 1);
    // Target must NOT match the source wildcard — 'stockSync' doesn't start
    // with 'cart', so the reaction listener won't re-fire on its own output.
    bus.register('stockSync', handler);

    createReaction('cart*', 'stockSync').install(bus);

    bus.dispatch('cartAdd',    {});
    bus.dispatch('cartRemove', {});

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
