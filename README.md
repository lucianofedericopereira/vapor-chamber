<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A lightweight command bus designed for <a href="https://github.com/vuejs/vue-vapor">Vue Vapor</a>. ~2KB gzipped. Optional DevTools integration.
</p>

## What is Vue Vapor?

Vue Vapor is Vue's upcoming compilation strategy that eliminates the Virtual DOM. Instead of diffing virtual trees, Vapor compiles templates to direct DOM operations using **signals** - reactive primitives that update only what changed.

**Vapor Chamber** embraces this philosophy: minimal abstraction, direct updates, signal-native reactivity.

## Migrating from Vue 3 emitters

If you're already using Vue 3's `emit` / `eventBus` pattern, here's the before and after:

```
// Before — Vue 3 emitter
// cart.vue
emit('cart:add', product);

// App.vue
bus.on('cart:add', (product) => {
  cart.items.push(product);
  analytics.track('add');
  validate(product);  // where does this live?
});

// ProductList.vue — also listens?
bus.on('cart:add', updateBadge);  // now two handlers, hard to trace
```

```
// After — Vapor Chamber
// Anywhere in the app
bus.dispatch('cart.add', product, { quantity: 1 });

// One place, once:
bus.register('cart.add', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items;
});

// Cross-cutting concerns as plugins, not scattered listeners:
bus.use(logger());
bus.use(validator({ 'cart.add': (cmd) => cmd.target.id ? null : 'Missing ID' }));
bus.use(analyticsPlugin);
```

**The key difference:** `emit` is fire-and-forget with many listeners. `dispatch` has one handler and a composable plugin pipeline — one place to look, debug, and test.

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

Plugins execute by priority (highest first), then registration order for equal priorities:

```typescript
bus.use(validatorPlugin, { priority: 10 }); // runs first
bus.use(analyticsPlugin, { priority: 1 });  // runs after validation
bus.use(loggerPlugin);                       // priority 0 (default, runs last)
```

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

## Batch Dispatch

Dispatch multiple commands as a unit. Stops on the first failure:

```typescript
const result = bus.dispatchBatch([
  { action: 'cart.add',        target: cart, payload: item },
  { action: 'totals.update',   target: cart },
  { action: 'analytics.track', target: session, payload: item },
]);

if (result.ok) {
  console.log('All succeeded:', result.results);
} else {
  console.error('Stopped at failure:', result.error);
  console.log('Partial results:', result.results);
}
```

Works on both sync and async buses.

## Dead Letter Handling

Configure what happens when a command has no registered handler:

```typescript
// Default: returns { ok: false, error }
createCommandBus()

// Throw instead of returning an error result
createCommandBus({ onMissing: 'throw' })

// Silently succeed (useful for optional commands)
createCommandBus({ onMissing: 'ignore' })

// Custom fallback
createCommandBus({
  onMissing: (cmd) => {
    console.warn(`Unhandled: ${cmd.action}`);
    return { ok: true, value: null };
  }
})
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

### useCommandBus

Lightweight composable for the "toolbox" pattern — import only when needed, tree-shaken out of builds that don't use it. Returns the shared bus directly:

```typescript
import { useCommandBus } from 'vapor-chamber';

const bus = useCommandBus();
bus.dispatch('cart.add', product, { quantity: 1 });
```

Use `useCommand()` when you need reactive `loading`/`lastError` signals. Use `useCommandBus()` when you just need to dispatch.

### configureSignal

Inject Vue Vapor's native signal factory once at app setup. Falls back to a built-in shim automatically in non-Vapor environments (standard Vue 3, tests, SSR):

```typescript
import { signal } from 'vue-vapor';
import { configureSignal } from 'vapor-chamber';

configureSignal(signal);
```

### Testing

`createTestBus()` records all dispatched commands without executing real handlers. Use it to test components that call `dispatch` without wiring up the full application:

```typescript
import { createTestBus, setCommandBus } from 'vapor-chamber';
import { describe, it, expect, beforeEach } from 'vitest';

