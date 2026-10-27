<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A command bus built for <a href="https://github.com/vuejs/core">Vue Vapor</a> - a <!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB brotli dispatch core with opt-in batteries, each 0 KB until imported. Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> aligned. LGPL-2.1.
</p>

---

Each user action is a command with **one handler**, **plugins** placed around it, and
**signal-native** reactive state. It replaces scattered event listeners and prop drilling with
one flow.

```ts
import { getCommandBus, logger, validator } from 'vapor-chamber';   // the bus: no Vue needed
import { useCommand } from 'vapor-chamber/vue';                       // composables: Vue wired at build time

const bus = getCommandBus();
bus.register('cartAdd', (cmd) => addToCart(cmd.target));
bus.use(logger());
bus.use(validator({ cartAdd: (cmd) => cmd.target.id ? null : 'Missing ID' }));

// In a component - same shared bus, with this key's busy state
const { dispatch, pending } = useCommand();
const adding = pending('cartAdd', { id: product.id });
dispatch('cartAdd', { id: product.id });
```

`emit` is fire-and-forget, with many listeners. `dispatch` has one handler and its plugins' rules
and steps, so each action has one place to read and to test.

## What's in the can

| | |
|---|---|
| **Core** (the bus) | dispatch/query/emit, plugin parts, wildcard listeners - framework-agnostic, no Vue import, **<!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB brotli** |
| **Vue composables** | `useCommand`, shared state, `defineVaporCommand`, full Vapor wrappers |
| **Router** (opt-in) | URL-addressed reads for Vue 3.6 over a server catch-all - route tables and loaders as data |
| **Plugins** (opt-in) | logger, validator, history (undo/redo), idempotent, auth guard. Retry is the async bus's own. Pacing (debounce, throttle) is the sender's: `pace()` |
| **Transports** (opt-in) | `httpTransport` (with `batch`), WebSocket, SSE, Laravel Echo/Reverb |
| **Extras** (opt-in) | SSR by the stores' states, form bus, HTTP client, streaming JSON parser, schema validation, transitions, devtools, Vite HMR, testing, MCP server, offline outbox |

- **Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> aligned**: signals, `onScopeDispose`, `getCurrentScope`, alien-signals internals. Tracked per release in the [CHANGELOG](CHANGELOG.md)
- **No runtime dependency**. `alien-signals` is an optional peer, installed only by apps that use the `vapor-chamber/alien-signals` connector. Unimported modules tree-shake to zero
- **ESM-only**, plus three IIFE `<script>` drop-ins for no-bundler pages
- **<!-- vc:covStatements -->100.0<!-- /vc:covStatements -->% coverage on all four axes** - statements, branches, functions and lines, across **<!-- vc:tests -->4866<!-- /vc:tests --> tests** in <!-- vc:testFiles -->466<!-- /vc:testFiles --> files ([full table](docs/COVERAGE.md))

## Contents

[Install](#install) | [Quick start](#quick-start) | [Router](#router) | [Vapor mode](#vue-36-vapor-mode) | [Core concepts](#core-concepts) | [Plugins](#built-in-plugins) | [Transports](#transport-layer) | [HTTP client](#http-client) | [Composables](#vapor-composables) | [Bundle sizes](#bundle-sizes) | [Testing](#testing) | [Examples](#examples) | [API reference](#api-reference)

## Install

```bash
npm install vapor-chamber        # npm registry (releases may lag the repo)

# or straight from the repo: the authoritative source while Vue 3.6 is in RC
# (a `prepare` script builds it on install):
npm install github:lucianofedericopereira/vapor-chamber
```

It needs Node 24 (24.5 or later; no other major is tested). Vue is an **optional** peer dep: >= 3.5 for composables, >= <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->
for the full Vapor surface. The core bus runs without Vue entirely. Vite >= 5 and `@vitejs/plugin-vue`
>= 5 are needed only for the `vapor-chamber/vite` plugins (HMR, `vaporChamberWire()`) and Vapor SFC support.

**ESM-only**, no CJS build: Node 24 `import`, bundlers and `<script type="module">` all work. For
classic `<script>` tags use the [IIFE variants](#iife--cdn-variants).

**Building a library on it?** Mark `vapor-chamber` and every `vapor-chamber/*` subpath external. A
subpath left in your bundle is a second copy of the library. Two copies do not share state: a
store from one is refused by the other's bus (`tests/library-names.test.ts`).

> **RC tracking.** This lib follows Vue 3.6 through its release candidates. The Vapor wrappers are
> transitional and will realign once 3.6 ships stable. [ROADMAP.md](ROADMAP.md) lists what is
> stable today and what is transitional.

<details>
<summary><b>Other integrations</b> - Vitest, Laravel, Astro, performance tuning, API docs</summary>

- **Vitest** - [docs/integrations/vitest.md](docs/integrations/vitest.md). One setup-file line
  gives matchers in Vitest's spy vocabulary (`toHaveBeenDispatchedWith`) and a recorded shared bus.
  It also gives `bus` / `asyncBus` fixtures, stubs restored by `using`, and an MCP client for
  testing what an agent can reach. `vaporChamberTest()` adds the configurable parts, and
  `npx vc-vitest-mcp` lets an agent run the suite and read its coverage gaps.

- **Laravel** - [docs/integrations/laravel.md](docs/integrations/laravel.md) covers the backend
  deliverables (route, controller, action classes, CSRF flows, Sanctum, Inertia coexistence,
  Filament panels, Reverb realtime, queued commands). Runnable PHP companions in
  [examples/laravel-backend/](examples/laravel-backend).
- **Astro** - [examples/exo-astro](examples/exo-astro) makes static Astro HTML live through the
  `data-vc-*` attributes (`bindCommands`, `bindDisplay`), with independent page sections on one bus.
  It passes `buffer: createBuffer()`, so sections can dispatch before their handlers hydrate.
- **Performance & tuning** - [docs/performance.md](docs/performance.md): what's optimized by
  default, the tuning knobs (`configureUid`, `configureSignal`), a store's saves,
  variant selection, benchmark snapshot.
- **Failures and the wire** - [docs/contract.md](docs/contract.md): the `owner:condition:subject`
  codes, the conditions, and the request and answer shapes both sides of the wire read.
- **Accessibility** - [docs/accessibility.md](docs/accessibility.md): what the library guarantees
  to keyboard and screen reader users, and what only the app can do.
- **Retry** - [docs/retry.md](docs/retry.md): which failures the async bus re-sends, when,
  how often, and how an action declares itself safe to send twice.
- **Timestamps** - [docs/timestamps.md](docs/timestamps.md): every timestamp the library
  produces and its form (epoch ms inside the process, RFC 3339 text at a boundary).
- **API reference** - [docs/api/](docs/api/): every published `exports` subpath, generated from
  the compiler by `npm run docs`. It is committed, so an added or changed export shows up in the diff.

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
import { defineSchema, createSchemaCommandBus, setCommandBus, type InferMap } from 'vapor-chamber';

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
  interface GlobalCommands extends InferMap<typeof schema> {}
}
```

From the same schema:

- `bus.toTools()`: tools for Anthropic/OpenAI.
- `vapor-chamber/mcp`: agents drive your commands over MCP, allowlisted, stamped `meta.origin`.
- `node scripts/generate-laravel.mjs commands.mjs`: the Laravel config registry and action-class
  stubs with validation rules.

A misspelled action or field in a component is a compile error, before any request is sent.

</details>

<details>
<summary><b>Gotcha:</b> in a Vue app, import from <code>vapor-chamber/vue</code>, not the root</summary>

Import from the static entry, `vapor-chamber/vue` (or `vapor-chamber/vapor` when the app calls the
library's Vapor API, such as `createVaporChamberApp`). It
carries the composables (`useCommand`, `useCommandHistory`, `signal`, ...) and the root's whole
surface: the bus, plugins, transports. The static entry hands Vue to the library at build time, the
moment it is imported, so even module-scope state is reactive:

```ts
import { createCommandBus, setCommandBus, useCommand, signal } from 'vapor-chamber/vue';

export const count = signal(0);   // reactive, no waiting
```

They are the root's own functions, so code that still takes the bus from the root shares the same
bus.

The root has to work with no Vue in the tree, so it can only look for Vue at runtime. It does so
through a bare `import('vue')` that resolves under a dev server and **fails in a production
bundle**. There, composables imported from the root get plain `{ value }` state (no reactivity),
arm no automatic cleanup and skip the KeepAlive guard, measured in
`tests/root-only-prod-fixture.test.ts`. The library logs one warning, in production too, when it
sees Vue running with nothing wired. It adds a DEV warning on the first composable call when Vue
arrived through that runtime lookup.

`waitForVueDetection()` waits on that same runtime lookup, so in a bundled app it cannot help: it
waits for the channel that fails. It is for **no-build pages only**, where the lookup can resolve,
for example through an import map for `vue`. On those pages `configureVue(Vue)` is still the
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
| `vapor-chamber/router` | `computed customRef getCurrentScope inject onScopeDispose shallowRef` | <!-- vc:sizeRouter -->11.3<!-- /vc:sizeRouter --> KB |
| `vapor-chamber/router/vdom` | `defineComponent h inject provide` | <!-- vc:sizeRouterVdom -->0.7<!-- /vc:sizeRouterVdom --> KB |
| `vapor-chamber/router/vapor` | `createDynamicComponent createIf createSlot defineVaporComponent inject provide` | <!-- vc:sizeRouterVapor -->0.7<!-- /vc:sizeRouterVapor --> KB |

A Vapor app that never renders an outlet pays nothing for the vDOM runtime. Blade rows take a
`fetchBlade` from you (`bladeFetcher()` from `vapor-chamber/router/remote` is the in-box one).
The blade *component* still needs no import. The router pulls `makeBladeComponent` in on demand,
as its own chunk, the first time it renders one.

**A pure-Vapor app can skip the vDOM renderer entirely** (experimental, v1.x).
`vapor-chamber/router/vapor` exports the same `RouterOutlet` name built from Vapor's own helpers,
so rendering a route needs no `vaporInteropPlugin`. Take the startup chunk of a Vite production
build. It comes out **<!-- vc:outletSaving -->17.97<!-- /vc:outletSaving --> KB brotli / <!-- vc:outletSavingRaw -->57.0<!-- /vc:outletSavingRaw --> KB raw** smaller than the same
app rendering through the vDOM outlet plus interop. The same harness derives that baseline
(`tests/vapor/vapor-outlet-size.test.ts`).

Route components on it must be `defineVaporComponent` output. Anything else throws a coded
`router:invalid:component` rather than silently re-installing interop. **Blade rows still need the
vDOM outlet**, since `makeBladeComponent` is itself `defineComponent`/`h`.

**Vapor interop, measured on rc.4** (not inferred from the roadmap): provide/inject works in Vapor
at *both* levels. App-level backs every composable, and component-level backs nested outlet depth.

</details>

Full guide, loader SPI, and Blade migration path: **[docs/router.md](docs/router.md)**.

## Vue 3.6 Vapor Mode

Vue Vapor compiles templates to direct DOM operations using **signals** instead of diffing a
virtual tree. Vapor Chamber's state is built on the same signals. It works in three contexts.

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
const { dispatch, pending } = useCommand();
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
const { dispatch, pending } = useCommand();
</script>
```

Vapor and vDOM components can now nest inside each other. Take `vaporInteropPlugin` from `vue`
directly. This library's `getVaporInteropPlugin()` returns it only once it has been handed over
(`configureVue({ vaporInteropPlugin })`). No entry wires it, on purpose, since it pulls in the whole
vDOM interop renderer.

</details>

<details>
<summary><b>3. Standard Vue 3</b> (no Vapor) + detection</summary>

Everything works without Vapor - `signal()` is wired to Vue's `shallowRef()` (at build time when
the composables come from `vapor-chamber/vue`). In Vue 3.6+ that is alien-signals backed.

