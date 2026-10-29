<p align="center">
  <img src="assets/vapor-chamber.png" alt="Vapor Chamber">
</p>

<p align="center">
  A command bus built for <a href="https://github.com/vuejs/core">Vue Vapor</a>: a <!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB brotli dispatch core, and opt-in modules that cost 0 KB until imported. Aligned with Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->. LGPL-2.1.
</p>

---

Each user action is a command with **one handler**, **plugins** placed around it, and
**signal-native** reactive state. One flow replaces scattered event listeners and prop drilling.

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

`emit` is fire-and-forget, with many listeners. `dispatch` has one handler and its plugins'
rules and steps, so each action has one place to read and one place to test.

## What's in the can

|  |  |
|--|--|
| **Core** (the bus) | dispatch, query and emit, plugin parts, wildcard listeners. Framework-agnostic, no Vue import, **<!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB brotli** |
| **Vue composables** | `useCommand`, shared state, `defineVaporCommand`, full Vapor wrappers |
| **Router** (opt-in) | URL-addressed reads for Vue 3.6 over a server catch-all, with route tables and loaders as data |
| **Plugins** (opt-in) | logger, validator, history (undo/redo), idempotent, auth guard. Retry is the async bus's own. Pacing (debounce, throttle) is the sender's: `pace()` |
| **Transports** (opt-in) | `httpTransport` (with `batch`), WebSocket, SSE, Laravel Echo/Reverb |
| **Extras** (opt-in) | SSR by the stores' states, form bus, HTTP client, streaming JSON parser, schema validation, transitions, devtools, Vite HMR, testing, MCP server, offline outbox |

- **Aligned with Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->:** signals, `onScopeDispose`,
  `getCurrentScope`, alien-signals internals. The [CHANGELOG](CHANGELOG.md) tracks each release.
- **No runtime dependency.** `alien-signals` is an optional peer, installed only by apps that use
  the `vapor-chamber/alien-signals` connector. Unimported modules tree-shake to zero.
- **ESM only**, plus three IIFE `<script>` drop-ins for pages with no bundler.
- **<!-- vc:covStatements -->100.0<!-- /vc:covStatements -->% coverage on all four axes:** statements, branches, functions and
  lines, across **<!-- vc:tests -->4866<!-- /vc:tests --> tests** in <!-- vc:testFiles -->466<!-- /vc:testFiles --> files ([full table](docs/COVERAGE.md)).

## Install

```bash
npm install vapor-chamber
```

It needs Node 24.5 or later. Vue is an optional peer: 3.5 or later for the composables,
<!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned --> or later for the full Vapor surface. The core bus runs with no Vue.

In a Vue app, import the composables from `vapor-chamber/vue` (or `vapor-chamber/vapor`), never
from the root: the root cannot wire Vue in a production bundle.
[Pick the entry your app imports from](docs/manual/01-getting-started.md#pick-the-entry-your-app-imports-from)
says which one.

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

## The manual

[The manual](docs/manual/README.md) shows how to do each thing, step by step:

1. [Getting started](docs/manual/01-getting-started.md): install, a first command, the entry to import from
2. [Commands, results and failures](docs/manual/02-commands.md)
3. [Plugins](docs/manual/03-plugins.md): the built-in ones, retry, optimistic actions, schema validation, your own
4. [Talking to a backend](docs/manual/04-backend.md): HTTP, batching, WebSocket, SSE, Echo, the offline outbox, the HTTP client
5. [Vue and Vapor components](docs/manual/05-vue.md): composables, directives, forms, DevTools
6. [Routing](docs/manual/06-router.md): route rows, guards, query state, outlets
7. [State](docs/manual/07-state.md): stores with undo, saving and tab sharing
8. [Pages without a build](docs/manual/08-pages-without-a-build.md): IIFE bundles on Blade and other server pages
9. [Server rendering](docs/manual/09-ssr.md)
10. [Testing](docs/manual/10-testing.md)
11. [Laravel](docs/manual/11-laravel.md)
12. [Sizes and tuning](docs/manual/12-sizes-and-tuning.md)
13. [Examples](docs/manual/13-examples.md)
14. [Quick reference](docs/manual/14-quick-reference.md)

## Design Goals

1. **Minimal:** a <!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB brotli core, no runtime dependency.
2. **Vapor-native:** built for signals, not vDOM.
3. **Composable:** a plugin for each cross-cutting concern.
4. **Type-safe:** full TypeScript, with one schema as the source of truth.
5. **Predictable:** sync by default, async when asked.
6. **Progressive:** works in vDOM, Vapor and mixed trees.

## Documentation

| | |
|---|---|
| [docs/manual/](docs/manual/README.md) | How to do each thing, step by step |
| [docs/whitepaper.md](docs/whitepaper.md) | Why it is built this way: design, architecture, the naming evidence, the Vue 3.6 alignment log |
| [docs/router.md](docs/router.md), [docs/store.md](docs/store.md) | The router and store guides, in depth |
| [docs/performance.md](docs/performance.md) | What is optimized, tuning knobs, benchmarks |
| [docs/BUNDLE-SIZES.md](docs/BUNDLE-SIZES.md), [docs/COVERAGE.md](docs/COVERAGE.md) | Generated, always current |
| [docs/api/](docs/api/README.md), [docs/errors.md](docs/errors.md) | Every export and every failure code, generated |
| [ROADMAP.md](ROADMAP.md) | Per-module status, versions, forward plan |
| [CHANGELOG.md](CHANGELOG.md) | Per-release detail, including Vue alignment per RC |

## License

[GNU Lesser General Public License v2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.en.html)
