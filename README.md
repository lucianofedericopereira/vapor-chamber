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

## Module Architecture

vapor-chamber is built in layers. The **core** is framework-agnostic, has zero dependencies, and is the only part required for v1.0. Everything else is optional and tree-shaken when not imported.

```
┌─────────────────────────────────────────────────────────┐
│  CORE  (zero deps · fully tested · framework-agnostic)  │
│  command-bus.ts  ·  testing.ts                          │
└────────────────────────┬────────────────────────────────┘
                         │ optional layers (tree-shaken)
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
   Vue composables    Plugins        Transport
   chamber.ts         plugins-core   http.ts
   chamber-vapor.ts   plugins-io     transports.ts
         │
         ▼
   Extras (per-feature opt-in)
   form.ts · schema.ts · devtools.ts · directives.ts · vite-hmr.ts
```

### Coverage & stability at v0.5.0

| Layer | Module | Coverage | Status |
|-------|--------|----------|--------|
| **Core** | `command-bus.ts` | 90% | ✅ Stable |
| **Core** | `testing.ts` | 96% | ✅ Stable |
| Plugins | `plugins-core.ts` | 90% | ✅ Stable |
| Plugins | `plugins-io.ts` | 88% | ✅ Stable |
| Transport | `http.ts` | 80% | ✅ Stable |
| Transport | `transports.ts` | 91% | ✅ Stable |
| Vue | `chamber.ts` | 76% | ✅ Stable |
| Extras | `form.ts` | 99% | ✅ Stable |
| Extras | `schema.ts` | 92% | ✅ Stable |
| Vue 3.6 | `chamber-vapor.ts` | — | ⚠️ Requires Vue 3.6 runtime to test |
| Vue | `directives.ts` | — | ⚠️ Requires Vue DOM environment to test |
| Build | `devtools.ts` | — | ⚠️ Requires browser DevTools API to test |
| Build | `vite-hmr.ts` | — | ⚠️ Requires Vite runtime to test |
| Build | `iife.ts` | — | 🔧 Bundle entry, not a public API |

Sub-path exports avoid pulling in optional modules:
```
'vapor-chamber'             → core + composables + everything (tree-shaken)
'vapor-chamber/transports'  → HTTP + WebSocket + SSE bridges only
'vapor-chamber/directives'  → v-command Vue directive only
'vapor-chamber/vite'        → Vite HMR plugin only
'vapor-chamber/iife'        → IIFE bundle
```

---

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

### Before Hooks

Run logic before a command reaches its handler. Throw to cancel — the dispatch returns `{ ok: false }`:

```typescript
// Global auth gate
bus.onBefore((cmd) => {
  if (!user.isAuth && protectedActions.includes(cmd.action)) {
    throw new Error('Unauthenticated');
  }
});

// Loading indicator
bus.onBefore(() => { isLoading.value = true; });
bus.onAfter(()  => { isLoading.value = false; });
```

On an async bus the hook can be async:
```typescript
asyncBus.onBefore(async (cmd) => {
  await rateLimiter.check(cmd.action);
});
```

### Wildcard Listeners

Subscribe to command patterns without being a handler:

