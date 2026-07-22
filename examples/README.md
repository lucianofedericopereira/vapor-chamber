# Examples

Runnable demos and copy-paste snippets for vapor-chamber. The full-project apps
each have their own README; the single-file snippets are self-contained. The apps
consume the library via `file:../..` and auto-build `dist/` on demand. Aligned with
**Vue 3.6.0-rc.1**.

Two shared helpers sit here rather than in each example:

| Helper | Role |
|--------|------|
| [`ensure-lib.mjs`](./ensure-lib.mjs) | Run by every app's `predev`/`prebuild`. A `file:` dep with a `prepare` script is installed as a **frozen copy**, not a symlink — this mirrors the freshly built `dist/` into it and drops Vite's pre-bundle cache, so an example can never run stale library code. |
| [`static-server.mjs`](./static-server.mjs) | Static host for the no-build pages (serves the repo root so `../../dist/...` resolves), with `Cache-Control: no-store` and a mock `POST /api/vc` so a dispatching page actually completes. |

## Full-project apps (runnable)

| App | What it shows |
|-----|---------------|
| [`vapor-sfc/`](./vapor-sfc) | End-to-end `<script setup vapor>` SFC tree — three panels showing `useCommand`, `defineVaporCommand`, and `useSharedCommandState` side by side. |
| [`vapor-island-cart/`](./vapor-island-cart) | Light-DOM Vapor custom-element islands coordinating through one bus (progressive enhancement: `logger` + `history` undo/redo + cross-tab `sync` + `persist`). |
| [`exo-astro/`](./exo-astro) | Five declarative directives for Astro pages (incl. `v-each`) — **dispatch before hydration** via `onMissing:'buffer'`. Its scanner is covered by [`tests/examples/`](../tests/examples/). |
| [`laravel-app/`](./laravel-app) | Real, verified Laravel app (13.x on a current skeleton): Blade page → core IIFE → dispatch → session-backed actions, with real CSRF (419/401). |
| [`laravel-backend/`](./laravel-backend) | Drop-in PHP controller/action files — the backend half of a dispatch. |
| [`sprinkled-blade/`](./sprinkled-blade) | Minimal sprinkled-JS pattern — server-rendered HTML enhanced with the core IIFE. One process serves page + API; shows server-rendered state vs. the fetch-on-load alternative. |

## Feature snippets (single-file)

| File | Feature |
|------|---------|
| [`feature-command-group.ts`](./feature-command-group.ts) | `useCommandGroup` — namespace isolation |
| [`feature-cross-tab-sync.ts`](./feature-cross-tab-sync.ts) | `sync` plugin — cross-tab coordination (BroadcastChannel) |
| [`feature-error-boundary.ts`](./feature-error-boundary.ts) | `useCommandError` — component-scoped error boundary |
| [`feature-persistence.ts`](./feature-persistence.ts) | `persist` plugin — localStorage / sessionStorage / custom storage (incl. IndexedDB) |
| [`feature-retry.ts`](./feature-retry.ts) | `retry` plugin — configurable backoff for failed dispatches |
| [`feature-transitions.ts`](./feature-transitions.ts) | Transition-dispatched commands (the transitions bridge) |
| [`feature-transports.ts`](./feature-transports.ts) | HTTP / WebSocket / SSE transport plugins |
| [`feature-vite-hmr.ts`](./feature-vite-hmr.ts) | `vaporChamberHMR` — state-preserving Vite hot reload |
| [`feature-directives.html`](./feature-directives.html) | `v-vc:command` / `v-vc-payload` / `v-vc-optimistic` — **runnable**, no build step (ESM + import map): `node examples/static-server.mjs` |

## Framework patterns

| File | Stack |
|------|-------|
| [`pattern-1-blade-cdn.html`](./pattern-1-blade-cdn.html) | Laravel Blade + IIFE script tag, no build step. Loads local `dist/` so it is runnable today; the CDN form is documented in-file, version-pinned. |
| [`pattern-2-laravel-vite.ts`](./pattern-2-laravel-vite.ts) | Laravel + Vite + SFC (full build) |
| [`pattern-3-inertia.ts`](./pattern-3-inertia.ts) | Laravel + Inertia.js (alternative to the family router) |
| [`pattern-6-vapor-router.ts`](./pattern-6-vapor-router.ts) | Laravel Blade + `vapor-chamber/router` (the family stack: bus = writes, router = reads) |
| [`pattern-4-nextjs.tsx`](./pattern-4-nextjs.tsx) | Next.js App Router |
| [`pattern-5-filament.ts`](./pattern-5-filament.ts) | Filament panel + vapor-chamber islands |

## Core usage

| File | Topic |
|------|-------|
| [`shopping-cart.ts`](./shopping-cart.ts) | Cart with validation, history, and undo/redo |
| [`form-validation.ts`](./form-validation.ts) | Form validation with error handling |
| [`async-api.ts`](./async-api.ts) | Async handlers with a hand-rolled retry wrapper (see `feature-retry.ts` for the built-in plugin) |
| [`realtime-search.ts`](./realtime-search.ts) | Debounced search queries |
| [`custom-plugins.ts`](./custom-plugins.ts) | Analytics, auth-guard, rate-limiter plugins |
| [`vue-vapor-component.vue`](./vue-vapor-component.vue) | Full Vue Vapor todo app |

> The reactive composable is `useCommand` (`dispatch` + `loading`/`lastError` + `register`/`on`/`emit`,
> Vapor-safe). For fire-and-forget hot paths use `defineVaporCommand`; for cross-component aggregate
> state use `useSharedCommandState`.
