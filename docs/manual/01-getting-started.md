# 1. Getting started

This chapter installs the package, runs a first command, and picks the entry your app imports
from. After it you have a bus that dispatches, and a build that wires Vue correctly.

## Install

```bash
npm install vapor-chamber        # npm registry (releases may lag the repo)

# or straight from the repo: the authoritative source while Vue 3.6 is in RC
# (a `prepare` script builds it on install):
npm install github:lucianofedericopereira/vapor-chamber
```

What it needs:

- **Node 24**, 24.5 or later. No other major is tested.
- **Vue is an optional peer:** 3.5 or later for the composables,
  <!-- vc:vueAligned -->3.6.0-rc.14<!-- /vc:vueAligned --> or later for the full Vapor surface. The core bus runs with no Vue.
- **Vite 5+ and `@vitejs/plugin-vue` 5+** only for the `vapor-chamber/vite` plugins (HMR,
  `vaporChamberWire()`) and Vapor SFC support.
- **ESM only**, no CJS build. Node 24 `import`, bundlers and `<script type="module">` all work.
  For classic `<script>` tags, use the IIFE variants ([chapter 8](./08-pages-without-a-build.md)).

> **RC tracking.** This library follows Vue 3.6 through its release candidates. The Vapor
> wrappers are transitional and realign once 3.6 ships stable. [ROADMAP.md](../../ROADMAP.md) lists
> what is stable today and what is transitional.

## Run a first command

Create a bus, install two plugins, register a handler, dispatch:

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

The dispatch returns `{ ok, value, error }`. [Chapter 2](./02-commands.md) covers commands,
results and failures in full.

## Pick the entry your app imports from

**In a Vue app, import from `vapor-chamber/vue`, not the root.** Use `vapor-chamber/vapor`
instead when the app calls the library's Vapor API, such as `createVaporChamberApp`. The entry
carries the composables (`useCommand`, `useCommandHistory`, `signal`, ...) and the root's whole
surface: the bus, plugins, transports. It hands Vue to the library the moment it is imported, so
even module-scope state is reactive:

```ts
import { createCommandBus, setCommandBus, useCommand, signal } from 'vapor-chamber/vue';

export const count = signal(0);   // reactive, no waiting
```

They are the root's own functions, so code that still takes the bus from the root shares the
same bus.

Imported from the root, the composables **fail in a production bundle**: plain `{ value }` state
with no reactivity, no automatic cleanup, no KeepAlive guard.[^root-lookup] The library warns
once, in production too, when it sees Vue running with nothing wired. It adds a DEV warning on
the first composable call when Vue arrived through the runtime lookup.

[^root-lookup]: The root must work with no Vue in the tree, so it can only look for Vue at runtime, through a bare `import('vue')`. That resolves under a dev server and fails in a production bundle. Measured in `tests/root-only-prod-fixture.test.ts`.

`waitForVueDetection()` waits on that same runtime lookup, so in a bundled app it cannot help.
It is for **no-build pages only**, where the lookup can resolve, for example through an import
map for `vue`. There too, `configureVue(Vue)` is the more reliable choice.

### One entry per kind of app

`/vue` and `/vapor` carry the bus too.[^entries-measured]

[^entries-measured]: Measured on built apps of each kind (log s35.231).

| App | Import from | Build step |
|---|---|---|
| App that calls the library's Vapor API (`createVaporChamberApp`, `defineVaporComponent`, `defineVaporAsyncComponent`, `defineVaporCustomElement`, `getVaporInteropPlugin`) | `vapor-chamber/vapor` | Optional, drops the runtime lookup: `vaporChamberWire({ entry: 'vapor' })` on Vite, the define below elsewhere |
| Any other Vue app, vDOM or Vapor, including one that uses only Vue's own Vapor APIs or `vapor-chamber/router/vapor` | `vapor-chamber/vue` | Optional, the same: `vaporChamberWire()` on Vite, the define elsewhere |
| Server build (SSR) | `vapor-chamber/vue` | Optional: the define drops the runtime lookup from the server bundle |
| App that imports only the root | the root | Needed on Vite: `vaporChamberWire()`. Other bundlers have none, so import from a subpath |
| `<script>`-tag page | `VaporChamber.configureVue(Vue)` | None. `untracked()` is not available |
| ESM page with an import map | `configureVue(Vue)` | None. `untracked()` cannot suspend tracking |

`untracked()` is a plain pass-through when Vue is absent. So the root import stays safe in code
shared between Vue and non-Vue targets, though it cannot suspend tracking there.

In DEV it warns once when Vue arrived through the runtime lookup rather than at build time. The
warning shows only where DEV is on: a page served by Vite's dev server, or a test runner with a
DOM. A production build drops it from every chunk. A server never shows it, because Node
resolves that lookup in production too, so the advice would be wrong there.[^dev-warning]

[^dev-warning]: Measured in a real browser on Vite 8, and in Node.

### A Vapor app: `vapor-chamber/vapor`

When the app calls the library's Vapor API, import from `vapor-chamber/vapor`. It needs Vue 3.6.
It is a superset of `vapor-chamber/vue`, with the same composables and the same tracking fix, and
it also wires Vue's Vapor APIs statically. So there is no `configureVue()` call to write and no
runtime probe to depend on:

```ts
import { createVaporChamberApp } from 'vapor-chamber/vapor';

createVaporChamberApp(App).mount('#app');
```

The root's Vapor detection is the same bare-specifier lookup, so in a production bundle it can
come up empty. Then `createVaporChamberApp()` throws *"No Vue detected"* on a page with Vapor
bundled into it. The static entry has no such failure mode. It is a separate subpath from
`vapor-chamber/vue` because the Vapor names do not exist on Vue 3.5, where importing them by
name is a build error.

