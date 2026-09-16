<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A command bus built for <a href="https://github.com/vuejs/core">Vue Vapor</a> - a <!-- vc:sizeCore -->3.9<!-- /vc:sizeCore --> KB brotli dispatch core with opt-in batteries, each 0 KB until imported. Vue <!-- vc:vueAligned -->3.6.0-rc.8<!-- /vc:vueAligned --> aligned. LGPL-2.1.
</p>

---

Every user action gets **one handler**, a composable **plugin pipeline**, and **signal-native**
reactive state - replacing scattered event listeners and prop-drilling with one predictable,
testable flow.

```ts
import { getCommandBus, logger, validator } from 'vapor-chamber';   // the bus: no Vue needed
import { useCommand } from 'vapor-chamber/vue';                       // composables: Vue wired at build time

const bus = getCommandBus();
bus.register('cartAdd', (cmd) => addToCart(cmd.target));
bus.use(logger());
bus.use(validator({ cartAdd: (cmd) => cmd.target.id ? null : 'Missing ID' }));

// In a component - same shared bus, with reactive state
const { dispatch, loading, lastError } = useCommand();
dispatch('cartAdd', { id: product.id });
```

**The difference from `emit`:** `emit` is fire-and-forget with many listeners. `dispatch` has one
handler and a composable pipeline - one place to look, debug, and test.

## What's in the can

A small core, and batteries you only pay for if you import them.

| | |
|---|---|
| **Core** (the bus) | dispatch/query/emit, plugin pipeline, wildcard listeners - framework-agnostic, no Vue import, **<!-- vc:sizeCore -->3.9<!-- /vc:sizeCore --> KB brotli** |
| **Vue composables** | `useCommand`, `useCommandState`, shared state, `defineVaporCommand`, full Vapor wrappers |
| **Router** (opt-in) | URL-addressed reads for Vue 3.6 over a server catch-all - route tables and loaders as data |
| **Plugins** (opt-in) | logger, validator, history (undo/redo), debounce, throttle, retry, persist, cross-tab sync, serialize, idempotent, auth guard |
| **Transports** (opt-in) | HTTP bridge, batching HTTP, WebSocket, SSE, Laravel Echo/Reverb |
| **Extras** (opt-in) | SSR dehydrate/rehydrate, form bus, HTTP client, streaming JSON parser, schema validation, transitions, devtools, Vite HMR, testing, MCP server, offline outbox |

- **Vue <!-- vc:vueAligned -->3.6.0-rc.8<!-- /vc:vueAligned --> aligned** - signals, `onScopeDispose`, `getCurrentScope`, alien-signals internals; tracked per release in the [CHANGELOG](CHANGELOG.md)
- **No runtime dependency**; `alien-signals` is an optional peer, installed only by apps that use the `vapor-chamber/alien-signals` connector; unimported modules tree-shake to zero
- **ESM-only**, plus three IIFE `<script>` drop-ins for no-bundler pages
- **<!-- vc:covStatements -->100.0<!-- /vc:covStatements -->% coverage on all four axes** - statements, branches, functions and lines, across **<!-- vc:tests -->2420<!-- /vc:tests --> tests** in <!-- vc:testFiles -->167<!-- /vc:testFiles --> files ([full table](docs/COVERAGE.md)). Not a sampled figure: every branch in the measured surface is taken by a test

## Contents

