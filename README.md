<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A command bus built for <a href="https://github.com/vuejs/core">Vue Vapor</a> — a ~3.6 KB brotli dispatch core with opt-in batteries, each 0 KB until imported. Vue 3.6.0-rc.3 aligned. LGPL-2.1.
</p>

---

Every user action gets **one handler**, a composable **plugin pipeline**, and **signal-native**
reactive state — replacing scattered event listeners and prop-drilling with one predictable,
testable flow.

```ts
import { getCommandBus, useCommand, logger, validator } from 'vapor-chamber';

const bus = getCommandBus();
bus.register('cartAdd', (cmd) => addToCart(cmd.target));
bus.use(logger());
bus.use(validator({ cartAdd: (cmd) => cmd.target.id ? null : 'Missing ID' }));

// In a component — same shared bus, with reactive state
const { dispatch, loading, lastError } = useCommand();
dispatch('cartAdd', { id: product.id });
```

**The difference from `emit`:** `emit` is fire-and-forget with many listeners. `dispatch` has one
handler and a composable pipeline — one place to look, debug, and test.

## What's in the can

A small core, and batteries you only pay for if you import them.

| | |
|---|---|
| **Core** (the bus) | dispatch/query/emit, plugin pipeline, wildcard listeners — framework-agnostic, no Vue import, **~3.6 KB brotli** |
| **Vue composables** | `useCommand`, `useCommandState`, shared state, `defineVaporCommand`, full Vapor wrappers |
| **Router** (opt-in) | URL-addressed reads for Vue 3.6 over a server catch-all — route tables and loaders as data |
| **Plugins** (opt-in) | logger, validator, history (undo/redo), debounce, throttle, retry, persist, cross-tab sync, serialize, idempotent, auth guard |
| **Transports** (opt-in) | HTTP bridge, batching HTTP, WebSocket, SSE, Laravel Echo/Reverb |
| **Extras** (opt-in, own subpath each) | SSR dehydrate/rehydrate, form bus, HTTP client, streaming JSON parser, schema validation, transitions, devtools, Vite HMR, testing, MCP server, offline outbox |

- **Vue 3.6.0-rc.3 aligned** — signals, `onScopeDispose`, `getCurrentScope`, alien-signals internals; tracked per release in the [CHANGELOG](CHANGELOG.md)
- **One runtime dependency** (`alien-signals`); unimported modules tree-shake to zero
- **ESM-only**, plus three IIFE `<script>` drop-ins for no-bundler pages
- **1491 tests** across 92 files · 97.1% statements · 98.3% lines ([full table](docs/COVERAGE.md))

## Contents

