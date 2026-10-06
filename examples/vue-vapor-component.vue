<!--
  Vue Vapor Component Example

  Demonstrates: a store with undo (defineChamberStore + useCommandHistory), a
  validator on its command, and the composables' results read in a template.

  Works in Vapor (`<script setup vapor>` with Vue 3.6+) and VDOM alike - only
  the script attribute differs between the two modes.

  Templates unwrap TOP-LEVEL refs, so a composable's result is kept as an
  object here (`cmd.loading.value`, `hist.canUndo.value`): a nested `.value`
  is the same at runtime and for vue-tsc.
-->

<script setup lang="ts">
import { computed, ref } from 'vue';
// The bus and its plugins need no Vue, so they come from the package root.
import { getCommandBus, validator } from 'vapor-chamber';
// The composables come from the Vue entry, which wires Vue at build time.
import { useCommand, useCommandHistory } from 'vapor-chamber/vue';
import { defineChamberStore } from 'vapor-chamber/store';

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

// The todos are a store: every change is a command (`todoAdd`, ...), and with
// `undo: true` each one can be undone through the history below. The new
// todo's id is minted where the command is sent (addTodo) and arrives as its
// payload: a redo dispatches the same command again, so the todo comes back
// with the same id (a key the list keeps), where an id minted inside the
// reducer would be a new one.
const useTodos = defineChamberStore('todo', {
  state: () => ({ items: [] as Todo[] }),
  reducers: {
    add: (s, text: string, p: { id: number }) => ({ items: [...s.items, { id: p.id, text, done: false }] }),
    toggle: (s, id: number) => ({ items: s.items.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) }),
    remove: (s, id: number) => ({ items: s.items.filter((t) => t.id !== id) }),
    clearCompleted: (s) => ({ items: s.items.filter((t) => !t.done) }),
  },
  undo: true,
});

const bus = getCommandBus();
bus.use(validator({
  todoAdd: (cmd) => (String(cmd.target ?? '').trim() ? null : 'Todo text cannot be empty'),
}));

const todos = useTodos(bus);
const cmd = useCommand();
const hist = useCommandHistory({ filter: (c) => c.action.startsWith('todo') });

// The filter is the view's own state, not the store's: a store write the
// history does not record would leave the last step not undoable (canUndo).
const filter = ref<'all' | 'active' | 'completed'>('all');
const newTodoText = ref('');

const visible = computed(() => {
  const items = todos.state.value.items;
  if (filter.value === 'active') return items.filter((t) => !t.done);
  if (filter.value === 'completed') return items.filter((t) => t.done);
  return items;
});
const stats = computed(() => {
  const items = todos.state.value.items;
  const active = items.filter((t) => !t.done).length;
  return { total: items.length, active, completed: items.length - active };
});

function addTodo() {
  // Dispatched through useCommand, so its loading and lastError track it.
  const result = cmd.dispatch('todoAdd', newTodoText.value.trim(), { id: Date.now() });
  if (!(result instanceof Promise) && result.ok) newTodoText.value = '';
}
</script>

<template>
  <div class="todo-app">
    <h1>Todo App</h1>

    <!-- A labelled input (a placeholder is not a label), and aria-disabled
         rather than disabled on buttons that can become unavailable while
         focused: `disabled` would send keyboard focus to <body>. -->
    <form @submit.prevent="addTodo" class="add-form">
      <label for="new-todo" class="visually-hidden">New todo</label>
      <input id="new-todo" v-model="newTodoText" placeholder="What needs to be done?" />
      <button type="submit" :aria-disabled="cmd.loading.value || !newTodoText.trim()">Add</button>
    </form>

    <!-- A live region, so the failure is heard -->
    <p class="error" role="alert">{{ cmd.lastError.value?.message }}</p>

    <div class="controls">
      <button @click="hist.canUndo.value && hist.undo()" :aria-disabled="!hist.canUndo.value">Undo</button>
      <button @click="hist.canRedo.value && hist.redo()" :aria-disabled="!hist.canRedo.value">Redo</button>
    </div>

    <div class="filters">
      <button @click="filter = 'all'" :class="{ active: filter === 'all' }" :aria-pressed="filter === 'all'">
        All ({{ stats.total }})
      </button>
      <button @click="filter = 'active'" :class="{ active: filter === 'active' }" :aria-pressed="filter === 'active'">
        Active ({{ stats.active }})
      </button>
      <button @click="filter = 'completed'" :class="{ active: filter === 'completed' }" :aria-pressed="filter === 'completed'">
        Completed ({{ stats.completed }})
      </button>
    </div>

    <ul class="todo-list">
      <li v-for="todo in visible" :key="todo.id" :class="{ done: todo.done }">
        <label>
          <input type="checkbox" :checked="todo.done" @change="todos.toggle(todo.id)" />
          {{ todo.text }}
        </label>
        <button @click="todos.remove(todo.id)" class="remove" :aria-label="`Remove ${todo.text}`">&times;</button>
      </li>
    </ul>

    <button v-if="stats.completed > 0" @click="todos.clearCompleted()" class="clear-completed">
      Clear completed ({{ stats.completed }})
    </button>
  </div>
</template>

<style scoped>
.visually-hidden {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

[aria-disabled="true"] { opacity: .5; cursor: not-allowed; }

.todo-app {
  max-width: 500px;
  margin: 0 auto;
  padding: 20px;
  font-family: system-ui, sans-serif;
}

.add-form {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.add-form input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.controls {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.filters {
  display: flex;
  gap: 4px;
  margin-bottom: 16px;
}

.filters button {
  padding: 4px 12px;
  border: 1px solid #ddd;
  background: white;
  border-radius: 4px;
  cursor: pointer;
}

.filters button.active {
  background: #007bff;
  color: white;
  border-color: #007bff;
}

.todo-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.todo-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid #eee;
}

.todo-list li.done label {
  text-decoration: line-through;
  color: #6b6b6b; /* 5.3:1 on white - greyed but readable */
}

.todo-list li label {
  flex: 1;
}

.remove {
  background: none;
  border: none;
  color: #dc3545;
  font-size: 20px;
  cursor: pointer;
  padding: 0 8px;
}

.clear-completed {
  margin-top: 16px;
  color: #666;
  background: none;
  border: 1px solid #ddd;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}

.error {
  color: #dc3545;
  padding: 8px;
  background: #ffe6e6;
  border-radius: 4px;
  margin-bottom: 16px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
