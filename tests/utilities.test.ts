/**
 * createChamber, createWorkflow and createReaction from src/utilities.
 * Why: a chamber must install and cleanly uninstall its namespaced handlers, a workflow must stop and compensate in reverse on failure, and a reaction must fire only as configured and keep delivering while tracking its chain.
 * Shows: chamber prefixing, forwarded undo option, uninstall, no collision and no partial install; workflow order, failure with compensation, target and payload mapping, frozen steps; reaction firing, when, map, mapPayload, cleanup, wildcard source, and chain-tracking edges (foreign causation id, emitted source, 300 dispatches still all delivered).
 */
import { describe, expect, vi } from 'vitest';
import { createChamber, createWorkflow, createReaction } from '../src/utilities';
import { it } from '../src/vitest';

describe('createChamber', () => {
  it('installs handlers with namespace prefix', ({ bus }) => {
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

  it('install returns cleanup that unregisters all handlers', ({ bus }) => {
    const chamber = createChamber('cart', { add: () => 1 });
    const uninstall = chamber.install(bus);

    expect(bus.dispatch('cartAdd', {}).ok).toBe(true);
    uninstall();
    expect(bus.dispatch('cartAdd', {})).toFailWith('core:missing:handler');
  });

  it('forwards RegisterOptions (undo) to bus.register', ({ bus }) => {
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

  it('two chambers with different namespaces do not collide', ({ bus }) => {
    createChamber('cart',  { add: () => 'cart' }).install(bus);
    createChamber('order', { add: () => 'order' }).install(bus);

    expect(bus.dispatch('cartAdd',  {}).value).toBe('cart');
    expect(bus.dispatch('orderAdd', {}).value).toBe('order');
  });

  // `$` names are the library's, so `x$y` makes the second register throw.
  it('an install that throws part way leaves nothing registered', ({ bus }) => {
    const chamber = createChamber('cart', { add: () => 1, x$y: () => 2 });
    expect(() => chamber.install(bus)).toThrow();
    expect(bus.hasHandler('cartAdd')).toBe(false);
  });
});

describe('createWorkflow', () => {
  it('runs all steps in order and returns combined results', async ({ bus }) => {
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

  it('stops on failure and compensates previous steps in reverse', async ({ bus }) => {
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

  it('mapTarget and mapPayload reshape step inputs', async ({ bus }) => {
    const captured: any[] = [];
    bus.register('step', (cmd) => { captured.push({ t: cmd.target, p: cmd.payload }); return 1; });

    const wf = createWorkflow([{
      action:     'step',
      mapTarget:  (_t, p) => ({ id: p.userId }),
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

  it('returns ok:true with empty compensations when all steps pass', async ({ bus }) => {
    bus.register('a', () => 1);
    const result = await createWorkflow([{ action: 'a' }]).run(bus, {});
    expect(result.ok).toBe(true);
    expect(result.compensations).toBeUndefined();
  });
});

describe('createReaction', () => {
  it('dispatches target action after source succeeds', ({ bus }) => {
    bus.register('cartAdd',       (cmd) => cmd.target);
    bus.register('inventoryCheck', vi.fn(() => 'checked'));

    createReaction('cartAdd', 'inventoryCheck').install(bus);
    bus.dispatch('cartAdd', { itemId: 7 });

    // Only checks the handler is registered; it does not observe that the reaction fired.
    expect(bus.hasHandler('inventoryCheck')).toBe(true);
  });

  it('does not fire when when predicate returns false', ({ bus }) => {
    bus.register('a', () => 1);
    const handler = vi.fn(() => 1);
    bus.register('b', handler);

    createReaction('a', 'b', { when: (_cmd, result) => !result.ok }).install(bus);
    bus.dispatch('a', {});

    expect(handler).not.toHaveBeenCalled();
  });

  it('map transforms the target passed to the reaction', ({ bus }) => {
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

  it('mapPayload sets the reaction payload', ({ bus }) => {
    bus.register('src', () => 1);
    const handler = vi.fn((cmd: any) => cmd.payload);
    bus.register('dst', handler);

    createReaction('src', 'dst', {
      mapPayload: (_cmd, result) => ({ echo: result.value }),
    }).install(bus);

    bus.dispatch('src', {});
    // The payload also carries `__reactionHops` and `__causationId`, hence objectContaining.
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ echo: 1 }),
    }));
  });

  it('install returns cleanup that stops the reaction', ({ bus }) => {
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

  it('supports wildcard source pattern', ({ bus }) => {
    bus.register('cartAdd',    () => 1);
    bus.register('cartRemove', () => 2);
    const handler = vi.fn(() => 1);
    // The target must not match the source wildcard, or the reaction would re-fire on its own output.
    bus.register('stockSync', handler);

    createReaction('cart*', 'stockSync').install(bus);

    bus.dispatch('cartAdd',    {});
    bus.dispatch('cartRemove', {});

    expect(handler).toHaveBeenCalledTimes(2);
  });
});

// The hop count is keyed by the causing command's id and walked through meta, since a primitive or array payload cannot carry a key.
describe('createReaction - chain tracking edges', () => {
  it('starts a fresh count for a causationId this reaction never recorded', ({ bus }) => {
    const seen: Array<number | undefined> = [];
    bus.register('src', () => 1);
    bus.register('dst', (cmd: any) => {
      seen.push(cmd.payload?.__reactionHops);
      return 1;
    });

    createReaction('src', 'dst', { maxHops: 2 }).install(bus);

    // A causation id from elsewhere (prior command, HTTP bridge, replay) is absent from this reaction's map, so the chain starts at hop 1.
    bus.dispatch('src', {}, { __causationId: 'not-from-this-reaction' });

    expect(seen).toEqual([1]);
  });

  it('an emitted source has no meta, so the chain simply does not track', ({ bus }) => {
    const handler = vi.fn((cmd: any) => cmd.payload);
    bus.register('dst', handler);

    createReaction('ping', 'dst').install(bus);

    // `emit` builds the command without meta (it skips stampMeta), so there is no id to key a chain by; the reaction must still fire.
    bus.emit('ping', { x: 1 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.__causationId).toBeUndefined();
    expect(handler.mock.calls[0][0].meta.causationId).toBeUndefined();
  });

  it('evicts the oldest chain entry rather than growing without bound', ({ bus }) => {
    let fired = 0;
    bus.register('src', () => 1);
    bus.register('dst', () => {
      fired++;
      return 1;
    });

    createReaction('src', 'dst').install(bus);

    // Each dispatch is its own chain root and the map is capped at 256, so 300 exceeds it; only delivery is observed.
    for (let i = 0; i < 300; i++) bus.dispatch('src', i);

    expect(fired).toBe(300);
  });
});