```typescript
import { isVaporAvailable } from 'vapor-chamber';
if (isVaporAvailable()) { /* Vue 3.6+ with createVaporApp available */ }
```

In a bundler, a bare `import 'vue'` carries Vapor: `vue.runtime.esm-bundler.js` re-exports
`@vue/runtime-vapor`, so no alias is needed (pinned by `tests/vue-bundler-vapor-exports.test.ts`).
On a no-build page Vapor ships only as `vue/dist/vue.runtime-with-vapor.esm-browser*.js`: load that
file and hand it over with `configureVue(Vue)`. Never mix two Vue dists in one page: they are two
disconnected reactivity instances, and the failure is silent.

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

One handler per action, the newest registration still live: when it is unregistered, the one it covered answers again. Returns a value or throws:

```typescript
bus.register('cartAdd', (cmd) => {
  cart.items.push(cmd.target);
  return cart.items;    // becomes result.value
});

// with undo support
bus.register('cartAdd', addHandler, {
  undo: (cmd) => { cart.items.pop(); },
});
```

Enforce naming conventions at register and dispatch time:

```typescript
const bus = createCommandBus({
  naming: { pattern: /^[a-z][a-zA-Z0-9]+$/, onViolation: 'throw' },  // or 'warn' / 'ignore'
});
bus.register('cartAdd', handler);    // ok
bus.register('cart_add', handler);   // throws
```

Names containing `$` are the library's (a store's `cart$reset`) and are not
checked against the pattern.

</details>

<details>
<summary><b>Plugins and before/after hooks</b></summary>

A plugin is an object of parts. The bus places each part where it belongs, and no
part holds `next`, so two plugins give the same outcome in either install order:

```typescript
import { type Command, type PluginParts } from 'vapor-chamber';

function timing(): PluginParts {
  const starts = new Map<Command, number>();
  return {
    id: 'timing',
    started: (cmd) => { starts.set(cmd, performance.now()); },
    settled: (cmd) => {
      console.log(`${cmd.action} took ${performance.now() - (starts.get(cmd) ?? 0)}ms`);
      starts.delete(cmd);
    },
  };
}
bus.use(timing());
```

| Part | When the bus calls it | What it may do |
|---|---|---|
| `started(cmd)` | a dispatch or a query starts, before its rules | observe |
| `settled(cmd, result)` | every outcome, after the `onAfter` hooks | observe |
| `authorize(action)`, `validate(action)` | asked once per action; its rule runs before the work | refuse |
| `reuse(cmd)` | before the work | answer with a stored result |
| `admit(cmd, fail)` | after every `reuse` | refuse (a limit), taking nothing |
| `begin(cmd)` | the command goes to the work | hand a `WorkTicket`: the work's `signal`, `landed(result)`, an `answer` |
| `attach(bus)` | at `use()` | subscribe; return the detach |

`id`, `actions` and `actionFilter` scope every part; `dispose` and `forget` run
at the bus's `dispose()` and after an undo lands. A command's own values are
the sender's: the bus never rewrites a command, so the caller adds them.

A refusal builds its result with `err(error)`, the bus's own factory, so every
result keeps one hidden class; `ok(value)` builds an answer. `fail(code,
message)`, handed to a rule and an `admit` step, mints the failure's owner from
the plugin's `id`. `countOption(value, fallback)` is the library's rule for a
numeric option (NaN falls back to the default, negatives clamp, fractions
truncate):

```typescript
import { err, type PluginParts } from 'vapor-chamber';

const qtyGuard: PluginParts = {
  id: 'qtyGuard', // the code reads qtyGuard:invalid:payload
  validate: (action) => action === 'cartAdd'
    ? (cmd, fail) => (cmd.payload?.qty > 0 ? undefined : err(fail('invalid:payload', 'qty must be positive')))
    : undefined,
};
```

A gate is a rule: it refuses before the work, and a rule may be async. A rule
runs for a dispatch and a query alike, so a gate names the actions it gates.
After-hooks run once a command settles:

```typescript
// a client-wide read-only mode over every write
bus.use({
  id: 'readOnly',
  authorize: (action) => (isWrite(action)
    ? (cmd, fail) => (maintenance.value ? err(fail('refused:action', 'Read-only mode')) : undefined)
    : undefined),
});
bus.onAfter((cmd, result) => { if (!result.ok) report(result.error); });
```

What is in flight is `commandState(bus).pending(action)` (`vapor-chamber`).

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

`query()` is a read: the command state does not count it as pending. Its rules,
steps and `onAfter` still run. This is the CQRS
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
  cmd.meta.id;              // unique per dispatch (counter-based, UUID through configureUid)
  cmd.meta.ts;              // Date.now(), read once per microtask turn
  cmd.meta.correlationId;   // trace ID for command chains
});

bus.dispatch('orderShip', order, {
  __correlationId: originalCommand.meta.id,
  __causationId:   originalCommand.meta.id,
});
```

History reads `causationId`: a command a handler dispatches with its parent's id is undone
with the parent, and a redo of the parent applies it once.

A command's `action`, `target`, `payload` and `meta` are `readonly` in its type: every part,
listener and history entry reads the one command, so build a new value instead of writing
it. The meta's own fields stay writable.

Every failure a dispatch or a transport returns is a `BusError`, with two
exceptions. A handler's own throw and an `Error` given as the abort reason come
back as themselves. A `BusError`'s code is `owner:condition:subject`: who raised
it, what went wrong, and what it is about. The bus sets the owner, never the
raiser.

```typescript
import { BusError, conditionOf, ownerOf } from 'vapor-chamber';

