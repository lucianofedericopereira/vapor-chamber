/**
 * useCommandHistory moves its stacks only after an undo or redo lands.
 *
 * Moving them first without looking at the outcome would, on an async bus,
 * leave an undo the server refused reading "undone": the command no longer
 * undoable, and a redo offered for a change that never happened. That is a correctness defect and an accessibility one (WCAG
 * 3.3.4 asks that a submission be reversible; a history that lies about what
 * was reversed defeats it, most of all for a screen-reader user, who cannot
 * see that nothing changed). docs/plan-failures-and-contract.md, 2.1 and 8e.
 *
 * The API does not change: undo() and redo() still return the command at
 * once. An undo handler that returns a promise is awaited; one that returns
 * nothing (a local, synchronous undo) moves the stacks at once, as before.
 */
import { expect } from 'vitest';
import { setCommandBus, useCommandHistory } from '../src/chamber';
import type { CommandResult } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { it } from '../src/vitest';

const settle = () => new Promise((r) => setTimeout(r, 0));
const refused: CommandResult = { ok: false, value: undefined, error: new Error('refused by the server') };

it('an undo the server refuses leaves the history as it was', async ({ asyncBus: bus }) => {
  setCommandBus(bus);
  bus.register('rename', async () => 'renamed', { undo: async () => refused });
  const h = useCommandHistory();
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });

  h.undo();
  await settle();
  expect(h.past.value).toHaveLength(1);
  expect(h.future.value).toHaveLength(0);
  expect(h.canUndo.value).toBe(true);
  expect(h.canRedo.value).toBe(false);
});

it('an undo handler that rejects leaves the history as it was', async ({ asyncBus: bus }) => {
  setCommandBus(bus);
  bus.register('rename', async () => 'renamed', { undo: async () => { throw new Error('network down'); } });
  const h = useCommandHistory();
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });

  h.undo();
  await settle();
  expect(h.past.value).toHaveLength(1);
  expect(h.canRedo.value).toBe(false);
});

it('an undo that lands moves the command to the redo stack', async ({ asyncBus: bus }) => {
  setCommandBus(bus);
  bus.register('rename', async () => 'renamed', { undo: async () => ({ ok: true, value: 'A' }) });
  const h = useCommandHistory();
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });

  const cmd = h.undo();
  expect(cmd?.action).toBe('rename'); // still returned at once
  await settle();
  expect(h.past.value).toHaveLength(0);
  expect(h.future.value).toHaveLength(1);
  expect(h.canRedo.value).toBe(true);
});

it('a synchronous undo handler moves the stacks at once, as before', ({ bus }) => {
  setCommandBus(bus);
  let undone = false;
  bus.register('rename', () => 'renamed', { undo: () => { undone = true; } });
  const h = useCommandHistory();
  bus.dispatch('rename', { id: 1 }, { to: 'B' });

  h.undo();
  expect(undone).toBe(true);
  expect(h.past.value).toHaveLength(0);
  expect(h.future.value).toHaveLength(1);
});

it('a redo the server refuses stays on the redo stack', async ({ asyncBus: bus }) => {
  setCommandBus(bus);
  let refuseRedo = false;
  bus.register('rename', async () => {
    if (refuseRedo) throw new Error('conflict');
    return 'renamed';
  }, { undo: async () => ({ ok: true, value: 'A' }) });
  const h = useCommandHistory();
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });
  h.undo();
  await settle();

  refuseRedo = true;
  h.redo();
  await settle();
  expect(h.future.value).toHaveLength(1);
  expect(h.past.value).toHaveLength(0);
  expect(h.canRedo.value).toBe(true);
});

it('a second press while an undo is pending does nothing', async ({ asyncBus: bus }) => {
  setCommandBus(bus);
  let release!: () => void;
  bus.register('rename', async () => 'renamed', {
    undo: () => new Promise<CommandResult>((r) => { release = () => r({ ok: true, value: 'A' }); }),
  });
  const h = useCommandHistory();
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });
  await bus.dispatch('rename', { id: 2 }, { to: 'C' });

  h.undo();
  expect(h.undo()).toBeUndefined(); // ignored while the first is in flight
  release();
  await settle();
  expect(h.past.value).toHaveLength(1);
  expect(h.future.value).toHaveLength(1);
});

// The history() PLUGIN had its own undo/redo with the same defect: one concept,
// two implementations. Both now share one ledger (src/ledger.ts), which moves
// the stacks first and back if the call is refused (settled.ts, moveUnlessRefused).
it('history() plugin: an undo the server refuses leaves its state as it was', async ({ asyncBus: bus }) => {
  const h = history({ bus });
  bus.use(h);
  bus.register('rename', async () => 'renamed', { undo: async () => refused });
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });

  h.undo();
  await settle();
  expect(h.getState()).toMatchObject({ canUndo: true, canRedo: false });
});

it('history() plugin: a redo the server refuses stays redoable', async ({ asyncBus: bus }) => {
  const h = history({ bus });
  bus.use(h);
  let refuseRedo = false;
  bus.register('rename', async () => {
    if (refuseRedo) throw new Error('conflict');
    return 'renamed';
  }, { undo: async () => ({ ok: true, value: 'A' }) });
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });
  h.undo();
  await settle();
  expect(h.getState()).toMatchObject({ canUndo: false, canRedo: true });

  refuseRedo = true;
  h.redo();
  await settle();
  expect(h.getState()).toMatchObject({ canUndo: false, canRedo: true });
});

it('a synchronous undo handler that refuses leaves the history as it was', ({ bus }) => {
  setCommandBus(bus);
  bus.register('rename', () => 'renamed', { undo: () => refused });
  const h = useCommandHistory();
  bus.dispatch('rename', { id: 1 }, { to: 'B' });

  h.undo();
  expect(h.past.value).toHaveLength(1);
  expect(h.future.value).toHaveLength(0);
});

it('a history cleared while an undo is in flight stays cleared when the undo is refused', async ({ asyncBus: bus }) => {
  setCommandBus(bus);
  let refuse!: (r: CommandResult) => void;
  bus.register('rename', async () => 'renamed', { undo: () => new Promise<CommandResult>((r) => { refuse = r; }) });
  const h = useCommandHistory();
  await bus.dispatch('rename', { id: 1 }, { to: 'B' });

  h.undo();
  h.clear();
  refuse(refused);
  await settle();
  // The refusal moves the command back only if it is still where the undo
  // put it; clear() emptied both stacks, so nothing comes back.
  expect(h.past.value).toHaveLength(0);
  expect(h.future.value).toHaveLength(0);
  expect(h.canUndo.value).toBe(false);
});
