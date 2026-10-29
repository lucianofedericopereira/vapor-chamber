# vapor-chamber manual

How to do things with vapor-chamber <!-- vc:version -->1.34.0<!-- /vc:version -->, aligned with Vue <!-- vc:vueAligned -->3.6.0-rc.13<!-- /vc:vueAligned -->. Each
chapter covers one area, with the steps in the order you need them. Read chapters 1 and 2 first.
The rest stand alone.

| Chapter | What you do there |
|---|---|
| [1. Getting started](./01-getting-started.md) | Install, run a first command, pick the entry your app imports from, define commands once |
| [2. Commands, results and failures](./02-commands.md) | Register, dispatch, listen, query, emit, read failures, batch, hold for a late handler, go async, let a model or an MCP client call commands |
| [3. Plugins](./03-plugins.md) | Use the built-in plugins, configure retry, make an action optimistic, validate with a schema library, write a plugin |
| [4. Talking to a backend](./04-backend.md) | HTTP, batching, request headers, WebSocket, SSE, Echo, the offline outbox, the HTTP client, caching |
| [5. Vue and Vapor components](./05-vue.md) | Composables, a busy button, directives, transitions, forms, DevTools |
| [6. Routing](./06-router.md) | Set up the router, write route rows, guard a navigation, typed query state, pick an outlet |
| [7. State](./07-state.md) | Stores: undo, saving, tabs, a store behind a transport |
| [8. Pages without a build](./08-pages-without-a-build.md) | IIFE variants on Blade and other server pages, islands |
| [9. Server rendering](./09-ssr.md) | A bus per request, the stores' states to the client |
| [10. Testing](./10-testing.md) | The test bus, assertions, replays |
| [11. Laravel](./11-laravel.md) | Route, controller, action classes, the contract check |
| [12. Sizes and tuning](./12-sizes-and-tuning.md) | What each entry costs, speed or memory, tuning knobs |
| [13. Examples](./13-examples.md) | Runnable apps and snippets |
| [14. Quick reference](./14-quick-reference.md) | The functions, options and methods used most |

## Where else to look

The manual says how. These pages say why, or list everything:

| Page | Type | Read it to |
|---|---|---|
| [whitepaper.md](../whitepaper.md) | explanation | understand the design, and the reasons behind each rule |
| [contract.md](../contract.md) | reference | read the failure codes and the wire shapes both sides speak |
| [retry.md](../retry.md) | reference | see exactly which failures the async bus re-sends |
| [router.md](../router.md) | guide | go deep on the router: loader SPI, Blade migration, Vapor interop |
| [store.md](../store.md) | guide | go deep on stores: undo, transports, tabs, saved state |
| [performance.md](../performance.md) | guide | see what is optimized, and tune it |
| [accessibility.md](../accessibility.md) | reference | see what the library guarantees to keyboard and screen reader users |
| [timestamps.md](../timestamps.md) | reference | see every timestamp the library produces, and its form |
| [integrations/vitest.md](../integrations/vitest.md) | guide | test with Vitest 5: matchers, fixtures, an MCP server |
| [integrations/laravel.md](../integrations/laravel.md) | guide | build the backend in Laravel |
| [migrating/from-mitt.md](../migrating/from-mitt.md), [from-event-emitter.md](../migrating/from-event-emitter.md) | how-to | move from an event emitter |
| [api/](../api/README.md) | reference | look up any export's signature (generated) |
| [errors.md](../errors.md) | reference | look up any failure code (generated) |
| [ROADMAP.md](../../ROADMAP.md) | status | see what is stable, transitional or planned |
| [CHANGELOG.md](../../CHANGELOG.md) | history | see what each release changed, and how to migrate |

## Integrations at a glance

- **Vitest:** [docs/integrations/vitest.md](../integrations/vitest.md). One setup-file line
  gives matchers in Vitest's spy vocabulary (`toHaveBeenDispatchedWith`), a recorded shared bus,
  `bus` and `asyncBus` fixtures, stubs restored by `using`, and an MCP client for testing what an
  agent can reach. `vaporChamberTest()` adds the configurable parts. `npx vc-vitest-mcp` lets an
  agent run the suite and read its coverage gaps.
- **Laravel:** [docs/integrations/laravel.md](../integrations/laravel.md) covers the backend:
  route, controller, action classes, CSRF flows, Sanctum, Inertia coexistence, Filament panels,
  Reverb realtime and queued commands. Runnable PHP companions are in
  [examples/laravel-backend/](../../examples/laravel-backend).
- **Astro:** [examples/exo-astro](../../examples/exo-astro) makes static Astro HTML live through the
  `data-vc-*` attributes (`bindCommands`, `bindDisplay`), with independent page sections on one
  bus. It passes `buffer: createBuffer()`, so a section can dispatch before its handler hydrates.
- **Performance and tuning:** [docs/performance.md](../performance.md): what is optimized by
  default, the tuning knobs (`configureUid`, `configureSignal`), a store's saves, variant
  selection, a benchmark snapshot.
- **Failures and the wire:** [docs/contract.md](../contract.md): the `owner:condition:subject`
  codes, the conditions, and the request and answer shapes both sides of the wire read.
- **Accessibility:** [docs/accessibility.md](../accessibility.md): what the library guarantees
  to keyboard and screen reader users, and what only the app can do.
- **Retry:** [docs/retry.md](../retry.md): which failures the async bus re-sends, when, how
  often, and how an action declares itself safe to send twice.
- **Timestamps:** [docs/timestamps.md](../timestamps.md): every timestamp the library produces
  and its form (epoch ms inside the process, RFC 3339 text at a boundary).
- **API reference:** [docs/api/](../api/): every published `exports` subpath, generated from
  the compiler by `npm run docs`. It is committed, so an added or changed export shows in the diff.