[Install](#install) · [Quick start](#quick-start) · [Router](#router) · [Vapor mode](#vue-36-vapor-mode) · [Core concepts](#core-concepts) · [Plugins](#built-in-plugins) · [Transports](#transport-layer) · [HTTP client](#http-client) · [Composables](#vapor-composables) · [Bundle sizes](#bundle-sizes) · [Testing](#testing) · [Examples](#examples) · [API reference](#api-reference)

## Install

```bash
npm install vapor-chamber        # npm registry (releases may lag the repo)

# or straight from the repo — the authoritative source while Vue 3.6 is in RC
# (a `prepare` script builds it on install):
npm install github:lucianofedericopereira/vapor-chamber
```

**Requirements:** Node ≥22.12. Vue is an **optional** peer dep — ≥3.5 for composables, ≥3.6.0-rc.3
for the full Vapor surface. The core bus runs without Vue entirely. Vite ≥5 + `@vitejs/plugin-vue`
≥5 only for the `vapor-chamber/vite` HMR plugin and Vapor SFC support.

This package is **ESM-only** — no CJS build. Node ≥22 `import`, bundlers, and
`<script type="module">` all work; for classic `<script>` tags use the [IIFE variants](#iife--cdn-variants).

> **RC tracking.** This lib follows Vue 3.6 through its release candidates. The Vapor wrappers are
> transitional surfaces that will realign once 3.6 ships stable. See [ROADMAP.md](ROADMAP.md) for
> what is stable today versus transitional.

<details>
<summary><b>Other integrations</b> — Laravel, Astro, performance tuning, API docs</summary>

- **Laravel** — [docs/integrations/laravel.md](docs/integrations/laravel.md) covers the backend
  deliverables (route, controller, action classes, CSRF flows, Sanctum, Inertia coexistence,
  Filament panels, Reverb realtime, queued commands). Runnable PHP companions in
  [examples/laravel-backend/](examples/laravel-backend).
- **Astro** — [examples/exo-astro](examples/exo-astro) is a declarative directive set (`v-scope`,
  `v-command`, `v-bind-text`, `v-show`) for coordinating independent page sections, with
  `onMissing: 'buffer'` so sections can dispatch before their handlers hydrate.
- **Performance & tuning** — [docs/performance.md](docs/performance.md): what's optimized by
  default, the tuning knobs (`persist({ coalesce: true })`, `configureUid`, `configureSignal`),
  variant selection, benchmark snapshot.
- **API reference** — generate locally with `npm run docs` (TypeDoc → `docs/api/`). The generated
  site is `.gitignore`d so it stays fresh per release.

</details>

## Quick start

```typescript
import { createCommandBus, logger, validator } from 'vapor-chamber';

const bus = createCommandBus();

bus.use(logger());
bus.use(validator({
  cartAdd: (cmd) => cmd.payload?.quantity > 0 ? null : 'Quantity required',
}));

bus.register('cartAdd', (cmd) => {
  cart.items.push({ ...cmd.target, quantity: cmd.payload.quantity });
  return cart.items;
});

const result = bus.dispatch('cartAdd', product, { quantity: 2 });
result.ok ? console.log('Added:', result.value) : console.error(result.error);
```

<details>
<summary><b>Define each command once</b> — one schema literal drives types, validation, the backend, and AI tools</summary>

```ts
// commands.ts
import { defineSchema, createSchemaCommandBus, setCommandBus, type CommandsOf } from 'vapor-chamber';

export const schema = defineSchema({
  cartAdd: {
    description: 'Add a product to the cart',
    target:  { id: 'number', name: 'string' },
    payload: { qty: 'number' },
    result:  { count: 'number', total: 'number' },
  },
});

setCommandBus(createSchemaCommandBus(schema));   // typed dispatch + runtime validation

declare module 'vapor-chamber' {                 // typed useCommand() everywhere
  interface GlobalCommands extends CommandsOf<typeof schema> {}
}
```

From the same schema: `bus.toTools()` (Anthropic/OpenAI), `vapor-chamber/mcp` (agents drive your
commands over MCP, whitelisted, stamped `meta.origin`), and
`node scripts/generate-laravel.mjs commands.mjs` (Laravel config registry + action-class stubs with
validation rules). Misspell an action or a field in a component and it's a compile error, not a
runtime 404.

</details>

<details>
<summary><b>Gotcha:</b> module-scope signals created before Vue boots</summary>

Vue detection is asynchronous. A `signal()` / `useCommandState()` created at **module scope**
(before `createApp` runs) may be created before Vue is detected — it stays a plain `{ value }`
object and never becomes reactive. A one-shot dev-mode warning fires when this happens.

```ts
// 1. Create reactive state inside components / after app boot (usual case), or
// 2. await detection explicitly for module-scope state:
import { waitForVueDetection, signal } from 'vapor-chamber';
await waitForVueDetection();
export const count = signal(0); // now Vue-reactive
```

</details>

## Router

`vapor-chamber/router` is a router for Vue 3.6 over **one thin server catch-all**
(`/admin/{any?}` → shell → one island). **Path = navigation, query = state.** Route tables and
data loaders are delivered as *data*, not as a hand-written config module.

The split with the bus is deliberate: **the bus owns writes (commands), the router owns reads
(URL-addressed data).**

```ts
import { createRouter } from 'vapor-chamber/router';
import { fetchLoaders } from 'vapor-chamber/router-fetch';
import { RouterOutlet } from 'vapor-chamber/router/vdom';

const router = createRouter({
  base: '/admin',
  routes: adminRoutes,                    // generated module, or { inline } / { url }
  loaders: fetchLoaders(),                // or your own LoaderHandlers preset
  components: {
    'Catalog/ListPage': () => import('./pages/CatalogList.vue'),
  },
});

app.use(router);   // register RouterOutlet locally where you render it
```

**Composables:** `useRouter` `useRoute` `useQueryParam` `useRouteData` `useRouteError` `useMenu`
`useBreadcrumbs` `usePagination` `onBeforeLeave` — all scope-auto-disposing.

### The two-layer URL model

| change | what happens |
|---|---|
| **path** | resolve → guards → components + loaders in parallel (aborted on supersede) → **one atomic frozen snapshot commit**. A page never renders with the previous page's data. |
| **query / hash** | fast path: location commits immediately — **no matching, no guards, no remount**. Only loaders that depend on a changed key refetch, patching `snapshot.data` when they land. |

So `page.value = 3` on a typed query param repaginates a list without ever unmounting it.

### The vDOM boundary

`RouterOutlet` is a `defineComponent` + `h()` component, so anything that reaches it *statically*
pins Vue's virtual-DOM runtime into your bundle. It therefore lives behind its own subpath, and
`app.use(router)` deliberately does **not** register it globally. Measured on built `dist/`:

| entry | bindings retained from `vue` | brotli |
|---|---|--:|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` | 12.3 KB |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` | 0.4 KB |

A Vapor app that never renders an outlet pays nothing for the vDOM runtime. Blade rows need no
import from you — the router pulls `makeBladeComponent` in on demand, as its own chunk, the first
time it renders one.

**Vapor interop, measured on rc.3** (not inferred from the roadmap): provide/inject works in Vapor
at *both* levels — app-level, which backs every composable, and component-level, which backs nested
outlet depth. What still ties the outlet to vDOM is its own render path, not an upstream gap.

Full guide, loader SPI, and Blade migration path: **[docs/router.md](docs/router.md)**.

## Vue 3.6 Vapor Mode

Vue Vapor compiles templates to direct DOM operations using **signals** instead of diffing a
virtual tree. Vapor Chamber embraces the same philosophy: minimal abstraction, direct updates,
signal-native reactivity. It works in three contexts.

<details>
<summary><b>1. Pure Vapor app</b> (smallest bundle)</summary>

```typescript
import { createVaporChamberApp } from 'vapor-chamber';
import App from './App.vue';

createVaporChamberApp(App).mount('#app');   // no vDOM runtime
```

```vue
<script setup vapor>
import { useCommand } from 'vapor-chamber';
const { dispatch, loading } = useCommand();
</script>
```

</details>

<details>
<summary><b>2. Mixed vDOM + Vapor</b> (gradual migration)</summary>

```typescript
import { createApp } from 'vue';
import { getVaporInteropPlugin } from 'vapor-chamber';

const app = createApp(App);
const interop = getVaporInteropPlugin();
if (interop) app.use(interop);
app.mount('#app');
```

Vapor and vDOM components can now nest inside each other.

</details>

<details>
<summary><b>3. Standard Vue 3</b> (no Vapor) + detection</summary>

Everything works without Vapor — the signal shim auto-detects Vue's `ref()`. In Vue 3.6+ that is
alien-signals backed.

```typescript
import { isVaporAvailable } from 'vapor-chamber';
if (isVaporAvailable()) { /* Vue 3.6+ with createVaporApp available */ }
```

Note that Vapor ships as a **physically separate dist file**
(`vue/dist/vue.runtime-with-vapor.esm-*.js`) — a bare `import 'vue'` never resolves to it outside a
bundler's per-app alias. Never mix that build with a plain `import 'vue'` in one context: two
separately-imported Vue dists are two disconnected reactivity instances, and the failure is silent.

</details>

## Core Concepts

A command has three parts — **action** (what to do), **target** (what to act on), and an optional
**payload**:

```typescript
bus.dispatch('cartAdd', product, { quantity: 2 });
```

Every dispatch returns `{ ok: boolean, value?: any, error?: Error }`.

<details>
<summary><b>Handlers, naming, and results</b></summary>

One handler per action. Returns a value or throws:

```typescript
bus.register('cartAdd', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items;    // becomes result.value
});

// with undo support and per-command throttling
bus.register('cartAdd', addHandler, {
  undo: (cmd) => { cart.items.pop(); },
  throttle: 300,   // max once per 300ms per target
});
```

Enforce naming conventions at register and dispatch time:

```typescript
const bus = createCommandBus({
  naming: { pattern: /^[a-z][a-zA-Z0-9]+$/, onViolation: 'throw' },  // or 'warn' / 'ignore'
});
bus.register('cartAdd', handler);    // ✓
bus.register('cart_add', handler);   // ✗ throws
```

</details>

<details>
<summary><b>Plugins and before/after hooks</b></summary>

Plugins wrap handlers — they can modify commands, short-circuit, observe results, or transform
output:

```typescript
const timingPlugin: Plugin = (cmd, next) => {
  const start = Date.now();
  const result = next();
  console.log(`${cmd.action} took ${Date.now() - start}ms`);
  return result;
};
bus.use(timingPlugin);
```

Execution is by priority (highest first), then registration order:

```typescript
bus.use(validatorPlugin, { priority: 10 }); // first
bus.use(analyticsPlugin, { priority: 1 });
bus.use(loggerPlugin);                      // priority 0 (default), last
```

Before hooks run ahead of the handler; throw to cancel (the dispatch returns `{ ok: false }`):

```typescript
bus.onBefore((cmd) => {
  if (!user.isAuth && protectedActions.includes(cmd.action)) throw new Error('Unauthenticated');
});
bus.onBefore(() => { isLoading.value = true; });
bus.onAfter(()  => { isLoading.value = false; });

// on an async bus, hooks can be async
asyncBus.onBefore(async (cmd) => { await rateLimiter.check(cmd.action); });
```

</details>

<details>
<summary><b>Wildcard listeners, query, and domain events</b></summary>

```typescript
bus.on('*', (cmd, result) => analytics.track(cmd.action));   // all commands
bus.on('cart*', (cmd, result) => console.log(cmd.action));   // prefix
bus.once('cartAdd', () => showConfetti());                   // fires once
bus.offAll('cart*');                                         // remove by pattern
bus.offAll();                                                // remove all
```

`query()` is `dispatch()` minus the `onBefore` hooks — reads shouldn't trigger mutation gates
(auth checks, spinners, optimistic updates). Plugins and `onAfter` still fire. This is the CQRS
separation: `dispatch()` writes, `query()` reads.

```typescript
bus.register('getUser', (cmd) => db.users.find(cmd.target.id));
const result = bus.query('getUser', { id: 42 });
```

`emit()` fires a domain event — notifies `on()` listeners, needs no handler, returns no result:

```typescript
bus.on('orderCreated', (cmd) => analytics.track('order', cmd.target));
bus.emit('orderCreated', { orderId: 42, total: 99.50 });
```

</details>

<details>
<summary><b>Metadata, structured errors, and introspection</b></summary>

Every dispatched command is auto-stamped with `meta`:

```typescript
bus.onAfter((cmd) => {
  cmd.meta.id;              // unique per dispatch (counter-based; UUID via configureUid)
  cmd.meta.ts;              // Date.now()
  cmd.meta.correlationId;   // trace ID for command chains
});

bus.dispatch('orderShip', order, {
  __correlationId: originalCommand.meta.id,
  __causationId:   originalCommand.meta.id,
});
```

Every error has a machine-readable code, severity, and emitter:

```typescript
import { BusError } from 'vapor-chamber';

const result = bus.dispatch('missing', {});
if (!result.ok && result.error instanceof BusError) {
  result.error.code;      // 'VC_CORE_NO_HANDLER'
  result.error.severity;  // 'error'
  result.error.emitter;   // 'core'
  result.error.context;   // extra data (e.g. retryIn for throttle)
}
```

Codes include `VC_CORE_NO_HANDLER`, `VC_CORE_THROTTLED`, `VC_CORE_REQUEST_TIMEOUT`,
`VC_PLUGIN_CIRCUIT_OPEN`, `VC_PLUGIN_RATE_LIMITED`. `ERROR_CODE_REGISTRY` is the full lookup table
with fix suggestions.

`inspectBus()` returns a topology snapshot — tree-shakeable, not bundled unless imported:

```typescript
const info = inspectBus(bus);
info.actions;          // ['cartAdd', 'cartRemove', ...]
info.undoActions;      // actions with registered undo handlers
info.pluginCount;      // 3
info.pluginPriorities; // [10, 5, 0]
info.sealed;           // false
info.dispatchDepth;    // 0 (increments during nested dispatch)
info.activeTimers;     // throttle timers currently running
```

</details>

<details>
<summary><b>Chambers, workflows (sagas), and reactions</b></summary>

```typescript
import { createChamber, createWorkflow, createReaction } from 'vapor-chamber';

// Group handlers under a namespace
const cart = createChamber('cart', { add: handleAdd, remove: handleRemove });
cart.install(bus);   // registers cartAdd, cartRemove

// Saga: sequential steps with automatic compensation
const checkout = createWorkflow([
  { action: 'cartValidate' },
  { action: 'paymentReserve', compensate: 'paymentRelease' },
  { action: 'orderCreate',    compensate: 'orderCancel' },
]);
await checkout.run(bus, { cartId });   // compensates on failure

// Declarative cross-domain reaction
createReaction('cartAdd', 'inventoryCheck', {
  when: (cmd, result) => result.ok,
  map:  (cmd) => ({ itemId: cmd.payload.itemId }),
}).install(bus);
```

</details>

<details>
<summary><b>supersede</b> — auto-cancel the previous in-flight dispatch</summary>

Genuinely aborts the stale request via `AbortController` rather than ignoring it on arrival. Ideal
for type-ahead search, autosave, or any rapidly re-fired command where only the latest matters.

```typescript
import { createAsyncCommandBus, supersede } from 'vapor-chamber';

const bus = createAsyncCommandBus();
bus.use(supersede());   // default key = commandKey(action, target)

bus.use(supersede({
  actions: ['searchQuery', 'draftSave'],                   // globs; default: all
  key: (cmd) => `${cmd.action}:${cmd.target?.id ?? ''}`,   // null/undefined to skip
}));
```

Because the bridges forward `cmd.signal` into their outbound `fetch`, a superseded HTTP request is
cancelled at the network layer.

</details>

<details>
<summary><b>Batch dispatch, transactions, and dead letters</b></summary>

```typescript
const result = bus.dispatchBatch([
  { action: 'cartAdd',      target: cart, payload: item },
  { action: 'totalsUpdate', target: cart },
]);
// stops at first failure by default

bus.dispatchBatch(commands, { continueOnError: true });
// result.successCount / result.failCount / result.results
```

`transactional: true` gives all-or-nothing execution — on failure, previously successful commands
roll back via their registered undo handlers:

```typescript
bus.register('paymentCharge', chargeHandler, { undo: refundHandler });

const result = bus.dispatchBatch([
  { action: 'inventoryReserve', target: item },
  { action: 'paymentCharge',    target: payment },
], { transactional: true });

if (!result.ok) console.log('Rollbacks:', result.rollbacks);
```

What happens when no handler is registered is configurable:

```typescript
createCommandBus()                                // default: { ok: false, error }
createCommandBus({ onMissing: 'throw' })
createCommandBus({ onMissing: 'ignore' })         // { ok: true, value: undefined }
createCommandBus({ onMissing: (cmd) => { … } })   // custom fallback
```

</details>

<details>
<summary><b>Request/response, async bus, and LLM schemas</b></summary>

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';

const bus = createAsyncCommandBus();
bus.register('userFetch', async (cmd) => (await fetch(`/api/users/${cmd.target.id}`)).json());
const result = await bus.dispatch('userFetch', { id: 123 });
```

Request/response with timeout — falls back to normal `dispatch()` if no responder is registered:

```typescript
bus.respond('getAuthToken', async () => (await fetch('/api/token')).json());
const result = await bus.request('getAuthToken', { userId: 42 }, { timeout: 3000 });
```

Schemas for LLM system prompts, so models don't hallucinate methods or error codes:

```typescript
import { describeErrorCodes, busApiSchema, getErrorEntry } from 'vapor-chamber';

const errorTable = describeErrorCodes();
const apiSchema  = busApiSchema();
getErrorEntry('VC_CORE_NO_HANDLER')?.fix;   // "Register a handler with bus.register(...)"
```

</details>

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
| `optimisticUndo(bus, actions, opts?)` | Auto-rollback via registered undo handlers |
| `retry(options)` | Retry failed async dispatches with backoff |
| `persist(options)` | Auto-save state to localStorage after commands |
| `sync(options, bus?)` | Broadcast commands across browser tabs |

Extras (same import): `cache`, `circuitBreaker`, `rateLimit`, `metrics`.

<details>
<summary><b>Usage for each plugin</b></summary>

```typescript
// logger / validator
bus.use(logger({ collapsed: true, filter: (cmd) => cmd.action.startsWith('cart') }));
bus.use(validator({
  cartAdd: (cmd) => cmd.target?.id ? null : 'Product must have an ID',   // null = valid
}));

// history — optionally bus-backed, so undo() executes registered inverse handlers
const historyPlugin = history({ maxSize: 100, bus });
bus.use(historyPlugin);
historyPlugin.undo();
historyPlugin.redo();
historyPlugin.getState();   // { past, future, canUndo, canRedo }

// debounce / throttle
bus.use(debounce(['searchQuery'], 300));
bus.use(throttle(['uiScroll'], 100));

// authGuard
bus.use(authGuard({
  isAuthenticated: () => !!user.value,
  protected: ['shopCart', 'shopWishlist'],
  onUnauthenticated: (cmd) => router.push('/login'),
}));

// optimistic — apply returns its own rollback
bus.use(optimistic({
  cartAdd: { apply: (cmd) => { cartCount.value++; return () => { cartCount.value--; }; } },
}));

// extras
bus.use(cache({ ttl: 60_000, actions: ['getUser*'] }));
bus.use(circuitBreaker({ threshold: 5, resetTimeout: 30_000 }));
bus.use(rateLimit({ max: 10, window: 1000 }));

const m = metrics();
bus.use(m);
m.summary();   // { cartAdd: { count: 42, avgMs: 1.2, errorRate: 0.02 } }
```

**optimisticUndo** — automatic rollback using registered undo handlers, on sync or async buses:

```typescript
bus.register('cartAdd', async (cmd) => api.addToCart(cmd.target), {
  undo: (cmd) => api.removeFromCart(cmd.target.id),
});

bus.use(optimisticUndo(bus, ['cartAdd'], {
  predict: (cmd) => ({ ...cart, items: [...cart.items, cmd.target] }),
  onRollback: (cmd, error) => toast.error(`Rolled back: ${error.message}`),
  onRollbackError: (cmd, undoErr, origErr) => console.error('Undo failed:', undoErr),
}));
```

**retry** — async bus only:

```typescript
bus.use(retry({ maxAttempts: 3, baseDelay: 200 }));            // exponential (default)
bus.use(retry({
  actions: ['api*'], maxAttempts: 5, baseDelay: 500, strategy: 'fixed',
  isRetryable: (err) => err.message !== 'Unauthorized',
}));
```

**persist** — auto-save after each successful command:

```typescript
const cartPersist = persist({ key: 'vc:cart', getState: () => cartState.value });
bus.use(cartPersist);

const saved = cartPersist.load();      // rehydrate before rendering
if (saved) cartState.value = saved;

cartPersist.save();    // force
cartPersist.clear();
bus.use(persist({ key: 'vc:cart', getState, storage: sessionStorage }));   // custom backend
```

**sync** — broadcast successful commands to other tabs via `BroadcastChannel`:

```typescript
const tabSync = sync(
  { channel: 'vapor-chamber:app', filter: (cmd) => cmd.action.startsWith('cart') },
  bus,   // pass the bus so received messages are re-dispatched locally
);
bus.use(tabSync);
tabSync.close();
```

</details>

## Transport Layer

Send commands to a backend over HTTP, WebSocket, or SSE. Import from `vapor-chamber/transports`.

| Bridge | Use for |
|---|---|
| `createHttpBridge` | POST command envelopes; unhandled commands fall through to the server |
| `createBatchingHttpBridge` | Same contract, but coalesces a tick's dispatches into one POST |
| `createWsBridge` | WebSocket with auto-reconnect and a reactive `connected` signal |
| `createSseBridge` | Server pushes commands to the client |
| `createEchoBridge` | Laravel Echo / Reverb channels → `bus.emit()` |

<details>
<summary><b>HTTP bridge</b> — CSRF, retry, timeouts, scope cancellation</summary>

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';
import { createHttpBridge } from 'vapor-chamber/transports';

const bus = createAsyncCommandBus({ onMissing: 'ignore' });

bus.use(createHttpBridge({
  endpoint: '/api/commands',
  csrf: true,                                 // reads XSRF-TOKEN cookie / meta tag
  csrfCookieUrl: '/sanctum/csrf-cookie',      // default; '' disables the refresh fetch
  retry: 2,                                   // 5xx / 429 / 408
  noRetry: ['paymentCharge', 'orderPlace'],   // never retry non-idempotent commands
  timeout: 8000,
  actions: ['order*'],                        // only forward these; others stay local
}));

await bus.dispatch('orderCreate', { items: cart });
// → POST /api/commands  { command: 'orderCreate', target: { items: … } }
```

Response shape — `result.value` is the contents of `state`:

```json
{ "state": { "orderId": 42, "status": "pending" } }
```

Cancel in-flight requests when a Vapor scope is disposed:

```typescript
const ctrl = new AbortController();
onScopeDispose(() => ctrl.abort());
bus.use(createHttpBridge({ endpoint: '/api/vc', scopeController: ctrl }));
```

</details>

<details>
<summary><b>Batching HTTP bridge</b> — one round trip per tick</summary>

Same backend contract as `createHttpBridge` (CSRF, retry, timeout, session-expiry all reuse the
same request path), but commands dispatched within a window coalesce into a single POST and are
matched back to each caller by id. Invisible to the call site — each `dispatch()` still resolves
with its own result.

```typescript
bus.use(createBatchingHttpBridge({
  endpoint: '/api/vc/batch',
  csrf: true,
  window: 'microtask',   // default: same-tick coalescing, zero added latency
  // window: 20,         // or hold the queue open N ms to catch separate ticks
}));

bus.dispatch('formSet', { field: 'email' }, { value: 'a@b.com' });
bus.dispatch('cartAdd', product, { quantity: 2 });
// → ONE HTTP round trip
```

```json
// → POST /api/vc/batch
{ "commands": [{ "id": "c1", "command": "formSet", "target": { "field": "email" } }] }
// ←
{ "results": [{ "id": "c1", "ok": true, "state": {} }] }
```

</details>

<details>
<summary><b>WebSocket, SSE, and Laravel Echo</b></summary>

```typescript
const ws = createWsBridge({
  url: 'wss://api.example.com/commands',
  actions: ['chat*', 'presence*'],
  timeout: 10_000,     // per-message response timeout
  maxQueueSize: 100,   // queued messages while disconnected
  reconnect: true,
  maxReconnects: 10,
});
bus.use(ws);
ws.connect();

ws.isConnected();      // imperative
ws.connected.value;    // reactive signal — bindable in templates, no polling
ws.disconnect();       // intentional close, suppresses reconnect
```

```typescript
bus.use(createSseBridge({ url: '/api/events' }));
```

Echo / Reverb — you pass your own instance, so the library never imports `laravel-echo`:

```typescript
const realtime = createEchoBridge({
  echo,
  channels: [
    { name: `user.${userId}`, type: 'private',  events: ['OrderShipped'] },
    { name: 'lobby',          type: 'presence', events: ['MessagePosted'] },
  ],
});
realtime.install(bus);   // OrderShipped → bus.emit('OrderShipped', payload)
// realtime.teardown();
```

</details>

## HTTP Client

Two levels over the same retry/timeout/CSRF machinery:

- **`postCommand`** — the single-purpose POST helper `createHttpBridge` builds on. For one-off HTTP
  control outside the transport plugin.
- **`createHttpClient`** — a full client (GET/POST/PUT/PATCH/DELETE) with interceptors, LRU
  caching, request dedup, safe mode, and file download. For any HTTP need in an app already using
  vapor-chamber, command-bus or not.

<details>
<summary><b>Client usage, caching, and error classification</b></summary>

```typescript
import { createHttpClient } from 'vapor-chamber';

const http = createHttpClient({ baseURL: '/api', csrf: true });

await http.get('/users', { params: { page: 1 } });
await http.post('/cart', { itemId: 1, qty: 2 });
await http.delete('/cart/1');

const result = await http.safe.post('/login', credentials);   // never throws
if (result.error) console.log(result.error.message);

await http.download('/export/csv', 'products.csv');

http.interceptors.request.use((config) => {
  config.headers = { ...config.headers, 'X-Custom': '1' };
  return config;
});

const adminHttp = http.create({ baseURL: '/admin/api' });   // shares interceptors
```

Retry (default 2 for GET, 0 for mutations) covers 5xx/429/408 **and** timeouts — a timeout competes
for the same retry budget instead of always failing on the first attempt. `TimeoutError` stays
distinct from a caller-triggered `AbortError`.

**Caching (GET only)** — `cache: true` for a flat TTL, or an object for more:

```typescript
// Stale-while-revalidate: a hit past `ttl` but inside `ttl + staleTtl` is served
// instantly (stale: true) while a background fetch refreshes it.
const res = await http.get('/dashboard/stats', { cache: { ttl: 30_000, staleTtl: 5 * 60_000 } });
if (res.revalidation) { const fresh = await res.revalidation; }

// serveStaleOnError: a *transient* failure with a retained entry resolves instead
// of rejecting — { data, stale: true, servedOnError: true, error }.
// Business errors (4xx) are never masked this way.
await http.get('/dashboard/stats', { cache: { ttl: 30_000, serveStaleOnError: true } });
```

`classifyError(error)` is the one named transience rule behind `serveStaleOnError`:
`transient = timeout || no response || status >= 500`. A 4xx is always a business error, never
transient, no matter how tempting it is to retry a flaky-looking 429.

**`silent`** — per-request opt-out for a host-provided global error handler:

```typescript
await http.post('/analytics/beacon', payload, { silent: true }).catch((e) => {
  e.silent;   // true — a global handler can check this and skip the toast
});
```

</details>

<details>
<summary><b>Streaming JSON parser</b></summary>

`vapor-chamber/stream-parser` — a dependency-free incremental JSON parser for progressively
consuming a streamed `fetch()`/SSE body without buffering the whole payload (LLM completions, large
exports). Subpath-only; adds nothing to the IIFE bundles.

```typescript
import { createStreamParser } from 'vapor-chamber/stream-parser';

const parser = createStreamParser({
  onValue: (key, value, path) => console.log(key, value, path),
});
await parser.stream(await fetch('/api/stream'));
```

</details>

## Vapor Composables

| Composable | Use when |
|---|---|
| `useCommand()` | You need reactive `loading` / `lastError` |
| `defineVaporCommand()` | Hot path — zero reactive overhead |
| `useCommandBus()` | You just need to dispatch |
| `useCommandState()` | State reduced by commands |
| `useCommandHistory()` | Reactive undo/redo |
| `useCommandGroup()` | Namespace isolation across feature modules |
| `useCommandError()` | Component-scoped error boundary |
| `createFormBus()` | Forms — per-field validation, dirty tracking |

`useCommand` uses no `getCurrentInstance()`, so it is Vapor-safe: the same API works in
`<script setup vapor>` and vDOM components alike, with auto-cleanup on scope disposal.

**Dispatching from inside a reactive effect.** A dispatch is an *action*, not a read, so
nothing the handler touches should make the caller re-run. Every composable here suspends
reactive tracking around its bus call, so this is handled for you. If you reach for a **raw
bus** inside an effect, wrap it:

```ts
import { untracked, getCommandBus } from 'vapor-chamber/vue';

watchEffect(() => {
  // without untracked(), anything the HANDLER reads becomes a dependency of
  // this effect — it would re-run on state it never mentions
  untracked(() => getCommandBus().dispatch('cartSync', cart));
});
```

**Import from `vapor-chamber/vue` in a Vue app.** Note the subpath — it is not cosmetic. The
package root has to work with no Vue in the tree, so it finds Vue's tracking primitives through
a runtime lookup that resolves under a dev server and **fails in a production bundle**, where a
bare specifier has nothing to resolve against. `untracked()` then silently becomes a
pass-through and your effects start re-running on state they never mention. `vapor-chamber/vue`
imports those primitives statically, so your bundler resolves them at build time and there is
nothing left to fail — importing it is the whole setup, there is no call to make. The same
composables (`useCommand`, `useCommandState`, …) are re-exported from there, and they are the
same functions, not copies.

`untracked()` is a plain pass-through when Vue is absent, so the root import stays safe in code
shared between Vue and non-Vue targets — it just cannot suspend tracking there. In DEV it warns
once if it is running as a pass-through on a page that *does* have Vue.

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

<details>
<summary><b>Full surface</b> — register, on, emit, dispose</summary>

```vue
<script setup vapor>
const { dispatch, register, on, emit, loading, lastError, dispose } = useCommand();

register('cartAdd', (cmd) => addToCart(cmd.target));   // scoped to this component
on('cart*', (cmd, result) => console.log('Cart event:', cmd.action));
dispatch('cartAdd', product, { quantity: 1 });
emit('cartChanged', { count: 1 });
// auto-cleanup via onScopeDispose — or call dispose() manually
</script>
```

</details>

<details>
<summary><b>defineVaporCommand, useCommandState, history, groups, errors</b></summary>

`defineVaporCommand` creates no reactive `loading`/`lastError` signals — for telemetry,
scroll sampling, debounced search, autosave:

```vue
<script setup vapor>
const { dispatch } = defineVaporCommand('telemetryEvent', (cmd) => {
  sendMetric(cmd.target.name, cmd.target.params);
});
dispatch({ event: 'page_view', params: { page: '/shop' } });
</script>
```

```typescript
// state reduced by commands
const { state: cart } = useCommandState({ items: [], total: 0 }, {
  cartAdd: (state, cmd) => ({
    items: [...state.items, cmd.target],
    total: state.total + cmd.target.price,
  }),
});

// reactive undo/redo
const { canUndo, canRedo, undo, redo } = useCommandHistory({
  filter: (cmd) => cmd.action.startsWith('editor'),
});

// namespace isolation — all calls prefixed in camelCase
const cart = useCommandGroup('cart');
cart.register('add', handler);   // registers 'cartAdd'
cart.dispatch('add', product);   // dispatches 'cartAdd'
cart.on('*', listener);          // listens to 'cart*'

// component-scoped error boundary
const { errors, latestError, clearErrors } = useCommandError({
  filter: (cmd) => cmd.action.startsWith('cart'),
});
```

</details>

<details>
<summary><b>createFormBus</b> — reactive forms on the bus</summary>

Per-field validation, dirty tracking, and the full plugin pipeline on every form command.

```typescript
const form = createFormBus({
  fields: { email: '', password: '' },
  rules: {
    email:    (v) => v.includes('@') ? null : 'Invalid email',   // sync — runs on every set()
    password: (v) => v.length >= 8   ? null : 'Too short',
    username: async (v) => await api.isUsernameTaken(v) ? 'Taken' : null,  // async — only on submit()
  },
  onSubmit: async (values) => await api.login(values),
});

form.use(logger());   // plugins attach like any bus

form.values.value; form.errors.value; form.isDirty.value; form.isValid.value; form.isSubmitting.value;

form.set('email', 'user@example.com');   // update + re-validate
form.touch('email');
await form.submit();                     // validate → onSubmit → boolean
form.reset();
```

**Headless mode** — `reactive: false` skips signal allocation for server-side, batch, or non-UI
use. All APIs work identically.

```vue
<input :value="form.values.value.email"
       @input="form.set('email', $event.target.value)"
       @blur="form.touch('email')" />
<span v-if="form.touched.value.email && form.errors.value.email">
  {{ form.errors.value.email }}
</span>
<button :disabled="!form.isValid.value || form.isSubmitting.value" @click="form.submit()">
  Submit
</button>
```

</details>

## Bundle sizes

Minified, comment-free, brotli q=11. Always-current per-export table:
**[docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md)** (`npm run size:doc`); `npm run size:check` fails CI
on any regression past budget.

| Entry | brotli |
|---|--:|
| dispatch core (`createCommandBus`, tree-shaken) | **~3.6 KB** |
| `vapor-chamber` (main barrel, import-*everything*) | 24.0 KB |
| `vapor-chamber/router` | 12.3 KB |
| `vapor-chamber/router/vdom` | 0.4 KB |
| `vapor-chamber/router-fetch` | 3.9 KB |
| `vapor-chamber/vue` | 7.4 KB |
| `vapor-chamber/reactive` | 5.2 KB |
| `vapor-chamber/transports` | 4.2 KB |
| `vapor-chamber/outbox` | 1.9 KB |
| `vapor-chamber/mcp` | 1.7 KB |
| `vapor-chamber/ssr` | 0.7 KB |

**Rows are not additive** — the shared core is included in every row and counted once. `.` is the
barrel measured import-everything; your bundler drops what you don't use.

These are brotli, hand-copied from [docs/BUNDLE-SIZES.md](./docs/BUNDLE-SIZES.md), which is
generated by `npm run size:doc` and verified fresh in CI. That file is the source of truth —
this table had drifted low on 7 of 9 rows before it was last reconciled, so trust the generated
one if the two ever disagree.

### IIFE / CDN variants

Three `<script>`-tag drop-ins. Pick by audience, not feature checklist.

| Variant | Audience | Min | Brotli | Gzip |
|---|---|--:|--:|--:|
| **core** | Sprinkled JS on server-rendered pages (Blade, Rails, Django, WordPress). You dispatch user actions to a backend over HTTP. | 26.1 KB | 7.6 KB | 8.4 KB |
| **elements** | Embeddable widgets (chat bubbles, checkout buttons, third-party drop-ins). You ship a `<vc-widget>` custom element. | 27.7 KB | 8.0 KB | 8.9 KB |
| **full** | SPAs that grew big enough to want everything (realtime, undo/redo, persistence, full Vapor surface). | 38.1 KB | 11.1 KB | 12.3 KB |

<details>
<summary><b>What's in each variant</b>, plus drop-in examples</summary>

| Surface | core | elements | full |
|---|:--:|:--:|:--:|
| Bus (`createCommandBus`, `createAsyncCommandBus`) | ✅ | ✅ | ✅ |
| `createApp()`, `connect()` one-liner | ✅ | ✅ | ✅ |
| HTTP transport | ✅ | ✅ | ✅ |
| Light plugins (logger, validator, debounce, throttle, retry, authGuard) | ✅ | ✅ | ✅ |
| `defineVaporCustomElement`, `defineWidget()` | ❌ | ✅ | ✅ |
| WebSocket / SSE | ❌ | ❌ | ✅ |
| Heavy plugins (persist, sync, history, optimistic) | ❌ | ❌ | ✅ |
| `mount()` | ❌ | ❌ | ✅ |
| Full Vapor (`defineVaporComponent`, async/Suspense) | ❌ | ❌ | ✅ |

```html
<!-- core: dispatch over HTTP, CSRF auto-wired -->
<script src=".../vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  document.getElementById('add')
    .addEventListener('click', () => dispatch('cartAdd', { id: 42 }));
</script>
```

```html
<!-- elements: register a custom-element widget in one call -->
<script src=".../vapor-chamber-elements.iife.min.js"></script>
<script>
  VaporChamber.defineWidget('vc-cart', {
    props: { sku: String },
    setup(props) { return () => h('span', `SKU ${props.sku}`); },
  });
</script>
<vc-cart sku="ABC-123"></vc-cart>
```

> **Variant contents are not under semver before v2.0.** While Vue 3.6 is in RC, the lib reserves
> the right to move APIs between IIFE variants. ESM consumers get the full surface and are
> unaffected.

</details>

### Subpath exports

```
vapor-chamber                  → core + composables + everything (tree-shaken)
vapor-chamber/router           → the router: table, engine, dom, loader SPI (no vDOM)
vapor-chamber/router/vdom      → RouterOutlet, makeBladeComponent (opts into vDOM)
vapor-chamber/router-fetch     → in-box loader preset for plain-JSON backends
vapor-chamber/transports       → HTTP + WebSocket + SSE + Echo bridges
vapor-chamber/directives       → v-command Vue directive
vapor-chamber/vite             → Vite HMR plugin
vapor-chamber/transitions      → View Transitions API helpers
vapor-chamber/ssr              → SSR dehydrate/replay helpers
vapor-chamber/devtools         → Vue DevTools integration
vapor-chamber/stream-parser    → incremental JSON parser for streamed bodies
vapor-chamber/fast-lane        → minimal-allocation dispatcher for real-real-hot loops
                                 (game ticks, trading data, audio, scroll) — not a bus
vapor-chamber/observable       → Symbol.observable interop — RxJS / xstream / callbag
vapor-chamber/standard-schema  → Standard Schema v1 validator (Zod / Valibot / ArkType)
vapor-chamber/alien-signals    → alien-signals as the reactive primitive (non-Vue contexts)
vapor-chamber/reactive         → opt-in DEEP reactivity (core signal() is shallow+fast)
vapor-chamber/outbox           → offline outbox: durable queue + ordered replay
vapor-chamber/mcp              → zero-dep MCP server from your schema bus
vapor-chamber/iife[-core|-elements] → IIFE bundles
```

## Architecture

The **core** is framework-agnostic, zero-dependency, and the only required part. Everything else is
optional and tree-shaken when unimported.

```
┌─────────────────────────────────────────────────────────┐
│  CORE  (zero deps · fully tested · framework-agnostic)  │
│  command-bus.ts  ·  testing.ts                          │
└────────────────────────┬────────────────────────────────┘
                         │ optional layers (tree-shaken)
         ┌───────────────┼───────────────┬───────────────┐
         ▼               ▼               ▼               ▼
   Vue composables    Plugins        Transport        Router
   chamber.ts         plugins-core   http.ts          router/
   chamber-vapor.ts   plugins-io     transports.ts    router-fetch/
         │
         ▼
   Extras (per-feature opt-in)
   form.ts · schema.ts · devtools.ts · directives.ts · vite-hmr.ts
```

**Coverage:** 97.1% statements · 91.9% branches · 96.8% functions · 98.3% lines across **1491 tests**
(92 files). The dispatch core is at 100% line + branch + function. Per-file table:
[docs/COVERAGE.md](docs/COVERAGE.md); run `npm run test:coverage` for live numbers.

## Testing

`createTestBus()` records all dispatched commands without executing real handlers.

```typescript
import { createTestBus, setCommandBus, resetCommandBus } from 'vapor-chamber';

beforeEach(() => { bus = createTestBus(); setCommandBus(bus); });
afterEach(()  => { resetCommandBus(); });

it('dispatches cartAdd on click', () => {
  expect(bus.wasDispatched('cartAdd')).toBe(true);
  expect(bus.getDispatched('cartAdd')[0].cmd.payload).toEqual({ quantity: 1 });
});
```

<details>
<summary><b>Snapshot & time-travel</b> — replay command sequences</summary>

```typescript
const snap = bus.snapshot();          // immutable RecordedDispatch[]
bus.travelTo(1);                      // commands 0..1 inclusive
bus.travelToAction('cartAdd');        // up to last occurrence
bus.travelTo(999);                    // out-of-range indices clamp
```

</details>

<details>
<summary><b>setupDevtools</b> — Commands timeline + inspector panel</summary>

Requires `@vue/devtools-api`; silently no-ops if not installed.

```typescript
import { setupDevtools } from 'vapor-chamber/devtools';

const app = createApp(App);
setupDevtools(getCommandBus(), app);
app.mount('#app');
```

</details>

## Examples

**Runnable full-project apps:**

| App | What it shows |
|-----|---------------|
| [`vapor-sfc`](examples/vapor-sfc) | `<script setup vapor>` SFC tree — `useCommand` / `defineVaporCommand` / `useSharedCommandState` |
| [`vapor-island-cart`](examples/vapor-island-cart) | Light-DOM Vapor custom-element islands coordinating through one bus |
| [`exo-astro`](examples/exo-astro) | Declarative directives for Astro — dispatch *before* hydration |
| [`laravel-app`](examples/laravel-app) | Verified Laravel app (13.x): Blade + core IIFE + real CSRF (419/401) |
| [`router-demo`](examples/router-demo) | The router end to end — outlet, loaders, typed query params, menus |

**Single-file snippets** — plus `feature-*` / `pattern-*` files; see the
[examples index](examples):

| Example | Description |
|---------|-------------|
| [`shopping-cart.ts`](examples/shopping-cart.ts) | Cart with validation, history, and undo/redo |
| [`form-validation.ts`](examples/form-validation.ts) | Form validation with error handling |
| [`async-api.ts`](examples/async-api.ts) | Async handlers with retry plugin |
| [`realtime-search.ts`](examples/realtime-search.ts) | Debounced search queries |
| [`custom-plugins.ts`](examples/custom-plugins.ts) | Analytics, auth guard, rate limiter plugins |
| [`pattern-6-vapor-router.ts`](examples/pattern-6-vapor-router.ts) | Router + bus: reads vs writes |
| [`vue-vapor-component.vue`](examples/vue-vapor-component.vue) | Full Vue Vapor todo app |

## API Reference

<details>
<summary><b>Core functions and bus options</b></summary>

| Function | Description |
|----------|-------------|
| `createCommandBus(options?)` | Create a synchronous command bus |
| `createAsyncCommandBus(options?)` | Create an async command bus |
| `createTestBus(options?)` | Create a test bus that records dispatches |
| `inspectBus(bus)` | `BusInspection` snapshot of bus topology (tree-shakeable) |
| `unsealBus(bus)` | Unseal a sealed bus (tree-shakeable escape hatch) |
| `createCommandPool(size)` | Pre-allocated Command object pool for hot paths |
| `commandKey(action, target)` | Stable `action:target` key for cache integration |

**`CommandBusOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onMissing` | `'error' \| 'throw' \| 'ignore' \| fn` | `'error'` | Behavior when no handler is registered |
| `naming` | `{ pattern: RegExp, onViolation?: string }` | — | Enforce naming convention on actions |

</details>

<details>
<summary><b>Command bus methods</b></summary>

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command (write). Auto-stamps `cmd.meta` |
| `query(action, target, payload?)` | Read-only dispatch — skips `onBefore`, runs plugins + handler + afterHooks |
| `emit(event, data?)` | Fire a domain event — notifies `on()` listeners, no handler required |
| `dispatchBatch(commands[], options?)` | Execute multiple commands → `{ successCount, failCount, results }` |
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, throttle? }` |
| `use(plugin, options?)` | Add a plugin. `options.priority` controls order |
| `onBefore(hook)` | Run before every command. Throw to cancel dispatch |
| `onAfter(hook)` | Run after every command |
| `on(pattern, listener)` | Subscribe to matching commands (`*`, `prefix*`, exact). Returns unsub |
| `once(pattern, listener)` | Like `on()` but auto-unsubscribes after first match |
| `offAll(pattern?)` | Remove listeners for a pattern, or all |
| `request(action, target, payload?, options?)` | Async request/response with timeout (default 5s) |
| `respond(action, handler)` | Register a responder for `request()` calls |
| `hasHandler(action)` | True if a handler is registered |
| `registeredActions()` | `string[]` of all registered action names |
| `clear()` | Remove all handlers, plugins, hooks, listeners |
| `seal()` | Freeze configuration — rejects register/use/clear after sealing |
| `dispose()` | Clean teardown — clears state, cancels timers, marks bus disposed |

</details>

<details>
<summary><b>Composables and helpers</b></summary>

| Composable | Description |
|------------|-------------|
| `useCommand()` | Vapor-safe: dispatch + register/on/emit + reactive loading/error, auto-cleanup |
| `useSharedCommandState(options?)` | Aggregate `isAnyLoading` + `errors` ring buffer, **shared** across subscribers on the same bus. For toolbars, status bars, global spinners |
| `defineVaporCommand(action, handler, options?)` | Zero-overhead dispatch for hot paths |
| `useCommandState(initial, handlers)` | State managed by commands |
| `useCommandHistory(options?)` | Reactive undo/redo |
| `useCommandGroup(namespace)` | Namespace isolation — prefixes all calls in camelCase |
| `useCommandError(options?)` | Reactive error boundary for failed dispatches |
| `useCommandBus()` / `getCommandBus()` | Get the shared bus (composable / plain) |
| `untracked(fn)` | Run a **raw-bus** dispatch without its handler's reads becoming dependencies of the surrounding effect. The composables above already do this — you only need it when calling `getCommandBus()` directly from inside a `watchEffect` / `computed`. No-op without Vue. **Import from `vapor-chamber/vue`** in a Vue app: from the package root it degrades to a pass-through in a production build |
| `setCommandBus(bus)` / `resetCommandBus()` | Set / reset the shared bus (useful in tests) |
| `configureSignal(fn)` | Inject a custom signal factory (auto-detected in Vue 3.6+) |
| `isVaporAvailable()` | True if Vue 3.6+ Vapor mode is detected |
| `createVaporChamberApp(component, props?)` | Create a Vapor app instance (requires Vue 3.6+) |
| `getVaporInteropPlugin()` | `vaporInteropPlugin` for mixed trees |
| `setupDevtools(bus, app)` | Connect bus to Vue DevTools (`vapor-chamber/devtools`) |

**Router** — see [docs/router.md](docs/router.md) for the full surface:
`createRouter`, `useRouter`, `useRoute`, `useQueryParam`, `useRouteData`, `useRouteError`,
`useMenu`, `useBreadcrumbs`, `usePagination`, `onBeforeLeave`, `RouterOutlet`.

</details>

## Design Goals

1. **Minimal** — ~3.6 KB brotli core, zero runtime dependencies (`alien-signals` is opt-in and never auto-bundled)
2. **Vapor-native** — built for signals, not vDOM
3. **Composable** — plugins for everything
4. **Type-safe** — full TypeScript, one schema as the source of truth
5. **Predictable** — sync by default, explicit async
6. **Progressive** — works in vDOM, Vapor, and mixed trees

## Documentation

| | |
|---|---|
| [docs/whitepaper.md](docs/whitepaper.md) | Design philosophy, architecture, naming rationale, Vue 3.6 alignment log, SSR guide, migration strategy |
| [docs/router.md](docs/router.md) | Router: loader SPI, Blade migration, Vapor interop |
| [docs/performance.md](docs/performance.md) | What's optimized, tuning knobs, benchmarks |
| [docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md) · [docs/COVERAGE.md](docs/COVERAGE.md) | Generated, always current |
| [ROADMAP.md](ROADMAP.md) | Per-module status, versions, forward plan |
| [CHANGELOG.md](CHANGELOG.md) | Per-release detail, including Vue alignment per RC |

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
