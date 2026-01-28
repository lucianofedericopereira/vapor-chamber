<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A lightweight command bus designed for <a href="https://github.com/vuejs/vue-vapor">Vue Vapor</a>. ~1KB core.
</p>

## What is Vue Vapor?

Vue Vapor is Vue's upcoming compilation strategy that eliminates the Virtual DOM. Instead of diffing virtual trees, Vapor compiles templates to direct DOM operations using **signals** - reactive primitives that update only what changed.

**Vapor Chamber** embraces this philosophy: minimal abstraction, direct updates, signal-native reactivity.

## Why a Command Bus?

Traditional event systems scatter logic across components. A command bus centralizes it:

```
Event-driven (scattered)          Command bus (centralized)
─────────────────────────         ─────────────────────────
Component A emits 'add'    →      dispatch('cart.add', product)
Component B listens...            ↓
Component C also listens...       Handler executes once
Who handles what? When?           Plugins observe/modify
                                  Result returned
```

**Benefits:**
- **Semantic actions** - `cart.add` is clearer than `emit('add')`
- **Single handler** - One place to look, debug, test
- **Plugin pipeline** - Cross-cutting concerns (logging, validation, analytics) without cluttering handlers
- **Undo/redo** - Command history is natural when actions are explicit

## Install

```bash
npm install vapor-chamber
```

## Quick Start

```typescript
import { createCommandBus, logger, validator } from 'vapor-chamber';

const bus = createCommandBus();

// Add plugins
bus.use(logger());
bus.use(validator({
  'cart.add': (cmd) => cmd.payload?.quantity > 0 ? null : 'Quantity required'
}));

// Register handler
bus.register('cart.add', (cmd) => {
  cart.items.push({ ...cmd.target, quantity: cmd.payload.quantity });
  return cart.items;
});

// Dispatch
const result = bus.dispatch('cart.add', product, { quantity: 2 });
if (result.ok) {
  console.log('Added:', result.value);
} else {
  console.error('Failed:', result.error);
}
```

## Core Concepts

### Commands

A command has three parts:

```typescript
bus.dispatch(
  'cart.add',      // action - what to do
  product,         // target - what to act on
  { quantity: 2 }  // payload - additional data (optional)
);
```

### Handlers

One handler per action. Returns a value or throws:

```typescript
bus.register('cart.add', (cmd) => {
  // cmd.action  = 'cart.add'
  // cmd.target  = product
  // cmd.payload = { quantity: 2 }

  cart.items.push(cmd.target);
  return cart.items; // becomes result.value
});
```

### Results

Every dispatch returns a result:

```typescript
type CommandResult = {
  ok: boolean;     // success or failure
  value?: any;     // handler return value (if ok)
  error?: Error;   // error thrown (if not ok)
};
```

### Plugins

Plugins wrap handlers. They can modify commands, short-circuit execution, observe results, or transform output:

```typescript
const timingPlugin: Plugin = (cmd, next) => {
  const start = Date.now();
  const result = next();  // call next plugin or handler
  console.log(`${cmd.action} took ${Date.now() - start}ms`);
  return result;
};

bus.use(timingPlugin);
```

Plugins execute in order: first added = outermost wrapper.

## Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `logger(options?)` | Log commands to console |
| `validator(rules)` | Validate commands before execution |
| `history(options?)` | Track command history for undo/redo |
| `debounce(actions, wait)` | Delay execution until activity stops |
| `throttle(actions, wait)` | Limit execution frequency |

### logger

```typescript
bus.use(logger({ collapsed: true, filter: (cmd) => cmd.action.startsWith('cart.') }));
```

### validator

```typescript
bus.use(validator({
  'cart.add': (cmd) => {
    if (!cmd.target?.id) return 'Product must have an ID';
    return null;  // null = valid
  }
}));
```

### history

```typescript
const historyPlugin = history({ maxSize: 100 });
bus.use(historyPlugin);

historyPlugin.undo();
historyPlugin.redo();
historyPlugin.getState(); // { past, future, canUndo, canRedo }
```

### debounce

```typescript
bus.use(debounce(['search.query'], 300)); // wait 300ms after last call
```

### throttle

```typescript
bus.use(throttle(['ui.scroll'], 100)); // max once per 100ms
```

## Async Command Bus

For async handlers (API calls, IndexedDB, etc.):

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';

const bus = createAsyncCommandBus();

bus.register('user.fetch', async (cmd) => {
  const response = await fetch(`/api/users/${cmd.target.id}`);
  return response.json();
});

const result = await bus.dispatch('user.fetch', { id: 123 });
```

## Vapor Composables

For Vue Vapor components:

### useCommand

```vue
<script setup>
import { useCommand } from 'vapor-chamber';

const { dispatch, loading, lastError } = useCommand();
</script>

<template>
  <button @click="dispatch('save', doc)" :disabled="loading.value">Save</button>
  <p v-if="lastError.value">{{ lastError.value.message }}</p>
</template>
```

### useCommandState

```vue
<script setup>
import { useCommandState } from 'vapor-chamber';

const { state: cart } = useCommandState(
  { items: [], total: 0 },
  {
    'cart.add': (state, cmd) => ({
      items: [...state.items, cmd.target],
      total: state.total + cmd.target.price
    })
  }
);
</script>
```

### useCommandHistory

```vue
<script setup>
import { useCommandHistory } from 'vapor-chamber';

const { canUndo, canRedo, undo, redo } = useCommandHistory({
  filter: (cmd) => cmd.action.startsWith('editor.')
});
</script>
```

## Examples

See the [`examples/`](./examples) folder for complete, runnable examples:

| Example | Description |
|---------|-------------|
| [`shopping-cart.ts`](./examples/shopping-cart.ts) | Cart with validation, history, and undo/redo |
| [`form-validation.ts`](./examples/form-validation.ts) | Form validation with error handling |
| [`async-api.ts`](./examples/async-api.ts) | Async handlers with retry plugin |
| [`realtime-search.ts`](./examples/realtime-search.ts) | Debounced search queries |
| [`custom-plugins.ts`](./examples/custom-plugins.ts) | Analytics, auth guard, rate limiter plugins |
| [`vue-vapor-component.vue`](./examples/vue-vapor-component.vue) | Full Vue Vapor todo app |

Run TypeScript examples with:
```bash
npx ts-node examples/shopping-cart.ts
```

## API Reference

### Core

| Function | Description |
|----------|-------------|
| `createCommandBus()` | Create a synchronous command bus |
| `createAsyncCommandBus()` | Create an async command bus |

### Command Bus Methods

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command |
| `register(action, handler)` | Register a handler (returns unregister fn) |
| `use(plugin)` | Add a plugin (returns unsubscribe fn) |
| `onAfter(hook)` | Run callback after every command |

### Composables

| Composable | Description |
|------------|-------------|
| `useCommand()` | Dispatch with reactive loading/error state |
| `useCommandState(initial, handlers)` | State managed by commands |
| `useCommandHistory(options?)` | Reactive undo/redo |
| `getCommandBus()` | Get shared bus instance |
| `setCommandBus(bus)` | Set shared bus instance |

## Documentation

See the [`docs/`](./docs) folder for detailed documentation:

- [Whitepaper](./docs/whitepaper.md) - Design philosophy and architecture

## Design Goals

1. **Minimal** - ~1KB core, no dependencies
2. **Vapor-native** - Built for signals, not VDOM
3. **Composable** - Plugins for everything
4. **Type-safe** - Full TypeScript support
5. **Predictable** - Sync by default, explicit async

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
