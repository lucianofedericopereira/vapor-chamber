<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A lightweight command bus designed for <a href="https://github.com/vuejs/vue-vapor">Vue Vapor</a>. ~2KB gzipped. Vue 3.6 Vapor aligned. Optional DevTools integration.
</p>

## What is Vue Vapor?

Vue Vapor is Vue's compilation strategy that eliminates the Virtual DOM. Instead of diffing virtual trees, Vapor compiles templates to direct DOM operations using **signals** — reactive primitives that update only what changed.

**As of Vue 3.6 beta**, Vapor mode is feature-complete for all stable APIs. The reactivity engine has been rewritten atop [alien-signals](https://github.com/stackblitz/alien-signals), delivering ~14% less memory and faster dependency tracking. `ref()` is now a signal internally.

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
bus.dispatch('cart_add', product, { quantity: 1 });

// One place, once:
bus.register('cart_add', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items;
});

// Cross-cutting concerns as plugins, not scattered listeners:
bus.use(logger());
bus.use(validator({ 'cart_add': (cmd) => cmd.target.id ? null : 'Missing ID' }));
bus.use(analyticsPlugin);
```

**The key difference:** `emit` is fire-and-forget with many listeners. `dispatch` has one handler and a composable plugin pipeline — one place to look, debug, and test.

## Why a Command Bus?

Traditional event systems scatter logic across components. A command bus centralizes it:

```
Event-driven (scattered)          Command bus (centralized)
─────────────────────────         ─────────────────────────
Component A emits 'add'    →      dispatch('cart_add', product)
Component B listens...            ↓
Component C also listens...       Handler executes once
Who handles what? When?           Plugins observe/modify
                                  Result returned
```

**Benefits:**
- **Semantic actions** — `cart_add` is clearer than `emit('add')`
- **Single handler** — One place to look, debug, test
- **Plugin pipeline** — Cross-cutting concerns (logging, validation, analytics) without cluttering handlers
- **Undo/redo** — Command history is natural when actions are explicit

## Install

```bash
npm install vapor-chamber
```

**Requirements:** Node.js ≥20.19.0 | Vue ≥3.5.0 (optional peer dep) | Vite 7/8 compatible

## Quick Start

```typescript
import { createCommandBus, logger, validator } from 'vapor-chamber';

const bus = createCommandBus();

// Add plugins
bus.use(logger());
bus.use(validator({
  'cart_add': (cmd) => cmd.payload?.quantity > 0 ? null : 'Quantity required'
}));

// Register handler
bus.register('cart_add', (cmd) => {
  cart.items.push({ ...cmd.target, quantity: cmd.payload.quantity });
  return cart.items;
});

// Dispatch
const result = bus.dispatch('cart_add', product, { quantity: 2 });
if (result.ok) {
  console.log('Added:', result.value);
} else {
  console.error('Failed:', result.error);
}
```

## Vue 3.6 Vapor Mode

Vapor Chamber v0.4.0 is aligned with Vue 3.6 beta. It works in three contexts:

### 1. Pure Vapor App (smallest bundle)

```typescript
import { createVaporChamberApp, getCommandBus } from 'vapor-chamber';
import App from './App.vue';

// No VDOM runtime — ~10KB baseline
createVaporChamberApp(App).mount('#app');
```

```vue
<script setup vapor>
import { useCommand } from 'vapor-chamber';

const { dispatch, loading } = useCommand();
</script>
```

### 2. Mixed VDOM + Vapor (gradual migration)

```typescript
import { createApp } from 'vue';
import { getVaporInteropPlugin } from 'vapor-chamber';

const app = createApp(App);
const interop = getVaporInteropPlugin();
if (interop) app.use(interop);
app.mount('#app');
```

Now Vapor and VDOM components can nest inside each other. Useful for incremental migration.

### 3. Standard Vue 3 (no Vapor)

Everything works without Vapor. The signal shim auto-detects Vue's `ref()` for reactivity. In Vue 3.6+ this is alien-signals backed.

### Vapor Detection

```typescript
import { isVaporAvailable } from 'vapor-chamber';

