<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A lightweight command bus designed for <a href="https://github.com/vuejs/vue-vapor">Vue Vapor</a>. ~2KB gzipped. Vue 3.6 Vapor aligned. Optional DevTools integration.
</p>

## What is Vapor Chamber?

Vapor Chamber is a **command bus for Vue 3.6+ Vapor mode**. It gives every user action a single handler, a composable plugin pipeline, and signal-native reactive state — replacing scattered event listeners and prop-drilling with one predictable, testable flow.

```ts
import { createCommandBus, useCommand } from 'vapor-chamber';

const bus = createCommandBus();

bus.register('cartAdd', (cmd) => addToCart(cmd.target));
bus.use(logger());
bus.use(validator({ cartAdd: (cmd) => cmd.target.id ? null : 'Missing ID' }));

// In a component
const { dispatch, loading, lastError } = useCommand('cartAdd');
```

- **~2 KB gzipped** — zero runtime dependencies
- **Framework-agnostic core** — the bus itself has no Vue import
- **Vue 3.6 Vapor aligned** — signals, `onScopeDispose`, alien-signals internals
- **Full plugin pipeline** — logger, validator, debounce, throttle, retry, persist, sync, and more
- **Transport layer** — HTTP bridge, WebSocket bridge, SSE bridge
- **SSR-safe** — per-request bus isolation, no shared singletons

---

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
bus.dispatch('cartAdd', product, { quantity: 1 });

// One place, once:
bus.register('cartAdd', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items;
});

// Cross-cutting concerns as plugins, not scattered listeners:
bus.use(logger());
bus.use(validator({ 'cartAdd': (cmd) => cmd.target.id ? null : 'Missing ID' }));
bus.use(analyticsPlugin);
```

**The key difference:** `emit` is fire-and-forget with many listeners. `dispatch` has one handler and a composable plugin pipeline — one place to look, debug, and test.

## Why a Command Bus?

Traditional event systems scatter logic across components. A command bus centralizes it:

```
Event-driven (scattered)          Command bus (centralized)
─────────────────────────         ─────────────────────────
Component A emits 'add'    →      dispatch('cartAdd', product)
Component B listens...            ↓
Component C also listens...       Handler executes once
Who handles what? When?           Plugins observe/modify
                                  Result returned
```

**Benefits:**
- **Semantic actions** — `cartAdd` is clearer than `emit('add')`
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
  'cartAdd': (cmd) => cmd.payload?.quantity > 0 ? null : 'Quantity required'
}));

// Register handler
bus.register('cartAdd', (cmd) => {
  cart.items.push({ ...cmd.target, quantity: cmd.payload.quantity });
  return cart.items;
});

// Dispatch
const result = bus.dispatch('cartAdd', product, { quantity: 2 });
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
  'cartAdd',      // action - what to do
  product,         // target - what to act on
  { quantity: 2 }  // payload - additional data (optional)
);
```

### Naming Convention

Enforce consistent action names at register and dispatch time:

```typescript
const bus = createCommandBus({
  naming: {
    pattern: /^[a-z][a-zA-Z0-9]+$/,  // camelCase
    onViolation: 'throw'  // or 'warn' or 'ignore'
  }
});

bus.register('cartAdd', handler);       // ✓ passes
bus.register('cart_add', handler);      // ✗ throws
```

### Handlers

One handler per action. Returns a value or throws:

```typescript
bus.register('cartAdd', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items; // becomes result.value
});
```

Register with options for undo support and per-command throttling:

