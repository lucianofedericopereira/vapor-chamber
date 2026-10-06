/** Redo of a store step writes the state it recorded, not a second run of the reducer (plan 1.27 item 1, R5). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createCommandBus, type Command } from '../src/command-bus';
import { history } from '../src/plugins-core';
import { defineChamberStore } from '../src/store';

type Todos = { items: Array<{ id: number; text: string }> };
let minted = 0;
const reducers = {
  add: (s: Todos, text: string) => ({ items: [...s.items, { id: ++minted, text }] }),
  touch: (s: Todos) => ({ items: [...s.items] }),
};
const useTodos = defineChamberStore('todos', { state: (): Todos => ({ items: [] }), reducers, undo: true });

function setup(filter?: (cmd: Command) => boolean) {
  const bus = createCommandBus();
  const h = history({ bus, filter });
  bus.use(h);
  const todos = useTodos(bus);
  return { bus, h, todos };
}

describe('redo of a store step', () => {
  it('restores the very state the action produced: same object, same ids', () => {
    const { h, todos } = setup();
    todos.add('milk');
    const produced = todos.state.value;
    h.undo();
    h.redo();
    expect(todos.state.value).toBe(produced);
    todos.$dispose();
  });

  it('does not run the reducer again', () => {
    const { h, todos } = setup();
    todos.add('milk');
    const before = minted;
    h.undo();
    h.redo();
    expect(minted).toBe(before);
    todos.$dispose();
  });

  it('restores a $reset the same way', () => {
    const { h, todos } = setup();
    todos.add('milk');
    todos.$reset();
    const produced = todos.state.value;
    h.undo();
    h.redo();
    expect(todos.state.value).toBe(produced);
    todos.$dispose();
  });

  it('control: listeners still hear the redo as the action, origin redo', () => {
    const { bus, h, todos } = setup();
    const heard: Array<[string, string | undefined]> = [];
    bus.on('todos*', (cmd) => { heard.push([cmd.action, cmd.meta?.origin]); });
    todos.add('milk');
    h.undo();
    h.redo();
    expect(heard).toEqual([['todosAdd', undefined], ['todosAdd$undo', 'undo'], ['todosAdd', 'redo']]);
    todos.$dispose();
  });

  it('control: after a change history did not record, redo runs the reducer', () => {
    const { h, todos } = setup((cmd) => cmd.action !== 'todosTouch');
    todos.add('milk');
    h.undo();
    todos.touch();
    const before = minted;
    h.redo();
    expect(minted).toBe(before + 1);
    expect(todos.state.value.items.map((t) => t.text)).toEqual(['milk']);
    todos.$dispose();
  });

  it('undo, redo, undo, redo goes back and forth on the same two states', () => {
    const { h, todos } = setup();
    todos.add('milk');
    const produced = todos.state.value;
    h.undo();
    const empty = todos.state.value;
    h.redo();
    h.undo();
    expect(todos.state.value).toBe(empty);
    h.redo();
    expect(todos.state.value).toBe(produced);
    todos.$dispose();
  });
});

/*
 * Before this, redo re-dispatched the action (`ledger.ts`, origin 'redo') and
 * the handler ran the reducer again. A reducer that mints a value (an id, a
 * time) brought the item back with a new one: a new key, a remounted row
 * (plan 1.27 item 1, the repo's own Vue todo example until s35.149).
 *
 * Now the redo is still the same command, so plugins, listeners, persist and
 * devtools hear what they heard. Inside the store's handler, when the step
 * being redone is the last one undone and the state is still the one that
 * undo restored, the handler writes the state the step recorded (Memento).
 * If anything moved the state since the undo, the precondition fails and the
 * reducer runs, as before.
 */