const result = bus.dispatch('missing', {});
if (!result.ok && result.error instanceof BusError) {
  result.error.code;          // 'core:missing:handler'
  ownerOf(result.error);      // 'core'
  conditionOf(result.error);  // 'missing'
  result.error.context;       // what the message carries (e.g. retryIn on every `limited` refusal)
}
```

A plugin's failures carry its declared `id` as the owner (`rateLimit:limited:action`,
`circuitBreaker:limited:action`). A backend's problem is
`remote:<condition of its status>:<its code>`, inside a 2xx `{ problem }` too.

The async bus's retry re-sends a transient failure (`limited`, a 408
`timeout`) for any action. An uncertain one (no reply, a 502 or 504, a 500) is
re-sent only for an action declared idempotent or a keyed command. A declared
`retryIn` sets the wait, never whether. An unidentified command that got no
reply is not re-sent: it fails with `context.outcome: 'unknown'`, since it may
have landed.

Never re-sent:

- a verdict (`invalid`, `refused`, `missing`, `already`, `conflict`), unless
  identified and answered with a wait
- an expired session (`unauthenticated`: sign in, then dispatch again)
- an abort, a depth bound or a plugin's own throw

A status maps to one condition: 404/410 `missing`, 409/412 `conflict`, 401/419
`unauthenticated`, 403 `refused`, 429/503 `limited`, 408/504 `timeout`. The
conditions read 1:1 against gRPC's canonical codes
(`docs/contract.md` 3). `ERROR_CODE_REGISTRY` is the full
table, with fix suggestions. Production messages state the fact and leave the
fix to it.

`<id>:failed:plugin` means a plugin's part threw or rejected: `cause` is the
original, `context.part` the part (`validate`, `admit`, ...). Every built-in plugin declares its id
(`cache:failed:plugin`). A transport that throws reads `transport:failed:send`,
like its other failures. A plugin of yours without an id reads `plugin:failed:plugin`. It is a
bug in the pipeline, not a failing server. The bus does not re-run it, and
`circuitBreaker` neither counts it nor resets on it.

`inspectBus()` returns a topology snapshot - tree-shakeable, not bundled unless imported:

```typescript
const info = inspectBus(bus);
info.actions;          // ['cartAdd', 'cartRemove', ...]
info.undoActions;      // actions with registered undo handlers
info.pluginCount;      // 3
info.plugins;          // [{ id: 'logger', actions: undefined, actionFilter: false, parts: ['settled'] }, ...] in install order
info.sealed;           // false
info.dispatchDepth;    // 0 (increments during nested dispatch)
```

What the library detects and goes on from (a listener's throw, a misuse in development) is a
report with its code. One formatter prints it, and every sink receives it. The default prints
an aligned level tag (`[ WARN ]` or `[ FAIL ]`), the code and the message, then in development a link to the code's section, which gives its fix
(`getErrorEntry(code).fix` reads it too):

```text
[vapor-chamber] [ FAIL ] core:failed:listener: a listener threw on "cartAdd"
  docs: https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/errors.md#failed
```

```typescript
import { configureReport, consoleSink } from 'vapor-chamber';
configureReport({ sinks: [consoleSink, (r) => telemetry.send(r.code, r.context)] });
configureReport({ format: (r) => [`${r.level} ${r.code} ${r.message}`] });
configureReport({ level: 'error' }); // warnings dropped; 'silent' drops both
configureReport(null); // the default formatter, the console, level 'warn'
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
// It does not run on an undo, a redo or a mirrored command (origin 'sync'):
// history replays the follow-up it recorded.
```

</details>

<details>
<summary><b>supersede</b> - auto-cancel the previous in-flight dispatch</summary>

Aborts the stale request through `AbortController` rather than ignoring it on arrival. Use it for
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

Because the HTTP transport forwards `cmd.signal` into its outbound `fetch`, a superseded HTTP request
is cancelled at the network layer. With `batch`, it settles a superseded command at once and
drops it from a batch not yet sent. It cancels a sent batch once every command in it has aborted.

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

`transactional: true` gives all-or-nothing execution. On failure, previously successful commands
roll back through their registered undo handlers:

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
getErrorEntry('core:missing:handler')?.fix;   // "Register a handler with bus.register(action, handler) before dispatching."
```

</details>

## Built-in Plugins

| Plugin | Description |
|--------|-------------|
| `logger(options?)` | Log every settled command to the console, a refusal or a cancel included |
| `validator(rules)` | Refuse a command a rule rejects, before every plugin and the work |
| `history({ bus, ... })` | Undo/redo of the bus's commands. Not a bus plugin: it installs its own recorder |
| `authGuard(options)` | Refuse protected commands when unauthenticated, before the validators |
| `createChannel(options)` | Mirror emitted facts to other tabs. Not a bus plugin: it takes a fast lane, not the bus |

Extras (same import): `cache`, `circuitBreaker`, `rateLimit`, `metrics`.

Pacing is the sender's, not a plugin: `pace(send, { debounce: ms })` runs the latest call of a
burst, `pace(send, { throttle: ms })` the first per wait. Calls are keyed by action and target, so
search as you type passes the typed text as the payload. `useCommand({ debounce })` and
`defineVaporCommand(action, handler, { throttle })` take the same options.

<details>
<summary><b>Usage for each plugin</b></summary>

```typescript
// logger / validator
bus.use(logger({ collapsed: true, actions: ['cart*'] }));
bus.use(validator({
  cartAdd: (cmd) => cmd.target?.id ? null : 'Product must have an ID',   // null = valid
}));

// history - records the bus's commands from the call on; undo() dispatches <action>$undo, which runs the registered inverse
const h = history({ bus, maxSize: 100 });
h.undo();
h.redo();
h.getState();   // { past, future, canUndo, canRedo }
// Undo is local: a command a transport sent reads canUndo false, so the server's
// write is never reversed on the client alone. Send a compensating command.

// pacing at the sender: the typed text is the payload, so a burst shares one key
const search = pace(bus.dispatch, { debounce: 300 });
const r = await search('searchQuery', {}, input.value); // the latest call's real result
const mark = pace(bus.dispatch, { throttle: 100 });     // a repeat inside 100 ms: pace:limited:dispatch

// authGuard
bus.use(authGuard({
  isAuthenticated: () => !!user.value,
  protected: ['shopCart', 'admin*'],          // 'shopCart' that action, 'admin*' every admin action, '*' all
  onUnauthenticated: (cmd) => router.push('/login'),
}));

// extras
bus.use(cache({ ttl: 60_000, actions: ['getUser*'] }));
bus.use(circuitBreaker({ threshold: 5, resetTimeout: 30_000 }));
bus.use(rateLimit({ max: 10, window: 1000 }));

const m = metrics();
bus.use(m);
m.summary();   // { cartAdd: { count: 42, avgMs: 1.2, errorRate: 0.02 } }
```

A plugin that takes `actions` also takes `actionFilter`, a predicate on the
action name. `actions` lists names or `prefix*` patterns, and absent or `[]`
means every action. Build a filter from CloudEvents filter expressions
(Subscriptions API 3.2.4: `exact`, `prefix`, `suffix`, `all`, `any`, `not`) with
`createActionFilter`. It rejects what the spec rejects (`core:invalid:filter`).
Given both, both must match. The bus asks it once per action, never per
dispatch, and only an app that calls `createActionFilter` carries its code. It
is also `createMcpHandler`'s allowlist, its one selection.

```typescript
import { createActionFilter } from 'vapor-chamber';

const reads = createActionFilter([{ all: [{ suffix: { action: 'Get' } }, { not: { prefix: { action: 'admin' } } }] }]);
bus.use(cache({ ttl: 60_000, actionFilter: reads }));
```

**Optimistic actions** - `register(action, handler, { undo, optimistic: true })`, on either bus.
The handler makes the local change and sends the write. The inverse reverses the local change
only: an inverse never does I/O. Undoing a write the server applied is the app's compensating
command, not an inverse. On the async bus the dispatch answers an `Accepted` at once. A failure
runs the undo before `done` settles with it. A plugin's refusal runs nothing, so nothing is undone.
For an action a transport sends, the handler is the local change and the transport the write.

```typescript
bus.register('cartAdd', async (cmd) => {
  cart.items.push(cmd.target);              // local, at once
  return api.addToCart(cmd.target);         // the write
}, {
  // local only: the write failed, so there is nothing on the server to remove
  undo: (cmd) => { cart.items = cart.items.filter((item) => item.id !== cmd.target.id); },
  optimistic: true,
});

const r = await bus.dispatch('cartAdd', item);       // an Accepted, at once
const end = await r.value.done;                       // the write's result
if (!end.ok) toast.error(`Rolled back: ${end.error.message}`);
```

A failure marked `context.outcome: 'unknown'` (no reply, and nothing identifies the command)
still rolls back, so the screen shows the last confirmed state. `done` settles with that error:
re-read the server, since the write may have landed.

**retry** - the async bus's own, on by default. It re-sends the call that
produced the outcome (a handler, or the transport), so the plugins outside see one
dispatch. It makes 3 attempts with a jittered backoff. A per-bus budget stops
retries from piling onto a backend that is down:

```typescript
const bus = createAsyncCommandBus({
  retry: {
    // Transient failures are re-sent for any action. An uncertain one (no
    // reply, a 500, a handler's throw) only where running twice is safe:
    actionPolicies: { 'cart*': 'idempotent', orderPay: false, searchRun: 2 }, // most specific wins
  },
});
createAsyncCommandBus({ retry: false });                        // off
createAsyncSchemaCommandBus({ cartSet: { retry: 'idempotent' } }); // on the schema
```