[Install](#install) · [Quick start](#quick-start) · [Router](#router) · [Vapor mode](#vue-36-vapor-mode) · [Core concepts](#core-concepts) · [Plugins](#built-in-plugins) · [Transports](#transport-layer) · [HTTP client](#http-client) · [Composables](#vapor-composables) · [Bundle sizes](#bundle-sizes) · [Testing](#testing) · [Examples](#examples) · [API reference](#api-reference)

## Install

```bash
npm install vapor-chamber        # npm registry (releases may lag the repo)

# or straight from the repo: the authoritative source while Vue 3.6 is in RC
# (a `prepare` script builds it on install):
npm install github:lucianofedericopereira/vapor-chamber
```

**Requirements:** Node ≥22.12. Vue is an **optional** peer dep - ≥3.5 for composables, ≥<!-- vc:vueAligned -->3.6.0-rc.8<!-- /vc:vueAligned -->
for the full Vapor surface. The core bus runs without Vue entirely. Vite ≥5 and `@vitejs/plugin-vue`
≥5 are needed only for the `vapor-chamber/vite` plugins (HMR, `vaporChamberWire()`) and Vapor SFC support.

**ESM-only**, no CJS build: Node ≥22 `import`, bundlers and `<script type="module">` all work; for
classic `<script>` tags use the [IIFE variants](#iife--cdn-variants).

> **RC tracking.** This lib follows Vue 3.6 through its release candidates. The Vapor wrappers are
> transitional and will realign once 3.6 ships stable. [ROADMAP.md](ROADMAP.md) lists what is
> stable today and what is transitional.

<details>
<summary><b>Other integrations</b> - Vitest, Laravel, Astro, performance tuning, API docs</summary>

- **Vitest** - [docs/integrations/vitest.md](docs/integrations/vitest.md): one setup-file line
  gives matchers in Vitest's spy vocabulary (`toHaveBeenDispatchedWith`), a recorded shared bus,
  `bus` / `asyncBus` fixtures, stubs restored by `using`, and an MCP client for testing what an
  agent can reach. `vaporChamberTest()` adds the configurable parts, and `npx vc-vitest-mcp`
  lets an agent run the suite and read its coverage gaps.

- **Laravel** - [docs/integrations/laravel.md](docs/integrations/laravel.md) covers the backend
  deliverables (route, controller, action classes, CSRF flows, Sanctum, Inertia coexistence,
  Filament panels, Reverb realtime, queued commands). Runnable PHP companions in
  [examples/laravel-backend/](examples/laravel-backend).
- **Astro** - [examples/exo-astro](examples/exo-astro) is a declarative directive set (`v-scope`,
  `v-command`, `v-bind-text`, `v-show`) for coordinating independent page sections, with
  `onMissing: 'buffer'` so sections can dispatch before their handlers hydrate.
- **Performance & tuning** - [docs/performance.md](docs/performance.md): what's optimized by
  default, the tuning knobs (`persist({ coalesce: true })`, `configureUid`, `configureSignal`),
  variant selection, benchmark snapshot.
- **API reference** - [docs/api/](docs/api/): every published `exports` subpath, generated from
  the compiler by `npm run docs` and committed, so an added or changed export shows up in the diff.

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
<summary><b>Define each command once</b> - one schema literal drives types, validation, the backend, and AI tools</summary>

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
<summary><b>Gotcha:</b> in a Vue app, import the composables from <code>vapor-chamber/vue</code>, not the root</summary>

Import the composables (`useCommand`, `useCommandState`, `signal`, ...) from the static entry,
`vapor-chamber/vue` (or `vapor-chamber/vapor` in a Vapor app), and the bus (`createCommandBus`,
`getCommandBus`, plugins, transports) from the root. The static entry hands Vue to the library at
build time, the moment it is imported, so even module-scope state is reactive:

```ts
import { createCommandBus, setCommandBus } from 'vapor-chamber';   // the bus: no Vue needed
import { useCommand, signal } from 'vapor-chamber/vue';           // composables: Vue wired

export const count = signal(0);   // reactive, no waiting
```

The root has to work with no Vue in the tree, so it can only look for Vue at runtime, through a
bare `import('vue')` that resolves under a dev server and **fails in a production bundle**. There,
composables imported from the root get plain `{ value }` state (no reactivity), arm no automatic
cleanup and skip the KeepAlive guard - measured in `tests/root-only-prod-fixture.test.ts`. The
library logs one warning, in production too, when it sees Vue running with nothing wired, and a
DEV warning on the first composable call when Vue arrived through that runtime lookup.

`waitForVueDetection()` waits on that same runtime lookup, so in a bundled app it cannot help: it
waits for the channel that fails. It is for **no-build pages only**, where the lookup can resolve
(for example through an import map for `vue`); on those pages `configureVue(Vue)` is still the
more reliable choice.

</details>

## Router

`vapor-chamber/router` is a router for Vue 3.6 over **one thin server catch-all**
(`/admin/{any?}` -> shell -> one island). **Path = navigation, query = state.** Route tables and
data loaders are delivered as *data*, not as a hand-written config module.

The split with the bus is deliberate: **the bus owns writes (commands), the router owns reads
(URL-addressed data).**

```ts
import { createRouter } from 'vapor-chamber/router';
import { fetchLoaders } from 'vapor-chamber/router-fetch';
import { RouterOutlet } from 'vapor-chamber/router/vdom';

const router = createRouter({
  base: '/admin',
  routes: adminRoutes,                    // generated module, or { inline }; { url } also needs `http`
  loaders: fetchLoaders(),                // or your own LoaderHandlers preset
  components: {
    'Catalog/ListPage': () => import('./pages/CatalogList.vue'),
  },
});

app.use(router);   // register RouterOutlet locally where you render it
```

**Composables:** `useRouter` `useRoute` `useQueryParam` `useRouteData` `useRouteError` `useMenu`
`useBreadcrumbs` `usePagination` `onBeforeLeave` - all scope-auto-disposing.

<details>
<summary><b>The two-layer URL model</b> - why a query change never remounts the page</summary>

| change | what happens |
|---|---|
| **path** | resolve -> guards -> components + loaders in parallel (aborted on supersede) -> **one atomic frozen snapshot commit**. A page never renders with the previous page's data. |
| **query / hash** | fast path: location commits immediately - **no matching, no guards, no remount**. Only loaders that depend on a changed key refetch, patching `snapshot.data` when they land. |

So `page.value = 3` on a typed query param repaginates a list without ever unmounting it.

</details>

<details>
<summary><b>The vDOM boundary</b> - what <code>RouterOutlet</code> costs, and why it has its own subpath</summary>

`RouterOutlet` is a `defineComponent` + `h()` component, so anything that reaches it *statically*
pins Vue's virtual-DOM runtime into your bundle. It therefore lives behind its own subpath, and
`app.use(router)` deliberately does **not** register it globally. Measured on built `dist/`:

| entry | bindings retained from `vue` | brotli |
|---|---|--:|
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` | <!-- vc:sizeRouter -->9.5<!-- /vc:sizeRouter --> KB |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` | <!-- vc:sizeRouterVdom -->0.4<!-- /vc:sizeRouterVdom --> KB |
| `vapor-chamber/router/vapor` | `createDynamicComponent createSlot defineVaporComponent inject provide` | <!-- vc:sizeRouterVapor -->0.4<!-- /vc:sizeRouterVapor --> KB |

A Vapor app that never renders an outlet pays nothing for the vDOM runtime. Blade rows take a
`fetchBlade` from you (`bladeFetcher()` from `vapor-chamber/router/remote` is the in-box one);
the blade *component* still needs no import - the router pulls `makeBladeComponent` in on
demand, as its own chunk, the first time it renders one.

**A pure-Vapor app can skip the vDOM renderer entirely** (experimental, v1.x):
`vapor-chamber/router/vapor` exports the same `RouterOutlet` name built from Vapor's own helpers,
so rendering a route needs no `vaporInteropPlugin`. The startup chunk of a Vite production build
comes out **<!-- vc:outletSaving -->20.42<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->64.7<!-- /vc:outletSavingRaw --> KB raw** smaller than the same
app rendering through the vDOM outlet plus interop, a baseline derived by the same harness
(`tests/vapor/vapor-outlet-size.test.ts`).
Route components on it must be `defineVaporComponent` output - anything else throws a coded
`mode_mismatch` rather than silently re-installing interop - and **blade rows still require the
vDOM outlet**, since `makeBladeComponent` is itself `defineComponent`/`h`.

**Vapor interop, measured on rc.4** (not inferred from the roadmap): provide/inject works in Vapor
at *both* levels - app-level, which backs every composable, and component-level, which backs nested
outlet depth.

</details>

Full guide, loader SPI, and Blade migration path: **[docs/router.md](docs/router.md)**.

## Vue 3.6 Vapor Mode

Vue Vapor compiles templates to direct DOM operations using **signals** instead of diffing a
virtual tree. Vapor Chamber embraces the same philosophy: minimal abstraction, direct updates,
signal-native reactivity. It works in three contexts.

<details>
<summary><b>1. Pure Vapor app</b> (smallest bundle)</summary>

```typescript
import { createVaporChamberApp } from 'vapor-chamber/vapor';
import App from './App.vue';

createVaporChamberApp(App).mount('#app');   // no vDOM runtime
```

```vue
<script setup vapor>
import { useCommand } from 'vapor-chamber/vapor';
const { dispatch, loading } = useCommand();
</script>
```

</details>

<details>
<summary><b>2. Mixed vDOM + Vapor</b> (gradual migration)</summary>

```typescript
import { createApp, vaporInteropPlugin } from 'vue';

createApp(App).use(vaporInteropPlugin).mount('#app');
```

```vue
<script setup vapor>
// the same import in vDOM and Vapor components alike
import { useCommand } from 'vapor-chamber/vue';
const { dispatch, loading } = useCommand();
</script>
```

Vapor and vDOM components can now nest inside each other. Take `vaporInteropPlugin` from `vue`
directly: this library's `getVaporInteropPlugin()` returns it only once it has been handed over
(`configureVue({ vaporInteropPlugin })`), and it is not wired by any entry on purpose, since it
pulls in the whole vDOM interop renderer.

</details>

<details>
<summary><b>3. Standard Vue 3</b> (no Vapor) + detection</summary>

Everything works without Vapor - `signal()` is wired to Vue's `shallowRef()` (at build time when
the composables come from `vapor-chamber/vue`). In Vue 3.6+ that is alien-signals backed.

```typescript
import { isVaporAvailable } from 'vapor-chamber';
if (isVaporAvailable()) { /* Vue 3.6+ with createVaporApp available */ }
```

Vapor ships as a **physically separate dist file**
(`vue/dist/vue.runtime-with-vapor.esm-*.js`) - a bare `import 'vue'` never resolves to it outside a
bundler's per-app alias. Never mix that build with a plain `import 'vue'` in one context: two
separately-imported Vue dists are two disconnected reactivity instances, and the failure is silent.

</details>

## Core Concepts

A command has three parts - **action** (what to do), **target** (what to act on), and an optional
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

Plugins wrap handlers - they can modify commands, short-circuit, observe results, or transform
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

Before hooks run ahead of the handler; throw to cancel (the dispatch returns `{ ok: false }` with a
`VC_CORE_BEFORE_CANCEL` error whose `cause` is what you threw):

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

// Auto-unsubscribe on abort - matches DOM addEventListener semantics
bus.on('cartAdd', trackAdd, { signal: controller.signal });

// Every unsubscribe fn also carries Symbol.dispose, for `using`
{
  using off = bus.once('checkout', showConfetti);
} // unsubscribed automatically at scope exit
```

`query()` is `dispatch()` minus the `onBefore` hooks - reads shouldn't trigger mutation gates
(auth checks, spinners, optimistic updates). Plugins and `onAfter` still fire. This is the CQRS
separation: `dispatch()` writes, `query()` reads.

```typescript
bus.register('getUser', (cmd) => db.users.find(cmd.target.id));
const result = bus.query('getUser', { id: 42 });
```

`emit()` fires a domain event - notifies `on()` listeners, needs no handler, returns no result:

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
`VC_PLUGIN_CIRCUIT_OPEN`, `VC_PLUGIN_RATE_LIMITED` and `VC_PLUGIN_THREW`. `ERROR_CODE_REGISTRY` is
the full lookup table, with fix suggestions.

`VC_PLUGIN_THREW` means a plugin threw or rejected: `cause` is the original, `context.index` its
place in the chain. It is a bug in the pipeline, not a failing server: `retry()` does not re-run
it, and `circuitBreaker` neither counts it nor resets on it.

`inspectBus()` returns a topology snapshot - tree-shakeable, not bundled unless imported:

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
<summary><b>supersede</b> - auto-cancel the previous in-flight dispatch</summary>

Aborts the stale request via `AbortController` rather than ignoring it on arrival. Use it for
type-ahead search, autosave, or any rapidly re-fired command where only the latest matters.

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

`transactional: true` gives all-or-nothing execution - on failure, previously successful commands
roll back via their registered undo handlers:

```typescript
bus.register('paymentCharge', chargeHandler, { undo: refundHandler });

const result = bus.dispatchBatch([
  { action: 'inventoryReserve', target: item },
  { action: 'paymentCharge',    target: payment },
], { transactional: true });

if (!result.ok) console.log('Rollbacks:', result.rollbacks);
```

`onMissing` sets what happens when no handler is registered:

```typescript
createCommandBus()                                // default: { ok: false, error }
createCommandBus({ onMissing: 'throw' })
createCommandBus({ onMissing: 'ignore' })         // { ok: true, value: undefined }
createCommandBus({ onMissing: (cmd) => { ... } })   // custom fallback
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

Request/response with timeout - falls back to normal `dispatch()` if no responder is registered:

```typescript
bus.respond('getAuthToken', async () => (await fetch('/api/token')).json());
const result = await bus.request('getAuthToken', { userId: 42 }, undefined, { timeout: 3000 });
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

// history - optionally bus-backed, so undo() executes registered inverse handlers
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

// optimistic - apply returns its own rollback
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

**optimisticUndo** - automatic rollback using registered undo handlers, on sync or async buses:

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

**retry** - async bus only:

```typescript
bus.use(retry({ maxAttempts: 3, baseDelay: 200 }));            // exponential (default)
bus.use(retry({
  actions: ['api*'], maxAttempts: 5, baseDelay: 500, strategy: 'fixed',
  isRetryable: (err) => err.message !== 'Unauthorized',
}));
```

**persist** - auto-save after each successful command:

```typescript
const cartPersist = persist({ key: 'vc:cart', getState: () => cartState.value });
bus.use(cartPersist);

const saved = cartPersist.load();      // rehydrate before rendering
if (saved) cartState.value = saved;

cartPersist.save();    // force
cartPersist.clear();
bus.use(persist({ key: 'vc:cart', getState, storage: sessionStorage }));   // custom backend
```

**sync** - broadcast successful commands to other tabs via `BroadcastChannel`:

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
| `createEchoBridge` | Laravel Echo / Reverb channels -> `bus.emit()` |

<details>
<summary><b>HTTP bridge</b> - CSRF, retry, timeouts, scope cancellation</summary>

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
// -> POST /api/commands  { command: 'orderCreate', target: { items: ... } }
```

Response shape - `result.value` is the contents of `state`:

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
<summary><b>Batching HTTP bridge</b> - one round trip per tick</summary>

Same backend contract as `createHttpBridge` (CSRF, retry, timeout, session-expiry all reuse the
same request path), but commands dispatched within a window coalesce into a single POST and are
matched back to each caller by id. Invisible to the call site - each `dispatch()` still resolves
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
// -> ONE HTTP round trip
```

```json
// -> POST /api/vc/batch
{ "commands": [{ "id": "c1", "command": "formSet", "target": { "field": "email" } }] }
// <-
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
ws.connected.value;    // reactive signal - bindable in templates, no polling
ws.disconnect();       // intentional close, suppresses reconnect
```

```typescript
bus.use(createSseBridge({ url: '/api/events' }));
```

Echo / Reverb - you pass your own instance, so the library never imports `laravel-echo`:

```typescript
const realtime = createEchoBridge({
  echo,
  channels: [
    { name: `user.${userId}`, type: 'private',  events: ['OrderShipped'] },
    { name: 'lobby',          type: 'presence', events: ['MessagePosted'] },
  ],
});
realtime.install(bus);   // OrderShipped -> bus.emit('OrderShipped', payload)
// realtime.teardown();
```

</details>

## HTTP Client

Two levels over the same retry/timeout/CSRF machinery:

- **`postCommand`** - the single-purpose POST helper `createHttpBridge` builds on. For one-off HTTP
  control outside the transport plugin.
- **`createHttpClient`** - a full client (GET/POST/PUT/PATCH/DELETE) with interceptors, LRU
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

**Two named rules decide what happens to a failure**, each stated once, both exported from the
package root:

- `isRetryableStatus(status)` - *may this request be sent again?* True for 408, 429 and every
  5xx. The client retries those (by default 2 retries for GET, 0 for mutations), honouring `Retry-After` on
  429/503; a network failure or a timeout competes for the same budget instead of always failing
  on the first attempt. `retry()`'s default predicate applies the same rule to errors that carry
  a status. Any other 4xx is sent once.
- `classifyError(error)` - *can a cached response stand in for this failure?* `transient` is true
  for a timeout, a network failure (no response) or a 5xx, and false for every 4xx, 408 and 429
  included, so `serveStaleOnError` does not serve stale data for them.

`TimeoutError` stays distinct from a caller-triggered `AbortError`, and an abort is never retried.

**Caching (GET only)** - `cache: true` for a flat TTL, or an object for more:

```typescript
// Stale-while-revalidate: a hit past `ttl` but inside `ttl + staleTtl` is served
// instantly (stale: true) while a background fetch refreshes it.
const res = await http.get('/dashboard/stats', { cache: { ttl: 30_000, staleTtl: 5 * 60_000 } });
if (res.revalidation) { const fresh = await res.revalidation; }

// serveStaleOnError: a *transient* failure with a retained entry resolves instead
// of rejecting - { data, stale: true, servedOnError: true, error }.
// Business errors (4xx) are never masked this way.
await http.get('/dashboard/stats', { cache: { ttl: 30_000, serveStaleOnError: true } });
```

**`silent`** - per-request opt-out for a host-provided global error handler:

```typescript
await http.post('/analytics/beacon', payload, { silent: true }).catch((e) => {
  e.silent;   // true - a global handler can check this and skip the toast
});
```

</details>

<details>
<summary><b>Streaming JSON parser</b></summary>

`vapor-chamber/stream-parser` - a dependency-free incremental JSON parser for progressively
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
| `defineVaporCommand()` | Hot path - zero reactive overhead |
| `useCommandState()` | State reduced by commands |
| `useCommandHistory()` | Reactive undo/redo |
| `useCommandGroup()` | Namespace isolation across feature modules |
| `useCommandError()` | Component-scoped error boundary |
| `useSharedCommandState()` | One loading/error state per bus; `isLoading(action, target?)` per key |
| `createFormBus()` | Forms - per-field validation, dirty tracking |

`useCommand` uses no `getCurrentInstance()`, so it is Vapor-safe: the same API works in
`<script setup vapor>` and vDOM components alike, with auto-cleanup on scope disposal.

<details>
<summary><b>Dispatching from inside a reactive effect</b> - why the composables wrap the bus in <code>untracked()</code></summary>

A dispatch is an *action*, not a read, so nothing the handler touches should make the caller
re-run. Every composable here suspends reactive tracking around its bus call. If you reach for a
**raw bus** inside an effect, wrap it:

```ts
import { getCommandBus } from 'vapor-chamber';     // the bus comes from the root
import { untracked } from 'vapor-chamber/vue';      // untracked() from the Vue entry

watchEffect(() => {
  // without untracked(), anything the HANDLER reads becomes a dependency of
  // this effect - it would re-run on state it never mentions
  untracked(() => getCommandBus().dispatch('cartSync', cart));
});
```

</details>

<details>
<summary><b>Which entry to import from</b> - <code>/vapor</code>, <code>/vue</code>, or the package root, and what each one wires</summary>

**Import from `vapor-chamber/vue` in a Vue app.** The Gotcha above says why: the root can only
look for Vue at runtime, and that lookup fails in a production bundle, so `untracked()` silently
becomes a pass-through there. The static entry resolves Vue at build time, and re-exports the
composables (`useCommand`, `useCommandState`, ...) as the same functions, not copies.

`untracked()` is a plain pass-through when Vue is absent, so the root import stays safe in code
shared between Vue and non-Vue targets - it just cannot suspend tracking there. In DEV it warns
once when Vue arrived through that runtime lookup rather than at build time. The warning shows
in a page where DEV is on - one served by Vite's dev server (measured in a real browser on Vite 8),
or a test runner with a DOM - and a production build drops it, from every chunk. A server never
shows it: Node resolves that lookup in production too (measured), so the advice would be wrong there.

**On Vue 3.6 with Vapor, import from `vapor-chamber/vapor` instead.** It is a superset of
`vapor-chamber/vue` - same composables, same tracking fix - that additionally wires Vue's Vapor
APIs statically, so there is no `configureVue()` call to write and no runtime probe to depend on:

```ts
import { createVaporChamberApp } from 'vapor-chamber/vapor';

createVaporChamberApp(App).mount('#app');
```

That matters for the same reason the subpath above does. The root's Vapor detection is the same
bare-specifier lookup, so in a production bundle it can come up empty and
`createVaporChamberApp()` throws *"No Vue detected"* on a page with Vapor bundled into it. The
static entry has no such failure mode. It is a separate subpath from `vapor-chamber/vue` because
the Vapor names do not exist on Vue 3.5, where importing them by name is a build error.

It wires `createVaporApp`, `defineVaporComponent` and `defineVaporAsyncComponent`, which add
**+<!-- vc:sizeVaporEntryRaw -->4.8<!-- /vc:sizeVaporEntryRaw --> KB** raw over hand-wiring `createVaporApp`, re-measured on every run with Vue
bundled (the Vapor wiring table in [docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md); the whitepaper's
rc.6 row has the measurement on the `examples/vapor-sfc` app that decided the split).
`defineVaporCustomElement` (+<!-- vc:sizeVaporCustomElementRaw -->6.8<!-- /vc:sizeVaporCustomElementRaw --> KB raw)
and `vaporInteropPlugin` (+<!-- vc:sizeVaporInteropRaw -->81.7<!-- /vc:sizeVaporInteropRaw --> KB raw - it pulls the whole VDOM interop renderer) are left out on
purpose, since a static import is retained whether your app calls it or not. If you use either,
one line adds it, and it merges with what the entry already wired:

```ts
import { defineVaporCustomElement, vaporInteropPlugin } from 'vue';
import { configureVue } from 'vapor-chamber/vapor';

configureVue({ defineVaporCustomElement, vaporInteropPlugin });
```

**With Vite, a plugin can make the root import correct instead.** `vaporChamberWire()` from
`vapor-chamber/vite` resolves the bare `vapor-chamber` specifier, at build time, to the real root
plus a side-effect import of `vapor-chamber/vue` - so an app whose components import the
composables from the root is wired in production with no import changed:

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue';
import { vaporChamberWire } from 'vapor-chamber/vite';

export default defineConfig({
  plugins: [vue(), vaporChamberWire()], // { entry: 'vapor' } when the app compiles <script setup vapor>
});
```

`'vapor'` is your call, not a guess: it wires the Vapor runtime into the bundle, which a vDOM-only
3.6 app should not pay for. The redirect runs in builds only: the dev server resolves the runtime
lookup by itself, and a redirect there, over a pre-bundled install, would put two copies of the
library in the page (measured). In dev the plugin only defines `__VC_WIRED__`, which keeps the DEV
warning above from telling you to change imports the plugin already handles. It adds to the app
exactly what importing the subpath would, and both halves are pinned against real Vite runs in
`tests/vite-wire-plugin.test.ts`. On other bundlers, import from the subpath.

The bus itself (`createCommandBus`, `getCommandBus`, plugins, transports) still comes from the
package root: it works with no Vue in the tree, so it is not part of a Vue-wiring entry.

</details>

```vue
<script setup vapor>
import { useCommand } from 'vapor-chamber/vapor';
const { dispatch, loading, lastError } = useCommand();
</script>

<template>
  <button @click="dispatch('save', doc)" :disabled="loading.value">Save</button>
  <p v-if="lastError.value">{{ lastError.value.message }}</p>
</template>
```

<details>
<summary><b>Full surface</b> - register, on, emit, dispose</summary>

```vue
<script setup vapor>
const { dispatch, register, on, emit, loading, lastError, dispose } = useCommand();

register('cartAdd', (cmd) => addToCart(cmd.target));   // scoped to this component
on('cart*', (cmd, result) => console.log('Cart event:', cmd.action));
dispatch('cartAdd', product, { quantity: 1 });
emit('cartChanged', { count: 1 });
// auto-cleanup via onScopeDispose - or call dispose() manually
</script>
```

</details>

<details>
<summary><b>defineVaporCommand, useCommandState, history, groups, errors</b></summary>

`defineVaporCommand` creates no reactive `loading`/`lastError` signals - for telemetry,
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

// namespace isolation - all calls prefixed in camelCase
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
<summary><b>createFormBus</b> - reactive forms on the bus</summary>

Per-field validation, dirty tracking, and the full plugin pipeline on every form command.

```typescript
const form = createFormBus({
  fields: { email: '', password: '' },
  rules: {
    email:    (v) => v.includes('@') ? null : 'Invalid email',   // sync - runs on every set()
    password: (v) => v.length >= 8   ? null : 'Too short',
    username: async (v) => await api.isUsernameTaken(v) ? 'Taken' : null,  // async - only on submit()
  },
  onSubmit: async (values) => await api.login(values),
});

form.use(logger());   // plugins attach like any bus

form.values.value; form.errors.value; form.isDirty.value; form.isValid.value; form.isSubmitting.value;

form.set('email', 'user@example.com');   // update + re-validate
form.touch('email');
await form.submit();                     // validate -> onSubmit -> boolean
form.reset();
```

**Headless mode** - `reactive: false` skips signal allocation for server-side, batch, or non-UI
use. Every API works the same.

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

The two that matter: the dispatch core is **<!-- vc:sizeCore -->3.9<!-- /vc:sizeCore --> KB** and the import-everything barrel is
<!-- vc:sizeBarrel -->23.2<!-- /vc:sizeBarrel --> KB. The main entries, and why the numbers are
machine-stamped rather than retyped:

<details>
<summary><b>Per-export table</b> - the main entries, brotli</summary>

| Entry | brotli |
|---|--:|
| dispatch core (`createCommandBus`, tree-shaken) | **<!-- vc:sizeCore -->3.9<!-- /vc:sizeCore --> KB** |
| `vapor-chamber` (main barrel, import-*everything*) | <!-- vc:sizeBarrel -->23.2<!-- /vc:sizeBarrel --> KB |
| `vapor-chamber/router` | <!-- vc:sizeRouter -->9.5<!-- /vc:sizeRouter --> KB |
| `vapor-chamber/router/vdom` | <!-- vc:sizeRouterVdom -->0.4<!-- /vc:sizeRouterVdom --> KB |
| `vapor-chamber/router/vapor` | <!-- vc:sizeRouterVapor -->0.4<!-- /vc:sizeRouterVapor --> KB |
| `vapor-chamber/router/remote` | <!-- vc:sizeRouterRemote -->3.4<!-- /vc:sizeRouterRemote --> KB |
| `vapor-chamber/router-fetch` | <!-- vc:sizeRouterFetch -->3.8<!-- /vc:sizeRouterFetch --> KB |
| `vapor-chamber/vue` | <!-- vc:sizeVue -->7.1<!-- /vc:sizeVue --> KB |
| `vapor-chamber/vapor` | <!-- vc:sizeVapor -->7.4<!-- /vc:sizeVapor --> KB |
| `vapor-chamber/reactive` | <!-- vc:sizeReactive -->5.3<!-- /vc:sizeReactive --> KB |
| `vapor-chamber/transports` | <!-- vc:sizeTransports -->4.3<!-- /vc:sizeTransports --> KB |
| `vapor-chamber/outbox` | <!-- vc:sizeOutbox -->1.9<!-- /vc:sizeOutbox --> KB |
| `vapor-chamber/mcp` | <!-- vc:sizeMcp -->1.7<!-- /vc:sizeMcp --> KB |
| `vapor-chamber/ssr` | <!-- vc:sizeSsr -->0.6<!-- /vc:sizeSsr --> KB |
| `vapor-chamber/store` | <!-- vc:sizeStore -->0.7<!-- /vc:sizeStore --> KB |

**Rows are not additive** - every row includes the shared core, which your bundle carries once.
`vapor-chamber` is the barrel measured import-everything; your bundler drops what you don't use.

These figures are **machine-stamped** from [docs/BUNDLE-SIZES.md](./docs/BUNDLE-SIZES.md): the
generated file (`npm run size:doc`) is the source of truth, `npm run docs:stamp` republishes its
rows here, and `lint:check` fails on a stale one. They used to be hand-copied, and they drifted:
this table had drifted low on 7 of 9 rows before it was last reconciled by hand, and had drifted
again by v1.16.0. A number a human retypes is a number that
drifts, so it is no longer retyped.

</details>

### IIFE / CDN variants

Three `<script>`-tag drop-ins. Pick by audience, not feature checklist.

| Variant | Audience | Min | Brotli | Gzip |
|---|---|--:|--:|--:|
| **core** | Sprinkled JS on server-rendered pages (Blade, Rails, Django, WordPress). You dispatch user actions to a backend over HTTP. | <!-- vc:sizeIifeCoreRaw -->27.2<!-- /vc:sizeIifeCoreRaw --> KB | <!-- vc:sizeIifeCore -->8.0<!-- /vc:sizeIifeCore --> KB | <!-- vc:sizeIifeCoreGzip -->8.9<!-- /vc:sizeIifeCoreGzip --> KB |
| **elements** | Embeddable widgets (chat bubbles, checkout buttons, third-party drop-ins). You ship a `<vc-widget>` custom element. | <!-- vc:sizeIifeElementsRaw -->29.0<!-- /vc:sizeIifeElementsRaw --> KB | <!-- vc:sizeIifeElements -->8.5<!-- /vc:sizeIifeElements --> KB | <!-- vc:sizeIifeElementsGzip -->9.4<!-- /vc:sizeIifeElementsGzip --> KB |
| **full** | SPAs that grew big enough to want everything (realtime, undo/redo, persistence, full Vapor surface). | <!-- vc:sizeIifeFullRaw -->40.0<!-- /vc:sizeIifeFullRaw --> KB | <!-- vc:sizeIifeFull -->11.8<!-- /vc:sizeIifeFull --> KB | <!-- vc:sizeIifeFullGzip -->13.1<!-- /vc:sizeIifeFullGzip --> KB |

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
    // A Vapor setup() returns a BLOCK - real DOM nodes. There is no compiler
    // on a no-build page to turn a template into one, and `h` is not on the
    // VaporChamber global in any variant, so build the node directly.
    setup(props) {
      const span = document.createElement('span');
      span.textContent = `SKU ${props.sku}`;
      return span;
    },
  });