```typescript
// All commands
bus.on('*', (cmd, result) => analytics.track(cmd.action));

// Prefix matching
bus.on('cart*', (cmd, result) => console.log('Cart event:', cmd.action));

// Exact match — fires once, then removes itself
bus.once('cartAdd', (cmd, result) => showConfetti());

// Remove all listeners for a pattern
bus.offAll('cart*');

// Remove all listeners
bus.offAll();
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
  csrf: true,                                    // reads XSRF-TOKEN cookie / meta tag automatically
  csrfCookieUrl: '/sanctum/csrf-cookie',         // default; set '' to disable the refresh fetch
  retry: 2,                                      // retry up to 2 times on 5xx / 429 / 408
  noRetry: ['paymentCharge', 'orderPlace'],      // never retry non-idempotent commands
  timeout: 8000,                                 // ms
  actions: ['order*'],                           // only forward order* actions; others stay local
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

const ws = createWsBridge({
  url: 'wss://api.example.com/commands',
  actions: ['chat*', 'presence*'],
  timeout: 10_000,       // per-message response timeout, ms (default: 10_000)
  maxQueueSize: 100,     // max queued messages during disconnect (default: 100)
  reconnect: true,       // auto-reconnect on close (default: true)
  maxReconnects: 10,     // give up after N reconnect attempts (default: 10)
});
bus.use(ws);
ws.connect();

// Lifecycle
ws.isConnected();  // → boolean
ws.disconnect();   // intentional close — suppresses reconnect
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

Dispatch multiple commands as a unit. Stops on the first failure by default:

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

Use `continueOnError` to run all commands regardless of failures, then check counts:

```typescript
const result = bus.dispatchBatch(commands, { continueOnError: true });
console.log(`${result.successCount} of ${result.results.length} succeeded`);
// result.failCount — how many failed
// result.results   — all CommandResult objects, in order
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
    // Sync rule — runs on every set() for live feedback
    email:    (v) => v.includes('@') ? null : 'Invalid email',
    password: (v) => v.length >= 8   ? null : 'Too short',
    // Async rule — only awaited on submit() (no UI jank during typing)
    username: async (v) => {
      const taken = await api.isUsernameTaken(v);
      return taken ? 'Username already taken' : null;
    },
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
| `dispatchBatch(commands[], options?)` | Execute multiple commands. Returns `{ successCount, failCount, results }` |
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, throttle? }` |
| `use(plugin, options?)` | Add a plugin. `options.priority` controls order |
| `onBefore(hook)` | Run hook before every command. Throw to cancel dispatch. |
| `onAfter(hook)` | Run hook after every command |
| `on(pattern, listener)` | Subscribe to commands matching a pattern (`*`, `prefix*`, exact). Returns unsub. |
| `once(pattern, listener)` | Like `on()` but auto-unsubscribes after first match |
| `offAll(pattern?)` | Remove all listeners for a pattern, or all listeners if omitted |
| `request(action, target, payload?, options?)` | Async request/response with timeout (default 5s) |
| `respond(action, handler)` | Register a responder for `request()` calls |
| `hasHandler(action)` | Returns true if a handler is registered for the action |
| `clear()` | Remove all handlers, plugins, hooks, and listeners |
| `getUndoHandler(action)` | Get the undo handler for an action (`@internal`) |

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

### Core — target: 100% feature-complete at v1.0

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| Dispatch / register / unregister | `command-bus` | ✅ v0.1.0 | ✅ 90% coverage |
| Plugin pipeline (sync + async) | `command-bus` | ✅ v0.1.0 | ✅ 90% coverage |
| Plugin priority ordering | `command-bus` | ✅ v0.2.0 | ✅ covered |
| `onAfter` hooks | `command-bus` | ✅ v0.2.0 | ✅ covered |
| Dead letter handling (`onMissing`) | `command-bus` | ✅ v0.2.0 | ✅ covered |
| Command batching + `continueOnError` + `successCount`/`failCount` | `command-bus` | ✅ v0.6.0 | ✅ covered |
| Naming convention enforcement | `command-bus` | ✅ v0.3.0 | ✅ covered |
| Wildcard listeners (`on`, `prefix*`) | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `once()` — one-shot listener | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `offAll(pattern?)` — mass unsubscribe | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `onBefore(hook)` — pre-dispatch hook, cancelable | `command-bus` | ✅ v0.6.0 | ✅ covered |
| Request / response pattern + timeout | `command-bus` | ✅ v0.3.0 | ✅ covered |
| Per-command throttle + undo at register | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `bus.hasHandler()` introspection | `command-bus` | ✅ v0.3.0 | ✅ covered |
| `bus.clear()` | `command-bus` | ✅ v0.5.0 | ✅ covered |
| `BaseBus` structural interface | `command-bus` | ✅ v0.6.0 | ✅ covered |
| `commandKey(action, target)` export | `command-bus` | ✅ v0.6.0 | ✅ covered |
| SSR isolation (independent bus instances) | `command-bus` | ✅ v0.5.0 | ✅ covered |
| `createTestBus` record + assert | `testing` | ✅ v0.2.0 | ✅ 96% coverage |
| `createTestBus` snapshot & time-travel | `testing` | ✅ v0.4.3 | ✅ covered |
| `TestBus.on()` / `once()` / `offAll()` real implementations | `testing` | ✅ v0.6.0 | ✅ covered |

### Plugins — optional, fully implemented

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `logger` | `plugins-core` | ✅ v0.1.0 | ✅ 90% coverage |
| `validator` | `plugins-core` | ✅ v0.1.0 | ✅ covered |
| `history` + bus-backed undo/redo | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `debounce` (stale-closure fix) | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `throttle` | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `authGuard` | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `optimistic` | `plugins-core` | ✅ v0.3.0 | ✅ covered |
| `retry` with configurable backoff + glob filter | `plugins-io` | ✅ v0.4.2 | ✅ 88% coverage |
| `persist` (localStorage / custom storage) | `plugins-io` | ✅ v0.4.2 | ✅ covered |
| `sync` (BroadcastChannel cross-tab) | `plugins-io` | ✅ v0.4.2 | ✅ covered |

### Transport layer — optional, fully implemented

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `postCommand` — POST with retry, CSRF, timeout, session | `http` | ✅ v0.5.0 | ✅ 80% coverage |
| `readCsrfToken` — meta / cookie / hidden input | `http` | ✅ v0.5.0 | ✅ covered |
| `HttpError.code` — machine-readable code from response body | `http` | ✅ v0.6.0 | ✅ covered |
| 419 vs 401 fix — CSRF expiry ≠ session expiry | `http` | ✅ v0.6.0 | ✅ covered |
| `createHttpBridge` — fetch plugin | `transports` | ✅ v0.4.2 | ✅ 91% coverage |
| `HttpBridgeOptions.noRetry` — per-action retry disable | `transports` | ✅ v0.6.0 | ✅ covered |
| `createWsBridge` — WebSocket plugin + reconnect + bounded queue | `transports` | ✅ v0.6.0 | ✅ covered |
| `createSseBridge` — server-push EventSource, accepts `BaseBus` | `transports` | ✅ v0.6.0 | ✅ covered |

### Vue composables — optional, requires Vue ≥3.5

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `useCommand` — reactive loading/error | `chamber` | ✅ v0.1.0 | ✅ 76% coverage |
| `useCommandState` | `chamber` | ✅ v0.2.0 | ✅ covered |
| `useCommandHistory` — reactive undo/redo | `chamber` | ✅ v0.2.0 | ✅ covered |
| `useCommandGroup` — namespace isolation | `chamber` | ✅ v0.4.1 | ✅ covered |
| `useCommandError` — error boundary | `chamber` | ✅ v0.4.1 | ✅ covered |
| `getCommandBus` / `setCommandBus` / `resetCommandBus` | `chamber` | ✅ v0.1.0 | ✅ covered |
| Signal shim + `configureSignal` | `chamber` | ✅ v0.3.0 | ✅ covered |
| `onScopeDispose` lifecycle alignment | `chamber` | ✅ v0.4.0 | ✅ covered |
| `isVaporAvailable()` | `chamber` | ✅ v0.4.0 | ✅ covered |
| `createVaporChamberApp` / `getVaporInteropPlugin` / `defineVaporCommand` | `chamber-vapor` | ✅ v0.4.0 | ⚠️ requires Vue 3.6 runtime |

### Extras — optional, per-feature opt-in

| Feature | Module | Status | Tests |
|---------|--------|--------|-------|
| `createFormBus` — reactive form + sync/async validation | `form` | ✅ v0.6.0 | ✅ 99% coverage |
| Schema layer — `createSchemaCommandBus`, `toTools`, `synthesize` | `schema` | ✅ v0.5.0 | ✅ 92% coverage |
| `SynthesizeOptions.adapter` — custom LLM adapter | `schema` | ✅ v0.6.0 | ✅ covered |
| `setupDevtools` — Vue DevTools panel | `devtools` | ✅ v0.4.0 | ⚠️ requires browser DevTools API |
| `createDirectivePlugin` — `v-command` directive | `directives` | ✅ v0.5.0 | ⚠️ requires Vue DOM environment |
| Vite HMR plugin | `vite-hmr` | ✅ v0.5.0 | ⚠️ requires Vite runtime |
| IIFE / CDN bundle | `iife` | ✅ v0.5.0 | 🔧 bundle entry |

### v1.0 checklist

| Item | Status |
|------|--------|
| Core (`command-bus` + `testing`) at 90%+ coverage | ✅ Done |
| All tests green (318/318, 0 failures) | ✅ Done |
| Optional modules clearly marked in exports | ✅ Done |
| Transport layer fully tested (HTTP + WS + SSE) | ✅ Done |
| Plugins fully tested | ✅ Done |
| camelCase naming convention locked in | ✅ Done |
| `onBefore` / `offAll` / `once` on both buses | ✅ Done (v0.6.0) |
| `BaseBus` structural interface for cross-bus utilities | ✅ Done (v0.6.0) |
| CSRF / 419 / session-expiry correctness | ✅ Done (v0.6.0) |
| Form async validation | ✅ Done (v0.6.0) |
| `HttpError.code` structured error codes | ✅ Done (v0.6.0) |
| WS queue cap (`maxQueueSize`) | ✅ Done (v0.6.0) |
| `synthesize` LLM adapter (proxy / OpenAI support) | ✅ Done (v0.6.0) |
| Architectural whitepaper | ✅ Done (v0.6.0) |
| `chamber.ts` branch coverage | 🔄 76% → target 85% |
| Publish to npm as `vapor-chamber@1.0.0` | ⬜ Pending |

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