An action declared idempotent gets one `Idempotency-Key` for all its attempts.

**A store's `persist`** - saved after its writes, read back when the store is created:

```typescript
const useCart = defineChamberStore('cart', { state, reducers, persist: saveTo({ key: 'vc:cart' }) });

const cart = useCart(bus);   // the saved state is its first state
cart.add(1);                 // saved once per microtask, whatever wrote it
cart.$reset();               // back to state(), and saved as that

defineChamberStore('tab', { state, reducers, persist: saveTo({ key: 'vc:tab', storage: sessionStorage }) });          // custom backend
defineChamberStore('prefs', { state, reducers, persist: saveTo({ key: 'vc:prefs', validate }) });                       // a check of the saved shape
defineChamberStore('rows', { state, reducers, persist: saveTo({ key: 'vc:rows', storage: indexedDbStorage() }) });   // IndexedDB: read when it answers
```

`saveTo` comes from `vapor-chamber` or the store entries, and throws without `key`. A store without `persist` carries none of it. Details: [docs/store.md](docs/store.md) (Saved state).

**createChannel** - mirror emitted facts to other tabs through `BroadcastChannel`. What crosses
is what a handler computed, not the command that caused it, so the receiving tab
applies values rather than re-deriving them. The bridge is not a bus plugin and
costs the dispatch path nothing:

```typescript
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
lane.on('cartChanged', (fact) => applyToCart(fact));   // local AND remote land here

bus.register('cartAdd', (cmd) => {
  lane.emit('cartChanged', computeCart(cmd.target));   // this is what crosses tabs
});

const tabSync = createChannel({ channel: 'vapor-chamber:app', lane, events: ['cartChanged'] });
tabSync.dispose();
```

Tabs mirror when the facts are absolute ("the count is 2") rather than relative
("add one"): a tab opened later then converges instead of drifting. A payload
crosses through structured clone, so it cannot carry functions.

</details>

## Transport Layer

Send commands to a backend over HTTP or WebSocket, and take pushes over SSE or Echo. Import from
`vapor-chamber/transports`.

A transport is declared at the async bus, `createAsyncCommandBus({ transport })`: one for every
action, or a map by action pattern where the most specific match wins (an exact name, then the
longest prefix, then `*`). It is the work for the actions it covers, where a local handler would
run: every plugin wraps it, wherever it was installed, and an action no pattern covers runs its
local handler. A `$` action is the library's and always runs locally.

| Name | Use for |
|---|---|
| `httpTransport` | POST each command to one endpoint; `batch` coalesces a window's commands into one POST |
| `wsTransport` | WebSocket with auto-reconnect and a reactive `connected` signal |
| `defineTransport` | Your own `send(cmd, local)`; `{ localFallback: true }` when it falls back to the local handler |
| `createSseBridge` | Server pushes in: store states written, events emitted |
| `createEchoBridge` | Laravel Echo / Reverb channels -> store states, then `bus.emit()` |

<details>
<summary><b>HTTP transport</b> - CSRF, re-sends by the bus, timeouts, scope cancellation</summary>

```typescript
import { createAsyncCommandBus } from 'vapor-chamber';
import { httpTransport } from 'vapor-chamber/transports';

// The bus re-sends through the transport by the rule above (never a redirect).
// Until a 429 or 503 wait ends, another command for that action waits it too,
// unsent (transport:limited:held, docs/retry.md).
const bus = createAsyncCommandBus({
  onMissing: 'ignore',
  transport: {
    'order*': httpTransport({                 // only these go to the server; others stay local
      endpoint: '/api/commands',
      csrf: true,                             // the meta tag, else the XSRF-TOKEN cookie
      csrfCookieUrl: '/sanctum/csrf-cookie',  // default; '' disables the refresh fetch
      timeout: 8000,
    }),
  },
});

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
const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', scopeController: ctrl }) });
```

</details>

<details>
<summary><b>Batching</b> - one round trip per tick</summary>

The same transport with `batch`: the same backend contract, CSRF, timeout and session expiry, and
the bus re-sends per command, each into the next batch. Commands sent within a window coalesce
into a single POST and are matched back to each caller by id. It is invisible to the call site:
each `dispatch()` still resolves with its own result.

```typescript
const bus = createAsyncCommandBus({
  transport: httpTransport({
    endpoint: '/api/vc/batch',
    csrf: true,
    batch: { window: 'microtask' },   // default: same-tick coalescing, zero added latency
    // batch: { window: 20 },         // or hold the queue open N ms to catch separate ticks
  }),
});

bus.dispatch('formSet', { field: 'email' }, { value: 'a@b.com' });
bus.dispatch('cartAdd', product, { quantity: 2 });
// -> ONE HTTP round trip
```

```json
// -> POST /api/vc/batch
{ "commands": [{ "id": "c1", "command": "formSet", "target": { "field": "email" } },
              { "id": "c2", "command": "cartAdd", "target": { "id": 7 }, "payload": { "quantity": 2 } }] }
// <- a 200; each command's answer on its own result, a failure as its problem
{ "results": [{ "id": "c1", "state": {} },
             { "id": "c2", "problem": { "status": 409, "code": "out_of_stock", "detail": "Out of stock" } }] }
```

</details>

<details>
<summary><b>WebSocket, SSE, and Laravel Echo</b></summary>

```typescript
const ws = wsTransport({
  url: 'wss://api.example.com/commands',
  timeout: 10_000,     // per-message response timeout
  reconnect: true,
  maxReconnects: 10,
});
const bus = createAsyncCommandBus({ transport: { 'chat*': ws, 'presence*': ws } });
ws.connect();

ws.isConnected();      // imperative
ws.connected.value;    // reactive signal - bindable in templates, no polling
ws.outbox.pending.value; // commands held while the socket is down
ws.disconnect();       // intentional close, suppresses reconnect
```

While the socket is down, a dispatch answers an `Accepted` whose `done` settles with the reply
once the socket opens and the command is sent. The transport's own outbox holds up to 100
commands, each for at most `timeout`, in memory. `disconnect()` settles what it holds. To hold
them durably, give the bus an outbox: `createAsyncCommandBus({ transport, outbox:
createOutbox() })` holds a WebSocket action while the socket is down too, saved in
`localStorage` and shared by the origin's tabs.

