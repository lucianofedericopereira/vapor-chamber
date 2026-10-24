/**
 * Supplemental coverage for src/plugins-core.ts.
 *
 *  - logger badges outside a browser: the node arm of the %c styling
 *    split.
 *  - history(): undo/redo on empty stacks, self-registered trigger
 *    actions with a bus, and the DEV warning without one.
 *  - history() redo on an ASYNC bus is recorded once, for every payload
 *    shape; the sync wiring the island cart uses, and the flag keeping an
 *    undo handler's own dispatches out of the ledger, are unchanged.
 */
import { describe, expect, vi } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/index';
import { history, logger } from '../src/plugins-core';
import { stubGlobal } from '../src/vitest-pure';
import { it } from '../src/vitest';


// ---------------------------------------------------------------------------
// logger - badges in a non-browser environment
// ---------------------------------------------------------------------------

describe('logger badges (node arm)', () => {
  it('prints plain-text badges when window is absent', () => {
    const group = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.use(logger({ badges: true }));
    bus.register('ok', () => 1);
    bus.register('down', () => { throw new Error('x'); });

    bus.dispatch('ok', {});
    bus.dispatch('down', {});

    const labels = group.mock.calls.map(c => String(c[0]));
    expect(labels[0]).toBe('[  OK  ] ⚡ ok');
    expect(labels[1]).toBe('[ FAIL ] ⚡ down');
    // Node arm: no %c styling directives.
    expect(labels.every(l => !l.includes('%c'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// history - empty stacks + trigger actions
// ---------------------------------------------------------------------------

describe('history', () => {
  it('undo/redo on empty stacks return undefined without side effects', ({ bus }) => {
    const h = history({ bus });
    expect(h.undo()).toBeUndefined();
    expect(h.redo()).toBeUndefined();
    expect(h.getState().canUndo).toBe(false);
    expect(h.getState().canRedo).toBe(false);
  });

  it('registers undo/redo trigger actions on the bus', ({ bus }) => {
    const calls: string[] = [];
    bus.register('act', () => { calls.push('do'); return 1; }, { undo: () => { calls.push('undo'); } });

    const h = history({ bus, undoAction: 'historyUndo', redoAction: 'historyRedo' });

    bus.dispatch('act', {});
    expect(h.getState().canUndo).toBe(true);

    // Dispatching the trigger actions drives the api - that's the wiring 213-214 adds.
    bus.dispatch('historyUndo', {});
    expect(calls).toEqual(['do', 'undo']);
    expect(h.getState().canRedo).toBe(true);

    bus.dispatch('historyRedo', {});
    expect(calls).toEqual(['do', 'undo', 'do']);
  });
});

// ---------------------------------------------------------------------------
// The optional-shape arms: one trigger without the other.
// ---------------------------------------------------------------------------

describe('history - optional-shape arms', () => {
  it('registers only the trigger that was configured', ({ bus }) => {
    // The wiring test above supplies BOTH undoAction and redoAction, so each
    // `if` only ever ran its true arm. Configuring one alone is the ordinary
    // case for an app that exposes undo but not redo.
    const calls: string[] = [];
    bus.register('act', () => { calls.push('do'); return 1; }, { undo: () => { calls.push('undo'); } });

    const h = history({ bus, undoAction: 'historyUndo' }); // no redoAction

    bus.dispatch('act', {});
    bus.dispatch('historyUndo', {});
    expect(calls).toEqual(['do', 'undo']);
    // The trigger that was never configured is not a registered command.
    //
    // `hasHandler`, a real accessor: an optional call on a method the bus does
    // not have would read `undefined` and let the assertion pass for any code.
    expect(bus.hasHandler('historyRedo')).toBe(false);
    // ...and the configured one IS registered, so the line above is reading a
    // real difference rather than a bus with nothing on it.
    expect(bus.hasHandler('historyUndo')).toBe(true);

    // ...and the mirror: redo only.
    const bus2 = createCommandBus();
    const calls2: string[] = [];
    bus2.register('act', () => { calls2.push('do'); return 1; }, { undo: () => { calls2.push('undo'); } });
    const h2 = history({ bus: bus2, redoAction: 'historyRedo' }); // no undoAction
    bus2.dispatch('act', {});
    h2.undo();
    bus2.dispatch('historyRedo', {});
    expect(calls2).toEqual(['do', 'undo', 'do']);
  });

});

// ---------------------------------------------------------------------------
// Cheap remaining arms: the browser badge colour.
// ---------------------------------------------------------------------------

describe('logger badges in a browser-ish environment', () => {
  it('uses the FAIL colour for a failed command', () => {
    // The `ok ? '#2a6' : '#c33'` ternary. The browser branch is only taken when
    // `window` exists, and the file's other logger tests run without one - so
    // the failure colour had never been produced. logger() writes through
    // console.groupCollapsed, so that is what gets spied.
    using _window = stubGlobal('window', {});
    const calls: unknown[][] = [];
    vi.spyOn(console, 'groupCollapsed').mockImplementation((...args: unknown[]) => { calls.push(args); });
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const bus = createCommandBus();
    bus.register('fine', () => 'ok');
    bus.register('boom', () => { throw new Error('nope'); });
    bus.use(logger({ badges: true }));

    bus.dispatch('fine', {});
    bus.dispatch('boom', {});

    const styles = calls.map((c) => String(c[1] ?? ''));
    expect(styles.some((s) => s.includes('#2a6'))).toBe(true); // OK green
    expect(styles.some((s) => s.includes('#c33'))).toBe(true); // FAIL red
  });
});

// ---------------------------------------------------------------------------
// history on an ASYNC bus - a redo is recorded once
// ---------------------------------------------------------------------------

describe('history - redo on an async bus', () => {
  // redo() set `_replaying`, dispatched, and cleared it in `finally`. On an
  // async bus the recorder runs when the dispatch SETTLES - a microtask after
  // that `finally` - so the redone command was pushed a second time and
  // `future.length = 0` wiped the rest of the redo stack. The number payload
  // is why the marker rides on the dispatch (`_withOrigin`), not in the
  // payload: a primitive has nowhere to carry a key.
  it.each([
    ['an object payload', { qty: 1 }],
    ['a number payload', 5],
  ])('records the redone command once, with %s', async (_label, payload) => {
    const bus = createAsyncCommandBus();
    bus.register('add', async () => 'ok');
    const h = history({ bus: bus as any });

    await bus.dispatch('add', { id: 1 }, payload);
    await bus.dispatch('add', { id: 2 }, payload);
    h.undo();
    h.undo();
    const redone = h.redo();
    await new Promise((r) => setTimeout(r, 0)); // the redo's dispatch settles

    expect(redone?.target).toEqual({ id: 1 });
    expect(h.getState().past.map((c) => c.target)).toEqual([{ id: 1 }]);
    expect(h.getState().future.map((c) => c.target)).toEqual([{ id: 2 }]);
    expect(h.redo()?.target).toEqual({ id: 2 }); // the redo stack survived
  });
});

describe('history - sync behaviour the async redo fix must not move', () => {
  it('island-cart wiring: count, canUndo and canRedo after every cart command', () => {
    // A hand-wired history on the sync bus: triggers registered by history()
    // itself, a scope on the one undoable command, and a cart* listener reading
    // getState(). The listener also sees the cartAdd a redo re-dispatches from
    // inside the cartRedo handler.
    const bus = createCommandBus();
    const cart = { count: 0 };
    const h = history({ maxSize: 50, bus, actions: ['cartAdd'], undoAction: 'cartUndo', redoAction: 'cartRedo' });
    bus.register('cartAdd', () => { cart.count += 1; }, { undo: () => { cart.count -= 1; } });
    const seen: Array<[string, number, boolean, boolean]> = [];
    bus.on('cart*', (cmd) => { const s = h.getState(); seen.push([cmd.action, cart.count, s.canUndo, s.canRedo]); });

    bus.dispatch('cartAdd', { id: 1 });
    bus.dispatch('cartAdd', { id: 2 });
    bus.dispatch('cartUndo', {});
    bus.dispatch('cartRedo', {});
    bus.dispatch('cartUndo', {});
    bus.dispatch('cartUndo', {});
    bus.dispatch('cartRedo', {});

    expect(seen).toEqual([
      ['cartAdd', 1, true, false],
      ['cartAdd', 2, true, false],
      ['cartAdd$undo', 1, true, true], // the undo, a command (s35.114)
      ['cartUndo', 1, true, true],
      ['cartAdd', 2, true, false], // re-dispatched by the redo
      ['cartRedo', 2, true, false],
      ['cartAdd$undo', 1, true, true],
      ['cartUndo', 1, true, true],
      ['cartAdd$undo', 0, false, true],
      ['cartUndo', 0, false, true],
      ['cartAdd', 1, true, true], // re-dispatched by the redo
      ['cartRedo', 1, true, true],
    ]);
    expect(h.getState().past).toHaveLength(1);
  });

  it('a command an undo handler dispatches is not recorded (the rollback stays out of the ledger)', () => {
    // Why `_replaying` stays beside the origin marker: on the sync bus it
    // brackets the undo handler, so a compensating command the handler
    // dispatches is part of the rollback, not a new entry. Recording it would
    // push it onto the undo stack and wipe the redo stack.
    const bus = createCommandBus();
    const h = history({ bus });
    bus.register('refund', () => 'refunded');
    bus.register('pay', () => 'paid', { undo: () => { bus.dispatch('refund', {}); } });

    bus.dispatch('pay', {});
    h.undo();

    expect(h.getState().past).toHaveLength(0);
    expect(h.getState().future.map((c) => c.action)).toEqual(['pay']);
    expect(h.getState().canRedo).toBe(true);
  });

  it("a command stamped origin 'sync' is not recorded; a plain one is", ({ bus }) => {
    const h = history({ bus });
    bus.register('cartAdd', () => 1);
    bus.dispatch('cartAdd', {}, { __origin: 'sync' });
    bus.dispatch('cartAdd', {});
    expect(h.getState().past.map((c) => c.meta?.origin)).toEqual([undefined]);
  });
});