</script>
<vc-cart sku="ABC-123"></vc-cart>
```

> **Variant contents are not under semver before v2.0.** While Vue 3.6 is in RC, the lib reserves
> the right to move APIs between IIFE variants. ESM consumers get the full surface and are
> unaffected.

</details>

### Subpath exports

<details>
<summary><b>Every subpath</b> - what each one pulls in</summary>

```
vapor-chamber                  -> core + composables + everything (tree-shaken)
vapor-chamber/vue              -> the composables with Vue's tracking primitives wired
                                 statically - the right root for a Vue app
vapor-chamber/vapor            -> superset of /vue that also wires Vue's Vapor APIs
                                 at build time (Vue 3.6 only)
vapor-chamber/router           -> the router: table, engine, dom, loader SPI (no vDOM)
vapor-chamber/router/vdom      -> RouterOutlet, makeBladeComponent (opts into vDOM)
vapor-chamber/router/vapor     -> RouterOutlet, Vapor-native (opts into Vapor; Vue 3.6 only)
vapor-chamber/router/remote    -> routerHttp, bladeFetcher (opts into the http client)
vapor-chamber/router-fetch     -> in-box loader preset for plain-JSON backends
vapor-chamber/transports       -> HTTP + WebSocket + SSE + Echo bridges
vapor-chamber/directives       -> v-vc:command (vDOM plugin; vcCommandVapor in Vapor)
vapor-chamber/vite             -> Vite HMR plugin + vaporChamberWire() (build-time Vue wiring)
vapor-chamber/transitions      -> Vue <Transition> hooks -> bus dispatch bridge
vapor-chamber/ssr              -> SSR dehydrate/replay helpers
vapor-chamber/devtools         -> Vue DevTools integration
vapor-chamber/stream-parser    -> incremental JSON parser for streamed bodies
vapor-chamber/fast-lane        -> minimal-allocation dispatcher for real-real-hot loops
                                 (game ticks, trading data, audio, scroll) - not a bus