A server's push is a name and data on every wire: an SSE event, an Echo broadcast, or a
WebSocket frame `{ event, data }` with no `id`. Each store state under the data's `stores` is
written to the store with that id, then the event is emitted on the bus. A push is never
dispatched, so no plugin runs and no transport sends it back
([docs/contract.md](docs/contract.md#4-the-wire)).

```typescript
// event: cartChanged, data: {"stores":{"cart":{...}}} -> the cart store, then bus.emit('cartChanged', data)
createSseBridge({ url: '/api/events', events: ['cartChanged'] }).install(bus);
// onEvent: (event, bus) => ... reads each event itself, in place of the push
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
// realtime.dispose();
```

</details>

## HTTP Client

Two levels over the same retry/timeout/CSRF machinery:

- **`postCommand`** - the single-purpose POST helper `httpTransport` builds on. For one-off HTTP
  control outside the transport.
- **`createHttpClient`** - a full client (GET/POST/PUT/PATCH/DELETE) with interceptors, LRU
  caching, request dedup, safe mode, and file download. For any HTTP need in an app already using
  vapor-chamber, command-bus or not.

<details>
<summary><b>Client usage, caching, and error classification</b></summary>

```typescript
import { createHttpClient, problemOf } from 'vapor-chamber';

const http = createHttpClient({ baseURL: '/api', csrf: true });

await http.get('/users', { params: { page: 1 } });
await http.post('/cart', { itemId: 1, qty: 2 });
await http.delete('/cart/1');

const result = await http.safe.post('/login', credentials);   // never throws
if (result.error) console.log(problemOf(result.error)?.errors); // a BusError; problemOf reads its RFC 9457 problem

await http.download('/export/csv', 'products.csv');

http.interceptors.request.use((config) => {
  config.headers = { ...config.headers, 'X-Custom': '1' };
  return config;
});

const adminHttp = http.create({ baseURL: '/admin/api' });   // defaults merged, its own interceptors
```

**Three named rules decide what happens to a failure**, each stated once, all exported from the
package root:

- `isRetryableStatus(status)` - *may the HTTP client send this request again?* True for 408, 429
  and every 5xx. The client re-sends by the bus's one rule and its bound: `retry: { maxAttempts }`,
  attempts in total, 3 by default. It is on for a GET and off for a write, `retry: {}` turns it on,
  `retry: false` off. 408, 429 and 503 are re-sent for any method. Every other 5xx and no reply are
  re-sent only for an idempotent method or a request with an `Idempotency-Key`. A declared wait
  sets when, never whether: `Retry-After`, else the `RateLimit` field's `t` when `r=0`, else
  `X-RateLimit-Reset`. With none, the wait is the async bus's: random, under 200 ms doubling per
  re-send, capped at 20 s. While re-sends are on, an unidentified request (a POST or PATCH with no
  `Idempotency-Key`) that got no reply, a 502 or a 504 fails with `context.outcome: 'unknown'`.
  Any other 4xx is sent once, unless identified and answered with a
  wait.
- `failureCondition(error, signal?)` - *what went wrong, by contract?* It reads a library failure's
  own condition, or an HTTP response's status through the status table. A timeout, an abort and
  `lost` (no response) have their own. Pass the command's `signal` and an abort with your own
  `Error` reason reads `aborted` too. The async bus's retry and the outbox judge a failure by it.
- `classifyError(error)` - *can a cached response stand in for this failure?* `transient` is true
  for a timeout, a network failure (no response) or a 5xx. It is false for every 4xx, 408 and 429
  included, so `serveStaleOnError` does not serve stale data for them.

Every failure is the core's `BusError`, the one a transport returns for the same answer. That is
`remote:<condition>:<code>`, `transport:timeout:reply`, `transport:lost:reply`, or the caller's
`transport:aborted:request`, which is never retried.

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

A write that succeeds (`post`, `put`, `patch`, `delete`) drops the cached entry for its URL, as
RFC 9111 asks. It also drops the `Location` and `Content-Location` its answer names on the same
origin, so the next `get` of any of them fetches. That invalidation and `clearCache()` also
cover reads already on the wire. Such a read still answers its callers, but it
is not stored. A read made after the invalidation fetches again instead of joining it
(`tests/http-cache-writes.test.ts`).

The server can say which reads a write made stale (RFC 9875). A read's `Cache-Groups` names its
groups, and a write's `Cache-Group-Invalidation` names the groups it changed. The client drops its
cached reads in those groups, and `onInvalidateGroup(listener)` hears each group (the router
listens there). `invalidateGroups(groups)` does the same by hand. A transport given the client
(`httpTransport({ httpClient })`, `wsTransport({ httpClient })`) passes a batched result's or a
frame's groups to it (`tests/cache-groups.test.ts`).

When a stored response has an `ETag`, its stale refresh asks `If-None-Match`. A 304 keeps the
copy: the refresh resolves to the stored response, the same data object, for a new window. A
response with `Cache-Control: no-store` is not stored (`tests/http-etag-refresh.test.ts`).
`cacheMode` sets Fetch's cache mode for one request, for the browser's cache and the client's
alike: `'no-cache'` asks the server before a stored copy is used (with its `ETag`), `'reload'`
reads past it, `'no-store'` neither reads nor stores (`tests/http-cache-mode.test.ts`).

**`silent`** - per-request opt-out for a global error handler the host installs:

```typescript
await http.post('/analytics/beacon', payload, { silent: true }).catch((e) => {
  e.context.silent;   // true - a global handler can check this and skip the toast
});
```

</details>

<details>
<summary><b>Streaming JSON parser</b></summary>

`vapor-chamber/stream-parser` - a dependency-free incremental JSON parser for progressively
consuming a streamed `fetch()`/SSE body without buffering the whole payload (LLM completions, large
exports). Subpath-only, it adds nothing to the IIFE bundles.

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
| `useCommand()` | Dispatch, a key's busy state (`pending`), handlers and listeners scoped to the component |
| `defineVaporCommand()` | Hot path - zero reactive overhead |
| `useCommandHistory()` | Reactive undo/redo |
| `useCommandGroup()` | Namespace isolation across feature modules |
| `useCommandError()` | Component-scoped error boundary |
| `useSharedCommandState()` | The bus's command state in a component: `pending(action, target?)` per key, `anyPending`, `errors` |
| `createFormBus()` | Forms - per-field validation, dirty tracking |

`useCommand` gates on `hasInjectionContext()`, not `getCurrentInstance()`, so it is Vapor-safe: the same API works in
`<script setup vapor>` and vDOM components alike, with auto-cleanup on scope disposal.

<details>
<summary><b>Dispatching from inside a reactive effect</b> - why the composables wrap the bus in <code>untracked()</code></summary>

A dispatch is an *action*, not a read, so nothing the handler touches should make the caller
re-run. Every composable here suspends reactive tracking around its bus call. If you reach for a
**raw bus** inside an effect, wrap it:

```ts
import { getCommandBus, untracked } from 'vapor-chamber/vue';

watchEffect(() => {
  // without untracked(), anything the HANDLER reads becomes a dependency of
  // this effect - it would re-run on state it never mentions
  untracked(() => getCommandBus().dispatch('cartSync', cart));
});
```

On a page with no build step (a `<script>` tag or an import map), `untracked()` cannot suspend
tracking: Vue's browser builds do not export what it needs. See
[whitepaper 9.6](docs/whitepaper.md#96-blade--cdn-zero-build).

</details>

<details>
<summary><b>Which entry to import from</b> - <code>/vapor</code>, <code>/vue</code>, or the package root, and what each one wires</summary>

One entry per kind of app, measured on built apps of each kind (log s35.231). `/vue` and `/vapor`
carry the bus too.

| App | Import from | Build step |
|---|---|---|
| App that calls the library's Vapor API (`createVaporChamberApp`, `defineVaporComponent`, `defineVaporAsyncComponent`, `defineVaporCustomElement`, `getVaporInteropPlugin`) | `vapor-chamber/vapor` | Optional, drops the runtime lookup: `vaporChamberWire({ entry: 'vapor' })` on Vite, the define below elsewhere |
| Any other Vue app, vDOM or Vapor, including one that uses only Vue's own Vapor APIs or `vapor-chamber/router/vapor` | `vapor-chamber/vue` | Optional, the same: `vaporChamberWire()` on Vite, the define elsewhere |
| Server build (SSR) | `vapor-chamber/vue` | Optional: the define drops the runtime lookup from the server bundle |
| App that imports only the root | the root | Needed on Vite: `vaporChamberWire()`. Other bundlers have none, so import from a subpath |
| `<script>`-tag page | `VaporChamber.configureVue(Vue)` | None. `untracked()` is not available |
| ESM page with an import map | `configureVue(Vue)` | None. `untracked()` cannot suspend tracking |

`untracked()` is a plain pass-through when Vue is absent. So the root import stays safe in code
shared between Vue and non-Vue targets, though it cannot suspend tracking there. In DEV it warns
once when Vue arrived through that runtime lookup rather than at build time. The warning shows
in a page where DEV is on. That is a page served by Vite's dev server (measured in a real browser
on Vite 8), or a test runner with a DOM. A production build drops it, from every chunk. A server never
shows it: Node resolves that lookup in production too (measured), so the advice would be wrong there.

**When the app calls the library's Vapor API, import from `vapor-chamber/vapor` instead.** It needs
Vue 3.6. It is a superset of
`vapor-chamber/vue`, with the same composables and the same tracking fix. It also wires Vue's
Vapor APIs statically. So there is no `configureVue()` call to write and no runtime probe to
depend on:

```ts
import { createVaporChamberApp } from 'vapor-chamber/vapor';

createVaporChamberApp(App).mount('#app');
```

That matters for the same reason the subpath above does. The root's Vapor detection is the same
bare-specifier lookup, so in a production bundle it can come up empty. Then
`createVaporChamberApp()` throws *"No Vue detected"* on a page with Vapor bundled into it. The
static entry has no such failure mode. It is a separate subpath from `vapor-chamber/vue` because
the Vapor names do not exist on Vue 3.5. There, importing them by name is a build error.

It wires `createVaporApp`, `defineVaporComponent` and `defineVaporAsyncComponent`. They add
**+<!-- vc:sizeVaporEntryRaw -->4.4<!-- /vc:sizeVaporEntryRaw --> KB** raw over hand-wiring `createVaporApp`, re-measured on every run with Vue
bundled. The Vapor wiring table in [docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md) has it. The
whitepaper's rc.6 row has the measurement on the `examples/vapor-sfc` app that decided the split.

`defineVaporCustomElement` (+<!-- vc:sizeVaporCustomElementRaw -->6.9<!-- /vc:sizeVaporCustomElementRaw --> KB raw)
and `vaporInteropPlugin` (+<!-- vc:sizeVaporInteropRaw -->73.0<!-- /vc:sizeVaporInteropRaw --> KB raw, the whole VDOM interop renderer) are left out on
purpose. A static import is retained whether your app calls it or not. If you use either, one
line adds it, and it merges with what the entry already wired:

```ts
import { defineVaporCustomElement, vaporInteropPlugin } from 'vue';
import { configureVue } from 'vapor-chamber/vapor';

configureVue({ defineVaporCustomElement, vaporInteropPlugin });
```

**With Vite, a plugin can make the root import correct instead.** `vaporChamberWire()` from
`vapor-chamber/vite` works at build time. It resolves the bare `vapor-chamber` specifier to the
real root plus a side-effect import of `vapor-chamber/vue`. So an app whose components import the
composables from the root is wired in production with no import changed:

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue';
import { vaporChamberWire } from 'vapor-chamber/vite';

export default defineConfig({
  plugins: [vue(), vaporChamberWire()], // { entry: 'vapor' } when the app calls the library's Vapor API
});
```

`'vapor'` is your call, not a guess. It wires Vue's Vapor app and component helpers into the bundle,
which an app that does not call the library's Vapor API should not pay for.

The redirect runs in builds only. The dev server resolves the runtime lookup by itself. A
redirect there, over a pre-bundled install, would put two copies of the library in the page
(measured). In dev the plugin only defines `__VC_WIRED__`. That keeps the DEV warning above from
telling you to change imports the plugin already handles. In a build it also defines
`__VC_WIRED_BUILD__`, which removes the root's runtime lookup from the bundle. It adds to the app
exactly what importing the subpath would. Both halves are pinned against real Vite runs in
`tests/vite-wire-plugin.test.ts`.

**On esbuild or webpack, import from the subpath and add one define.** Both bundlers resolve the
root's runtime `import('vue')` to the whole Vue namespace. So without the define, every app that
uses the composables ships all of Vue, and webpack warns "Critical dependency".
Once the app imports `vapor-chamber/vue` (or `/vapor`) the lookup is dead code, and the define
says so:

```ts
// esbuild
define: { __VC_WIRED_BUILD__: 'true' }
// webpack
new webpack.DefinePlugin({ __VC_WIRED_BUILD__: 'true' })
```

Leave it out only for an app that imports the composables from the root and wires nothing: there
the lookup is what finds Vue (`tests/root-probe-builds.test.ts`).

A Vite app that imports from the subpath, with neither `vaporChamberWire()` nor the define, still
ships the lookup as dead code: +2,589 B raw, +932 B brotli on a vDOM app (measured 2026-10-08, log
s35.231). Either one removes it.

</details>

```vue
<script setup vapor>
import { ref } from 'vue';
import { useCommand } from 'vapor-chamber/vapor';
const { dispatch, pending } = useCommand();
const saving = pending('save', doc);      // this key, bus-wide
const failure = ref(null);                 // the dispatch's own result
async function save() {
  const r = await dispatch('save', doc);
  failure.value = r.ok ? null : r.error;
}
</script>

<template>
  <!-- aria-disabled, not :disabled: a disabled button loses keyboard focus -->
  <button @click="!saving && save()" :aria-disabled="saving">Save</button>
  <p role="alert">{{ failure?.message }}</p>
</template>
```

<details>
<summary><b>Full surface</b> - register, on, emit, dispose</summary>

```vue
<script setup vapor>
const { dispatch, pending, register, on, emit, dispose } = useCommand();

register('cartAdd', (cmd) => addToCart(cmd.target));   // scoped to this component
on('cart*', (cmd, result) => console.log('Cart event:', cmd.action));
dispatch('cartAdd', product, { quantity: 1 });
emit('cartChanged', { count: 1 });
// auto-cleanup through onScopeDispose - or call dispose() manually
</script>
```

</details>

<details>
<summary><b>defineVaporCommand, history, groups, errors</b></summary>

`defineVaporCommand` registers its handler and dispatches with no state at all - for telemetry,
scroll sampling, debounced search, autosave:

```vue
<script setup vapor>
const { dispatch } = defineVaporCommand('telemetryEvent', (cmd) => {
  sendMetric(cmd.target.event, cmd.target.params);
});
dispatch({ event: 'page_view', params: { page: '/shop' } });
</script>
```

```typescript
// state reduced by commands is a store: defineChamberStore (vapor-chamber/store)

// reactive undo/redo
const { canUndo, canRedo, undo, redo } = useCommandHistory({
  actions: ['editor*'],
});

// namespace isolation - all calls prefixed in camelCase
const cart = useCommandGroup('cart');
cart.register('add', handler);   // registers 'cartAdd'
cart.dispatch('add', product);   // dispatches 'cartAdd'
cart.on('*', listener);          // listens to 'cart*'

// component-scoped error boundary
const { errors, latestError, clearErrors } = useCommandError({
  actions: ['cart*'],
});
```

</details>

<details>
<summary><b>createFormBus</b> - reactive forms on the bus</summary>

Per-field validation, dirty tracking, and every plugin's rules and steps on every form command.

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
// read-only: set(), touch(), reset() and setErrors() write them, one write per command

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
<button :aria-disabled="!form.isValid.value || form.isSubmitting.value"
        @click="form.isValid.value && !form.isSubmitting.value && form.submit()">
  Submit
</button>
```

</details>

## Bundle sizes

Minified, comment-free, brotli q=11. Always-current per-export table:
**[docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md)** (`npm run size:doc`). `npm run size:check` fails CI
on any regression past budget.

The two that matter: the dispatch core is **<!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB** and the import-everything barrel is
<!-- vc:sizeBarrel -->48.5<!-- /vc:sizeBarrel --> KB. The main entries, and why the numbers are
machine-stamped rather than retyped:

<details>
<summary><b>Per-export table</b> - the main entries, brotli</summary>

| Entry | brotli |
|---|--:|
| dispatch core (`createCommandBus`, tree-shaken) | **<!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB** |
| `vapor-chamber` (main barrel, import-*everything*) | <!-- vc:sizeBarrel -->48.5<!-- /vc:sizeBarrel --> KB |
| `vapor-chamber/router` | <!-- vc:sizeRouter -->11.3<!-- /vc:sizeRouter --> KB |
| `vapor-chamber/router/vdom` | <!-- vc:sizeRouterVdom -->0.7<!-- /vc:sizeRouterVdom --> KB |
| `vapor-chamber/router/vapor` | <!-- vc:sizeRouterVapor -->0.7<!-- /vc:sizeRouterVapor --> KB |
| `vapor-chamber/router/remote` | <!-- vc:sizeRouterRemote -->6.6<!-- /vc:sizeRouterRemote --> KB |
| `vapor-chamber/router-fetch` | <!-- vc:sizeRouterFetch -->6.9<!-- /vc:sizeRouterFetch --> KB |
| `vapor-chamber/vue` (with the root's surface, import-*everything*) | <!-- vc:sizeVue -->48.6<!-- /vc:sizeVue --> KB |
| `vapor-chamber/vapor` (the same) | <!-- vc:sizeVapor -->48.7<!-- /vc:sizeVapor --> KB |
| `vapor-chamber/reactive` | <!-- vc:sizeReactive -->0.5<!-- /vc:sizeReactive --> KB |
| `vapor-chamber/transports` | <!-- vc:sizeTransports -->12.1<!-- /vc:sizeTransports --> KB |
| `vapor-chamber/outbox` | <!-- vc:sizeOutbox -->6.1<!-- /vc:sizeOutbox --> KB |
| `vapor-chamber/mcp` | <!-- vc:sizeMcp -->1.8<!-- /vc:sizeMcp --> KB |
| `vapor-chamber/ssr` | <!-- vc:sizeSsr -->1.0<!-- /vc:sizeSsr --> KB |
| `vapor-chamber/store` | <!-- vc:sizeStore -->5.8<!-- /vc:sizeStore --> KB |

**Rows are not additive** - every row includes the shared core, which your bundle carries once.
The `/vue` and `/vapor` rows include the whole root they carry. An app pays only for what it
imports: one import from `/vapor` builds `examples/vapor-sfc` to the same bytes as two (log
s35.236).
`vapor-chamber` is the barrel measured import-everything. Your bundler drops what you don't use.

These figures are **machine-stamped** from [docs/BUNDLE-SIZES.md](./docs/BUNDLE-SIZES.md). The
generated file (`npm run size:doc`) is the source of truth. `npm run docs:stamp` republishes its
rows here, and `lint:check` fails on a stale one. A number a human retypes drifts, so none is
retyped.

</details>

### IIFE / CDN variants

Three `<script>`-tag drop-ins. Pick by audience, not feature checklist.

| Variant | Audience | Min | Brotli | Gzip |
|---|---|--:|--:|--:|
| **core** | Sprinkled JS on server-rendered pages (Blade, Rails, Django, WordPress). You dispatch user actions to a backend over HTTP. | <!-- vc:sizeIifeCoreRaw -->69.2<!-- /vc:sizeIifeCoreRaw --> KB | <!-- vc:sizeIifeCore -->21.6<!-- /vc:sizeIifeCore --> KB | <!-- vc:sizeIifeCoreGzip -->24.1<!-- /vc:sizeIifeCoreGzip --> KB |
| **elements** | Embeddable widgets (chat bubbles, checkout buttons, third-party drop-ins). You ship a `<vc-widget>` custom element. | <!-- vc:sizeIifeElementsRaw -->71.6<!-- /vc:sizeIifeElementsRaw --> KB | <!-- vc:sizeIifeElements -->22.4<!-- /vc:sizeIifeElements --> KB | <!-- vc:sizeIifeElementsGzip -->24.9<!-- /vc:sizeIifeElementsGzip --> KB |
| **full** | SPAs that grew big enough to want everything (realtime, undo/redo, persistence, full Vapor surface). | <!-- vc:sizeIifeFullRaw -->95.6<!-- /vc:sizeIifeFullRaw --> KB | <!-- vc:sizeIifeFull -->29.7<!-- /vc:sizeIifeFull --> KB | <!-- vc:sizeIifeFullGzip -->33.2<!-- /vc:sizeIifeFullGzip --> KB |

<details>
<summary><b>What's in each variant</b>, plus drop-in examples</summary>

| Surface | core | elements | full |
|---|:--:|:--:|:--:|
| Bus (`createCommandBus`, `createAsyncCommandBus`) | yes | yes | yes |
| `createApp()`, `connect()` one-liner | yes | yes | yes |
| HTTP transport (`httpTransport`) | yes | yes | yes |
| Light plugins (logger, validator, authGuard) and `pace()` | yes | yes | yes |
| `bindCommands()`: `[data-vc-command]` on plain HTML | yes | yes | yes |
| `bindDisplay()`: `data-vc-text`, `-show`, `-each`, `-pending` | yes | yes | yes |
| The core store (`defineChamberStore`) and `commandState`, what the display bindings read | yes | yes | yes |
| `defineVaporCustomElement`, `defineWidget(tag, component, { when })`, `emitDOMEvent()` | - | yes | yes |
| WebSocket / SSE (`wsTransport`, `sse`) | - | - | yes |
| The store's `persist: saveTo()` and `share: shareTabs()`, heavy plugins (history) and `createChannel` | - | - | yes |
| `mount()` | - | - | yes |
| Full Vapor (`defineVaporComponent`, async/Suspense) | - | - | yes |

```html
<!-- core: a button and a search box that dispatch, busy and error styled by vc-loading / vc-error -->
<button data-vc-command="cartAdd" data-vc-target='{"id":42}'>Add</button>
<input data-vc-command="searchQuery" data-vc-debounce="300">
<span data-vc-text="cart.count">0</span> <span data-vc-pending="cartAdd" data-vc-target='{"id":42}'>saving</span>
<script src=".../vapor-chamber-core.iife.min.js"></script>
<script>
  const { bus } = VaporChamber.connect({ endpoint: '/api/vc' });
  VaporChamber.defineChamberStore('cart', { state: () => ({ count: 0 }), reducers: { set: (s, t, count) => ({ count }) } })(bus);
  VaporChamber.bindCommands(document.body, { bus });
  VaporChamber.bindDisplay(document.body, { bus });
</script>

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
<script type="module">
  // Needed: without Vue's Vapor build handed over, defineWidget returns false.
  const Vue = await import('.../vue.runtime-with-vapor.esm-browser.prod.js');
  VaporChamber.configureVue(Vue);
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
vapor-chamber/directives       -> v-vc-command, v-vc-payload, v-vc-optimistic (both renderers); the
                                 same interaction on plain HTML is `bindCommands` (root)
vapor-chamber/vite             -> Vite HMR plugin + vaporChamberWire() (build-time Vue wiring)
vapor-chamber/vitest           -> Vitest 5 setup file: matchers, a recorded shared bus, fixtures
vapor-chamber/vitest/pure      -> the same helpers, registering no hook and no matcher
vapor-chamber/vitest/mcp       -> Vitest as MCP tools for an agent (behind vc-vitest-mcp)
vapor-chamber/transitions      -> Vue <Transition> hooks -> bus dispatch bridge
vapor-chamber/transitions/vapor -> VcTransition, a bus-driven transition (Vapor; Vue 3.6 only)
vapor-chamber/ssr              -> SSR by the stores' states (storeStates, seedStores), liveStores
vapor-chamber/devtools         -> Vue DevTools integration
vapor-chamber/stream-parser    -> incremental JSON parser for streamed bodies
vapor-chamber/fast-lane        -> minimal-allocation dispatcher for the real hot loops
                                 (game ticks, trading data, audio, scroll) - not a bus
vapor-chamber/observable       -> Symbol.observable interop - RxJS / xstream / callbag
vapor-chamber/standard-schema  -> Standard Schema v1 validator (Zod / Valibot / ArkType)
vapor-chamber/alien-signals    -> alien-signals as the reactive primitive (non-Vue contexts)
vapor-chamber/reactive         -> opt-in DEEP reactivity (core signal() is shallow+fast)
vapor-chamber/outbox           -> offline outbox: durable queue + ordered replay
vapor-chamber/mcp              -> zero-dep MCP server from your schema bus
vapor-chamber/store            -> experimental state layer: every mutation is a command
vapor-chamber/store/core       -> the same store with no Vue (signal() or alien-signals)
vapor-chamber/iife[-core|-elements] -> IIFE bundles
```

</details>

## Architecture

The **core** imports no framework and no dependency, and it is the only part an app needs.

```
+---------------------------------------------------------+
|  CORE  (zero deps, fully tested, framework-agnostic)    |
|  command-bus.ts, testing.ts                             |
+------------------------+--------------------------------+
                         | optional layers (tree-shaken)
         +---------------+---------------+---------------+
         v               v               v               v
   Vue composables    Plugins        Transport        Router
   chamber.ts         plugins-core   http.ts          router/
   chamber-vapor.ts   plugins-io     transports.ts    router-fetch/
         |
         v
   Extras (per-feature opt-in)
   form.ts, schema.ts, devtools.ts, directives.ts, vite-hmr.ts
```

**Coverage:** <!-- vc:covStatements -->100.0<!-- /vc:covStatements -->% statements, <!-- vc:covBranches -->100.0<!-- /vc:covBranches -->% branches, <!-- vc:covFunctions -->100.0<!-- /vc:covFunctions -->% functions, <!-- vc:covLines -->100.0<!-- /vc:covLines -->% lines across **<!-- vc:tests -->4866<!-- /vc:tests --> tests**
(<!-- vc:testFiles -->466<!-- /vc:testFiles --> files). Per-file table:
[docs/COVERAGE.md](docs/COVERAGE.md). Run `npm run test:coverage` for live numbers.

## Testing

On Vitest 5, `setupFiles: ['vapor-chamber/vitest']` tests the real bus with matchers such as
`expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 })`. See
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
const snap = bus.snapshot();          // RecordedDispatch[], a deep copy: editing it changes no record
bus.travelTo(1);                      // commands 0..1 inclusive
bus.travelToAction('cartAdd');        // up to last occurrence
bus.travelTo(999);                    // out-of-range indices clamp
```

</details>

<details>
<summary><b>setupDevtools</b> - Commands timeline + inspector panel</summary>

Needs `@vue/devtools-api`. Without it, it silently does nothing.

```typescript
import { setupDevtools } from 'vapor-chamber/devtools';

const app = createApp(App);
setupDevtools(getCommandBus(), app);
app.mount('#app');
```

An emitted fact runs no hooks, so it is not on the Commands layer. Name the facts to show
on a Facts layer: `setupDevtools(bus, app, { facts: ['router*'] })`.

</details>

## Examples

Runnable demos and copy-paste snippets. Each full-project app has its own README; each
single-file snippet is self-contained. The apps consume the library via `file:../..` and
auto-build `dist/` on demand.

Two shared helpers sit in `examples/` rather than in each example:

| Helper | Role |
|--------|------|
| [`ensure-lib.mjs`](examples/ensure-lib.mjs) | Run by every app's `predev`/`prebuild`. A `file:` dep with a `prepare` script is installed as a **frozen copy**, not a symlink - this mirrors the repo's `dist/` (built first only when it is missing) into it and drops Vite's pre-bundle cache, so an example never runs an older copy than that `dist/`. After a change under `src/`, run `npm run build` first. Under the root workspace install the entry is a symlink to the working tree, and there is nothing to mirror. |
| [`static-server.mjs`](examples/static-server.mjs) | Static host for the no-build pages (serves the repo root so `../../dist/...` resolves), with `Cache-Control: no-store` and a mock `POST /api/vc` so a dispatching page actually completes. |

**Full-project apps (runnable):**

| App | What it shows |
|-----|---------------|
| [`vapor-sfc/`](examples/vapor-sfc) | End-to-end `<script setup vapor>` SFC tree - three panels showing `useCommand`, `defineVaporCommand`, and `useSharedCommandState` side by side. |
| [`vapor-island-cart/`](examples/vapor-island-cart) | Light-DOM Vapor custom-element islands coordinating through one bus (progressive enhancement: `logger` + `history` undo/redo + a store's `persist` and `share: shareTabs()`). |
| [`exo-astro/`](examples/exo-astro) | Static Astro HTML made live by `data-vc-*` attributes alone (`bindCommands`, `bindDisplay`) - **dispatch before hydration** through `buffer: createBuffer()`. |
| [`laravel-app/`](examples/laravel-app) | Real, verified Laravel app (13.x on a current skeleton): Blade page -> core IIFE -> dispatch -> session-backed actions, with real CSRF (419/401). |
| [`laravel-backend/`](examples/laravel-backend) | Drop-in PHP controller/action files - the backend half of a dispatch. |
| [`router-demo/`](examples/router-demo) | The router end to end - outlet, loaders, typed query params, menus. No build step: `node examples/static-server.mjs`. |
| [`sprinkled-blade/`](examples/sprinkled-blade) | Minimal sprinkled-JS pattern - server-rendered HTML enhanced with the core IIFE. One process serves page + API; shows server-rendered state vs. the fetch-on-load alternative. |

**Feature snippets (single-file):**

| File | Feature |
|------|---------|
| [`feature-command-group.ts`](examples/feature-command-group.ts) | `useCommandGroup` - namespace isolation |
| [`feature-cross-tab-sync.ts`](examples/feature-cross-tab-sync.ts) | `createChannel` - a handler emits a fact, every other same-origin context applies it (BroadcastChannel) |
| [`feature-error-boundary.ts`](examples/feature-error-boundary.ts) | `useCommandError` - component-scoped error boundary |
| [`feature-persistence.ts`](examples/feature-persistence.ts) | A store's `persist` - localStorage / sessionStorage / custom storage (incl. IndexedDB) |
| [`feature-outbox.ts`](examples/feature-outbox.ts) | `createOutbox` - commands queued offline, replayed in order with their idempotency key |
| [`feature-store.ts`](examples/feature-store.ts) | `defineChamberStore` - actions as commands, undo, `$reset`, field events, `share` across tabs, `store/core` without Vue |
| [`feature-retry.ts`](examples/feature-retry.ts) | The async bus's retry - the default by condition, per-action declarations (`'idempotent'`, `false`, a count), on a schema too |
| [`feature-transitions.ts`](examples/feature-transitions.ts) | Transition-dispatched commands (the transitions bridge) |
| [`feature-transports.ts`](examples/feature-transports.ts) | HTTP and WebSocket transports, server pushes over SSE |
| [`feature-vite-hmr.ts`](examples/feature-vite-hmr.ts) | `vaporChamberHMR` - Vite hot reload that keeps the bus |
| [`feature-vite-wire.ts`](examples/feature-vite-wire.ts) | `vaporChamberWire` - build-time Vue wiring, `entry` and `profile` |
| [`feature-directives.html`](examples/feature-directives.html) | `v-vc-command` / `v-vc-payload` / `v-vc-optimistic` - **runnable**, no build step (ESM + import map): `node examples/static-server.mjs` |

**Framework patterns:**

| File | Stack |
|------|-------|
| [`pattern-1-blade-cdn.html`](examples/pattern-1-blade-cdn.html) | Laravel Blade + IIFE script tag, no build step. Loads local `dist/` so it is runnable today; the CDN form is documented in-file, version-pinned. |
| [`pattern-2-laravel-vite.ts`](examples/pattern-2-laravel-vite.ts) | Laravel + Vite + SFC (full build) |
| [`pattern-3-inertia.ts`](examples/pattern-3-inertia.ts) | Laravel + Inertia.js (alternative to the family router) |
| [`pattern-6-vapor-router.ts`](examples/pattern-6-vapor-router.ts) | Laravel Blade + `vapor-chamber/router` (the family stack: bus = writes, router = reads) |
| [`pattern-4-nextjs.tsx`](examples/pattern-4-nextjs.tsx) | Next.js App Router |
| [`pattern-5-filament.ts`](examples/pattern-5-filament.ts) | Filament panel + vapor-chamber islands |

**Core usage:**

| File | Topic |
|------|-------|
| [`shopping-cart.ts`](examples/shopping-cart.ts) | Cart with validation, history, and undo/redo |
| [`form-validation.ts`](examples/form-validation.ts) | Form validation with error handling |
| [`async-api.ts`](examples/async-api.ts) | Async handlers, an async logger plugin, and an idempotent read the bus re-sends |
| [`realtime-search.ts`](examples/realtime-search.ts) | Debounced search queries |
| [`custom-plugins.ts`](examples/custom-plugins.ts) | Writing plugins for either bus: reading the result through the `settled` part, refusing with a coded failure through `fail` (and an `id`), declaring `retryIn` |
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
| `buffer` | `createBuffer()` | - | Hold a dispatch whose handler registers later, and run it then. A query never waits |
| `naming` | `{ pattern: RegExp, onViolation?: 'warn' \| 'throw' \| 'ignore' }` | `onViolation: 'warn'` | Enforce naming convention on actions (names containing `$` are the library's and not checked) |

</details>

<details>
<summary><b>Command bus methods</b></summary>

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command (write). Auto-stamps `cmd.meta` |
| `query(action, target, payload?)` | Read-only dispatch - its rules, steps, handler and afterHooks; not counted as pending |
| `emit(event, data?)` | Fire a domain event - notifies `on()` listeners, needs no handler |
| `dispatchBatch(commands[], options?)` | Execute multiple commands -> `{ successCount, failCount, results }` |
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, canUndo?, answer?, optimistic?, exclusive?, cacheGroups?, cacheGroupInvalidation? }` |
| `use(plugin)` | Add a plugin: the bus places each part it declares |
| `onAfter(hook)` | Run after every command |
| `on(pattern, listener)` | Subscribe to matching commands (`*`, `prefix*`, exact). Returns unsub |
| `once(pattern, listener)` | Like `on()` but auto-unsubscribes after first match |
| `offAll(pattern?)` | Remove listeners for a pattern, or all |
| `request(action, target, payload?, options?)` | Async request/response with timeout (default 5s). `options.signal` settles it |
| `respond(action, handler)` | Register a responder for `request()` calls |
| `hasHandler(action)` | True if a handler is registered |
| `registeredActions()` | `string[]` of all registered action names |
| `clear()` | Remove all handlers, plugins, hooks, listeners |
| `seal()` | Freeze configuration - rejects register/use/clear after sealing |
| `dispose()` | Teardown - runs each plugin's `dispose()`, clears state, settles waiting `request()`s as `core:aborted:dispatch`. The bus stays usable |

</details>

<details>
<summary><b>Composables and helpers</b></summary>

| Composable | Description |
|------------|-------------|
| `useCommand(options?)` | Vapor-safe: dispatch + `pending(action, target?)` (the bus's `commandState`) + register/on/emit, auto-cleanup. A dispatch's own failure is its result |
| `commandState(bus, options?)` | What is in flight on a bus and what failed, for any framework or none. `pending(action, target?)` answers "is THIS one in flight?" per `commandKey(action, target)`, bus-wide, as its own signal: a reader re-runs only on its key. `anyPending` is any command in flight. `errors` is a ring buffer (`maxSize`, default 10) and `lastError` the newest. `subscribe(fn)` runs after a value moves, for a page whose signals are plain values. Counting starts at the first `pending()` call or `anyPending` read, and stops when the last handle leaves with nothing in flight. A dispatch already in flight when counting starts reads `false`. Throws `core:invalid:bus` for a bus this library did not make |
| `useSharedCommandState(options?)` | `commandState` on the component's bus, released with its scope. For toolbars, status bars, global spinners |
| `defineVaporCommand(action, handler, options?)` | Dispatch with no state, for hot paths |
| `useCommandHistory(options?)` | Reactive undo/redo |
| `useCommandGroup(namespace, options?)` | Namespace isolation - prefixes all calls in camelCase |
| `useCommandError(options?)` | Reactive error boundary for failed dispatches |
| `getCommandBus()` | Get the shared bus |
| `untracked(fn)` | Run a **raw-bus** dispatch without its handler's reads becoming dependencies of the surrounding effect. The composables above already do this - you only need it when calling `getCommandBus()` directly from inside a `watchEffect` / `computed`. No-op without Vue. **Import from `vapor-chamber/vue`** in a Vue app: from the package root it degrades to a pass-through in a production build |
| `setCommandBus(bus)` / `resetCommandBus()` | Set / reset the shared bus (useful in tests). Set it before anything calls `getCommandBus()`: replacing the bus that call already created and handed out splits the app between two buses, and warns in development |
| `configureSignal(fn)` | Inject a custom signal factory (auto-detected in Vue 3.6+) |
| `isVaporAvailable()` | True if Vue 3.6+ Vapor mode is detected |
| `createVaporChamberApp(component, props?)` | Create a Vapor app instance, typed so `.directive('vc-command', vcCommandVapor)` registers app-wide (`vapor-chamber/vapor`, needs Vue 3.6+) |
| `getVaporInteropPlugin()` | `vaporInteropPlugin` for mixed trees |
| `setupDevtools(bus, app, { facts? })` | Connect bus to Vue DevTools (`vapor-chamber/devtools`) |

Every composable above takes `bus` in its options, sync or async. Without it, it uses the shared bus.

**Router** - see [docs/router.md](docs/router.md) for the full surface:
`createRouter`, `useRouter`, `useRoute`, `useQueryParam`, `useRouteData`, `useRouteError`,
`useMenu`, `useBreadcrumbs`, `usePagination`, `onBeforeLeave`, `RouterOutlet`.

</details>

## Design Goals

1. **Minimal** - <!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB brotli core, no runtime dependency
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
| [docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md), [docs/COVERAGE.md](docs/COVERAGE.md) | Generated, always current |
| [ROADMAP.md](ROADMAP.md) | Per-module status, versions, forward plan |
| [CHANGELOG.md](CHANGELOG.md) | Per-release detail, including Vue alignment per RC |

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
