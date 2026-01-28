<!--
  Vue Vapor Component Example

  Demonstrates: useCommand, useCommandState, useCommandHistory composables

  Note: This example shows the expected API when Vue Vapor is released.
  The composables use Vapor's signal-based reactivity.
-->

<script setup lang="ts">
import {
  useCommand,
  useCommandState,
  useCommandHistory,
  getCommandBus,
  validator
} from '../src';

// Get shared bus and add validation
const bus = getCommandBus();
bus.use(validator({
  'todo.add': (cmd) => {
    if (!cmd.target?.trim()) return 'Todo text cannot be empty';
    return null;
  }
}));

// Dispatch with loading/error state
const { dispatch, loading, lastError } = useCommand();

// Todo interface
interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoState {
  items: Todo[];
  filter: 'all' | 'active' | 'completed';
}

// Reactive state managed by commands
const { state: todos } = useCommandState<TodoState>(
  { items: [], filter: 'all' },
  {
    'todo.add': (state, cmd) => ({
      ...state,
      items: [...state.items, {
        id: Date.now(),
        text: cmd.target as string,
        done: false
      }]
    }),

    'todo.toggle': (state, cmd) => ({
      ...state,
      items: state.items.map(t =>
        t.id === cmd.target ? { ...t, done: !t.done } : t
      )
    }),

    'todo.remove': (state, cmd) => ({
      ...state,
      items: state.items.filter(t => t.id !== cmd.target)
    }),

    'todo.clear-completed': (state) => ({
      ...state,
      items: state.items.filter(t => !t.done)
    }),

    'todo.filter': (state, cmd) => ({
      ...state,
      filter: cmd.target as TodoState['filter']
    })
  }
);

// Undo/redo for todo actions
const { canUndo, canRedo, undo, redo } = useCommandHistory({
  filter: (cmd) => cmd.action.startsWith('todo.') && cmd.action !== 'todo.filter'
});

// Computed filtered items
function getFilteredItems() {
  const { items, filter } = todos.value;
  switch (filter) {
    case 'active': return items.filter(t => !t.done);
    case 'completed': return items.filter(t => t.done);
    default: return items;
  }
}

// Form state
let newTodoText = '';

// Actions
function addTodo() {
  if (!newTodoText.trim()) return;

  const result = dispatch('todo.add', newTodoText.trim());
  if (result.ok) {
    newTodoText = '';
  }
}

function toggleTodo(id: number) {
  dispatch('todo.toggle', id);
}

function removeTodo(id: number) {
  dispatch('todo.remove', id);
}

function clearCompleted() {
  dispatch('todo.clear-completed', null);
}

function setFilter(filter: TodoState['filter']) {
  dispatch('todo.filter', filter);
}

// Stats
function getStats() {
  const items = todos.value.items;
  return {
    total: items.length,
    active: items.filter(t => !t.done).length,
    completed: items.filter(t => t.done).length
  };
}
</script>

<template>
  <div class="todo-app">
    <h1>Todo App</h1>

    <!-- Add form -->
    <form @submit.prevent="addTodo" class="add-form">
      <input
        v-model="newTodoText"
        placeholder="What needs to be done?"
        :disabled="loading.value"
      />
      <button type="submit" :disabled="loading.value || !newTodoText.trim()">
        Add
      </button>
    </form>

    <!-- Error display -->
    <p v-if="lastError.value" class="error">
      {{ lastError.value.message }}
    </p>

    <!-- Undo/Redo controls -->
    <div class="controls">
      <button @click="undo" :disabled="!canUndo.value">
        Undo
      </button>
      <button @click="redo" :disabled="!canRedo.value">
        Redo
      </button>
    </div>

    <!-- Filter tabs -->
    <div class="filters">
      <button
        @click="setFilter('all')"
        :class="{ active: todos.value.filter === 'all' }"
      >
        All ({{ getStats().total }})
      </button>
      <button
        @click="setFilter('active')"
        :class="{ active: todos.value.filter === 'active' }"
      >
        Active ({{ getStats().active }})
      </button>
      <button
        @click="setFilter('completed')"
        :class="{ active: todos.value.filter === 'completed' }"
      >
        Completed ({{ getStats().completed }})
      </button>
    </div>

    <!-- Todo list -->
    <ul class="todo-list">
      <li
        v-for="todo in getFilteredItems()"
        :key="todo.id"
        :class="{ done: todo.done }"
      >
        <input
          type="checkbox"
          :checked="todo.done"
          @change="toggleTodo(todo.id)"
        />
        <span>{{ todo.text }}</span>
        <button @click="removeTodo(todo.id)" class="remove">
          &times;
        </button>
      </li>
    </ul>

    <!-- Clear completed -->
    <button
      v-if="getStats().completed > 0"
      @click="clearCompleted"
      class="clear-completed"
    >
      Clear completed ({{ getStats().completed }})
    </button>
  </div>
</template>

<style scoped>
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

.todo-list li.done span {
  text-decoration: line-through;
  color: #888;
}

.todo-list li span {
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
