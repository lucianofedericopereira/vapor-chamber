# 13. Examples

Runnable apps and copy-paste snippets, each showing one task end to end.

Runnable demos and copy-paste snippets. Each full-project app has its own README, and each
single-file snippet stands alone. The apps consume the library through `file:../../..` and build
`dist/` on demand.

The tree is grouped by kind:

| Folder | Holds |
|--------|-------|
| `examples/apps/` | The apps with a build of their own: `vapor-sfc`, `vapor-island-cart`, `exo-astro`. |
| `examples/pages/` | The no-build pages: `router-demo`, `sprinkled-blade`, `feature-directives.html`, `pattern-1-blade-cdn.html`. |
| `examples/laravel/` | The Laravel app (`app/`) and the drop-in backend files (`backend/`). |
| `examples/snippets/` | The single-file snippets, type-checked by `tsconfig.patterns.json` and `tsconfig.pattern-4.json` there. |
| `examples/shared/` | What more than one example uses. |

**Paths moved.** A link, log entry or bookmark written before this layout maps as follows:

| Old path | New path |
|----------|----------|
| `examples/{vapor-sfc,vapor-island-cart,exo-astro}/` | `examples/apps/...` |
| `examples/{router-demo,sprinkled-blade}/` | `examples/pages/...` |
| `examples/{feature-directives.html,pattern-1-blade-cdn.html}` | `examples/pages/...` |
| `examples/*.ts`, `examples/*.tsx`, `examples/*.vue`, `examples/*.d.ts` | `examples/snippets/...` |
| `examples/{tsconfig.patterns.json,tsconfig.pattern-4.json}` | `examples/snippets/...` |
| `examples/{ensure-lib.mjs,static-server.mjs,vite.base.ts}` | `examples/shared/...` |
| `examples/laravel-app/` | `examples/laravel/app/` |
| `examples/laravel-backend/` | `examples/laravel/backend/` |

**Run the no-build pages with one command:** `npm run examples`, then open `http://localhost:3000/`. The index there links every page and names each app's own `npm run dev`.

The shared helpers sit in `examples/shared/` rather than in each example:

| Helper | Role |
|--------|------|
| [`ensure-lib.mjs`](../../examples/shared/ensure-lib.mjs) | Run by every app's `predev` and `prebuild`, and before `npm run examples`. A `file:` dependency with a `prepare` script is installed as a **frozen copy**, not a symlink. This helper mirrors the repo's `dist/` into it (building `dist/` first only when it is missing) and drops Vite's pre-bundle cache, so an example never runs an older copy than that `dist/`. After a change under `src/`, run `npm run build` first. Under the root workspace install the entry is a symlink to the working tree, and there is nothing to mirror. |
| [`static-server.mjs`](../../examples/shared/static-server.mjs) | Static host for the no-build pages. It serves the repo root so `../../../dist/...` resolves, with `Cache-Control: no-store` and a mock `POST /api/vc` so a dispatching page completes. |
| [`base.css`](../../examples/shared/base.css) | The examples' shared layout: the page column, panels, muted text, code. Each page keeps, inline, the `vc-*` and `aria-disabled` rules it teaches and whatever only it needs (router-demo and exo-astro a wider column). The no-build pages link it, the Vite apps import it in `main.ts`, exo-astro in its frontmatter; `setup.sh` copies it to the Laravel app's `public/css/`. |
| [`vite.pages.config.mjs`](../../examples/shared/vite.pages.config.mjs) | `npm run examples`: a Vite server for the index (`examples/index.html`), with the static server's handler in front of it, so every page, `dist/` file and mock answer is sent as it is on disk (a page Vite transformed would no longer show a page with no build step). It also starts sprinkled-blade's backend on 3001. The apps keep their own dev servers and builds. |

**Full-project apps (runnable):**

| App | What it shows |
|-----|---------------|
| [`vapor-sfc/`](../../examples/apps/vapor-sfc) | An end-to-end `<script setup vapor>` SFC tree: three panels showing `useCommand`, `defineVaporCommand` and `useSharedCommandState` side by side. |
| [`vapor-island-cart/`](../../examples/apps/vapor-island-cart) | Light-DOM Vapor custom-element islands coordinating through one bus, as progressive enhancement: `logger`, `history` undo/redo, and a store's `persist` and `share: shareTabs()`. |
| [`exo-astro/`](../../examples/apps/exo-astro) | Static Astro HTML made live by `data-vc-*` attributes alone (`bindCommands`, `bindDisplay`), with **dispatch before hydration** through `buffer: createBuffer()`. |
| [`laravel/app/`](../../examples/laravel/app) | A real, verified Laravel app (13.x on a current skeleton): Blade page -> core IIFE -> dispatch -> session-backed actions, with real CSRF (419/401). |
| [`laravel/backend/`](../../examples/laravel/backend) | Drop-in PHP controller and action files: the backend half of a dispatch. |
| [`router-demo/`](../../examples/pages/router-demo) | The router end to end: outlet, loaders, typed query params, menus. No build step: `node examples/shared/static-server.mjs`. |
| [`sprinkled-blade/`](../../examples/pages/sprinkled-blade) | The minimal sprinkled-JS pattern: server-rendered HTML enhanced with the core IIFE. One process serves page and API, and shows server-rendered state against the fetch-on-load alternative. |