describe('CartButton', () => {
  let bus: TestBus;

  beforeEach(() => {
    bus = createTestBus();
    setCommandBus(bus);
  });

  it('dispatches cart.add on click', () => {
    // ... render component, click button ...
    expect(bus.wasDispatched('cart.add')).toBe(true);
    expect(bus.getDispatched('cart.add')[0].cmd.payload).toEqual({ quantity: 1 });
  });
});
```

Register real handlers for actions you want to test deeply:

```typescript
bus.register('cart.add', (cmd) => {
  // real handler logic
});
```

### setupDevtools

Connect a bus to Vue DevTools. Adds a **Commands** timeline layer and a **Vapor Chamber** inspector panel. Requires `@vue/devtools-api` — silently no-ops if not installed:

```typescript
import { createApp } from 'vue';
import { getCommandBus, setupDevtools } from 'vapor-chamber';

const app = createApp(App);
setupDevtools(getCommandBus(), app);
app.mount('#app');
```

The inspector shows:
- Every dispatched command with its action, target, payload, and result
- Green `ok` / red `error` tags at a glance
- Full detail (value or error message) when a command is selected
- Filterable tree by action name

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
| `createCommandBus(options?)` | Create a synchronous command bus |
| `createAsyncCommandBus(options?)` | Create an async command bus |
| `createTestBus(options?)` | Create a test bus that records dispatches (see [Testing](#testing)) |

**`CommandBusOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onMissing` | `'error' \| 'throw' \| 'ignore' \| fn` | `'error'` | Behavior when no handler is registered for an action |

### Command Bus Methods

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command |
| `dispatchBatch(commands[])` | Execute multiple commands; stops on first failure |
| `register(action, handler)` | Register a handler (returns unregister fn) |
| `use(plugin, options?)` | Add a plugin (returns unsubscribe fn). `options.priority` controls order — higher runs first |
| `onAfter(hook)` | Run callback after every command |

### Composables

| Composable | Description |
|------------|-------------|
| `useCommandBus()` | Get the shared bus — lightweight, tree-shakeable |
| `useCommand()` | Dispatch with reactive loading/error state. Returns `dispose()` to clean up registered handlers/plugins |
| `useCommandState(initial, handlers)` | State managed by commands. Returns `dispose()` to unregister handlers |
| `useCommandHistory(options?)` | Reactive undo/redo. Returns `dispose()` to unsubscribe |
| `getCommandBus()` | Get shared bus instance |
| `setCommandBus(bus)` | Set shared bus instance |
| `configureSignal(fn)` | Inject a custom signal factory (e.g. Vue Vapor's native `signal`) |
| `setupDevtools(bus, app)` | Connect bus to Vue DevTools. No-ops automatically in production builds |

## Roadmap

| Feature | Status |
|---------|--------|
| DevTools integration | ✅ Done |
| DevTools production strip (0KB in prod) | ✅ Done |
| Command batching (`dispatchBatch`) | ✅ Done |
| Middleware priority/ordering | ✅ Done |
| Dead letter handling (`onMissing`) | ✅ Done |
| Testing utilities (`createTestBus`) | ✅ Done |
| Persistence plugin (localStorage / IndexedDB) | Planned |
| SSR support | Planned (pending Vue Vapor stabilization) |

## Documentation

See the [`docs/`](./docs) folder for detailed documentation:

- [Whitepaper](./docs/whitepaper.md) - Design philosophy and architecture
- [SSR Guide](./docs/ssr.md) - Server-side rendering and hydration

## Design Goals

1. **Minimal** - ~1KB core, no dependencies
2. **Vapor-native** - Built for signals, not VDOM
3. **Composable** - Plugins for everything
4. **Type-safe** - Full TypeScript support
5. **Predictable** - Sync by default, explicit async

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