vapor-chamber/observable       -> Symbol.observable interop - RxJS / xstream / callbag
vapor-chamber/standard-schema  -> Standard Schema v1 validator (Zod / Valibot / ArkType)
vapor-chamber/alien-signals    -> alien-signals as the reactive primitive (non-Vue contexts)
vapor-chamber/reactive         -> opt-in DEEP reactivity (core signal() is shallow+fast)
vapor-chamber/outbox           -> offline outbox: durable queue + ordered replay
vapor-chamber/mcp              -> zero-dep MCP server from your schema bus
vapor-chamber/store            -> experimental state layer: every mutation is a command
vapor-chamber/iife[-core|-elements] -> IIFE bundles
```

</details>

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

**Coverage:** <!-- vc:covStatements -->100.0<!-- /vc:covStatements -->% statements · <!-- vc:covBranches -->100.0<!-- /vc:covBranches -->% branches · <!-- vc:covFunctions -->100.0<!-- /vc:covFunctions -->% functions · <!-- vc:covLines -->100.0<!-- /vc:covLines -->% lines across **<!-- vc:tests -->2420<!-- /vc:tests --> tests**
(<!-- vc:testFiles -->167<!-- /vc:testFiles --> files). Per-file table:
[docs/COVERAGE.md](docs/COVERAGE.md); run `npm run test:coverage` for live numbers.

## Testing

On Vitest 5, `setupFiles: ['vapor-chamber/vitest']` tests the real bus with matchers such as
`expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 })`; see
[docs/integrations/vitest.md](docs/integrations/vitest.md).

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
<summary><b>Snapshot & time-travel</b> - replay command sequences</summary>

```typescript
const snap = bus.snapshot();          // immutable RecordedDispatch[]
bus.travelTo(1);                      // commands 0..1 inclusive
bus.travelToAction('cartAdd');        // up to last occurrence
bus.travelTo(999);                    // out-of-range indices clamp
```

</details>

<details>
<summary><b>setupDevtools</b> - Commands timeline + inspector panel</summary>

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
| [`vapor-sfc`](examples/vapor-sfc) | `<script setup vapor>` SFC tree - `useCommand` / `defineVaporCommand` / `useSharedCommandState` |
| [`vapor-island-cart`](examples/vapor-island-cart) | Light-DOM Vapor custom-element islands coordinating through one bus |
| [`exo-astro`](examples/exo-astro) | Declarative directives for Astro - dispatch *before* hydration |
| [`laravel-app`](examples/laravel-app) | Verified Laravel app (13.x): Blade + core IIFE + real CSRF (419/401) |
| [`router-demo`](examples/router-demo) | The router end to end - outlet, loaders, typed query params, menus |

**Single-file snippets** - plus `feature-*` / `pattern-*` files; see the
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
| `onMissing` | `'error' \| 'throw' \| 'ignore' \| 'buffer' \| fn` | `'error'` | Behavior when no handler is registered |
| `naming` | `{ pattern: RegExp, onViolation?: string }` | - | Enforce naming convention on actions |

</details>

<details>
<summary><b>Command bus methods</b></summary>

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command (write). Auto-stamps `cmd.meta` |
| `query(action, target, payload?)` | Read-only dispatch - skips `onBefore`, runs plugins + handler + afterHooks |
| `emit(event, data?)` | Fire a domain event - notifies `on()` listeners, no handler required |
| `dispatchBatch(commands[], options?)` | Execute multiple commands -> `{ successCount, failCount, results }` |
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, throttle? }` |
| `use(plugin, options?)` | Add a plugin. `options.priority` controls order |
| `onBefore(hook)` | Run before every command. Throw to cancel dispatch |
| `onAfter(hook)` | Run after every command |
| `on(pattern, listener)` | Subscribe to matching commands (`*`, `prefix*`, exact). Returns unsub |
| `once(pattern, listener)` | Like `on()` but auto-unsubscribes after first match |
| `offAll(pattern?)` | Remove listeners for a pattern, or all |
| `request(action, target, payload?, options?)` | Async request/response with timeout (default 5s); `options.signal` settles it |
| `respond(action, handler)` | Register a responder for `request()` calls |
| `hasHandler(action)` | True if a handler is registered |
| `registeredActions()` | `string[]` of all registered action names |
| `clear()` | Remove all handlers, plugins, hooks, listeners |
| `seal()` | Freeze configuration - rejects register/use/clear after sealing |
| `dispose()` | Clean teardown - clears state, cancels throttle timers, settles waiting `request()`s as `VC_CORE_ABORTED`; the bus stays usable |