It wires `createVaporApp`, `defineVaporComponent` and `defineVaporAsyncComponent`, which add
**+<!-- vc:sizeVaporEntryRaw -->4.4<!-- /vc:sizeVaporEntryRaw --> KB** raw over hand-wiring `createVaporApp`.[^vapor-wiring]

[^vapor-wiring]: Re-measured on every run with Vue bundled. The Vapor wiring table in [docs/BUNDLE-SIZES.md](../BUNDLE-SIZES.md) has it. The whitepaper's rc.6 row has the measurement on the `examples/vapor-sfc` app that decided the split.

`defineVaporCustomElement` (+<!-- vc:sizeVaporCustomElementRaw -->6.9<!-- /vc:sizeVaporCustomElementRaw --> KB raw)
and `vaporInteropPlugin` (+<!-- vc:sizeVaporInteropRaw -->73.0<!-- /vc:sizeVaporInteropRaw --> KB raw, the whole VDOM interop renderer) are left out on
purpose, because a static import stays in the bundle whether the app calls it or not. If you use
either, one line adds it, merged with what the entry already wired:

```ts
import { defineVaporCustomElement, vaporInteropPlugin } from 'vue';
import { configureVue } from 'vapor-chamber/vapor';

configureVue({ defineVaporCustomElement, vaporInteropPlugin });
```

### On Vite: `vaporChamberWire()`

A Vite plugin can make the root import correct instead. `vaporChamberWire()` from
`vapor-chamber/vite` works at build time. It resolves the bare `vapor-chamber` specifier to the
real root plus a side-effect import of `vapor-chamber/vue`. So an app whose components import
the composables from the root is wired in production with no import changed:

```ts
// vite.config.ts
import vue from '@vitejs/plugin-vue';
import { vaporChamberWire } from 'vapor-chamber/vite';

export default defineConfig({
  plugins: [vue(), vaporChamberWire()], // { entry: 'vapor' } when the app calls the library's Vapor API
});
```

`'vapor'` is your call, not a guess. It wires Vue's Vapor app and component helpers into the
bundle, which an app that does not call the library's Vapor API should not pay for.

- **In dev** the plugin does not redirect: the dev server resolves the runtime lookup by
  itself.[^dev-redirect] It only defines `__VC_WIRED__`, which keeps the DEV warning above from
  telling you to change imports the plugin already handles.
- **In a build** it also defines `__VC_WIRED_BUILD__`, which removes the root's runtime lookup
  from the bundle. It adds to the app exactly what importing the subpath would.[^wire-pinned]

[^dev-redirect]: A redirect there, over a pre-bundled install, would put two copies of the library in the page (measured).

[^wire-pinned]: Both halves are pinned against real Vite runs in `tests/vite-wire-plugin.test.ts`.

The same plugin sets the build profile, `vaporChamberWire({ profile: 'lean' })`, which trades
speed for memory. The default is `'performance'`. [Chapter 12](./12-sizes-and-tuning.md) covers
it.

### On esbuild or webpack: one define

Import from the subpath and add one define. Both bundlers resolve the root's runtime
`import('vue')` to the whole Vue namespace. Without the define, every app that uses the
composables ships all of Vue, and webpack warns "Critical dependency". Once the app imports
`vapor-chamber/vue` (or `/vapor`), the lookup is dead code, and the define says so:

```ts
// esbuild
define: { __VC_WIRED_BUILD__: 'true' }
// webpack
new webpack.DefinePlugin({ __VC_WIRED_BUILD__: 'true' })
```

Leave it out only for an app that imports the composables from the root and wires nothing:
there, the lookup is what finds Vue.[^root-probe]

[^root-probe]: `tests/root-probe-builds.test.ts`.

A Vite app that imports from the subpath, with neither `vaporChamberWire()` nor the define,
still ships the lookup as dead code. Either one removes it.[^dead-lookup]

[^dead-lookup]: +2,589 B raw, +932 B brotli on a vDOM app, measured 2026-10-08 (log s35.231).

## Define each command once

One schema literal drives types, validation, the backend and AI tools:

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

- `bus.toTools()`: tools for Anthropic and OpenAI.
- `vapor-chamber/mcp`: agents drive your commands over MCP, allowlisted, stamped `meta.origin`.
- `node scripts/generate-laravel.mjs commands.mjs`: the Laravel config registry and action-class
  stubs with validation rules.

A misspelled action or field in a component is a compile error, before any request is sent.

## Build a library on vapor-chamber

Mark `vapor-chamber` and every `vapor-chamber/*` subpath external. A subpath left in your bundle
is a second copy of the library, and two copies share no state: a store from one is refused by
the other's bus.[^two-copies]

[^two-copies]: `tests/library-names.test.ts`.

## The package's subpaths

Each subpath is opt-in, and costs nothing until imported:

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

The **core** imports no framework and no dependency, and it is the only part an app needs:

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

**Coverage:** <!-- vc:covStatements -->100.0<!-- /vc:covStatements -->% statements, <!-- vc:covBranches -->100.0<!-- /vc:covBranches -->% branches, <!-- vc:covFunctions -->100.0<!-- /vc:covFunctions -->% functions, <!-- vc:covLines -->100.0<!-- /vc:covLines -->% lines across **<!-- vc:tests -->4867<!-- /vc:tests --> tests**
(<!-- vc:testFiles -->472<!-- /vc:testFiles --> files). The per-file table is [docs/COVERAGE.md](../COVERAGE.md). Run
`npm run test:coverage` for live numbers.

Next: [2. Commands, results and failures](./02-commands.md).