**Feature snippets (single-file):**

| File | Feature |
|------|---------|
| [`feature-command-group.ts`](../../examples/snippets/feature-command-group.ts) | `useCommandGroup`: namespace isolation |
| [`feature-cross-tab-sync.ts`](../../examples/snippets/feature-cross-tab-sync.ts) | `createChannel`: a handler emits a fact, and every other same-origin context applies it (BroadcastChannel) |
| [`feature-error-boundary.ts`](../../examples/snippets/feature-error-boundary.ts) | `useCommandError`: a component-scoped error boundary |
| [`feature-persistence.ts`](../../examples/snippets/feature-persistence.ts) | A store's `persist`: localStorage, sessionStorage or custom storage (IndexedDB included) |
| [`feature-outbox.ts`](../../examples/snippets/feature-outbox.ts) | `createOutbox`: commands queued offline, replayed in order with their idempotency key |
| [`feature-store.ts`](../../examples/snippets/feature-store.ts) | `defineChamberStore`: actions as commands, undo, `$reset`, field events, `share` across tabs, `store/core` without Vue |
| [`feature-retry.ts`](../../examples/snippets/feature-retry.ts) | The async bus's retry: the default by condition, per-action declarations (`'idempotent'`, `false`, a count), on a schema too |
| [`feature-transitions.ts`](../../examples/snippets/feature-transitions.ts) | Commands dispatched by transitions (the transitions bridge) |
| [`feature-transports.ts`](../../examples/snippets/feature-transports.ts) | HTTP and WebSocket transports, server pushes over SSE |
| [`feature-vite-hmr.ts`](../../examples/snippets/feature-vite-hmr.ts) | `vaporChamberHMR`: Vite hot reload that keeps the bus |
| [`feature-vite-wire.ts`](../../examples/snippets/feature-vite-wire.ts) | `vaporChamberWire`: build-time Vue wiring, `entry` and `profile` |
| [`feature-directives.html`](../../examples/pages/feature-directives.html) | `v-vc-command`, `v-vc-payload`, `v-vc-optimistic`. **Runnable** with no build step (ESM and an import map): `node examples/shared/static-server.mjs` |

**Framework patterns:**

| File | Stack |
|------|-------|
| [`pattern-1-blade-cdn.html`](../../examples/pages/pattern-1-blade-cdn.html) | Laravel Blade + IIFE script tag, no build step. It loads the local `dist/`, so it runs today. The CDN form is documented in the file, version-pinned. |
| [`pattern-2-laravel-vite.ts`](../../examples/snippets/pattern-2-laravel-vite.ts) | Laravel + Vite + SFC (full build) |
| [`pattern-3-inertia.ts`](../../examples/snippets/pattern-3-inertia.ts) | Laravel + Inertia.js (the alternative to the family router) |
| [`pattern-6-vapor-router.ts`](../../examples/snippets/pattern-6-vapor-router.ts) | Laravel Blade + `vapor-chamber/router` (the family stack: bus = writes, router = reads) |
| [`pattern-4-nextjs.tsx`](../../examples/snippets/pattern-4-nextjs.tsx) | Next.js App Router |
| [`pattern-5-filament.ts`](../../examples/snippets/pattern-5-filament.ts) | Filament panel + vapor-chamber islands |

**Core usage:**

| File | Topic |
|------|-------|
| [`shopping-cart.ts`](../../examples/snippets/shopping-cart.ts) | Cart with validation, history, and undo/redo |
| [`form-validation.ts`](../../examples/snippets/form-validation.ts) | Form validation with error handling |
| [`async-api.ts`](../../examples/snippets/async-api.ts) | Async handlers, an async logger plugin, and an idempotent read the bus re-sends |
| [`realtime-search.ts`](../../examples/snippets/realtime-search.ts) | Debounced search queries |
| [`custom-plugins.ts`](../../examples/snippets/custom-plugins.ts) | Writing plugins for either bus: reading the result through the `settled` part, refusing with a coded failure through `fail` (and an `id`), declaring `retryIn` |
| [`vue-vapor-component.vue`](../../examples/snippets/vue-vapor-component.vue) | A full Vue Vapor todo app |

Next: [14. Quick reference](./14-quick-reference.md).