</details>

<details>
<summary><b>Composables and helpers</b></summary>

| Composable | Description |
|------------|-------------|
| `useCommand()` | Vapor-safe: dispatch + register/on/emit + reactive loading/error, auto-cleanup |
| `useSharedCommandState(options?)` | Aggregate `isAnyLoading` + `errors` ring buffer, **shared** across subscribers on the same bus. For toolbars, status bars, global spinners. `isLoading(action, target?)` answers "is THIS one in flight?" per `commandKey(action, target)`, bus-wide, as its own reactive flag - a reader re-runs only on its key |
| `defineVaporCommand(action, handler, options?)` | Zero-overhead dispatch for hot paths |
| `useCommandState(initial, handlers)` | State managed by commands |
| `useCommandHistory(options?)` | Reactive undo/redo |
| `useCommandGroup(namespace)` | Namespace isolation - prefixes all calls in camelCase |
| `useCommandError(options?)` | Reactive error boundary for failed dispatches |
| `getCommandBus()` | Get the shared bus |
| `untracked(fn)` | Run a **raw-bus** dispatch without its handler's reads becoming dependencies of the surrounding effect. The composables above already do this - you only need it when calling `getCommandBus()` directly from inside a `watchEffect` / `computed`. No-op without Vue. **Import from `vapor-chamber/vue`** in a Vue app: from the package root it degrades to a pass-through in a production build |
| `setCommandBus(bus)` / `resetCommandBus()` | Set / reset the shared bus (useful in tests) |
| `configureSignal(fn)` | Inject a custom signal factory (auto-detected in Vue 3.6+) |
| `isVaporAvailable()` | True if Vue 3.6+ Vapor mode is detected |
| `createVaporChamberApp(component, props?)` | Create a Vapor app instance (requires Vue 3.6+) |
| `getVaporInteropPlugin()` | `vaporInteropPlugin` for mixed trees |
| `setupDevtools(bus, app)` | Connect bus to Vue DevTools (`vapor-chamber/devtools`) |

**Router** - see [docs/router.md](docs/router.md) for the full surface:
`createRouter`, `useRouter`, `useRoute`, `useQueryParam`, `useRouteData`, `useRouteError`,
`useMenu`, `useBreadcrumbs`, `usePagination`, `onBeforeLeave`, `RouterOutlet`.

</details>

## Design Goals

1. **Minimal** - <!-- vc:sizeCore -->3.9<!-- /vc:sizeCore --> KB brotli core, no runtime dependency; `alien-signals` is an optional peer the library never imports, so nothing bundles it unless you do
2. **Vapor-native** - built for signals, not vDOM
3. **Composable** - plugins for everything
4. **Type-safe** - full TypeScript, one schema as the source of truth
5. **Predictable** - sync by default, explicit async
6. **Progressive** - works in vDOM, Vapor, and mixed trees

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