if (isVaporAvailable()) {
  // Vue 3.6+ with createVaporApp available
}
```

## Core Concepts

### Commands

A command has three parts:

```typescript
bus.dispatch(
  'cart_add',      // action - what to do
  product,         // target - what to act on
  { quantity: 2 }  // payload - additional data (optional)
);
```

### Naming Convention

Enforce consistent action names at register and dispatch time:

```typescript
const bus = createCommandBus({
  naming: {
    pattern: /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/,  // snake_case
    onViolation: 'throw'  // or 'warn' or 'ignore'
  }
});

bus.register('cart_add', handler);       // ✓ passes
bus.register('cartAdd', handler);        // ✗ throws
```

### Handlers

One handler per action. Returns a value or throws:

```typescript
bus.register('cart_add', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items; // becomes result.value
});
```

Register with options for undo support and per-command throttling:

```typescript
bus.register('cart_add', addHandler, {
  undo: (cmd) => { cart.items.pop(); },
  throttle: 300,  // max once per 300ms per target
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

### Wildcard Listeners

Subscribe to command patterns without being a handler:

```typescript
// All commands
bus.on('*', (cmd, result) => analytics.track(cmd.action));

// Prefix matching
bus.on('shop_*', (cmd, result) => console.log('Shop event:', cmd.action));

// Exact match
bus.on('cart_add', (cmd, result) => updateBadge());
```

### Request / Response

Async request/response pattern with timeout:

```typescript
// Register a responder
bus.respond('get_auth_token', async (cmd) => {
  const response = await fetch('/api/token');
  return response.json();
});

// Request with timeout
const result = await bus.request('get_auth_token', { userId: 42 }, { timeout: 3000 });
```

Falls back to normal `dispatch()` if no responder is registered.

## Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `logger(options?)` | Log commands to console |
| `validator(rules)` | Validate commands before execution |
| `history(options?)` | Track command history for undo/redo |
| `debounce(actions, wait)` | Delay execution until activity stops |
| `throttle(actions, wait)` | Limit execution frequency |
| `authGuard(options)` | Block protected commands when unauthenticated |
| `optimistic(handlers)` | Apply optimistic updates, rollback on failure |

### logger

```typescript
bus.use(logger({ collapsed: true, filter: (cmd) => cmd.action.startsWith('cart_') }));
```

### validator

```typescript
bus.use(validator({
  'cart_add': (cmd) => {
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

With bus-backed undo (executes inverse handlers):

```typescript
const historyPlugin = history({ maxSize: 100, bus });
bus.use(historyPlugin);

// If cart_add was registered with { undo: fn }, calling undo() executes it
historyPlugin.undo();
```

### debounce

```typescript
bus.use(debounce(['search_query'], 300)); // wait 300ms after last call
```

### throttle

```typescript
bus.use(throttle(['ui_scroll'], 100)); // max once per 100ms
```

### authGuard

```typescript
bus.use(authGuard({
  isAuthenticated: () => !!user.value,
  protected: ['shop_cart_', 'shop_wishlist_'],
  onUnauthenticated: (cmd) => router.push('/login'),
}));
```

### optimistic

```typescript
bus.use(optimistic({
  'cart_add': {
    apply: (cmd) => {
      cartCount.value++;
      return () => { cartCount.value--; };  // rollback function
    }
  }
}));
```

## Batch Dispatch

Dispatch multiple commands as a unit. Stops on the first failure:

```typescript
const result = bus.dispatchBatch([
  { action: 'cart_add',        target: cart, payload: item },
  { action: 'totals_update',   target: cart },
  { action: 'analytics_track', target: session, payload: item },
]);

if (result.ok) {
  console.log('All succeeded:', result.results);
} else {
  console.error('Stopped at failure:', result.error);
}
```

## Dead Letter Handling

Configure what happens when a command has no registered handler:

```typescript
createCommandBus()                                    // default: returns { ok: false, error }
createCommandBus({ onMissing: 'throw' })              // throws the error
createCommandBus({ onMissing: 'ignore' })             // returns { ok: true, value: undefined }
createCommandBus({ onMissing: (cmd) => { ... } })     // custom fallback
```

## Async Command Bus

For async handlers (API calls, IndexedDB, etc.):

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';

const bus = createAsyncCommandBus();

bus.register('user_fetch', async (cmd) => {
  const response = await fetch(`/api/users/${cmd.target.id}`);
  return response.json();
});

const result = await bus.dispatch('user_fetch', { id: 123 });
```

## Vapor Composables

### useCommand

Dispatch commands with reactive loading/error state:

```vue
<script setup vapor>
import { useCommand } from 'vapor-chamber';

const { dispatch, loading, lastError } = useCommand();
</script>

<template>
  <button @click="dispatch('save', doc)" :disabled="loading.value">Save</button>
  <p v-if="lastError.value">{{ lastError.value.message }}</p>
</template>
```

### defineVaporCommand

Zero-overhead dispatch for hot paths — no reactive `loading`/`lastError` signals created.
Ideal for GA4 tracking, scroll events, debounced search, fire-and-forget patterns:

```vue
<script setup vapor>
import { defineVaporCommand } from 'vapor-chamber';

const { dispatch } = defineVaporCommand('analytics_track', (cmd) => {
  gtag('event', cmd.target.event, cmd.target.params);
});

// Fire-and-forget — no reactive overhead in the alien-signals graph
dispatch({ event: 'page_view', params: { page: '/shop' } });
</script>
```

### useCommandState

State managed by commands:

```vue
<script setup vapor>
import { useCommandState } from 'vapor-chamber';

const { state: cart } = useCommandState(
  { items: [], total: 0 },
  {
    'cart_add': (state, cmd) => ({
      items: [...state.items, cmd.target],
      total: state.total + cmd.target.price
    })
  }
);
</script>
```

### useCommandHistory

Reactive undo/redo:

```vue
<script setup vapor>
import { useCommandHistory } from 'vapor-chamber';

const { canUndo, canRedo, undo, redo } = useCommandHistory({
  filter: (cmd) => cmd.action.startsWith('editor_')
});
</script>
```

### useCommandBus

Lightweight access to the shared bus — tree-shakeable:

```typescript
import { useCommandBus } from 'vapor-chamber';

const bus = useCommandBus();
bus.dispatch('cart_add', product, { quantity: 1 });
```

Use `useCommand()` when you need reactive `loading`/`lastError` signals. Use `defineVaporCommand()` for zero-overhead hot paths. Use `useCommandBus()` when you just need to dispatch.

### configureSignal

Inject a custom signal factory. In Vue 3.6+, `ref()` is auto-detected and backed by alien-signals — calling `configureSignal` is only needed for custom signal implementations:

```typescript
import { ref } from 'vue';
import { configureSignal } from 'vapor-chamber';

configureSignal(ref); // explicit — usually auto-detected
```

### Testing

`createTestBus()` records all dispatched commands without executing real handlers:

```typescript
import { createTestBus, setCommandBus } from 'vapor-chamber';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetCommandBus } from 'vapor-chamber';

describe('CartButton', () => {
  let bus: TestBus;

  beforeEach(() => {
    bus = createTestBus();
    setCommandBus(bus);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('dispatches cart_add on click', () => {
    // ... render component, click button ...
    expect(bus.wasDispatched('cart_add')).toBe(true);
    expect(bus.getDispatched('cart_add')[0].cmd.payload).toEqual({ quantity: 1 });
  });
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

## API Reference

### Core

| Function | Description |
|----------|-------------|
| `createCommandBus(options?)` | Create a synchronous command bus |
| `createAsyncCommandBus(options?)` | Create an async command bus |
| `createTestBus(options?)` | Create a test bus that records dispatches |

**`CommandBusOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onMissing` | `'error' \| 'throw' \| 'ignore' \| fn` | `'error'` | Behavior when no handler is registered |
| `naming` | `{ pattern: RegExp, onViolation?: string }` | — | Enforce naming convention on actions |

### Command Bus Methods

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command |
| `dispatchBatch(commands[])` | Execute multiple commands; stops on first failure |
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, throttle?, debounce? }` |
| `use(plugin, options?)` | Add a plugin. `options.priority` controls order |
| `onAfter(hook)` | Run callback after every command |
| `on(pattern, listener)` | Subscribe to commands matching a pattern (`*`, `prefix_*`, exact) |
| `request(action, target, options?)` | Async request/response with timeout |
| `respond(action, handler)` | Register a responder for `request()` calls |
| `getUndoHandler(action)` | Get the undo handler for an action |

### Composables

| Composable | Description |
|------------|-------------|
| `useCommand()` | Dispatch with reactive loading/error state |
| `defineVaporCommand(action, handler, options?)` | Zero-overhead dispatch for hot paths |
| `useCommandState(initial, handlers)` | State managed by commands |
| `useCommandHistory(options?)` | Reactive undo/redo |
| `useCommandBus()` | Get shared bus instance |
| `getCommandBus()` | Get shared bus instance (non-composable) |
| `setCommandBus(bus)` | Set shared bus instance |
| `resetCommandBus()` | Reset shared bus to null (useful in tests) |
| `configureSignal(fn)` | Inject a custom signal factory |
| `isVaporAvailable()` | Returns true if Vue 3.6+ Vapor mode is detected |
| `createVaporChamberApp(component, props?)` | Create a Vapor app instance (requires Vue 3.6+) |
| `getVaporInteropPlugin()` | Returns `vaporInteropPlugin` for mixed trees |
| `setupDevtools(bus, app)` | Connect bus to Vue DevTools |

## Roadmap

| Feature | Status |
|---------|--------|
| DevTools integration | ✅ Done |
| DevTools production strip (0KB in prod) | ✅ Done |
| Command batching (`dispatchBatch`) | ✅ Done |
| Middleware priority/ordering | ✅ Done |
| Dead letter handling (`onMissing`) | ✅ Done |
| Testing utilities (`createTestBus`) | ✅ Done |
| Naming convention enforcement | ✅ Done (v0.3.0) |
| Wildcard listeners (`on`) | ✅ Done (v0.3.0) |
| Request/response pattern | ✅ Done (v0.3.0) |
| Per-command throttle/undo at register | ✅ Done (v0.3.0) |
| Auth guard plugin | ✅ Done (v0.3.0) |
| Optimistic update plugin | ✅ Done (v0.3.0) |
| Vue 3.6 Vapor alignment | ✅ Done (v0.4.0) |
| `defineVaporCommand` zero-overhead composable | ✅ Done (v0.4.0) |
| `onScopeDispose` lifecycle alignment | ✅ Done (v0.4.0) |
| Persistence plugin (localStorage / IndexedDB) | Planned |
| SSR support | Planned (pending Vue Vapor stabilization) |

## Documentation

See the [`docs/`](./docs) folder for detailed documentation:

- [Whitepaper](./docs/whitepaper.md) — Design philosophy and architecture
- [Vue 3.6 Vapor Alignment](./docs/whitepaper-vue36.md) — Alien-signals, Vapor mode, and migration strategy
- [SSR Guide](./docs/ssr.md) — Server-side rendering and hydration

## Design Goals

1. **Minimal** — ~1KB core, no dependencies
2. **Vapor-native** — Built for signals, not VDOM
3. **Composable** — Plugins for everything
4. **Type-safe** — Full TypeScript support
5. **Predictable** — Sync by default, explicit async
6. **Progressive** — Works in VDOM, Vapor, and mixed trees

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