```typescript
bus.register('cartAdd', addHandler, {
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
bus.on('cart*', (cmd, result) => console.log('Cart event:', cmd.action));

// Exact match
bus.on('cartAdd', (cmd, result) => updateBadge());
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
| `retry(options)` | Retry failed async dispatches with backoff |
| `persist(options)` | Auto-save state to localStorage after commands |
| `sync(options, bus?)` | Broadcast commands across browser tabs |

### logger

```typescript
bus.use(logger({ collapsed: true, filter: (cmd) => cmd.action.startsWith('cart') }));
```

### validator

```typescript
bus.use(validator({
  'cartAdd': (cmd) => {
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

// If cartAdd was registered with { undo: fn }, calling undo() executes it
historyPlugin.undo();
```

### debounce

```typescript
bus.use(debounce(['searchQuery'], 300)); // wait 300ms after last call
```

### throttle

```typescript
bus.use(throttle(['uiScroll'], 100)); // max once per 100ms
```

### authGuard

```typescript
bus.use(authGuard({
  isAuthenticated: () => !!user.value,
  protected: ['shopCart', 'shopWishlist'],
  onUnauthenticated: (cmd) => router.push('/login'),
}));
```

### optimistic

```typescript
bus.use(optimistic({
  'cartAdd': {
    apply: (cmd) => {
      cartCount.value++;
      return () => { cartCount.value--; };  // rollback function
    }
  }
}));
```

### retry

Async plugin that retries failed dispatches with configurable backoff. Install on an `AsyncCommandBus`:

```typescript
import { createAsyncCommandBus, retry } from 'vapor-chamber';

const bus = createAsyncCommandBus();

// All actions, exponential backoff (default)
bus.use(retry({ maxAttempts: 3, baseDelay: 200 }));

// Only retry network actions, fixed delay
bus.use(retry({
  actions: ['api*'],
  maxAttempts: 5,
  baseDelay: 500,
  strategy: 'fixed',
  isRetryable: (err) => err.message !== 'Unauthorized',
}));
```

### persist

Auto-save state to localStorage after each successful command. Rehydrate on startup:

```typescript
import { persist } from 'vapor-chamber';

const cartPersist = persist({
  key: 'vc:cart',
  getState: () => cartState.value,
});
bus.use(cartPersist);

// On app start — rehydrate before rendering
const saved = cartPersist.load();
if (saved) cartState.value = saved;

// Manual operations
cartPersist.save();   // force save now
cartPersist.clear();  // remove from storage

// Custom backend (sessionStorage, IndexedDB adapter, etc.)
bus.use(persist({ key: 'vc:cart', getState, storage: sessionStorage }));
```

### sync

Broadcast successful commands to all other open tabs via `BroadcastChannel`:

```typescript
import { sync } from 'vapor-chamber';

const tabSync = sync(
  {
    channel: 'vapor-chamber:app',
    filter: (cmd) => cmd.action.startsWith('cart') || cmd.action.startsWith('auth'),
  },
  bus // pass the bus so received messages are re-dispatched locally
);

bus.use(tabSync);

// Teardown (component unmount, app destroy)
tabSync.close();
tabSync.isOpen(); // → false
```

## Transport Layer

Send commands to a backend over HTTP, WebSocket, or SSE. Import from `vapor-chamber/transports`
or directly from `vapor-chamber`:

### createHttpBridge

Async plugin that POSTs command envelopes to a backend endpoint. Unhandled commands (no local handler) fall through to the server:

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';
import { createHttpBridge } from 'vapor-chamber/transports';

const bus = createAsyncCommandBus({ onMissing: 'ignore' });

bus.use(createHttpBridge({
  endpoint: '/api/commands',
  csrf: true,           // reads XSRF-TOKEN cookie / meta tag automatically
  retry: 2,             // retry up to 2 times on 5xx / 429 / 408
  timeout: 8000,        // ms
  actions: ['order*'],  // only forward order* actions; others stay local
}));

const result = await bus.dispatch('orderCreate', { items: cart });
// → POST /api/commands  { command: 'orderCreate', target: { items: ... } }
```

The backend response shape:
```json
{ "state": { "orderId": 42, "status": "pending" } }
```
`result.value` will be the contents of `state`.

### createWsBridge

WebSocket transport with auto-reconnect:

```typescript
import { createWsBridge } from 'vapor-chamber/transports';

bus.use(createWsBridge({
  url: 'wss://api.example.com/commands',
  actions: ['chat*', 'presence*'],
}));
```

### createSseBridge

Server-sent events — server pushes commands to the client:

```typescript
import { createSseBridge } from 'vapor-chamber/transports';

bus.use(createSseBridge({
  url: '/api/events',
}));
```

## HTTP Client

`postCommand` is exposed for use outside the transport plugin when you need direct HTTP control:

```typescript
import { postCommand } from 'vapor-chamber';

const response = await postCommand('/api/commands', {
  command: 'cartAdd',
  target: product,
  payload: { quantity: 2 },
}, {
  csrf: true,
  timeout: 5000,
  retry: 2,
  onSessionExpired: (status) => router.push('/login'),
});
```

## Batch Dispatch

Dispatch multiple commands as a unit. Stops on the first failure:

```typescript
const result = bus.dispatchBatch([
  { action: 'cartAdd',        target: cart, payload: item },
  { action: 'totalsUpdate',   target: cart },
  { action: 'analyticsTrack', target: session, payload: item },
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

bus.register('userFetch', async (cmd) => {
  const response = await fetch(`/api/users/${cmd.target.id}`);
  return response.json();
});

const result = await bus.dispatch('userFetch', { id: 123 });
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

const { dispatch } = defineVaporCommand('analyticsTrack', (cmd) => {
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
    'cartAdd': (state, cmd) => ({
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

### useCommandGroup

Namespace isolation for large apps and multi-team projects. All calls are automatically prefixed in camelCase — prevents action name collisions when composing multiple feature modules:

```typescript
import { useCommandGroup } from 'vapor-chamber';

// Cart feature module
const cart = useCommandGroup('cart');
cart.register('add', handler);        // registers 'cartAdd'
cart.dispatch('add', product);        // dispatches 'cartAdd'
cart.on('*', listener);               // listens to 'cart*'

// Orders feature — completely isolated
const orders = useCommandGroup('orders');
orders.dispatch('cancel', { id });    // dispatches 'ordersCancel'

// Access the namespace
cart.namespace;  // → 'cart'
```

Auto-cleanup on Vue scope disposal. `dispose()` is also available for manual teardown.

### useCommandError

Component-scoped error boundary. Reactively captures all failed command results:

```typescript
import { useCommandError } from 'vapor-chamber';

// Watch all failed commands
const { errors, latestError, clearErrors } = useCommandError();

// Narrow to a subset
const { latestError } = useCommandError({
  filter: (cmd) => cmd.action.startsWith('cart'),
});

// In template
// latestError.value?.message
// errors.value.length
```

### createFormBus

Reactive form state manager built on the command bus. Per-field validation, dirty tracking, and full plugin pipeline on every form command:

```typescript
import { createFormBus, logger } from 'vapor-chamber';

const form = createFormBus({
  fields: { email: '', password: '' },
  rules: {
    email:    (v) => v.includes('@') ? null : 'Invalid email',
    password: (v) => v.length >= 8   ? null : 'Too short',
  },
  onSubmit: async (values) => await api.login(values),
});

// Attach plugins — logger, throttle, authGuard, etc.
form.use(logger());

// Reactive state
form.values.value        // { email: '', password: '' }
form.errors.value        // { email: 'Invalid email', ... }
form.isDirty.value       // true when any field has changed
form.isValid.value       // true when no errors
form.isSubmitting.value  // true while onSubmit is in flight

// Actions
form.set('email', 'user@example.com');  // updates field + re-runs validation
form.touch('email');                     // marks field as interacted with
await form.submit();                     // validate → onSubmit → returns bool
form.reset();                            // restore initial values
```

Template usage (Vue 3):

```vue
<input :value="form.values.value.email"
       @input="form.set('email', $event.target.value)"
       @blur="form.touch('email')" />
<span v-if="form.touched.value.email && form.errors.value.email">
  {{ form.errors.value.email }}
</span>
<button :disabled="!form.isValid.value || form.isSubmitting.value"
        @click="form.submit()">
  Submit
</button>
```

### useCommandBus

Lightweight access to the shared bus — tree-shakeable:

```typescript
import { useCommandBus } from 'vapor-chamber';

const bus = useCommandBus();
bus.dispatch('cartAdd', product, { quantity: 1 });
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
import { createTestBus, setCommandBus, resetCommandBus } from 'vapor-chamber';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('CartButton', () => {
  let bus: TestBus;

  beforeEach(() => {
    bus = createTestBus();
    setCommandBus(bus);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('dispatches cartAdd on click', () => {
    // ... render component, click button ...
    expect(bus.wasDispatched('cartAdd')).toBe(true);
    expect(bus.getDispatched('cartAdd')[0].cmd.payload).toEqual({ quantity: 1 });
  });
});
```

**Snapshot & time-travel** — replay command sequences for debugging or testing:

```typescript
const bus = createTestBus();

bus.dispatch('login', user);
bus.dispatch('cartAdd', product, { quantity: 1 });
bus.dispatch('cartAdd', product2, { quantity: 2 });
bus.dispatch('checkout', cart);

// Immutable snapshot — mutations don't affect bus.recorded
const snap = bus.snapshot(); // → RecordedDispatch[]

// Commands 0..N inclusive (returns Command[])
bus.travelTo(1);                        // → [login, cartAdd]

// All commands up to last occurrence of 'cartAdd'
bus.travelToAction('cartAdd');          // → [login, cartAdd, cartAdd]

// Out-of-range indices are clamped
bus.travelTo(999);                      // → full history
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
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, throttle? }` |
| `use(plugin, options?)` | Add a plugin. `options.priority` controls order |
| `onAfter(hook)` | Run callback after every command |
| `on(pattern, listener)` | Subscribe to commands matching a pattern (`*`, `prefix*`, exact) |
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
| `useCommandGroup(namespace)` | Namespace isolation — prefixes all calls in camelCase |
| `useCommandError(options?)` | Reactive error boundary for failed dispatches |
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
| Namespace isolation (`useCommandGroup`) | ✅ Done (v0.4.1) |
| Error boundary (`useCommandError`) | ✅ Done (v0.4.1) |
| Transport layer (HTTP / WebSocket / SSE) | ✅ Done (v0.4.2) |
| Retry plugin with configurable backoff | ✅ Done (v0.4.2) |
| Persistence plugin (localStorage / IndexedDB) | ✅ Done (v0.4.2) |
| Cross-tab sync plugin (`BroadcastChannel`) | ✅ Done (v0.4.2) |
| `createTestBus` snapshot & time-travel | ✅ Done (v0.4.3) |
| camelCase action names (LLM-tokenization optimal) | ✅ Done (v0.5.0) |
| TypeScript HTTP client (`postCommand`) | ✅ Done (v0.5.0) |
| CDCC-compliant file splits | ✅ Done (v0.5.0) |
| SSR concurrency tests | ✅ Done (v0.5.0) |
| Directive plugin (`v-command`) | ✅ Done (v0.5.0) |
| Vite HMR plugin | ✅ Done (v0.5.0) |
| Form bus (`createFormBus`) | ✅ Done (v0.5.0) |

## Documentation

See [`docs/whitepaper.md`](./docs/whitepaper.md) for design philosophy, architecture, camelCase naming rationale, Vue 3.6 Vapor alignment, SSR guide, and migration strategy.

## Design Goals

1. **Minimal** — ~1KB core, no dependencies
2. **Vapor-native** — Built for signals, not VDOM
3. **Composable** — Plugins for everything
4. **Type-safe** — Full TypeScript support
5. **Predictable** — Sync by default, explicit async
6. **Progressive** — Works in VDOM, Vapor, and mixed trees

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
