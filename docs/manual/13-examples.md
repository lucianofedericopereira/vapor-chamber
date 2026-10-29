# 13. Examples

Runnable apps and copy-paste snippets, each showing one task end to end.

Runnable demos and copy-paste snippets. Each full-project app has its own README, and each
single-file snippet stands alone. The apps consume the library through `file:../..` and build
`dist/` on demand.

Two shared helpers sit in `examples/` rather than in each example:

| Helper | Role |
|--------|------|
| [`ensure-lib.mjs`](../../examples/ensure-lib.mjs) | Run by every app's `predev` and `prebuild`. A `file:` dependency with a `prepare` script is installed as a **frozen copy**, not a symlink. This helper mirrors the repo's `dist/` into it (building `dist/` first only when it is missing) and drops Vite's pre-bundle cache, so an example never runs an older copy than that `dist/`. After a change under `src/`, run `npm run build` first. Under the root workspace install the entry is a symlink to the working tree, and there is nothing to mirror. |
| [`static-server.mjs`](../../examples/static-server.mjs) | Static host for the no-build pages. It serves the repo root so `../../dist/...` resolves, with `Cache-Control: no-store` and a mock `POST /api/vc` so a dispatching page completes. |

**Full-project apps (runnable):**

| App | What it shows |
|-----|---------------|
| [`vapor-sfc/`](../../examples/vapor-sfc) | An end-to-end `<script setup vapor>` SFC tree: three panels showing `useCommand`, `defineVaporCommand` and `useSharedCommandState` side by side. |
| [`vapor-island-cart/`](../../examples/vapor-island-cart) | Light-DOM Vapor custom-element islands coordinating through one bus, as progressive enhancement: `logger`, `history` undo/redo, and a store's `persist` and `share: shareTabs()`. |
| [`exo-astro/`](../../examples/exo-astro) | Static Astro HTML made live by `data-vc-*` attributes alone (`bindCommands`, `bindDisplay`), with **dispatch before hydration** through `buffer: createBuffer()`. |
| [`laravel-app/`](../../examples/laravel-app) | A real, verified Laravel app (13.x on a current skeleton): Blade page -> core IIFE -> dispatch -> session-backed actions, with real CSRF (419/401). |
| [`laravel-backend/`](../../examples/laravel-backend) | Drop-in PHP controller and action files: the backend half of a dispatch. |
| [`router-demo/`](../../examples/router-demo) | The router end to end: outlet, loaders, typed query params, menus. No build step: `node examples/static-server.mjs`. |
| [`sprinkled-blade/`](../../examples/sprinkled-blade) | The minimal sprinkled-JS pattern: server-rendered HTML enhanced with the core IIFE. One process serves page and API, and shows server-rendered state against the fetch-on-load alternative. |

**Feature snippets (single-file):**

| File | Feature |
|------|---------|
| [`feature-command-group.ts`](../../examples/feature-command-group.ts) | `useCommandGroup`: namespace isolation |
| [`feature-cross-tab-sync.ts`](../../examples/feature-cross-tab-sync.ts) | `createChannel`: a handler emits a fact, and every other same-origin context applies it (BroadcastChannel) |
| [`feature-error-boundary.ts`](../../examples/feature-error-boundary.ts) | `useCommandError`: a component-scoped error boundary |
| [`feature-persistence.ts`](../../examples/feature-persistence.ts) | A store's `persist`: localStorage, sessionStorage or custom storage (IndexedDB included) |
| [`feature-outbox.ts`](../../examples/feature-outbox.ts) | `createOutbox`: commands queued offline, replayed in order with their idempotency key |
| [`feature-store.ts`](../../examples/feature-store.ts) | `defineChamberStore`: actions as commands, undo, `$reset`, field events, `share` across tabs, `store/core` without Vue |
| [`feature-retry.ts`](../../examples/feature-retry.ts) | The async bus's retry: the default by condition, per-action declarations (`'idempotent'`, `false`, a count), on a schema too |
| [`feature-transitions.ts`](../../examples/feature-transitions.ts) | Commands dispatched by transitions (the transitions bridge) |
| [`feature-transports.ts`](../../examples/feature-transports.ts) | HTTP and WebSocket transports, server pushes over SSE |
| [`feature-vite-hmr.ts`](../../examples/feature-vite-hmr.ts) | `vaporChamberHMR`: Vite hot reload that keeps the bus |
| [`feature-vite-wire.ts`](../../examples/feature-vite-wire.ts) | `vaporChamberWire`: build-time Vue wiring, `entry` and `profile` |
| [`feature-directives.html`](../../examples/feature-directives.html) | `v-vc-command`, `v-vc-payload`, `v-vc-optimistic`. **Runnable** with no build step (ESM and an import map): `node examples/static-server.mjs` |

**Framework patterns:**

| File | Stack |
|------|-------|
| [`pattern-1-blade-cdn.html`](../../examples/pattern-1-blade-cdn.html) | Laravel Blade + IIFE script tag, no build step. It loads the local `dist/`, so it runs today. The CDN form is documented in the file, version-pinned. |
| [`pattern-2-laravel-vite.ts`](../../examples/pattern-2-laravel-vite.ts) | Laravel + Vite + SFC (full build) |
| [`pattern-3-inertia.ts`](../../examples/pattern-3-inertia.ts) | Laravel + Inertia.js (the alternative to the family router) |
| [`pattern-6-vapor-router.ts`](../../examples/pattern-6-vapor-router.ts) | Laravel Blade + `vapor-chamber/router` (the family stack: bus = writes, router = reads) |
| [`pattern-4-nextjs.tsx`](../../examples/pattern-4-nextjs.tsx) | Next.js App Router |
| [`pattern-5-filament.ts`](../../examples/pattern-5-filament.ts) | Filament panel + vapor-chamber islands |

**Core usage:**

| File | Topic |
|------|-------|
| [`shopping-cart.ts`](../../examples/shopping-cart.ts) | Cart with validation, history, and undo/redo |
| [`form-validation.ts`](../../examples/form-validation.ts) | Form validation with error handling |
| [`async-api.ts`](../../examples/async-api.ts) | Async handlers, an async logger plugin, and an idempotent read the bus re-sends |
| [`realtime-search.ts`](../../examples/realtime-search.ts) | Debounced search queries |
| [`custom-plugins.ts`](../../examples/custom-plugins.ts) | Writing plugins for either bus: reading the result through the `settled` part, refusing with a coded failure through `fail` (and an `id`), declaring `retryIn` |
| [`vue-vapor-component.vue`](../../examples/vue-vapor-component.vue) | A full Vue Vapor todo app |

Next: [14. Quick reference](./14-quick-reference.md).
