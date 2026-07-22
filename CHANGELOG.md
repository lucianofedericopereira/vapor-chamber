# Changelog

All notable changes to this project will be documented in this file.

## v1.9.0 — Vue 3.6.0-rc1 alignment

Adds `createBatchingHttpBridge`, declarative per-action authorization, the
`supersede` plugin, and the in-box `vapor-chamber/router` +
`vapor-chamber/router-fetch` subpaths.

### Added

- **Coverage gate corrected and ratcheted.** Two problems: the include glob
  `src/**/*.ts` also matched nested source trees, so `examples/exo-astro/src/**`
  was silently counted toward the library's thresholds; and `devtools.ts` was
  excluded outright while v1.9 promotes it to a **public subpath** — a
  published entry point measured at nothing. Examples and tests are now
  excluded explicitly, `devtools.ts` is measured (40.5% → **97.3%** statements,
  12.5% → **81.3%** branch, 46.9% → **100%** lines, via `@vue/devtools-api`
  added as a devDependency so the plugin body is reachable at all), and the
  floors moved from 90/90/82/89 to **95/94/86/93** — the old ones sat ~7 points
  below reality, wide enough for a genuine regression to pass unnoticed.
  New tests also close the router's delivery error paths (missing/empty inline
  element, remote-payload base warning, `routes_load_failed`) and the blade
  hook branches.
- **`usePagination()`** (`vapor-chamber/router`) — pagination over a
  loader-backed list, driven entirely by the URL: `items`, a writable `page`
  ref, `total` / `perPage` / `lastPage`, `hasNext` / `hasPrev`,
  `next` / `prev` / `go`, a windowed `pageRange` (first and last page always
  present, `0` marking an elision) and `loading` (the router's own in-flight
  flag). A page change stays STATE — no matching, no guards, no remount, only
  the loaders whose template depends on the key refetch, with the previous
  request aborted. Reading the response is the only backend-specific part, so
  every extractor is overridable; the defaults accept `{ items | data }` with
  `{ total, per_page | perPage, last_page | lastPage }` or their `meta`
  nesting, covering Laravel's paginator and most plain-JSON APIs. It was
  documented in `docs/router.md` and had never been implemented — building the
  runnable router example is what surfaced that.
- **`createBatchingHttpBridge`** (`src/transports.ts`) — coalesces every
  command dispatched within the same microtask (or an explicit `window` ms)
  into one `POST { commands: [...] }`, matched back by id against
  `{ results: [...] }`. Reuses the existing CSRF/retry/timeout path
  (`postCommand`) rather than duplicating it. The Laravel example controller
  (`examples/laravel-backend/VaporChamberController.php`) gained a `batch()`
  action demonstrating the endpoint shape.
- **Declarative per-action authorization** (`src/schema.ts` — new
  `ActionSchema.authorize?: string`; `scripts/generate-laravel.mjs`). When
  set, `generate-laravel.mjs` emits
  `Gate::forUser($user)->authorize(ability, ...)` into the generated action
  stub, ahead of the existing `Validator::make` block. Purely descriptive on
  the bus itself — auth is enforced server-side only.
- **`supersede`** plugin (`src/plugins-extra.ts`) — auto-cancels the previous
  in-flight dispatch for the same key (default: `commandKey(action, target)`,
  matching `idempotent`'s default) when a new one for that key starts.
  Implemented on top of vapor-chamber's existing `cmd.signal → fetch`
  forwarding (`AbortController`/`AbortSignal.any`) — the stale request is
  genuinely cancelled, not just ignored on arrival.
- **`vapor-chamber/router` + `vapor-chamber/router-fetch`** (new subpaths,
  `src/router/`, `src/router-fetch/`) — the router for Vue 3.6 over a
  server-owned catch-all (Laravel Blade the worked example) now ships **in-box**
  as a subpath of the single `vapor-chamber` package (path = navigation,
  query = state; generator-emitted route tables). Data loading is pluggable via
  a loader SPI: the in-box `router-fetch` subpath is the plain-JSON preset, and
  any other backend convention is a preset returning `LoaderHandlers`.
  Subpath-only — adds nothing to the core or the IIFE bundles.
  See [`docs/router.md`](docs/router.md) and the pattern below.
- **`examples/pattern-6-vapor-router.ts`** — the family-stack pattern: reads
  through `vapor-chamber/router` (URL-addressed data, abort-on-supersede
  loaders, `?page=2` as state not navigation) alongside writes through
  vapor-chamber's own bus/`createHttpBridge` (unchanged from pattern-2), one
  Laravel catch-all route serving a Blade shell with an inlined,
  permission-filtered route table.
- **`vapor-chamber/stream-parser`** (new subpath, `src/stream-parser.ts`) —
  dependency-free incremental JSON parser (bytes → state machine → values)
  for progressively consuming a streamed `fetch()`/SSE response body without
  buffering the whole payload — LLM/AI streaming completions, large exports.
  Reorganized into small per-state-group handler methods rather than one
  large dispatch switch (CDCC); the `true`/`false`/`null` keyword states
  collapse from ten near-duplicate cases into one target-string index walk.
  Subpath-only — adds nothing to the IIFE bundles.
- **`cache.staleTtl`** (`http.ts`/`http-cache.ts`) — opt-in stale-while-
  revalidate for GET caching. A hit inside `ttl` is fresh (unchanged); a hit
  between `ttl` and `ttl + staleTtl` is stale — served instantly as
  `{ stale: true, revalidation: Promise }` while a background fetch
  refreshes the entry, instead of always blocking on a refetch once `ttl`
  passes.
- **`cache.serveStaleOnError`** — opt-in resilience: when a request fails
  with a *transient* error (timeout, network, or 5xx — see `classifyError`
  below) and a retained cache entry exists for that URL (even past its
  stale window — expired entries are no longer deleted on read, only by LRU
  pressure or explicit invalidation), it resolves to
  `{ stale: true, servedOnError: true, error }` instead of rejecting.
  Business errors (4xx) and user aborts are never masked.
- **`classifyError`** (new `src/http-errors.ts`) — the single named
  transience rule (`timeout || no response || status >= 500`) driving
  `serveStaleOnError`, extracted so it can't drift from the retry logic's
  own status-code lists.
- **`silent` config flag** — `config.silent: true` stamps `error.silent`
  on anything thrown by `postCommand`/`clientRequest`, so a caller-provided
  global error handler can skip fire-and-forget requests (best-effort
  telemetry, background prefetch) without UI noise.

### Fixed

- **Timeout-triggered aborts now retry** (`postCommand` and `clientRequest`
  in `src/http.ts`). Previously any `AbortError` — a genuine user cancel
  *or* the internal timeout controller firing — threw immediately, skipping
  the `attempt >= retry` / backoff path entirely. A `retry: 2` GET was
  protected against 5xx/429/408 but silently got zero protection against a
  timeout. Now only a caller-supplied `signal` aborting throws immediately;
  a timeout competes for the same retry budget as any other transient
  failure, and still surfaces as `TimeoutError` (never mistaken for a user
  cancel — `isCancel`-style checks are unaffected) once retries are
  exhausted. Covered by two new tests in `tests/http-client.test.ts`.
- **`.npmignore` deleted** — it was dead and self-contradicting: `package.json`
  has a `files` array, which takes precedence, and the ignore file claimed to
  exclude `src/` while `files` ships it. Verified inert (`npm pack --dry-run`
  byte-identical with and without it: 226 files, 949.6 kB). Keeping it meant a
  future removal of `files` would silently change the published shape.
- **Every IIFE global was double-nested — the whole `<script>` audience was
  broken** (`scripts/build.mjs`, `src/iife*.ts`). All three variants shipped
  `window.VaporChamber = { VaporChamber, default }`, so the documented entry
  point of the no-build path — `VaporChamber.connect({ endpoint })`, and
  equally `.createCommandBus`, `.http`, every plugin — threw
  "is not a function"; the API was only reachable as
  `VaporChamber.VaporChamber.connect`. Cause: the entries carried *both* a
  default and a named export, so rollup emitted a module-namespace wrapper and
  assigned that to the global name, clobbering the module's own
  `globalThis.VaporChamber = …`. The IIFE entries are now default-export only
  and build with `output.exports: 'default'`, so the global *is* the API
  object. `tests/iife-bundle.test.ts` missed this for the worst reason — its
  loader unwrapped `outer.default ?? outer.VaporChamber ?? outer` before
  asserting, testing a shape no browser sees; it now reads the global exactly
  as a `<script>` tag does, and asserts the absence of both wrappers.
  Found by running `examples/sprinkled-blade` in a browser.
- **BREAKING (small): `useQueryParam()` now returns a real `Ref`.** It was a
  lookalike object with a `value` accessor, so `isRef()` was false and Vue did
  **not** auto-unwrap it in templates — making it the one composable in the
  module whose templates needed `.value`, while `useRoute` / `useRouteData` /
  `useMenu` did not. It is now built with `customRef`, keeps
  `push` / `replace` / `clear`, and reads/writes identically in script
  (`page.value = 3`). Templates that wrote `{{ page.value }}` become
  `{{ page }}`.
- **`{ inline: … }` route tables ignored the payload's `base` — so NO link was
  ever intercepted** (`src/router/index.ts`). `base` must be known before the
  history is built, but the inline payload was only read during `start()`, so
  the router ran on base `''`. `canHandle` then received unstripped paths,
  never matched the (base-relative) table, and **every in-app navigation became
  a full page load** — with the documented "falls back to the payload's base"
  silently not applying to the primary Blade delivery shape. The inline payload
  is now read synchronously at construction (it is already in the DOM — that is
  what "inline" means), via a deliberately total helper: a missing element,
  malformed JSON or a non-DOM environment return null and leave diagnosis to
  `start()`, so the constructor stays pure. A remote `{ url }` payload genuinely
  cannot inform `base` (the history exists before the fetch resolves) and now
  says so in dev instead of misbehaving the same way.
- **An unmatched URL could reload forever** (`src/router/index.ts`).
  `unmatched` is a `HARD_NAV_CODE`, so the router handed the URL back to the
  server — correct only if the server can answer differently. Behind the
  catch-all this router is designed for, the shell comes back, the router says
  `unmatched` again, and `location.assign()` fires again: an endless reload
  storm that **survives refreshes**, because the offending URL stays in the
  address bar. Any stale bookmark, mistyped link or deleted route could pin a
  user in it. The router now hard-navigates only when the target differs from
  the current URL, and otherwise logs what happened and how to fix it (add a
  `path: "/*"` row).
- **A malformed path segment compiled to a dead route, silently**
  (`src/router/table.ts`). `PARAM_RE` does not match vue-router's `:name*`, so
  the segment fell through to the `static` branch and compiled to the *literal*
  text — a row that can never match any URL, with no warning. `/:pathMatch*`
  and typos like `/:id(\d+` both did this; the only symptom was a 404
  somewhere else (and, before the fix above, a reload loop). A segment opening
  with `:` that does not parse as a param is now a coded `invalid_path` error in
  dev, naming the supported forms (`:name`, `:name(regex)`, `:name?`, trailing
  `/*`). Production stays lenient, per dev-trusts-generator.
- **BREAKING (dev-tooling only): `setupDevtools` moved to its own subpath.**
  `import { setupDevtools } from 'vapor-chamber'` becomes
  `import { setupDevtools } from 'vapor-chamber/devtools'`. It is no longer
  re-exported from the barrel, and that is the actual fix for the bug below:
  the barrel is what every consumer's bundler pre-bundles, so a dynamic import
  of the optional `@vue/devtools-api` peer sitting in it reached apps that
  never asked for devtools and did not install the peer. On a subpath the
  specifier only reaches importers who opted in — who are exactly the people
  who installed it — so the specifier is a plain literal again and devtools
  *works* under a bundler instead of silently no-oping.
  `tests/dist-optional-peers.test.ts` now enforces the boundary rather than
  banning the literal outright: an optional peer may be resolved statically
  from its opt-in subpath, never from anything reachable via the package root.
- **Optional `@vue/devtools-api` peer broke every Vite/Astro consumer**
  (`src/devtools.ts`). `dist/` emitted `import("@vue/devtools-api")` as a
  *literal* specifier: the source deliberately routed it through a variable so
  bundlers could not resolve it statically, but the build constant-folded the
  variable straight back into the literal. Vite pre-bundles the package, fails
  to resolve a peer that most apps never install, and returns 500 for the dep
  bundle — surfacing as an unhandled rejection plus a dev-server reload loop,
  with `@vite-ignore` powerless because the *pre-bundled* dep is re-analyzed.
  The specifier is now assembled at runtime (`['@vue', 'devtools-api'].join('/')`),
  which the folder cannot evaluate, so it stays dynamic in `dist/` and a missing
  peer falls into the existing `.catch()` as designed.
- **`examples/exo-astro` — stale dot-path bindings** (example code, not
  shipped in `dist/`). The example's directive scanner wrapped only the top
  level of a reactive object, so the documented `v-bind-text="cart.count"` /
  `v-show="cart.hasItems"` bindings rendered once and then never updated:
  a nested write mutated an inner object whose effect set was empty.
  `reactive()` now wraps plain objects and arrays at every depth against one
  shared effect set (exotic values — `Date`, `Map`, DOM nodes, class
  instances — are stored untouched, and a cyclic graph terminates). Also:
  `scan()` is idempotent, so re-running it after a client-side page swap
  (`astro:page-load`) re-wires new nodes without double-binding clicks or
  resetting live scope state; a binding now resolves against the nearest
  `v-scope` that *declared* its head key and falls through to the global bus
  state otherwise, so one subtree can mix local UI state and bus state; and
  the new `scopeOf(el)` export lets a command handler write local scope state
  without breaking the "the only write path is `v-command`" rule. Covered by
  `tests/examples/exo-astro-directives.test.ts` (24 specs) — the example is
  published as copy-paste code, so its contract is now pinned like the
  library's. The example requires Node ≥ 22.12 (Astro 7's floor); the library
  itself still supports Node ≥ 20.19.

### Examples

Not shipped in `dist/` — but the run that produced the two `Fixed` entries
above was a browser pass over every example, and each of these was a real
defect a reader would have hit.

- **Every example ran STALE library code.** `"vapor-chamber": "file:../.."`
  does not symlink when the root package has a `prepare` script: npm packs the
  library and installs a frozen *copy*, so an example kept running whatever
  `dist/` looked like at install time — a fixed bug reproduced indefinitely in
  the browser. New shared [`examples/ensure-lib.mjs`](examples/ensure-lib.mjs),
  wired into all three apps' `predev`/`prebuild`, mirrors the built `dist/`
  into the installed copy and drops Vite's pre-bundle cache (keyed on
  manifests, not contents — it would serve the stale bundle otherwise).
- **`examples/static-server.mjs`** (new) — static host for the no-build pages:
  serves the repo root so `../../dist/...` resolves, sends
  `Cache-Control: no-store` (a browser heuristically caching an un-headered
  bundle means testing the build from ten minutes ago), and answers
  `POST /api/vc` with the same `{ command, target, payload }` →
  `{ ok, state }` contract as the other backends, so a dispatching page
  completes instead of 404-ing.
- **`exo-astro`** — the directive scanner gained `v-each` (repeat a row
  prototype per array entry, each clone scoped to its item; prototype taken
  from a `<template>` child or, where parsers disagree about templates in
  table sections, the detached first element child). Bindings now resolve
  against the nearest scope that *declared* the key and fall through to bus
  state otherwise, so a subtree mixes local and bus state; `scopeOf(el)` lets a
  handler write scope state without breaking "the only write path is
  `v-command`"; `scan()` is idempotent for `astro:page-load`. The demo page
  became a two-column invoice-style ticket that aggregates repeat items
  (`Coffee ×3`) — a write one level deep into the array, which only reaches the
  DOM because of the deep-reactivity fix above. Controls that start hidden now
  carry `style="display:none"` in the markup: the script is a module, so
  without it the empty cart's table and buttons painted before the first
  effect.
- **`sprinkled-blade`** — three fixes and a shape change. The mock backend's
  CORS allowlist omitted `X-Requested-With`, which the bridge always sends, so
  every dispatch failed the preflight (Chrome reports only `Failed to fetch`).
  The page hardcoded `0 items` while the server held the real cart — in a demo
  whose lesson is *the server owns the state*. `cartClear` existed in the mock
  with no UI to call it. The backend now also serves the page with the cart
  **rendered into it** (`data-hydrated`), so the client skips its startup fetch
  entirely: one process, same origin, no CORS, no flicker — with the static
  cross-origin path kept, because the contrast is the lesson. Remaining UI
  flicker was the demo's own doing: a status line blanked on click and refilled
  milliseconds later, a busy state that strobed on a local round trip (now on a
  120ms threshold), and elements that reserved no space.
- **`examples/router-demo/` (new)** — the first runnable proof of the headline
  v1.9 feature, and the reason three of the router fixes above exist. No build
  step (plain ESM + an import map against the published `dist/` files): a
  Blade-style inline route table, `router-fetch` loaders against the mock API
  in `static-server.mjs` (which also serves a **catch-all** for the demo's base,
  so deep links and F5 behave like Laravel), `usePagination` with a windowed
  pager, four sortable columns that toggle direction and reset to page 1 in a
  single `setQuery`, document-wide link interception with `data-active`
  stamping, a client-rendered 404 and a `useRouteError` boundary. It also
  carries its own boot diagnostics — a classic script installed before the
  module plus a watchdog — because an example that fails silently teaches
  nothing.
- **`feature-directives.html` was not runnable at all** — 2,666 bytes of pure
  HTML comments, advertised as *"`v-vc:command` in the browser"*. Now a real
  page (plain ESM + an import map, no build step) demonstrating all three
  directives across five panels, including `.vc-loading` / `.vc-error` and an
  optimistic update that rolls back. It is the only runnable coverage
  `src/directives.ts` has, being excluded from the coverage gate as
  "requires a real Vue runtime".
- **`pattern-1-blade-cdn.html` pointed at an UNVERSIONED CDN URL** — i.e. the
  *published* package, never the working tree, edge-cached and silently
  re-pointed by every release. It was the one example nobody could run before
  publishing, and the one that shipped broken. It now loads local `dist/`
  (self-hosting is also what `laravel-app` does and what a CSP-constrained
  Blade app wants), with the CDN form documented in-file and version-pinned.
  Every unversioned `cdn.jsdelivr.net/npm/vapor-chamber/` URL across the docs
  was pinned to `@1.9` for the same reason. It also gained a Clear button:
  `persist()` restored the count on load with no way to bring it back down, so
  the page could show a number the backend no longer agreed with.
- **`docs/integrations/laravel.md`** gained a CORS section — the cross-origin
  Sanctum case needs `X-Requested-With` (and `Idempotency-Key` with the
  `idempotent()` plugin) on the preflight allowlist, which was documented
  nowhere.

## v1.8 — Vue 3.6.0-beta.17 alignment


### Added — the typed command contract (define each command once)

- **`GlobalCommands` augmentation** (pinia-style): augment one interface and every
  `useCommand()` / `getCommandBus()` / `useCommandBus()` call site gets typed
  dispatch/register with autocomplete and compile errors. Fully backward
  compatible when unaugmented; `getCommandBus<CommandMap>()` opts out per call
  site. Enforced by a compile-time contract test (`tsconfig.typecheck.json`,
  chained into `npm run typecheck`).
- **`defineSchema` + `CommandsOf<S>`**: const-preserving schema helper so one
  schema literal yields typed dispatch (`createSchemaCommandBus`), runtime
  validation, LLM tools, and — via `interface GlobalCommands extends
  CommandsOf<typeof schema>` — the typed shared bus.
- **`scripts/generate-laravel.mjs`**: generates the Laravel half from the same
  schema — `config/vapor-chamber.php` registry + invokable action-class stubs
  with `Validator::make` rules derived from the field types. Never overwrites
  edited stubs without `--force`.
- **`vapor-chamber/outbox`**: offline outbox — matching commands queue durably
  (localStorage default, zero-dep IndexedDB adapter) while offline, replay in
  strict FIFO on reconnect with their ORIGINAL `Idempotency-Key`s, so retried
  writes stay exactly-once end to end. Reactive `pending` count, bounded queue,
  auto-flush on `'online'`, SSR-safe.
- **`vapor-chamber/mcp`**: zero-dep Model Context Protocol server from a schema
  bus — `busToMcpTools`, `createMcpHandler` (JSON-RPC: initialize, ping,
  tools/list, tools/call), `serveMcpStdio` for Node. Action whitelisting via
  globs; `agentOrigin()` plugin stamps `meta.origin = 'agent'`.
- **`CommandMeta.origin`** (`'user' | 'remote' | 'sync' | 'replay' | 'agent'`):
  marks where a command originated — stamped by the outbox (`'replay'`) and MCP
  (`'agent'`); type-only in the core.
- **`logger({ level, badges })`**: log-level filtering (`debug`/`info`/`warn`/
  `error`) and opt-in `[ OK ]`/`[ FAIL ]` badges — `%c`-styled in browsers,
  plain text in Node. Default output unchanged.
- **Retryable/category error metadata**: every `ERROR_CODE_REGISTRY` entry now
  carries `retryable` + `category`; new `isRetryableCode()`; `RETRYABLE_CODES`
  exported beside `BusError`. `retry()`'s default predicate now stops on
  known-permanent `VC_*` codes (validation failures, sealed bus, max depth)
  instead of blindly retrying — plain Errors retry as before. Registry gaps
  filled: `VC_CORE_ABORTED`, `VC_VALIDATION_FAILED`.
- **size**: IIFE budgets +~0.2 KB raw / +0.15 KB brotli for the logger/retry
  metadata (details in scripts/check-size.mjs); the four new modules are
  subpath-only and add nothing to the IIFE bundles. Net ESM consumer WIN:
  `/* @__PURE__ */` on ERROR_CODE_REGISTRY's freeze makes the registry
  tree-shakeable — it had been silently pinned into every barrel-import bundle
  since v1.0. The reference consumer bundle drops 7.0 → 6.1 KB brotli, and the
  tree-shake regression ceiling was LOWERED to lock it in.

### Added

- **Sync-bus footgun guard (dev only)**: dispatching through an async plugin
  (`retry`, `createHttpBridge`, ...) installed on a bus created with
  `createCommandBus()` now logs a one-time-per-action warning pointing at
  `createAsyncCommandBus()` — previously the dispatch silently "failed" with
  `result.ok === undefined`. DCE'd out of production builds.
- **`setCommandBus` accepts `AsyncCommandBus`** — the composables already
  handled thenable results at runtime; callers no longer need an `as any` cast.

### Fixed

- **transports**: the HTTP bridge now surfaces the backend failure body's
  `error`/`message` as `result.error.message` (with `status`/`code`/`response`
  preserved and the original error as `cause`) instead of the bare `"HTTP 422"`
  — matching the documented contract in the Laravel integration guide. The bare
  status message remains the fallback for bodyless failures.
- **examples**: a sweep of all example folders fixed copy-paste-breaking bugs —
  async plugins installed on sync buses (and vice versa) in four pattern files,
  handlers registered on a local bus while `useCommand()` dispatched on the
  shared one, local handlers shadowed by the HTTP bridge's forwarding (which
  never falls through to handlers), a double-wrapped dispatch target, a
  non-functional undo in the shopping-cart demo, a duplicate `searchExecute`
  registration in the Vapor SFC app, and a dead error path in the island-cart
  app. Also: dotted action names normalized to the documented camelCase
  convention, `'../src'` imports replaced with `'vapor-chamber'`, unused
  imports removed, and stale README claims corrected.
- **Laravel docs/examples**: the Sanctum flow's `routes/api.php` snippets used
  `'/api/vc'`, which Laravel's automatic `api` prefix turns into `/api/api/vc`
  (404 on every dispatch) — now `'/vc'` with an explanatory note; added Laravel
  11+ `install:api` / `statefulApi()` steps; the example controller now honors
  the `Idempotency-Key` header with a short-TTL cache replay and emits
  machine-readable `code` fields; endpoint drift in the idempotency snippet
  fixed; `ModelNotFoundException` catch added to the doc's controller snippet.

- **devtools**: the production guard now uses the bare `process.env.NODE_ENV` literal so
  bundler define-replacement actually fires — previously the `globalThis.`-prefixed read
  defeated it and `setupDevtools` ran in production browser builds (per-dispatch buffering
  of the last 100 commands for the app lifetime).
- **packaging**: `vapor-chamber/iife-core` and `vapor-chamber/iife-elements` exports pointed
  at dist files the build never produced — both are now built as ESM entries (with rows in
  `docs/BUNDLE-SIZES.md`).
- **http**: 401 responses through `createHttpClient` fired `onSessionExpired` (and the
  `session-expired` window event) twice; now once.
- **http**: retry sleeps and the `AbortSignal.any` fallback detach their abort listeners when
  the request settles — previously they accreted on component-lifetime signals per request.
- **http**: concurrent 419 CSRF refreshes now share one in-flight promise instead of a 100ms
  polling loop (removes up to 5s of added latency and a stale-result race).
- **http**: cache and dedupe keys include `responseType`, so a `json` and a `blob` request for
  the same URL no longer collapse into one; `invalidateCache` patterns still match the URL.
- **transports**: the WS bridge re-queues unsent messages if the socket closes mid-flush,
  guards `connect()` against creating a second socket while one is live, and clears a pending
  reconnect timer on manual connect.
- **directives**: the async-dispatch timeout race clears its timer when the dispatch wins —
  previously every click left a live 30s timer.
- **plugins-extra**: `idempotent()` deletes expired entries on read and caps the completed-key
  map (new `maxKeys` option, default 500) — previously it grew without bound.
- **chamber**: `useCommandError` caps its error list (new `errorCap` option, default 50);
  `useCommandHistory` no longer assigns a fresh empty redo stack on every dispatch (spurious
  watcher re-runs).
- **README**: the first example used a `useCommand('action')` signature that doesn't exist and
  registered on a non-shared bus; duplicate Install section, duplicate `registeredActions()`
  row, stale v1.0 checklist, and the `~1KB core` claim corrected; embedded feature matrix moved
  to ROADMAP.md.

### Changed

- **CommandResult is a discriminated union** on `ok` — `if (result.ok)` now narrows; on the
  failure arm `error` is a guaranteed `Error`. `value` stays optional on success (void
  commands), so `return { ok: true }` handlers keep compiling.
- **Async bus**: after-hook fan-out skips the async frame when no after-hooks are registered,
  and before/after hook loops only `await` actual thenables — several fewer microtask hops per
  dispatch with sync hooks.
- **schema**: `schemaValidator` precompiles per-action field checks at creation instead of
  walking `Object.entries` per dispatch; throttle rejections skip V8 stack capture (expected
  control flow on a by-design hot path).
- **form**: `submit()` runs async field validators concurrently (`Promise.all`) instead of
  sequentially.
- **packaging**: `types` listed first plus a `default` condition in every export block;
  `sideEffects` is now an array exempting the side-effect-only `iife*` files from tree-shaking;
  `src/` ships in the tarball so `declarationMap` go-to-definition works; `vite` peer range
  loosened `>=7.0.0` → `>=5.0.0` (the HMR plugin uses no Vite runtime APIs).
- **size**: IIFE budgets bumped for the fixes above plus the bridge error-message
  feature and the (runtime-inert) sync-bus dev warning that rolldown can't strip
  (full 36.9 KB raw / 10.6 KB brotli, core 25.5/7.3, elements 27.0/7.7). Details
  in scripts/check-size.mjs.

## v1.7.0 — Vue 3.6.0-beta.17 alignment

_Targets **v1.7.0** (not yet published). The breaking `useVaporCommand` removal would be a major
under strict semver, but **2.0.0 is reserved for the Vue-3.6-stable identity decision** (Vapor-first
vs bus-first — see ROADMAP). While Vue 3.6 is still beta and there is effectively no userspace to
break, this cycle ships as a minor; the major bump is held for the post-beta direction call._
Every one of beta.16's 28 fixes
was read at the commit level and mapped to our surface. **The beta.16 alignment itself needs
no vapor-chamber code change** — all fixes are inherited through the pass-through wrappers, are
compile-time only, or sit *below* our SSR command-replay. A follow-on retrospective of betas
**9 → 16** (Vue's changelog against ours) then surfaced a few real gaps, fixed here: event-modifier
support on `v-vc:command`, two corrected version attributions, and the two alignment-log rows we
had skipped. **Beta.17** then arrived during this same unreleased cycle and is **also fully
pass-through** — its seven compiler-vapor slot/expression fixes are compile-time, its runtime
slot/interop/hydration fixes sit below the command-replay or are inherited through the
`getVaporInteropPlugin()` pass-through (paired `beforeUpdate`/`updated` slot hooks `bcaa753`, slot
owner-root re-sync `975dd4d`, `#14972` hydration), and its reactivity/scheduler fixes (function-ref
tracking `#14986`, render-effect creation-order `#14984`) never touch the bus — so the suite was
simply re-pointed at beta.17. Verified against beta.17: `tsc --noEmit` clean, **884/884 tests** pass
(47 files), build + `size:check` green (IIFE 10.2 / 7.0 / 7.4 KB brotli, under budget), benches run
green on the recorded baselines with no measured host regression.

### Changed

- **peerDependencies** → `vue: ">=3.5.0 || >=3.6.0-beta.17"`; dev `vue` → `^3.6.0-beta.17`;
  examples (`vapor-sfc`, `vapor-island-cart`) repinned. Both ranges already admitted beta.17
  by semver prerelease ordering; the floor is bumped to keep the *tested-version* statement
  honest — beta.17 is what the suite now runs against.
- **SFC examples → Vite 8** (`vapor-sfc`, `vapor-island-cart`): `vite ^7 → ^8`, aligning the demos
  with the library's own toolchain. `@vitejs/plugin-vue ^6` already declares `vite ^5||^6||^7||^8`,
  so no plugin bump; both build clean (0 vulns, stale beta.15 lockfiles regenerated). The Laravel /
  Blade / Astro examples are unaffected — they use the IIFE drop-in or Astro's own bundler, not Vite
  directly. Fixed a pre-existing `vue-tsc` failure surfaced by the rebuild: the Vapor templates use
  vapor-chamber signals **bare** (Vapor auto-unwraps them at runtime), but `vue-tsc` can't unwrap the
  deliberately-Vue-free `Signal<T> = { value: T }` type. Added a small `asRef()` helper that re-types
  a signal as the `ShallowRef` it genuinely is when Vue is present — runtime-honest, and it makes
  `vue-tsc` auto-unwrap in templates. (The typed `vapor-chamber/vapor` surface on the v2.0 roadmap
  will remove the helper.)

### Changed — dispatch hot-path audit (surfaced by the beta.17 commit read)

Reading beta.17 at the commit level — specifically Vue's **#14984** (*preserve render-effect
creation order*, which had to add creation-order as a scheduler tiebreaker behind component id) —
prompted a pass over our own dispatch hot path. **No Vue-driven change was needed** (our plugin
ordering already gets that invariant for free from JS's stable `Array.prototype.sort` on
equal-priority entries, pinned by the `equal priority preserves registration order` test). But the
audit surfaced two internal inconsistencies, fixed here. Neither changes behavior; the suite stays
green at **801 tests** (40 files) after the new coverage below.

- **`validateNaming` now guarded on every per-dispatch path** (`command-bus.ts`).
  `_syncDispatchInner` already gated the call behind `if (s.opts.naming !== undefined)`; `syncQuery`,
  `_asyncDispatchInner`, and `asyncQuery` did **not** — they paid a function call per dispatch even
  with no naming convention configured (the common case). All four per-dispatch paths now share the
  guard. The cold `register` / `respond` paths keep the bare call (no hot loop to protect, and
  `validateNaming` already early-returns on no-naming). Consistency fix; free.
- **`stampMeta` reads `payload?.__causationId` once, not twice.** The duplicate optional-chain read
  fed both `causationId` and `correlationId`'s fallback. A same-process interleaved A/B (the only
  honest microbench shape on a single host) measured the dedup **~5–9% faster *in isolation*** on
  the common no-ids payload — V8 does **not** CSE the repeated read — but **end-to-end the delta is
  within run-to-run noise** (`uid()` + `Date.now()` + the 4-field alloc dominate `stampMeta`'s
  ~36–46 ns; the full-path sign flips between runs). Filed as a **cleanup, not a perf change**: it
  removes a genuine-but-invisible read, is never slower on any payload shape, and avoids a double
  read on getter payloads. Returned field set/order unchanged (hidden class preserved).
- **Coverage: the guard above is now tested on every path it touches.** Adding the
  `if (s.opts.naming !== undefined)` gate to `query` / async-`dispatch` / async-`query` introduced
  three new branches the suite didn't exercise (only `dispatch`'s naming path was tested). Three
  tests in `tests/command-bus-features.test.ts` now drive the naming-configured branch through all
  three, restoring **`command-bus.ts` to 100% branch coverage** (was 98.97% right after the guard
  landed). Total suite **798 → 801**.
- **Removed a dead biome suppression** (`schema.ts`). A `biome-ignore lint/correctness/useValidTypeof`
  comment guarded a `typeof v !== expected` compare against a *variable*; a newer biome no longer
  flags it, so the suppression was unused and biome 2.x warned on it. Deleting the comment makes
  `lint:check` **fully clean (0 warnings)** without re-triggering the rule.

### Changed — coverage pass + WebSocket disconnect fix it surfaced

A test-only coverage pass — schema LLM helpers, the `http`/`transports`/`plugins-io` I/O modules,
the `plugins-core` error/rollback paths, and assorted reachable branches across
`observable`/`plugins-schema`/`utilities`/`http-query`/`chamber-vapor` plus a pure-logic branch
mop-up; **+80 tests** across seven `*-coverage`/mop-up files, no `src/` changes — lifted overall
coverage to ~**97% stmt / ~91% branch / 98% lines** and took `schema`, `http`, `plugins-io`,
`plugins-core`, `http-query`, `plugins-schema`, `observable`, `utilities` to 100% lines. It also
surfaced one real bug in `transports.ts` — fixed here (this part **does** touch `src/`):

- **`createWsBridge`: in-flight requests now fail fast on disconnect.** Every pending request was
  provisioned with a `reject` handle that **nothing ever called** — the bus settles failures via
  `resolve({ ok:false })`, never promise-rejection, so the field was dead. Studying *why* it was
  dead exposed the gap behind it: `onclose` / `onerror` / `disconnect()` never drained the
  `pending` map, so a sent-but-unanswered request left an `await bus.dispatch(...)` **hanging until
  its per-request `timeout`** (default 10 s) even after an explicit `disconnect()`.
  - **Removed** the vestigial `reject` field from `PendingRequest` (also takes `transports.ts`
    function coverage to 100% — the dead arrow was the last uncovered function).
  - **Added** `failAllPending(reason)`: on terminal teardown — an explicit `disconnect()`, or a
    close with no reconnect pending (reconnect disabled or `maxReconnects` exhausted) — every
    in-flight request settles immediately with `{ ok:false, error }` and unsent queued messages are
    dropped. **Recoverable closes are unchanged**: when a reconnect is still pending, queued
    commands survive for `flushQueue` and sent requests ride the existing timeout net. +3 tests.

### Added

- **`v-vc:command` now honors event modifiers** (`directives.ts`). The directive attaches a
  **direct** `addEventListener`, so Vue's compiled `withModifiers` never reached it — every
  modifier except the numeric `.timeout` was silently dropped. It now applies `.stop` / `.prevent`
  (DOM-event actions), `.self` and `.left` / `.middle` / `.right` (dispatch guards), and `.capture`
  / `.once` / `.passive` (passed as `addEventListener` options, and matched on removal). Surfaced
  by the beta.9–16 retrospective — Vue's beta.15 click-modifier-normalization fix (`eaefa71`) never
  reaches a direct listener. +5 tests in `tests/directives.test.ts`.

### Changed — `useVaporCommand` folded into `useCommand` (breaking)

- **`useVaporCommand` is removed; `useCommand` is now the single command composable.** The two had
  converged: both were Vapor-safe (the "needs a VDOM instance" distinction was obsolete —
  `useCommand` cleans up via `onScopeDispose`, never touches `getCurrentInstance`), and
  `useVaporCommand` was just `useCommand` + `register`/`on`/`emit`/`dispose`. `useCommand` now
  carries that full API — reactive `loading`/`lastError` **plus** `register`/`on`/`emit` with
  `onScopeDispose` auto-cleanup — Vapor-safe in `<script setup vapor>` and VDOM alike. For
  fire-and-forget with zero reactive overhead, `defineVaporCommand` is unchanged.
  - **Migration:** replace `useVaporCommand()` with `useCommand()` — identical return shape.
  - Removed **clean** (no deprecated alias): pre-release Vue + a tiny userbase made a deprecation
    cycle not worth the carry. ~60 lines of duplicated logic gone; the IIFE bundles now expose
    `useCommand` (they previously only exposed `useVaporCommand`).
  - Swept across examples, README, whitepaper (§9.4 reworked to drop the false `useCommand`-vs-
    `useVaporCommand` distinction), performance.md, the migration guide, and the ROADMAP (the
    `useVaporCommand`→`useCommand` merge item is now **done**, shipped ahead of v2.0). The
    `register`/`on`/`emit`/`dispose` tests now exercise `useCommand`. **798 tests green.**
- **Examples folder documented.** Added a top-level `examples/README.md` indexing all examples
  (full-project apps + `feature-*` / `pattern-*` snippets + core usage); the main README's
  Examples section listed only 6 of them and now surfaces the flagship runnable apps + links the
  index. (The whitepaper carries no example references — nothing stale there.)

### Removed (dead code)

- **`useVaporAsyncCommand`'s `listeners` array** (`chamber-vapor.ts`). It was copy-pasted from
  `useVaporCommand` but the composable exposes no `register`/`on`, so nothing could ever populate
  it — provably always empty, making its `dispose()` a no-op. Removed the array; `dispose` is now
  an explicit no-op kept for return-shape symmetry. Zero behavior change (798 tests green; the `.`
  barrel dropped 0.1 KB min). Identified by the DRY audit.

### Inherited behavior worth knowing (no code change)

- **Transitions — `onLeave` now fires for a non-v-show root removed after a v-show branch**
  (Vue `a816c9e`, *stop persisted leaking to non-v-show roots*). Before beta.16 a latched
  `persisted=true` made Vapor skip the leave, so `useTransitionCommand` / `createTransitionBridge`
  silently **dropped the `*Leave` dispatch** in that sequence. The runtime fix gates the
  carry-forward on an actual v-show marker; our bridge forwards the now-correct hook. `onLeave`
  JSDoc updated. The other five transition fixes — `fda5bc4` (re-resolve hooks on prop change),
  `207dce4` / `254a9c0` (type-bucketed leaving cache), `5689b88` (raw-key compare before early
  removal), `370de63` (out-in branch-key sync) — govern DOM-duplication / stale-branch
  correctness during rapid toggles; hook signatures unchanged, forwarded as-is.
- **App lifecycle — `createVaporChamberApp(...)` inherits two hardening fixes directly.**
  `.mount('#missing')` now **no-ops + dev-warns** instead of throwing (Vue `05bf22a`), and
  `.unmount()` no longer throws in **production builds** (Vue `52fda7c` — `app._instance` is
  dev-only, so prod unmount was a real minified-build crash; it now resolves the instance from a
  WeakMap). We return Vue's app untouched, so consumers get both for free. Caveat now documented:
  `.mount()` can return `undefined` for a bad selector — don't assume a component proxy.

### Pass-through (substantiated per commit, not waved through)

- **SSR / hydration (`ssr.ts`).** `rehydrate()` is command replay *above* Vue's DOM hydration,
  so all seven hydration fixes sit below us and only hand our replay a more-correct DOM:
  `a36f43b` (dynamic props applied on mismatch-recreated nodes), `58aeb40` (static-text patching,
  prod included), `3daf8f5` (exact tag-mismatch detection — no more `<i>`/`<ins>` prefix
  collisions), `2d7464c` (static-template clone-cache reused, not re-cloned per adoption),
  `0c92f54` (v-if empty branches hydrated with static templates), `4eb5dca` (fragment-start
  warning text), `baa7c59` (empty-container full mount on `createVaporSSRApp`, which we don't
  wrap). Note: `a36f43b` reduces "Hydration text mismatch" dev-warning counts — nothing in the
  lib keys off that count.
- **Props / emit / attrs / events.** `5100a6e` (dynamic v-bind event options parsed like VDOM —
  `Once`/`Passive`/`Capture`) affects Vue's *compiled* dynamic-event path only; `v-vc:command`
  attaches a **direct** `addEventListener`, so the beta.15 disabled/in-flight mirror is untouched
  (the same "direct listener gets no compiled help" property is why we added explicit modifier
  handling — see **Added**). `ffd671c` (nullish emit sources), `a63b165` (symbol attr stringify),
  `f53da05` (nullish dynamic props → empty) are internal `prop.ts` / `componentEmits.ts` hardening,
  inherited.
- **Compiler (8 fixes).** Compile-time correctness in generated code: `0bf86ef` (setup-let inline
  assignment), `224e672` (v-html children before text transforms), `780c4ff` (unsafe attr names
  kept out of static templates), `d80423d` (dynamic modifier arg keys), `898ce5b` / `eb25a7f`
  (native / static v-model modifier key quoting), `1eaacfa` (slot v-else without adjacent v-if
  now reported, not crashed), `2c73a96` (empty blocks return `[]`). They reach consumer `.vue` /
  examples on recompile; we vendor no generator files, so the `genDirectiveModifiers` relocation
  in `898ce5b` doesn't touch us.

### Performance — technique recorded, not applied

- **`27b0482` (skip SlotFragment for stable slot fallback, #14969).** A coordinated
  compiler + runtime + shared change: the compiler proves a slot's fallback is unreachable,
  encodes it as a one-bit `VaporSlotFlags.NON_STABLE` flag on the emitted slot fn, and the
  runtime picks a lighter `DynamicFragment` (skipping the `SlotFragment` allocation **and** its
  content-vs-fallback arbitration) whenever the flag is absent. Consumers on beta.16 inherit it by
  depending on Vue's runtime. The **transferable pattern** — push an uncertainty decision to where
  the shape is statically known, encode it as a cheap flag, and select a lighter object + simpler
  path on the proven-safe majority — is logged in the whitepaper alignment table as an opportunity
  to evaluate against our own hot paths. It is **not** applied this cycle: it intersects the
  deferred Vapor-first / bus-first identity decision (v2.0.0), and any such change ships only with
  a measured, same-host A/B — never a guess.

### Retrospective (beta.9 → beta.16 audit)

Walked Vue's per-beta changelog against ours, one beta at a time, to catch anything overlooked.
Outcome: the wrappers held — every flagged item is genuine pass-through once checked against the
actual code (the directive receives the live `el` from Vue and cleans up in `beforeUnmount`; the
HMR shim only saves/restores the bus, never component effects; SSR replay sits above DOM
hydration). Three real gaps were fixed:

- **Alignment log completed.** The whitepaper "Vue 3.6 alignment log" claimed one row per beta but
  skipped **beta.9** and **beta.10**; both rows added (pass-through — e.g. beta.9's TransitionGroup
  parity fixes mean the bus now receives the *corrected* hook set, including no more bogus hooks on
  unkeyed interop children).
- **Two attributions corrected** (verified against Vue's tags): the alien-signals reactivity rewrite
  landed in **3.6.0-alpha.1** (#12349), not beta.8; `defineVapor*` were introduced across
  **3.6.0-alpha.3–5** (#13059 / #14017 / #13831), not beta.10 (which only tree-shook / async-hydrated
  them). Fixed in `whitepaper.md`, `chamber-vapor.ts`, `ROADMAP.md`.
- **Event modifiers on `v-vc:command`** — see **Added** above.

### Core coverage to 100%, lazy buffer allocation, honest coverage docs

A measurement-driven hardening pass on `command-bus.ts` — the dispatch core named in the §19
Core Guarantee.

- **`command-bus.ts` reaches 100% line + branch + function coverage** (was ~96.7% line /
  92.2% branch). **+19 tests** in `tests/command-bus-features.test.ts` exercise the
  previously-untested error/edge branches on the *real* sync/async buses (not the
  coverage-excluded `TestBus`): throwing `onBefore` hooks, `offAll()` clear-all, the async
  transactional abort + rollback paths, `query()` on a missing handler, `onMissing:'buffer'`
  overflow/drop (incl. the production warning-suppression branch), the prefix-cache LRU
  eviction, idempotent unsubscribe, and the `inspectBus` fallback. Three **provably-unreachable**
  defensive guards (a caller-guaranteed null-check; two `!results[j].ok` rollback skips that the
  "halt at first failure" batch semantics make dead) are excluded with `/* v8 ignore */` +
  rationale, not faked. Suite: **801 passing / 40 files**.
- **Buffer queue (`deferred`) is now lazily allocated** (`command-bus.ts`) — `null` until the
  first buffered command, instead of an eager `new Map()` at construction for every
  `onMissing:'buffer'` bus. A buffer-mode bus whose handlers always beat its dispatches now
  allocates nothing. The alternative — keeping it eager so the hot-path miss-gate could read
  `deferred !== null` instead of `opts.onMissing === 'buffer'` — was tested with a same-process
  A/B and **rejected**: the `deferred !== null` gate is faster only when monomorphic (~3–7%) and
  *regresses* ~1.7% in apps mixing buffer + non-buffer buses (polymorphic inline cache), so the
  hot-path gate stays on `onMissing`. Net: simpler constructor, no wasted allocation, the
  lazy-init branch is now covered by existing tests, and the `.` barrel dropped ~0.1 KB min.
- **Coverage claims corrected.** Whitepaper §19 "100% branch and line coverage — always" was
  **false** (global branch was 82.8%); it now states the true, *measured* `command-bus.ts` 100%
  line+branch+function (behind the `vitest.config` gate, with `testing.ts` excluded as the test
  harness). `vitest.config.ts` thresholds tightened from a slack 73/65/80/75 to **89/82/90/90**
  (~2 points under measured — restoring a meaningful regression gate), and the stale
  "plugins-extra.ts / utilities.ts at 0%" comment removed (both ~93% — their test files exist).
- **Stale doc numbers synced.** Recursion-depth guard now documented as **max 16** (matches
  `MAX_DISPATCH_DEPTH`; was "max 10" in three places); the §21 File Map test inventory regenerated
  from a partial 13-file/466 list to all **40 files / 798 total**; the `command-bus.ts` header
  size corrected from "~2KB gzipped" to "~3.6 KB brotli core; full ~10–20 KB" → `BUNDLE-SIZES.md`.
  Version-stamped historical counts (v1.0's 466) left frozen.

### Performance docs re-measured against the bench

`npm run bench` re-run on the current host (Vue 3.6.0-beta.16); `docs/performance.md` corrected
to the measured same-process ratios — drift went **both** directions:

- **Overstated mitt comparisons brought down.** No-listener emit "2.5× faster than mitt" →
  **~1.4×**; emit fan-out "1.8× faster than mitt" → **~1.4×**; "within 20% of nanoevents" →
  **~28% behind** (nanoevents pulled ahead — its no-listener path now ~8× vapor's, vs the old
  ~3.3×). mitt simply got relatively faster since the numbers were first taken.
- **Undersold fast-lane raised.** "5.3× faster than mitt" → **~5.6×**; "1.9× faster than
  nanoevents" → **~2.1×**; fast-lane emit no longer "ties" nanoevents — it **edges it (~1.1×)**.
- **Stale absolutes refreshed / removed.** The unreproducible "+12% / +26% (415 → 466 ops/sec)"
  listener-impact line replaced with current fan-out numbers; single-handler `bus.dispatch`
  ~630 → **~1,800 ops/sec** (~18M dispatches/s); persist `coalesce` ~8.75× → **~23×**; meta-id
  counter speedup 2.26× → **~2.5×**. Comparative tables re-stated to the current run, ratios
  written as approximates (one run; machine-sensitivity caveat kept).
- **Unbenched memory claim labeled.** Whitepaper §9.4's "~64 bytes/signal" table is now marked an
  order-of-magnitude **estimate** (not a measured heap allocation) — the robust claim is the
  direction (alien-signals lighter than the 3.5 `Proxy`). The shallowRef-vs-`ref` ratios stay —
  they're proven by the committed `tests/signal-shallow-ab.test.ts` A/B, not assumed.

### Internal — DRY pass (measure-driven)

- **Disposer teardown → `disposeAll(fns)`** (extracted to `command-bus.ts`). The "run every collected
  disposer, then clear the list" teardown was repeated across five sites (`useCommand` /
  `useCommandState` / `useCommandGroup`, `createChamber`'s install, and the `history` plugin) in two
  idioms (`forEach` ×4, `for-of` ×1). Unified to one plain-loop helper (cold path — runs at teardown,
  no per-dispose closure). Also fixed a latent inconsistency: `createChamber`'s disposer omitted the
  `.length = 0` clear, so it wasn't idempotent on double-dispose — now it is, everywhere. +2 tests.
- **Namespace-join convention → measured, kept inline (not extracted).** The camelCase join (`'cart'`
  + `'add'` → `'cartAdd'`) is inline-duplicated in `useCommandGroup`, `createChamber`, and the
  transitions bridge. A shared `prefixAction()` kernel was tried, but a same-process A/B (11 trials
  ×2, real `bus.dispatch` per hook) measured the extra call **~0.6–1.3% slower** on the per-dispatch
  paths (`useCommandGroup`, transitions). Not worth it — the three sites now mirror the convention
  **inline by design**, each with a "do not consolidate — settled" guard comment so it isn't
  re-DRY'd. (`createChamber` is setup-only/cold, but stays inline too for one consistent shape.)

Net size impact neutral.

### Fixed — `commandKey` canonical key (public-API behavior change)

`commandKey(action, target)` — the public key exported for cache integration and used internally by
`debounce`, throttle, and request dedup — silently **dropped nested object keys**. Its object path
was `JSON.stringify(target, Object.keys(target).sort())`, and the array form of that replacer is a
*top-level allowlist applied recursively*, so `{ q: { page: 2 } }` and `{ q: { page: 3 } }` both
serialized to `{"q":{}}` and **collided**. Measured against the function's own stated intent
("stable serialization"), that was a bug — distinct targets produced the same key.

Rewritten to a true canonical serialization: a **function** replacer sorts keys at *every* level, so
the key is order-independent (the original intent) **and** keeps nested fields in full (arrays keep
order). Knock-on correctness wins:
- **`debounce` / throttle** no longer collapse two same-action commands whose targets differ only in
  a nested field.
- **Request in-flight dedup** (`asyncRequest`) now reuses `commandKey` instead of a hand-rolled,
  order-*sensitive* `JSON.stringify(target)`. Identical requests dedup regardless of key order, while
  nested-different requests stay separate (the old inline key never false-deduped but missed
  order-different dedups — now both are correct). This resolves the S4b duplication **at the root**:
  the two keys diverged only because `commandKey` was broken; one correct key now serves both.

**Behavior change:** `commandKey`'s output string for *object* targets is different (nested content
included, keys sorted at all levels). TanStack-Query-style cache keys built from it change shape — a
one-time cache miss on upgrade, no data effect. Primitive-target keys are unchanged. Slightly more
allocation on the object path (a sorted-object rebuild per nested level); the primitive fast path —
the common debounce/throttle case — is untouched. +6 tests (**798** total).

### Verified

- `npm install` resolves `vue@3.6.0-beta.17`; `prepare` build green (ESM + 3 IIFE variants).
- `tsc --noEmit`: clean. `vitest run`: **884 passing / 47 files**. `vitest bench`: green; the
  Vue-independent paths (plain `{ value }` ~368k ops/s, fast-lane ~28.6k) land on the recorded
  baselines, no regression observed on this host. No controlled cross-beta delta was run (that
  needs beta.15 re-measured on the same host).
- `npm audit`: **0 vulnerabilities** after the toolchain bump below (was 3 dev-only advisories:
  esbuild←vite, markdown-it←typedoc). None ever touched the shipped runtime (`alien-signals` only).

### Build & dev dependencies (dev-only — no runtime or public-API change)

Major dev-toolchain bump; clears all `npm audit` advisories. The shipped library (one runtime
dep, `alien-signals`) is unaffected.

- **Vite 7 → 8** (now **rolldown**-based, esbuild dropped) · **TypeScript 5.9 → 6.0** · **Biome
  1.9 → 2.5** · Vitest/coverage 4.0 → 4.1.9 · @types/node, typedoc-plugin-markdown patch bumps.
- **Size measurement now uses an explicit `esbuild@^0.28.1` devDep** — Vite 8/rolldown no longer
  bundles esbuild, which `scripts/measure-size.mjs` and the `esm-treeshake` test need. 0.28.1 is
  above the advisory range (`0.17.0–0.28.0`), so it stays clean; the tree-shake test (which had
  auto-skipped) runs again.
- **Bundle size shifted under rolldown:** brotli got **smaller** (IIFE full 10.4→10.2, core
  7.1→7.0, elements 7.5→7.4 KB) while raw nudged up ~46 B on `core` — `scripts/check-size.mjs`
  raw ceiling for `core` raised 25_000→25_500 to absorb the toolchain drift; brotli ceilings
  unchanged. Docs + `docs/BUNDLE-SIZES.md` regenerated to the new numbers.
- **Fallout fixed:** `tsconfig` gained `"types": ["node"]` (TS 6 stopped auto-resolving the
  `process` global); `biome.json` migrated to v2 schema, the relocated `useValidTypeof`
  (`suspicious`→`correctness`) suppression updated, `forEach(fn => fn())` disposers given block
  bodies (biome 2 `useIterableCallbackReturn`), and `noUnusedFunctionParameters` disabled (test
  callbacks, not enforced under biome 1). Lint / typecheck / 798 tests / build all green.

### Tooling — honest, automated size & LOC measurement

- **`docs/BUNDLE-SIZES.md`** (generated by `npm run size:doc`) is the canonical, always-current
  size table — **minified, comment-free** brotli/gzip for every subpath export + IIFE variant
  (esbuild `--minify` for ESM, so comments never inflate the number). CI regenerates it and
  `git diff --exit-code`s it, so published sizes can't drift. `npm run size` prints the table.
- **`npm run loc`** (`scripts/measure-loc.mjs`) splits code vs comment lines (source is ~5,505
  code / ~3,509 comment) — size is measured as *code*, never raw lines.
- **Stale size claims corrected** across README / performance.md / whitepaper to measured values:
  the false "Under 3KB gzipped" → measured ~4 KB gz dispatch core; "~2 KB core" → **3.6 KB
  brotli** (`createCommandBus`, esbuild-minified); IIFE 9.8/6.7 → current measured. All now point
  at the generated table.
- **README size table refreshed + per-version history.** The README IIFE/CDN table was still
  showing **v1.2.0** sizes (labeled as such — core 6.1 / elements 6.4 / full 8.7 KB brotli);
  updated to current measured (**7.0 / 7.4 / 10.2**) and given a **Size-by-version** table
  (v1.2.0 → v1.6.0 → current) so size evolution is visible per release.
- **Regression verified.** Current IIFE brotli is **≤ the v1.6.0 baseline on every variant**
  (rolldown shaved 0.1–0.2 KB: core 7.1→7.0, elements 7.5→7.4, full 10.4→10.2 KB) — no size
  regression from the beta.16 alignment, the directive-modifier addition, or the toolchain bump.
  `npm run size:check` (`scripts/check-size.mjs`) stays the automated CI guard against future drift.

### CI — modernized GitHub Actions

- **Dedicated `lint + typecheck` job** (runs once, not 4× across the test matrix); the test matrix
  now covers **Node 20.19.0 / 22 / 24** × ubuntu/macos and drops the redundant explicit build
  (`npm ci`'s `prepare` already builds `dist/`). `loc` + the `size:doc` freshness `git diff` gate
  run on one deterministic entry.
- **All actions pinned to commit SHAs** (with version comments) and bumped to current: checkout
  v6, setup-node v6, upload-artifact v7, configure-pages v6, upload-pages-artifact v5, deploy-pages
  v5. Fixed the bench step masking failures (`tee` swallowed the exit code → added `set -o pipefail`).

## v1.7.0-Candidate — Vue 3.6.0-beta.16 alignment (unreleased)

_Targets **v1.7.0** (not yet published). The breaking `useVaporCommand` removal would be a major
under strict semver, but **2.0.0 is reserved for the Vue-3.6-stable identity decision** (Vapor-first
vs bus-first — see ROADMAP). While Vue 3.6 is still beta and there is effectively no userspace to
break, this cycle ships as a minor; the major bump is held for the post-beta direction call._
Every one of beta.16's 28 fixes
was read at the commit level and mapped to our surface. **The beta.16 alignment itself needs
no vapor-chamber code change** — all fixes are inherited through the pass-through wrappers, are
compile-time only, or sit *below* our SSR command-replay. A follow-on retrospective of betas
**9 → 16** (Vue's changelog against ours) then surfaced a few real gaps, fixed here: event-modifier
support on `v-vc:command`, two corrected version attributions, and the two alignment-log rows we
had skipped. Verified against beta.16: `tsc --noEmit` clean, **798/798 tests** pass (40 files),
benches run green with no measured host regression.

### Changed

- **peerDependencies** → `vue: ">=3.5.0 || >=3.6.0-beta.16"`; dev `vue` → `^3.6.0-beta.16`;
  examples (`vapor-sfc`, `vapor-island-cart`) repinned. Both ranges already admitted beta.16
  by semver prerelease ordering; the floor is bumped to keep the *tested-version* statement
  honest — beta.16 is what the suite now runs against.
- **SFC examples → Vite 8** (`vapor-sfc`, `vapor-island-cart`): `vite ^7 → ^8`, aligning the demos
  with the library's own toolchain. `@vitejs/plugin-vue ^6` already declares `vite ^5||^6||^7||^8`,
  so no plugin bump; both build clean (0 vulns, stale beta.15 lockfiles regenerated). The Laravel /
  Blade / Astro examples are unaffected — they use the IIFE drop-in or Astro's own bundler, not Vite
  directly. Fixed a pre-existing `vue-tsc` failure surfaced by the rebuild: the Vapor templates use
  vapor-chamber signals **bare** (Vapor auto-unwraps them at runtime), but `vue-tsc` can't unwrap the
  deliberately-Vue-free `Signal<T> = { value: T }` type. Added a small `asRef()` helper that re-types
  a signal as the `ShallowRef` it genuinely is when Vue is present — runtime-honest, and it makes
  `vue-tsc` auto-unwrap in templates. (The typed `vapor-chamber/vapor` surface on the v2.0 roadmap
  will remove the helper.)

### Added

- **`v-vc:command` now honors event modifiers** (`directives.ts`). The directive attaches a
  **direct** `addEventListener`, so Vue's compiled `withModifiers` never reached it — every
  modifier except the numeric `.timeout` was silently dropped. It now applies `.stop` / `.prevent`
  (DOM-event actions), `.self` and `.left` / `.middle` / `.right` (dispatch guards), and `.capture`
  / `.once` / `.passive` (passed as `addEventListener` options, and matched on removal). Surfaced
  by the beta.9–16 retrospective — Vue's beta.15 click-modifier-normalization fix (`eaefa71`) never
  reaches a direct listener. +5 tests in `tests/directives.test.ts`.

### Changed — `useVaporCommand` folded into `useCommand` (breaking)

- **`useVaporCommand` is removed; `useCommand` is now the single command composable.** The two had
  converged: both were Vapor-safe (the "needs a VDOM instance" distinction was obsolete —
  `useCommand` cleans up via `onScopeDispose`, never touches `getCurrentInstance`), and
  `useVaporCommand` was just `useCommand` + `register`/`on`/`emit`/`dispose`. `useCommand` now
  carries that full API — reactive `loading`/`lastError` **plus** `register`/`on`/`emit` with
  `onScopeDispose` auto-cleanup — Vapor-safe in `<script setup vapor>` and VDOM alike. For
  fire-and-forget with zero reactive overhead, `defineVaporCommand` is unchanged.
  - **Migration:** replace `useVaporCommand()` with `useCommand()` — identical return shape.
  - Removed **clean** (no deprecated alias): pre-release Vue + a tiny userbase made a deprecation
    cycle not worth the carry. ~60 lines of duplicated logic gone; the IIFE bundles now expose
    `useCommand` (they previously only exposed `useVaporCommand`).
  - Swept across examples, README, whitepaper (§9.4 reworked to drop the false `useCommand`-vs-
    `useVaporCommand` distinction), performance.md, the migration guide, and the ROADMAP (the
    `useVaporCommand`→`useCommand` merge item is now **done**, shipped ahead of v2.0). The
    `register`/`on`/`emit`/`dispose` tests now exercise `useCommand`. **798 tests green.**
- **Examples folder documented.** Added a top-level `examples/README.md` indexing all examples
  (full-project apps + `feature-*` / `pattern-*` snippets + core usage); the main README's
  Examples section listed only 6 of them and now surfaces the flagship runnable apps + links the
  index. (The whitepaper carries no example references — nothing stale there.)

### Removed (dead code)

- **`useVaporAsyncCommand`'s `listeners` array** (`chamber-vapor.ts`). It was copy-pasted from
  `useVaporCommand` but the composable exposes no `register`/`on`, so nothing could ever populate
  it — provably always empty, making its `dispose()` a no-op. Removed the array; `dispose` is now
  an explicit no-op kept for return-shape symmetry. Zero behavior change (798 tests green; the `.`
  barrel dropped 0.1 KB min). Identified by the DRY audit.

### Inherited behavior worth knowing (no code change)

- **Transitions — `onLeave` now fires for a non-v-show root removed after a v-show branch**
  (Vue `a816c9e`, *stop persisted leaking to non-v-show roots*). Before beta.16 a latched
  `persisted=true` made Vapor skip the leave, so `useTransitionCommand` / `createTransitionBridge`
  silently **dropped the `*Leave` dispatch** in that sequence. The runtime fix gates the
  carry-forward on an actual v-show marker; our bridge forwards the now-correct hook. `onLeave`
  JSDoc updated. The other five transition fixes — `fda5bc4` (re-resolve hooks on prop change),
  `207dce4` / `254a9c0` (type-bucketed leaving cache), `5689b88` (raw-key compare before early
  removal), `370de63` (out-in branch-key sync) — govern DOM-duplication / stale-branch
  correctness during rapid toggles; hook signatures unchanged, forwarded as-is.
- **App lifecycle — `createVaporChamberApp(...)` inherits two hardening fixes directly.**
  `.mount('#missing')` now **no-ops + dev-warns** instead of throwing (Vue `05bf22a`), and
  `.unmount()` no longer throws in **production builds** (Vue `52fda7c` — `app._instance` is
  dev-only, so prod unmount was a real minified-build crash; it now resolves the instance from a
  WeakMap). We return Vue's app untouched, so consumers get both for free. Caveat now documented:
  `.mount()` can return `undefined` for a bad selector — don't assume a component proxy.

### Pass-through (substantiated per commit, not waved through)

- **SSR / hydration (`ssr.ts`).** `rehydrate()` is command replay *above* Vue's DOM hydration,
  so all seven hydration fixes sit below us and only hand our replay a more-correct DOM:
  `a36f43b` (dynamic props applied on mismatch-recreated nodes), `58aeb40` (static-text patching,
  prod included), `3daf8f5` (exact tag-mismatch detection — no more `<i>`/`<ins>` prefix
  collisions), `2d7464c` (static-template clone-cache reused, not re-cloned per adoption),
  `0c92f54` (v-if empty branches hydrated with static templates), `4eb5dca` (fragment-start
  warning text), `baa7c59` (empty-container full mount on `createVaporSSRApp`, which we don't
  wrap). Note: `a36f43b` reduces "Hydration text mismatch" dev-warning counts — nothing in the
  lib keys off that count.
- **Props / emit / attrs / events.** `5100a6e` (dynamic v-bind event options parsed like VDOM —
  `Once`/`Passive`/`Capture`) affects Vue's *compiled* dynamic-event path only; `v-vc:command`
  attaches a **direct** `addEventListener`, so the beta.15 disabled/in-flight mirror is untouched
  (the same "direct listener gets no compiled help" property is why we added explicit modifier
  handling — see **Added**). `ffd671c` (nullish emit sources), `a63b165` (symbol attr stringify),
  `f53da05` (nullish dynamic props → empty) are internal `prop.ts` / `componentEmits.ts` hardening,
  inherited.
- **Compiler (8 fixes).** Compile-time correctness in generated code: `0bf86ef` (setup-let inline
  assignment), `224e672` (v-html children before text transforms), `780c4ff` (unsafe attr names
  kept out of static templates), `d80423d` (dynamic modifier arg keys), `898ce5b` / `eb25a7f`
  (native / static v-model modifier key quoting), `1eaacfa` (slot v-else without adjacent v-if
  now reported, not crashed), `2c73a96` (empty blocks return `[]`). They reach consumer `.vue` /
  examples on recompile; we vendor no generator files, so the `genDirectiveModifiers` relocation
  in `898ce5b` doesn't touch us.

### Performance — technique recorded, not applied

- **`27b0482` (skip SlotFragment for stable slot fallback, #14969).** A coordinated
  compiler + runtime + shared change: the compiler proves a slot's fallback is unreachable,
  encodes it as a one-bit `VaporSlotFlags.NON_STABLE` flag on the emitted slot fn, and the
  runtime picks a lighter `DynamicFragment` (skipping the `SlotFragment` allocation **and** its
  content-vs-fallback arbitration) whenever the flag is absent. Consumers on beta.16 inherit it by
  depending on Vue's runtime. The **transferable pattern** — push an uncertainty decision to where
  the shape is statically known, encode it as a cheap flag, and select a lighter object + simpler
  path on the proven-safe majority — is logged in the whitepaper alignment table as an opportunity
  to evaluate against our own hot paths. It is **not** applied this cycle: it intersects the
  deferred Vapor-first / bus-first identity decision (v2.0.0), and any such change ships only with
  a measured, same-host A/B — never a guess.

### Retrospective (beta.9 → beta.16 audit)

Walked Vue's per-beta changelog against ours, one beta at a time, to catch anything overlooked.
Outcome: the wrappers held — every flagged item is genuine pass-through once checked against the
actual code (the directive receives the live `el` from Vue and cleans up in `beforeUnmount`; the
HMR shim only saves/restores the bus, never component effects; SSR replay sits above DOM
hydration). Three real gaps were fixed:

- **Alignment log completed.** The whitepaper "Vue 3.6 alignment log" claimed one row per beta but
  skipped **beta.9** and **beta.10**; both rows added (pass-through — e.g. beta.9's TransitionGroup
  parity fixes mean the bus now receives the *corrected* hook set, including no more bogus hooks on
  unkeyed interop children).
- **Two attributions corrected** (verified against Vue's tags): the alien-signals reactivity rewrite
  landed in **3.6.0-alpha.1** (#12349), not beta.8; `defineVapor*` were introduced across
  **3.6.0-alpha.3–5** (#13059 / #14017 / #13831), not beta.10 (which only tree-shook / async-hydrated
  them). Fixed in `whitepaper.md`, `chamber-vapor.ts`, `ROADMAP.md`.
- **Event modifiers on `v-vc:command`** — see **Added** above.

### Core coverage to 100%, lazy buffer allocation, honest coverage docs

A measurement-driven hardening pass on `command-bus.ts` — the dispatch core named in the §19
Core Guarantee.

- **`command-bus.ts` reaches 100% line + branch + function coverage** (was ~96.7% line /
  92.2% branch). **+19 tests** in `tests/command-bus-features.test.ts` exercise the
  previously-untested error/edge branches on the *real* sync/async buses (not the
  coverage-excluded `TestBus`): throwing `onBefore` hooks, `offAll()` clear-all, the async
  transactional abort + rollback paths, `query()` on a missing handler, `onMissing:'buffer'`
  overflow/drop (incl. the production warning-suppression branch), the prefix-cache LRU
  eviction, idempotent unsubscribe, and the `inspectBus` fallback. Three **provably-unreachable**
  defensive guards (a caller-guaranteed null-check; two `!results[j].ok` rollback skips that the
  "halt at first failure" batch semantics make dead) are excluded with `/* v8 ignore */` +
  rationale, not faked. Suite: **798 passing / 40 files**.
- **Buffer queue (`deferred`) is now lazily allocated** (`command-bus.ts`) — `null` until the
  first buffered command, instead of an eager `new Map()` at construction for every
  `onMissing:'buffer'` bus. A buffer-mode bus whose handlers always beat its dispatches now
  allocates nothing. The alternative — keeping it eager so the hot-path miss-gate could read
  `deferred !== null` instead of `opts.onMissing === 'buffer'` — was tested with a same-process
  A/B and **rejected**: the `deferred !== null` gate is faster only when monomorphic (~3–7%) and
  *regresses* ~1.7% in apps mixing buffer + non-buffer buses (polymorphic inline cache), so the
  hot-path gate stays on `onMissing`. Net: simpler constructor, no wasted allocation, the
  lazy-init branch is now covered by existing tests, and the `.` barrel dropped ~0.1 KB min.
- **Coverage claims corrected.** Whitepaper §19 "100% branch and line coverage — always" was
  **false** (global branch was 82.8%); it now states the true, *measured* `command-bus.ts` 100%
  line+branch+function (behind the `vitest.config` gate, with `testing.ts` excluded as the test
  harness). `vitest.config.ts` thresholds tightened from a slack 73/65/80/75 to **89/82/90/90**
  (~2 points under measured — restoring a meaningful regression gate), and the stale
  "plugins-extra.ts / utilities.ts at 0%" comment removed (both ~93% — their test files exist).
- **Stale doc numbers synced.** Recursion-depth guard now documented as **max 16** (matches
  `MAX_DISPATCH_DEPTH`; was "max 10" in three places); the §21 File Map test inventory regenerated
  from a partial 13-file/466 list to all **40 files / 798 total**; the `command-bus.ts` header
  size corrected from "~2KB gzipped" to "~3.6 KB brotli core; full ~10–20 KB" → `BUNDLE-SIZES.md`.
  Version-stamped historical counts (v1.0's 466) left frozen.

### Performance docs re-measured against the bench

`npm run bench` re-run on the current host (Vue 3.6.0-beta.16); `docs/performance.md` corrected
to the measured same-process ratios — drift went **both** directions:

- **Overstated mitt comparisons brought down.** No-listener emit "2.5× faster than mitt" →
  **~1.4×**; emit fan-out "1.8× faster than mitt" → **~1.4×**; "within 20% of nanoevents" →
  **~28% behind** (nanoevents pulled ahead — its no-listener path now ~8× vapor's, vs the old
  ~3.3×). mitt simply got relatively faster since the numbers were first taken.
- **Undersold fast-lane raised.** "5.3× faster than mitt" → **~5.6×**; "1.9× faster than
  nanoevents" → **~2.1×**; fast-lane emit no longer "ties" nanoevents — it **edges it (~1.1×)**.
- **Stale absolutes refreshed / removed.** The unreproducible "+12% / +26% (415 → 466 ops/sec)"
  listener-impact line replaced with current fan-out numbers; single-handler `bus.dispatch`
  ~630 → **~1,800 ops/sec** (~18M dispatches/s); persist `coalesce` ~8.75× → **~23×**; meta-id
  counter speedup 2.26× → **~2.5×**. Comparative tables re-stated to the current run, ratios
  written as approximates (one run; machine-sensitivity caveat kept).
- **Unbenched memory claim labeled.** Whitepaper §9.4's "~64 bytes/signal" table is now marked an
  order-of-magnitude **estimate** (not a measured heap allocation) — the robust claim is the
  direction (alien-signals lighter than the 3.5 `Proxy`). The shallowRef-vs-`ref` ratios stay —
  they're proven by the committed `tests/signal-shallow-ab.test.ts` A/B, not assumed.

### Internal — DRY pass (measure-driven)

- **Disposer teardown → `disposeAll(fns)`** (extracted to `command-bus.ts`). The "run every collected
  disposer, then clear the list" teardown was repeated across five sites (`useCommand` /
  `useCommandState` / `useCommandGroup`, `createChamber`'s install, and the `history` plugin) in two
  idioms (`forEach` ×4, `for-of` ×1). Unified to one plain-loop helper (cold path — runs at teardown,
  no per-dispose closure). Also fixed a latent inconsistency: `createChamber`'s disposer omitted the
  `.length = 0` clear, so it wasn't idempotent on double-dispose — now it is, everywhere. +2 tests.
- **Namespace-join convention → measured, kept inline (not extracted).** The camelCase join (`'cart'`
  + `'add'` → `'cartAdd'`) is inline-duplicated in `useCommandGroup`, `createChamber`, and the
  transitions bridge. A shared `prefixAction()` kernel was tried, but a same-process A/B (11 trials
  ×2, real `bus.dispatch` per hook) measured the extra call **~0.6–1.3% slower** on the per-dispatch
  paths (`useCommandGroup`, transitions). Not worth it — the three sites now mirror the convention
  **inline by design**, each with a "do not consolidate — settled" guard comment so it isn't
  re-DRY'd. (`createChamber` is setup-only/cold, but stays inline too for one consistent shape.)

Net size impact neutral.

### Fixed — `commandKey` canonical key (public-API behavior change)

`commandKey(action, target)` — the public key exported for cache integration and used internally by
`debounce`, throttle, and request dedup — silently **dropped nested object keys**. Its object path
was `JSON.stringify(target, Object.keys(target).sort())`, and the array form of that replacer is a
*top-level allowlist applied recursively*, so `{ q: { page: 2 } }` and `{ q: { page: 3 } }` both
serialized to `{"q":{}}` and **collided**. Measured against the function's own stated intent
("stable serialization"), that was a bug — distinct targets produced the same key.

Rewritten to a true canonical serialization: a **function** replacer sorts keys at *every* level, so
the key is order-independent (the original intent) **and** keeps nested fields in full (arrays keep
order). Knock-on correctness wins:
- **`debounce` / throttle** no longer collapse two same-action commands whose targets differ only in
  a nested field.
- **Request in-flight dedup** (`asyncRequest`) now reuses `commandKey` instead of a hand-rolled,
  order-*sensitive* `JSON.stringify(target)`. Identical requests dedup regardless of key order, while
  nested-different requests stay separate (the old inline key never false-deduped but missed
  order-different dedups — now both are correct). This resolves the S4b duplication **at the root**:
  the two keys diverged only because `commandKey` was broken; one correct key now serves both.

**Behavior change:** `commandKey`'s output string for *object* targets is different (nested content
included, keys sorted at all levels). TanStack-Query-style cache keys built from it change shape — a
one-time cache miss on upgrade, no data effect. Primitive-target keys are unchanged. Slightly more
allocation on the object path (a sorted-object rebuild per nested level); the primitive fast path —
the common debounce/throttle case — is untouched. +6 tests (**798** total).

### Verified

- `npm install` resolves `vue@3.6.0-beta.16`; `prepare` build green (ESM + 3 IIFE variants).
- `tsc --noEmit`: clean. `vitest run`: **798 passing / 40 files**. `vitest bench`: green; the
  Vue-independent paths (plain `{ value }` ~368k ops/s, fast-lane ~28.6k) land on the recorded
  baselines, no regression observed on this host. No controlled cross-beta delta was run (that
  needs beta.15 re-measured on the same host).
- `npm audit`: **0 vulnerabilities** after the toolchain bump below (was 3 dev-only advisories:
  esbuild←vite, markdown-it←typedoc). None ever touched the shipped runtime (`alien-signals` only).

### Build & dev dependencies (dev-only — no runtime or public-API change)

Major dev-toolchain bump; clears all `npm audit` advisories. The shipped library (one runtime
dep, `alien-signals`) is unaffected.

- **Vite 7 → 8** (now **rolldown**-based, esbuild dropped) · **TypeScript 5.9 → 6.0** · **Biome
  1.9 → 2.5** · Vitest/coverage 4.0 → 4.1.9 · @types/node, typedoc-plugin-markdown patch bumps.
- **Size measurement now uses an explicit `esbuild@^0.28.1` devDep** — Vite 8/rolldown no longer
  bundles esbuild, which `scripts/measure-size.mjs` and the `esm-treeshake` test need. 0.28.1 is
  above the advisory range (`0.17.0–0.28.0`), so it stays clean; the tree-shake test (which had
  auto-skipped) runs again.
- **Bundle size shifted under rolldown:** brotli got **smaller** (IIFE full 10.4→10.2, core
  7.1→7.0, elements 7.5→7.4 KB) while raw nudged up ~46 B on `core` — `scripts/check-size.mjs`
  raw ceiling for `core` raised 25_000→25_500 to absorb the toolchain drift; brotli ceilings
  unchanged. Docs + `docs/BUNDLE-SIZES.md` regenerated to the new numbers.
- **Fallout fixed:** `tsconfig` gained `"types": ["node"]` (TS 6 stopped auto-resolving the
  `process` global); `biome.json` migrated to v2 schema, the relocated `useValidTypeof`
  (`suspicious`→`correctness`) suppression updated, `forEach(fn => fn())` disposers given block
  bodies (biome 2 `useIterableCallbackReturn`), and `noUnusedFunctionParameters` disabled (test
  callbacks, not enforced under biome 1). Lint / typecheck / 798 tests / build all green.

### Tooling — honest, automated size & LOC measurement

- **`docs/BUNDLE-SIZES.md`** (generated by `npm run size:doc`) is the canonical, always-current
  size table — **minified, comment-free** brotli/gzip for every subpath export + IIFE variant
  (esbuild `--minify` for ESM, so comments never inflate the number). CI regenerates it and
  `git diff --exit-code`s it, so published sizes can't drift. `npm run size` prints the table.
- **`npm run loc`** (`scripts/measure-loc.mjs`) splits code vs comment lines (source is ~5,505
  code / ~3,509 comment) — size is measured as *code*, never raw lines.
- **Stale size claims corrected** across README / performance.md / whitepaper to measured values:
  the false "Under 3KB gzipped" → measured ~4 KB gz dispatch core; "~2 KB core" → **3.6 KB
  brotli** (`createCommandBus`, esbuild-minified); IIFE 9.8/6.7 → current measured. All now point
  at the generated table.
- **README size table refreshed + per-version history.** The README IIFE/CDN table was still
  showing **v1.2.0** sizes (labeled as such — core 6.1 / elements 6.4 / full 8.7 KB brotli);
  updated to current measured (**7.0 / 7.4 / 10.2**) and given a **Size-by-version** table
  (v1.2.0 → v1.6.0 → current) so size evolution is visible per release.
- **Regression verified.** Current IIFE brotli is **≤ the v1.6.0 baseline on every variant**
  (rolldown shaved 0.1–0.2 KB: core 7.1→7.0, elements 7.5→7.4, full 10.4→10.2 KB) — no size
  regression from the beta.16 alignment, the directive-modifier addition, or the toolchain bump.
  `npm run size:check` (`scripts/check-size.mjs`) stays the automated CI guard against future drift.

### CI — modernized GitHub Actions

- **Dedicated `lint + typecheck` job** (runs once, not 4× across the test matrix); the test matrix
  now covers **Node 20.19.0 / 22 / 24** × ubuntu/macos and drops the redundant explicit build
  (`npm ci`'s `prepare` already builds `dist/`). `loc` + the `size:doc` freshness `git diff` gate
  run on one deterministic entry.
- **All actions pinned to commit SHAs** (with version comments) and bumped to current: checkout
  v6, setup-node v6, upload-artifact v7, configure-pages v6, upload-pages-artifact v5, deploy-pages
  v5. Fixed the bench step masking failures (`tee` swallowed the exit code → added `set -o pipefail`).

## v1.6.0 — Vue 3.6.0-beta.15 alignment

### Changed

- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.15"`; dev `vue` pinned to
  `^3.6.0-beta.15`.
- **`useSharedCommandState` now observes errors BUS-WIDE (`chamber.ts`).** Previously it recorded
  errors only from dispatches made through its own `dispatch` wrapper — failures from
  `useVaporCommand`, `useCommand`, or raw `bus.dispatch` were invisible to the shared error
  list, contradicting its documented "observes the whole bus" behavior (found live: the vapor-sfc
  StatusBar never updated). It now subscribes `bus.on('*')` and records every failed command on
  the bus; the wrapper no longer double-records, and the observer unhooks when the last
  subscriber disposes. `isAnyLoading` stays scoped to the composable's own dispatches (bus-wide
  in-flight pairing isn't guaranteed on all error paths). +3 regression tests. The vapor-sfc
  example was also made an honest demo: stateful fake-server handler (totals accumulate),
  handler-confirmed cart line on success (the happy path previously rendered nothing).
- **Fixed: `vaporChamberHMR()` made Vue/Vapor detection impossible in Vite dev (`vite-hmr.ts`).**
  The injected shim import sits at the top of every transformed module, so `vapor-chamber`
  always evaluated before any user code could prime detection — and the lib's async probe
  (bare-specifier dynamic `import('vue')`) always fails in browsers. Net effect: with the HMR
  plugin active, `createVaporChamberApp()` threw on every dev page load. The shim now emits a
  companion virtual module that sets `globalThis.__VUE__` from the consumer's own `vue` BEFORE
  importing `vapor-chamber` (no-op when `vue` doesn't resolve, so non-Vue consumers are
  unaffected). Found by browser-verifying the `vapor-sfc` example, which was broken-by-design in
  dev; its templates had even been written against the broken behavior (explicit `.value` on
  top-level refs that Vapor templates auto-unwrap) and its async handlers sat on the sync bus
  (rejections escaped `lastError`) — both fixed in the example alongside. +3 plugin tests.
- **`v-vc:command` now skips dispatch on disabled / in-flight elements (`directives.ts`).** Mirrors
  beta.15's runtime change *skip disabled delegated direct handlers* (#14948) for the **direct**
  click listener this directive attaches (it is not a delegated handler, so Vue's runtime fix does
  not reach it automatically). `buildHandler` now bails out when (a) a dispatch is already in flight
  — preventing a re-entrant double-dispatch from rapid clicks during an async command — or (b) the
  element is disabled via the DOM `disabled` property or `aria-disabled="true"`. The platform already
  suppresses clicks on disabled `<button>`/`<input>`, but `v-vc:command` can sit on
  `<a>`/`<div>`/`aria-disabled` elements it does not guard.

### Docs — Vue 3.6.0-beta.15 alignment notes (all other items pass-through)

Per-file alignment headers updated; these are Vue runtime/compiler fixes that flow through the
pass-through wrappers with no code change on our side:

- **`transitions.ts`** — *restore transition group hooks after skipped move* (a child whose move was
  skipped, e.g. a v-show-hidden item, keeps its move hooks so a later real reorder still dispatches
  `*Move`), *transition group key inheritance aligned with vdom*, *inherited keys kept stable*,
  *unique keys preserved for multi-root v-for items*, *transition v-if comment handling aligned with
  vdom*. `onMove` JSDoc updated.
- **`chamber-vapor.ts`** — *guard interop vnode access* (interop reads of a possibly-absent bridged
  vnode no longer crash in rapidly mounting/unmounting mixed trees), *clear old keyed direct template
  refs*, the full **teleport** group (invalid-target handling, disabled-target order, explicit mount-
  location tracking, CSS-vars-by-mount-location, no target-child moves on reorder, reused raw props
  proxy), and *avoid retaining fragment classes in app-only bundles* (smaller app-only builds; the
  library is `sideEffects: false` and tree-shakes alongside it).
- **`ssr.ts`** — teleport hydration: *track mount location explicitly* and *preserve disabled teleport
  target order* keep `rehydrate()` command replay in document order around teleport boundaries
  (builds on beta.13's logical-sibling teleport-range skip); *update teleport css vars by mount
  location* noted for completeness.

### Added

- **`history()` gains `undoAction` / `redoAction` options.** The plugin registers the undo/redo
  trigger handlers itself and ALWAYS excludes those actions from recording — removing the footgun
  where a hand-wired `bus.register('cart.undo', () => h.undo())` recorded the trigger command into
  history (wiping the redo stack on every dispatch: undo worked once, redo never enabled — found
  live in the island-cart example). Also adds `dispose()` to unregister the triggers. Guarded by
  4 new tests in `tests/plugins.test.ts`; the example now uses the new options.
- **`onMissing:'buffer'` hardening: `bufferTTL` + `onBufferOverflow`.** `bufferTTL` (ms) lazily
  reaps queued commands that outlive it — on the next push and at flush — so a handler that never
  arrives (an island that fails to hydrate) can't pin stale commands in memory; expired entries are
  not replayed. `onBufferOverflow(action, dropped)` fires for both TTL reaps and `bufferLimit`
  drops, giving production observability (drops were previously dev-console-only). Defaults
  unchanged. 3 new tests in `tests/deferred-dispatch.test.ts`.
- **Dev warning for the signal()-before-detection race.** Vue detection is async; a `signal()`
  created before it resolves is a plain `{ value }` object forever (writes never trigger
  reactivity) while later signals get `shallowRef` — a silent semantics gap. `configureSignal()`
  now warns once (dev only) when a reactive backing arrives after plain signals were created, and
  points at `waitForVueDetection()`. Test: `tests/signal-race-warning.test.ts`.
- **Typed Vapor wrappers (opt-in).** `defineVaporComponent` / `defineVaporCustomElement` /
  `defineVaporAsyncComponent` / `createVaporChamberApp` gained a `<T = any>` return generic and
  `object`-typed params instead of `any` — callers opt in (`defineVaporComponent<MyComp>(opts)`)
  with zero Vue-type dependency on the main barrel. Full Vue-typed inference is parked for v2.0.0
  (ROADMAP checklist) once Vue's Vapor types settle.
- **`prepare` script — git installs now work.** `npm install github:lucianofedericopereira/vapor-chamber`
  builds `dist/` on install, making the repo an authoritative install source while registry
  releases lag. Root `npm install` also auto-builds, and the examples gained `predev`/`prebuild`
  hooks that build the lib on demand — no more manual "build the library first" step.

### Docs & maintenance

- **SSR concurrency warning.** `setCommandBus()` and the ssr.ts examples now state plainly that the
  shared-bus set/render/reset pattern is per-process and only safe for one render at a time;
  concurrent SSR servers should create a per-request bus and pass it explicitly. The README's
  "no shared singletons" bullet was corrected to match reality.
- **Per-beta alignment headers consolidated (~265 lines removed).** The src file headers in
  `transitions.ts` / `chamber-vapor.ts` / `ssr.ts` / `directives.ts` no longer duplicate the full
  per-beta changelog prose — they carry one line per version plus in-file code-change notes, and
  point at CHANGELOG.md and the whitepaper's alignment log (now genuinely the single source of
  per-beta detail). Function-level JSDoc keeps behavior-relevant notes only.
- **README opening rewritten** as a self-contained "what's in the can" — core vs opt-in batteries
  table, install (registry + git), honest SSR bullet.
- **Bench labels self-track the running Vue version** (`import { version } from 'vue'`) instead of
  hardcoded beta tags; recorded 3-run beta.15 dev-host baselines with cross-host variance notes.

- **`examples/laravel-app/`** — runnable, **verified** Laravel example. `setup.sh` scaffolds a fresh
  skeleton and drops in session-backed action classes (zero migrations), the audited
  `VaporChamberController` from `../laravel-backend`, a Blade view with the core IIFE and real CSRF
  (`VaporChamber.connect({ csrf: true })`), and append-safe routes. Verified end-to-end on Laravel 12 /
  PHP 8.5: happy path (`{ok:true,state}`), session persistence across dispatches, validation → 422,
  unknown command → 404, missing CSRF → 419. Verification also caught and fixed an append-snippet
  fatal (duplicate `Route` facade `use` — snippet is now fully-qualified).
- **`examples/exo-astro/`** — exo-style declarative event-bus directives for Astro pages, vendored
  self-contained (`v-scope`, `v-command`, `v-bind-text`, `v-show` — a ~150-line Proxy-based scanner,
  no framework runtime; 4.9 kB gzip client JS total). Headline: **dispatch before hydration** —
  handlers register 2s late on purpose and `onMissing:'buffer'` + `bufferTTL` + `onBufferOverflow`
  buffer and replay the clicks. Verified: `astro build` + dev server.
- **Fixed `examples/vapor-sfc` silent runtime breakage** — its Vite config lacked the
  `vue` → `vue/dist/vue.runtime-with-vapor.esm-browser.js` alias, so builds succeeded (63 kB bundle)
  while `createVaporChamberApp()` would throw at runtime ("Vue 3.6+ with Vapor mode required"):
  Vue's default entry ships no Vapor runtime. Alias + `optimizeDeps` added (bundle now 81 kB with
  the runtime, matching the island-cart example); `@vitejs/plugin-vue` aligned to `^6.0.0`.
- **`examples/vapor-island-cart/`** — runnable `<script setup vapor>` example: a light-DOM Vapor
  **custom-element island** cart. Plain server-rendered HTML upgrades in place to Vapor custom
  elements (`defineVaporCustomElement`, `shadowRoot: false`) that coordinate through a single command
  bus (`logger` + `history` undo/redo + cross-tab `sync` + `persist`). Demonstrates HTML-first
  progressive enhancement and `client:load` / `client:visible` / `client:idle` hydration. Promoted
  from the `test-draft` working copy and aligned to the `examples/` convention (`vapor-chamber:
  file:../..`, beta.15 `vue`).

## v1.5.0 — Vue 3.6.0-beta.14 alignment

### Changed

- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.14"`.
- **`signal()` now wires Vue's `shallowRef()` instead of `ref()`** when Vue is detected
  (`chamber.ts`, `signal.ts`). The library only ever replaces a signal's value wholesale
  (`state.value = handler(...)`, `errors.value = [...]`) and never mutates nested fields in
  place, so shallow tracking is semantically identical for every internal signal while skipping
  the deep reactive Proxy (`toReactive()`) that `ref()` wraps around object/array values. This is
  *not* a beta.14 feature — it is a standing optimization surfaced while profiling the beta.14
  reactive path. Measured on the real `useCommandState` dispatch path (interleaved same-process
  A/B, not the coarse vitest-bench harness whose ~480µs/iteration floor masks the effect):
  array-state dispatch **~3.4× faster** (+245% at 100 dispatches), scalar signals **~1.1–1.2×**,
  lower per-write allocation. Proven by a committed, reproducible benchmark —
  `tests/signal-shallow-ab.test.ts` measures the real dispatch path with `process.hrtime` and
  **prints the table on every run** (the live evidence); it doesn't assert a timing threshold
  (ratios are unstable under load/coverage and it compares Vue primitives directly, so it can't catch
  a library regression). The regression guard is `tests/chamber.test.ts` → "signal() factory — shallow
  reactivity", which asserts the factory stays a `shallowRef` and that whole-value replacement still
  drives reactivity. (Isolated `ref`-vs-`shallowRef`
  micro-benches were deliberately *not* added to `perf.bench.ts`: pure signal loops are
  constant-foldable and V8 dead-code-elimination inflates the ratio to 800×+ with ±100% variance —
  the real-path interleaved test is the only trustworthy measure.) Consumer note: directly mutating a returned
  `state.value.x = y` (instead of dispatching a command) no longer triggers reactivity under the
  shallow default — that always bypassed the command bus and was an anti-pattern, but if you need
  it deliberately, use `useDeepCommandState` / `deepSignal` from `vapor-chamber/reactive` (see Added).
- **`tryAutoCleanup` dev warning — deduped and reworded.** The "composable used outside a Vue scope"
  warning now fires **at most once per module** (it used to repeat on every such call, flooding test
  and bench output) and is reworded as a clearly-labeled, self-explaining hint — it opens with
  "Heads-up (not an error)" and states it's "expected and harmless when intentional — e.g. in tests,
  one-off scripts, or anywhere you dispose manually", so it can't be mistaken for a failure. Guarded
  by `tests/auto-cleanup-warning.test.ts`.
- **`onMissing:'buffer'` allocates lazily.** The per-action buffer Map is created only when
  `onMissing:'buffer'` is configured (read once at construction) — non-buffer buses, the overwhelming
  majority, skip the allocation entirely.

### Tooling & tests

- **`npm test` now runs once and exits** (`vitest run`) instead of launching the watch-mode dev
  runner; the interactive watcher moved to **`npm run test:watch`**. `test:run` is unchanged; CI and
  `prepublishOnly` already used it.
- **`chamber.ts` coverage 76% → ~87% branch / ~95% statements** — new behavior tests for the
  `globalThis.__VUE__` script-tag/MPA detection path, `runDispatch`/`useSharedCommandState` error
  arms, undo/redo handler errors, and the `useCommandGroup` `use`/`on`/`query`/`emit`/`dispose`
  methods. Self-flagged roadmap target met.
- **Adversarial hardening tests** for the saga/compensation path — a compensation step that *itself*
  fails, first-step failure (nothing to compensate), reverse-order compensation, async-bus sagas.
- **De-flaked the `signal-shallow-ab` proof test.** It blew the 5s default timeout under heavy
  parallel load / `--coverage` instrumentation (the real cause of a rare CI flake, not its
  assertions). It now skips under `--coverage` (instrumented timing is meaningless there), runs with
  a 30s timeout otherwise, and only smoke-checks finite/positive ratios — it *prints* the evidence
  rather than asserting a timing threshold (the `isShallow` test is the real regression guard).

### Docs

- **Feature set declared locked; docs restructured for Vue-version tracking.** `ROADMAP.md`
  refreshed to beta.14 (currency, peer dep, the moving-API range) and given a **feature-lock
  posture** (the surface is complete; the only forward motion until 3.6 stable is tracking betas),
  a **Vue version-support matrix**, and a **"what flips at Vue 3.6 stable" checklist** so the
  stable landing is mechanical. The whitepaper's layered beta.8 → .14 addenda were consolidated
  into a single **Vue 3.6 alignment log table** (one row per beta — the only place per-beta detail
  lives now), and `performance.md`'s parallel beta.13/beta.14 reactive-notes sections merged into
  one version-agnostic section with prior-beta baselines cited inline. No content lost; future beta
  bumps are now a one-row table edit instead of another stacked addendum.

### Added

- **`createEchoBridge` — Laravel Echo / Reverb realtime → bus.** Protocol-aware over the generic WS
  bridge: subscribes public / private / presence channels and routes each broadcast to `bus.emit()`
  (or a command via `onBroadcast`); presence membership (`here`/`joining`/`leaving`) is emitted as
  `"<channel>:here"` etc. Receive-only by design (outbound still goes through the HTTP bridge). Takes
  your own Echo instance, so the library never imports `laravel-echo` and non-Laravel consumers don't
  pay for it. `install(bus)` / `teardown()`. 6 tests against a mock Echo. (Was previously roadmap-only.)
- **`onMissing: 'buffer'` — deferred dispatch (buffer-until-registered).** A command dispatched
  before its handler exists is now queued **per action, FIFO**, and replayed — in order, through the
  full pipeline (plugins/hooks/listeners fire on replay, not before) — the moment a handler
  `register()`s. Built for lazy/async wiring where dispatch can precede the handler (Astro/island
  hydration, code-split panels): the click isn't lost, it fires when the handler arrives. Sync and
  async buses; bounded by `bufferLimit` (default 256, drop-oldest + dev warning). Buffered dispatch
  returns `{ ok: true, value: undefined }`; `query` never buffers (falls back to `'error'`). 8 tests.
- **`idempotent` plugin — collapse duplicate commands (client-side exactly-once).** Repeats of the
  same logical command — double-clicked Checkout, an auto-retry, a reconnect replay — run the
  handler/backend **once**: concurrent dupes share the first in-flight promise, sequential dupes
  within `ttl` (default 60 s) return the cached result. Failures are **not** cached (a real retry
  runs). Default key is `commandKey(action, target)`; configurable `key`/`ttl`/`actions`. Stamps
  `cmd.meta.idempotencyKey`, and **the HTTP bridge now forwards it as an `Idempotency-Key` header**
  so the backend can reject the duplicate write too — the wire half of exactly-once. Composes with
  `serialize` (orders same-key locally). Lives in `plugins-extra` (tree-shaken; not in the IIFE
  bundles). 7 tests.
- **Bundle-size budgets** (`scripts/check-size.mjs`): all three IIFE variants +~120–230 B (brotli)
  for the `onMissing:'buffer'` deferred-dispatch logic in `command-bus.ts`. The `idempotent` plugin
  is in `plugins-extra` and not in these bundles.
- **`serialize` plugin — per-key sequential processing for async commands.** Closes the one
  genuine core-feature gap: ordered serialization of *distinct* same-key commands (the bus already
  had in-flight *dedup*, which collapses identical requests — this queues different same-key commands
  so they apply in order). Async bus only (sync handlers are atomic and can't interleave). Prevents
  read-modify-write races on a shared resource — two `accountWithdraw` for the same account, rapid
  `cartCheckout` clicks, etc. `serialize({ key: (cmd) => cmd.target.accountId, actions: ['account*'] })`.
  Failure-safe (a rejected command doesn't stall its lane) and bounded (per-key entries reclaimed when
  a lane drains). **`scope: 'cross-tab'`** extends serialization across every tab/window of the same
  origin via the **Web Locks API** (`navigator.locks`) — browser-arbitrated mutual exclusion with no
  custom transport, auto-falling back to the per-instance queue when the API is absent (SSR/older
  browsers). Lives in `plugins-extra` (tree-shaken; not in the IIFE bundles). 10 tests including a
  control case proving the race exists without it and deterministic barrier-based concurrency checks.
- **`vapor-chamber/reactive` — opt-in deep-reactivity companion.** New subpath module exporting
  `deepSignal()` and `useDeepCommandState()`. The core stays shallow and fast by default; import
  this module only when you genuinely need nested reactivity — e.g. a state object two-way bound
  with `v-model` whose fields you mutate in place (`state.value.profile.name = 'x'`) rather than
  through dispatched commands. `useDeepCommandState` shares the exact dispatch/coalesce/cleanup
  core with `useCommandState` (via the internal `_createCommandState`), differing only in the
  signal factory (deep `ref()` vs shallow `shallowRef()`), so the two can never drift. The companion
  ships in its own tree-shakable chunk and is **not** bundled into the IIFE variants or pulled into
  the core `.` entry. Best of both worlds: shallow-fast default, deep-reactive when asked.
- **Bundle-size budgets** (`scripts/check-size.mjs`): `full` brotli 10,100 → 10,250 B and `elements`
  raw 25,100 → 25,250 B, accommodating the ~60–120 B `_createCommandState` shared-core refactor that
  backs the reactive companion. The companion module itself is not in these IIFE bundles.

### Vue 3.6.0-beta.14 alignment

#### HMR (`vite-hmr.ts`)

- **Deduplication of parent reload cycles** (`hmr: dedupe HMR parent reloads`):
  Vue's runtime now deduplicates parent HMR reload events. The injected shim
  mirrors this with a per-cycle guard (`data.__vc_disposed`) so the command bus
  is persisted at most once per HMR update, even if parent reload events fire
  multiple times in a single cycle.

- **Child/parent reload timing aligned** (`hmr: align child component HMR reload
  with parent rerender`): child component HMR reloads are now synchronised with
  the parent rerender. Bus restoration in the shim happens after the full parent
  subtree settles — no stale handler snapshots during the reload window.

- **Setup effects preserved across HMR rerenders** (`runtime-vapor: preserve setup
  effects during hmr rerender`): watchers and computed effects created in `setup()`
  survive a hot-reload without requiring re-registration. Bus handlers registered
  via `watchEffect` inside a Vapor component's `setup()` no longer need to be
  re-registered after a hot reload.

- **HMR context restored on errors** (`runtime-vapor: restore hmr context on
  errors`): the shim's `dispose` handler now wraps bus persistence in `try/catch`.
  A failed `getCommandBus()` call mid-reload no longer leaves the module in an
  unrecoverable state — whatever was last stored in `globalThis` is kept intact.

- **App instance updated on root HMR reload** (`runtime-vapor: update app instance
  on root hmr reload`): when the root Vapor component hot-reloads, the `app`
  instance reference on that component is refreshed. Callers of
  `createVaporChamberApp()` no longer need to re-acquire the app reference after a
  root HMR cycle.

#### TransitionGroup (`transitions.ts`)

- **`onMove` not called for v-show-hidden children** (`transition: avoid move
  transition for hidden v-show group children`): before beta.14, Vue called `onMove`
  for TransitionGroup children hidden with `v-show` (i.e. `display:none`), causing
  invisible move animations. After beta.14, Vue's runtime skips the hook entirely
  for such elements — the `*Move` command is never dispatched. Handlers that guarded
  against spurious move events by checking element visibility can remove that check.

#### Custom elements (`chamber-vapor.ts` — `defineVaporCustomElement`)

- **No hook retention on shared definitions** (`custom-element: avoid retaining
  custom element hooks on shared definitions`): lifecycle hooks are no longer
  accumulated on the shared `options` object when the same reference is passed to
  multiple `defineVaporCustomElement()` calls. Hooks stay correctly scoped to each
  element instance.

- **Children update from reactive props** (`custom-element: update custom element
  children from reactive props`): Vapor custom elements now correctly re-render
  their children tree when reactive props change, fixing missing updates in shadow
  DOM subtrees.

#### Async components (`chamber-vapor.ts` — `defineVaporAsyncComponent`)

- **Props and slots forwarded to `loadingComponent`** (`runtime-vapor: pass props
  and slots to loadingComponent`): the loading placeholder now receives the same
  props and slots as the deferred component. Use this to render a skeleton that
  matches the final component's shape and slot structure.

- **SSR runtime alias exposed** (`vapor: expose async component alias for SSR
  runtime`): the async component output now declares an SSR alias, enabling correct
  tree-shaking of the async component chunk in SSR code-split builds.

#### Interop bridge (`chamber-vapor.ts` — `getVaporInteropPlugin`)

- **Bridge not mutated on app setup** (`runtime-vapor: avoid mutating shared interop
  bridge`): the plugin reference returned by `getVaporInteropPlugin()` is no longer
  modified by Vue's runtime during `createApp().use(plugin)`. The reference is safe
  to hold and reuse across multiple app instances and HMR cycles.

- **Interop slot wrappers cached** (`runtime-vapor: cache normalized interop slot
  wrappers`): slot wrapper normalization across the Vapor↔VDOM boundary is now
  memoised. Repeated boundary crossings in the same render cycle no longer allocate
  new wrapper functions per slot per render.

#### Vapor app root (`chamber-vapor.ts` — `createVaporChamberApp`)

- **Scope ID preserved on dynamic root updates** (`runtime-vapor: preserve scope id
  on dynamic root updates`): CSS scope IDs are now maintained when the root
  component updates dynamically, not only on initial mount. Scoped styles in
  mixed Vapor/VDOM trees remain correct across all root re-renders.

#### Async wrapper / scheduler

- **Error component creation aligned** (`runtime-vapor: align error component
  creation in async wrapper`): error components inside async wrappers (Suspense
  boundaries) now render consistently with VDOM behaviour; `useVaporAsyncCommand()`
  error state handling is unaffected at the command-bus level.

- **Scheduler job queue reset after flush** (`scheduler: reset job queue length
  after flush`): the Vapor scheduler correctly resets its internal job counter
  after each flush cycle. Async commands queued in burst patterns no longer
  accumulate stale queue-length state across flushes.

#### v-for fixes

- **Skip `updated` hooks on initial mount** (`runtime-vapor: skip v-for updated
  hooks on initial mount`): `onUpdated` no longer fires for v-for items during
  the initial mount pass. `defineVaporCommand` and `useVaporCommand` handlers
  wired to `onUpdated` inside v-for blocks will not fire prematurely on mount.

- **Component v-for avoids fast remove** (`runtime-vapor: avoid fast remove for
  component v-for`): component-level v-for no longer uses the fast-remove path,
  fixing cleanup ordering for `defineVaporCommand` / `useVaporCommand` registered
  inside v-for items. Dispose callbacks now run in the correct sequence relative
  to parent teardown.

- **Lazy destructure defaults** (`vFor: avoid eager evaluation of destructure
  defaults`): destructure defaults in v-for item patterns are evaluated lazily.
  No impact on command handlers; aligns compiled template output with expected
  JavaScript semantics.

### Performance baselines (v1.5.0, 2026-06-05)

Run on Apple Silicon dev machine, Vue beta.14 devDep installed.

**Reactive signal paths** *(beta.14 — confirmed bench run)*

| path (isolated scalar write loop) | ops/sec | note |
|---|---|---|
| plain `{ value }` fallback | ~372,000 | not reactive; fastest |
| **Vue `shallowRef` via `signal()`** (v1.5.0 default) | **~40k–62k** | ~4–7× the deep `ref()` it replaced; ~4–6× the alien adapter (run-dependent) |
| alien-signals `configureAlienSignals` | ~10,400 | opt-in, non-Vue contexts |
| Vue deep `ref()` (old v1.4 `signal()` default) | ~9,000 | replaced by shallowRef |
| `effectScope` + `onScopeDispose` only | ~173,000 | **+9%** vs beta.13 (scheduler flush fix) |
| `effectScope` + reactive signal + scope | ~21–26k | +2% (within noise) |
| `useCommandState` 100 dispatches (real path) | ~2,050 | bus dispatch dominates; signal cost masked here |

Key finding: two separate effects. (a) beta.14's scheduler flush fix ("reset job queue length
after flush") gives ~+9% on `effectScope` lifecycle. (b) v1.5.0's `signal()` → `shallowRef`
switch makes the auto-detected Vue path ~4–7× faster on isolated scalar writes (~40–62k across
runs vs the old deep-`ref()` ~9k; absolute is machine-state sensitive, ratio is the robust claim)
— so the earlier "alien-signals and Vue `ref()` have converged to ~9–10k" claim is **obsolete**:
`signal()` (shallowRef) is now several× the `configureAlienSignals` adapter.
`configureAlienSignals` is for non-Vue contexts, not a throughput upgrade. NOTE: the isolated
scalar figure (~62k) is signal-write cost only; end-to-end through the bus the scalar gain is
~+12% and the array gain ~+245% (dispatch dominates) — see `tests/signal-shallow-ab.test.ts`.

**Transition bridge** *(beta.14 improvements confirmed)*

| bench | hz | delta vs beta.13 |
|---|---|---|
| all 9 hooks × 1k sequences | 776 | **+9%** |
| onMove only × 10k | 1,096 | **+8%** |
| onEnter + onLeave × 5k | 1,022 | **+4%** |
| raw `bus.dispatch` overhead delta | 1,904 | **+8%** |

All transition bridge paths improved ~4–9% in beta.14, attributable to the scheduler
flush fix. Note: `onMove` baseline reflects the beta.14 v-show fix — the hook is no
longer called for hidden TransitionGroup children, so production hot paths with mixed
visible/hidden lists will see fewer calls than this bench measures (bench uses all-visible elements).

## v1.4.0 — Vue 3.6.0-beta.13 alignment

### Changed

- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.13"`.

### Vue 3.6.0-beta.13 alignment

#### TransitionGroup (`transitions.ts`)

- **`onMove` now fires for Vapor component moves** (`runtime-vapor: animate vapor
  component moves in TransitionGroup`): `onMove` was silently skipped when a
  Vapor component was repositioned inside a Vapor `<TransitionGroup>`. The hook
  now fires correctly — `createTransitionBridge` and `useTransitionCommand`
  dispatch the `*Move` command as expected.

- **`onMove` now fires for VDOM component moves** (`runtime-vapor: animate vdom
  component moves in vapor TransitionGroup`): the same class of bug affected VDOM
  components inside a Vapor `<TransitionGroup>`. Both cases are now fixed in
  Vue's runtime; wrappers here are pass-through.

- **`onMove` fires after child updates flush** (`runtime-vapor: defer
  TransitionGroup moves until child updates flush`): move hooks are deferred until
  all child update jobs complete before `onMove` is called. The dispatched command
  receives `el` in its settled pre-move position — safe to read final layout.

- **Transition hooks on slot fallbacks** (`runtime-vapor: apply transition hooks
  to slot fallbacks`): transition lifecycle hooks now apply to slot fallback
  children inside Vapor components. Commands wired to `onBeforeEnter`/`onLeave`
  etc. fire correctly when a fallback slot transitions.

- **v-for item keys preserved** (`runtime-vapor: preserve v-for item keys in
  transition group`): keys assigned to v-for items are maintained through
  TransitionGroup reorders, preventing identity mismatches during animated list
  updates. No wiring change needed.

#### Interop / Vapor roots (`chamber-vapor.ts`)

- **CSS scope IDs on Vapor roots** (`runtime-vapor: apply interop scope ids to
  vapor roots`): Vapor app roots created with `createVaporChamberApp()` and
  Vapor components mounted via the interop plugin now correctly inherit CSS scope
  IDs from parent VDOM components. Scoped styles no longer leak or go missing in
  mixed Vapor/VDOM trees.

- **v-once respected in VDOM slot interop** (`runtime-vapor: respect v-once in
  vdom slot interop`): VDOM slot content marked `v-once` no longer re-evaluates
  after crossing into a `defineVaporComponent()`. Slot prop snapshots are also
  preserved (`runtime-vapor: preserve v-once slot prop snapshots`,
  `runtime-vapor: snapshot v-once slot inputs`).

- **v-once for slot fallback children** (`runtime-vapor: preserve v-once
  semantics for slot fallback children`): `v-once` semantics are now consistently
  applied to slot fallback content in Vapor components. All wrappers in this
  library are pass-through.

#### SSR / Hydration (`ssr.ts`)

- **No stale DOM on mismatch** (`runtime-vapor: avoid preserving stale element
  mismatch content`): Vue's hydration recovery no longer retains wrong DOM nodes
  when server and client markup diverge. `rehydrate()` results are more reliable
  after a mismatch.

- **Namespace preserved during recovery** (`runtime-vapor: preserve namespace
  during hydration recovery`): SVG and MathML namespace context is maintained
  when Vue recovers from hydration errors. No impact on command-level replay.

- **Allowed prop mismatches respected** (`runtime-vapor: respect allowed prop
  mismatches during hydration`): expected prop differences (e.g. `data-v-inspector`
  in dev) no longer trigger spurious hydration warnings. The `ignoreUnhandled`
  option is unaffected.

- **Teleport ranges excluded from sibling walk** (`runtime-vapor: skip teleport
  ranges for logical hydration siblings`): Teleport boundaries are correctly
  skipped during logical sibling traversal, preventing command replay ordering
  issues in apps that use `<Teleport>` with SSR.

- **Static hydration target validation in dev** (`runtime-vapor: validate static
  hydration targets in dev`): dev builds now assert that static element targets
  exist before hydrating, surfacing markup errors earlier. Safe for `rehydrate()`
  callers — command dispatch happens after DOM is ready.

### Performance

Beta.13 ships a large batch of compiler and runtime optimizations that benefit
vapor-chamber consumers automatically — no code changes required.

#### `tryAutoCleanup` / composable lifecycle cost (`chamber.ts`)

`runtime-vapor: only create lifecycle update jobs when needed` — lifecycle update
jobs are now created lazily. Every vapor-chamber composable calls `tryAutoCleanup`
→ `onScopeDispose`, which previously caused an update job to be allocated per
component even when no reactive signals were consumed. In beta.13, components that
use vapor-chamber purely for dispatch (no signals read in the template) incur zero
update-job overhead.

#### `useCommandState` coalesced writes (`chamber.ts`)

`runtime-vapor: specialize v-for block operations` and `runtime-vapor: reduce v-if
branch scope overhead` — signal writes flushed by `{ coalesce: true }` now land
into faster Vapor runtime patch paths. v-for list updates dispatch less overhead
per item; v-if branches around state-driven conditionals have reduced scope
allocation.

#### `useTransitionCommand` v-bind spread (`transitions.ts`)

`compiler-vapor: expand object literal v-bind and v-on` — object literal spreads
are expanded inline at compile time instead of spread at runtime. The canonical
`<Transition v-bind="t">` / `<TransitionGroup v-bind="t">` pattern now produces
cheaper compiled output; the hook object keys are statically known at the call
site.

`runtime-vapor: avoid duplicate TransitionGroup props resolution` — `<TransitionGroup>`
no longer resolves its own props twice per render cycle. Applies to all
TransitionGroup instances, including those bound via `useTransitionCommand`.

#### `defineVaporComponent` compiled output (`chamber-vapor.ts`)

`vapor: encode template options as flags` — `emits`, `inheritAttrs`, and other
template-level options are encoded as bit flags rather than objects at compile
time. Components wrapped with `defineVaporComponent()` parse options faster.

`compiler-vapor: inline static component literal props` — static props passed at
the call site are inlined by the compiler rather than allocated as runtime objects
per render.

`vapor: lower single-use asset component resolves` — a component used exactly once
in a template no longer goes through `resolveComponent()` at runtime; the compiler
emits a direct reference. Most `defineVaporComponent()` usages in leaf templates
qualify.

`compiler-vapor: use onBinding helper for reactive events` and `vapor: move event
invoker wrapping into runtime helpers` — event handlers use shared runtime helpers
instead of per-element closures. Vapor components with event bindings generate
less code and allocate fewer closures.

#### Directives (`directives.ts`)

`vapor: move event invoker wrapping into runtime helpers` — VDOM components that
use `v-vc:command` now share a single invoker wrapper per action type rather than
one closure per element in compiled output.

### Performance baselines (v1.4.0, 2026-05-28)

New benchmark groups added to `tests/perf.bench.ts` covering surfaces affected
by beta.13 optimizations. Run `npm run bench` to reproduce.

**Transition bridge (`createTransitionBridge`)** *(two-run average)*

| bench | run 1 | run 2 | avg | mean |
|---|---|---|---|---|
| all 9 hooks × 1k sequences | 709 hz | 717 hz | 713 hz | 1.40ms / 1k |
| onMove only × 10k *(beta.13 baseline)* | 1,067 hz | 969 hz | 1,018 hz | 0.98ms / 10k |
| onEnter + onLeave × 5k | 1,000 hz | 969 hz | 984 hz | 1.02ms / 5k pairs |
| raw `bus.dispatch` × 10k *(overhead delta)* | 1,750 hz | 1,764 hz | 1,757 hz | 0.57ms / 10k |

Bridge overhead vs bare dispatch: ~37ns/call (`dispatchSafe` try/catch).
The `onMove` baseline is new — this path was silently skipped in Vapor before beta.13.
`onMove` shows higher run-to-run variance (±6% vs ±0.4% for raw dispatch) due to
the try/catch block inhibiting V8 inlining under GC pressure — expected behaviour.

**`useCommandState` immediate vs coalesced** *(two-run average)*

| bench | run 1 | run 2 | avg |
|---|---|---|---|
| immediate — 10 array appends | 20,188 hz | 20,507 hz | 20,347 hz |
| coalesced — 10 array appends | 19,767 hz | 19,715 hz | 19,741 hz |
| immediate — 100 array appends | 1,934 hz | 2,090 hz | 2,012 hz |
| coalesced — 100 array appends | 2,015 hz | 2,090 hz | 2,052 hz |
| immediate — 100 counter | 2,015 hz | 2,073 hz | 2,044 hz |
| coalesced — 100 counter | 1,875 hz | 2,098 hz | 1,986 hz |

`{ coalesce: true }` is neutral across all cases — both array and scalar types
stay within noise of immediate mode across two independent runs. The earlier
single-run finding of "no win for scalars" was within measurement variance.
Rule of thumb: use coalesced when you want to guarantee ≤1 signal write per
microtask burst (correctness reason), not for a throughput win. Throughput is
equivalent; the benefit is fewer Vue re-renders per rapid dispatch burst.

**Vue reactive integration — beta.13 actual signal cost (vue@3.6.0-beta.13 devDep)**

Previous bench runs had no Vue installed — `signal()` fell back to plain
getter/setter objects and `tryAutoCleanup` never hit `onScopeDispose`. These
numbers reflect the real reactive path with Vue beta.13.

| bench | hz | note |
|---|---|---|
| plain closure getter/setter 10k writes *(baseline)* | 2,542 hz | what all prior benches were measuring |
| Vue ref (alien-signals) 10k writes | 9,647 hz | **3.8× faster** than plain fallback |
| effectScope + onScopeDispose only × 1k | 165,559 hz | beta.13 lazy job — no update job allocated |
| effectScope + signal + onScopeDispose × 1k | 22,027 hz | full reactive scope path |
| useCommandState 100 dispatches — Vue ref | 1,902 hz | ~7% vs 2,044 hz without Vue |
| useCommandState coalesced 100 dispatches | 1,897 hz | identical to immediate (confirmed) |

Three findings:

**alien-signals writes are 3.8× faster than the plain fallback.** The closure
getter/setter fallback (`let _v; get value() { return _v; }`) forces V8 through
scope-chain lookup and property descriptor dispatch. alien-signals uses a plain
internal object that V8 can fully inline. Users running without Vue are not
getting "cheaper" signals — they're getting slower ones.

**beta.13 lazy lifecycle jobs confirmed.** `effectScope + onScopeDispose` with
no reactive state runs at 165k hz — no update job is allocated. The cost only
appears when reactive state is actually tracked inside the scope (22k hz for
the full path). Every `tryAutoCleanup` call in a dispatch-only component (no
signal reads in the template) now costs nothing in terms of update jobs.

**useCommandState overhead from alien-signals tracking: ~7%.** The full path
(dispatch → handler → `state.value = newValue` through alien-signals) costs
~7% more than plain object writes — entirely from dependency tracking bookkeeping.
This is the true cost paid per reactive state update in a real app.

### Refactors (v1.4.0)

Three runtime changes driven by bench findings with Vue beta.13 and alien-signals
installed. All are internal — no public API changes, no behavior changes for
existing consumers.

**`src/signal.ts` — plain `{ value }` object fallback**

Replaced the closure getter/setter fallback (`let _v; { get value(), set value() }`)
with a plain `{ value: initial }` object. Getter/setter descriptors force V8 through
a function call on every read/write; a plain data property has zero indirection.
The improvement is an upper bound in synthetic benches (V8 DCEs dead writes) but
the lack of function-call overhead is real in all paths.

**`src/alien-signals.ts` — class-based `AlienSignalWrapper`**

Replaced the `alienSignalAdapter` return value (object literal with getter/setter)
with a `class AlienSignalWrapper<T>`. Classes give V8 a stable hidden class for all
wrapper instances — monomorphic inline caches at every `.value` access site across
the reactive graph.

**`package.json` — `alien-signals` promoted to `dependencies`**

Moved from `devDependencies` to `dependencies`. Consumers using
`configureAlienSignals` no longer need a separate `npm install alien-signals`.
alien-signals is **not** auto-bundled in `signal.ts` — it only enters your bundle
when you explicitly call `configureAlienSignals`. Bundle impact: zero for consumers
who don't use it; the `vapor-chamber/alien-signals` sub-path entry stays opt-in.

---

**Regression check — v1.3.0 → v1.4.0**

The table below uses two independent bench runs to confirm no regression in core
dispatch throughput against v1.3.0 baselines. The signal.ts and alien-signals.ts
changes are internal-only and do not affect the dispatch hot path.

| bench | v1.3.0 recorded | v1.4.0 run 1 | v1.4.0 run 2 | Δ vs v1.3.0 |
|---|---|---|---|---|
| syncDispatch bare | 2,259 hz | 2,231 hz | 2,213 hz | -2% — noise |
| syncQuery bare | 2,393 hz | 2,374 hz | 2,377 hz | -1% — noise |
| bus.emit 3 listeners | 4,640 hz *(v1.2.x)* | 4,618 hz | 4,717 hz | flat |
| fast-lane compile+dispatch | 25,400 hz *(v1.2.x)* | 28,584 hz | 28,763 hz | **+13%** — JIT/session variance |
| bus.dispatch bare | ~700 hz *(v1.2.x, pre-opt)* | 1,801 hz | 1,827 hz | **+160%** — cumulative v1.2–v1.3 opt |
| rehydrate 1k | *(not recorded)* | 13,888 hz | 14,355 hz | — |
| rehydrate 1k ignoreUnhandled | *(not recorded)* | 97,113 hz | 100,290 hz | — |
| persist coalesced 100 | *(not recorded)* | 103,162 hz | 104,735 hz | — |
| asyncDispatch bare | *(not recorded)* | 3,000 hz | 3,387 hz | — |

No regressions. The `bus.dispatch` +160% reflects cumulative optimisations from
v1.2.x–v1.3.0 (bare-bus fast path, `stampMeta` simplification, FIFO prefix-cache
eviction) — not a v1.4.0 change. Two-run spread on all rows is within ±5%,
consistent with normal JIT and OS scheduling variance.

**Comparative emit fan-out — v1.2.x recorded vs v1.4.0 (two-run, peer library versions may differ)**

| peer | v1.2.x recorded | v1.4.0 run 1 | v1.4.0 run 2 | note |
|---|---|---|---|---|
| vapor-chamber bus.emit 3 listeners | 4,640 hz | 4,662 hz | 4,694 hz | flat |
| mitt | 2,550 hz | 3,312 hz | 3,357 hz | +31% — likely mitt version bump |
| nanoevents | 5,620 hz | 6,484 hz | 6,622 hz | +18% — likely nanoevents version bump |
| eventemitter3 | *(not recorded)* | 6,224 hz | 6,341 hz | — |
| tiny-emitter | *(not recorded)* | 2,278 hz | 2,288 hz | — |
| rxjs Subject | *(not recorded)* | 2,424 hz | 2,394 hz | — |
| raw Map+Set baseline | *(not recorded)* | 5,529 hz | 5,539 hz | — |

vapor-chamber's own emit throughput is flat and consistent across runs.
Peer library improvements reflect their own version upgrades between bench sessions.
Run-to-run variance across both sessions is ≤2% for all peers except rxjs (±1.2%).

---

## v1.3.0 — Vue 3.6.0-beta.12 alignment

### Changed

- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.12"`.

### Vue 3.6.0-beta.12 alignment

- **Error recovery in Vapor setup**: Vue now restores component context,
  fallthrough prop state, and render effect state after `setup()` throws.
  Wrappers (`createVaporChamberApp`, `defineVaporComponent`,
  `useVaporAsyncCommand`) are pass-through — consumers receive the fix
  automatically on upgrade.

- **VDOM slots interop**: `runtime-vapor` normalizes and exposes VDOM slots
  during interop, and no longer retains interop state from emits.
  `getVaporInteropPlugin()` passes through unchanged — mixed Vapor/VDOM trees
  pick up these fixes with no code changes.

- **SSR unresolved tag fallback**: `server-renderer` now renders unresolved tags
  as elements rather than failing. The `rehydrate()` function's `ignoreUnhandled`
  option already handles the command-bus side — this Vue fix covers the
  server-render side symmetrically.

- **Deferred fragment hydration anchors**: anchor preservation for deferred
  fragment hydration is now correct. Applications using `rehydrate()` inside
  Vapor fragments benefit without any vapor-chamber changes.

- **v-for item scope detach** (perf): Vapor's runtime detaches v-for item scopes
  on removal, preventing scope retention. `useCommandState` arrays used in v-for
  benefit from reduced scope overhead on item removal.

- **Static class fast path** (perf): Vapor's compiler emits a fast path for
  static class strings, lowering DOM update cost per render cycle.

### New

- **`useCommandState` coalesce option** (`chamber.ts`): New `{ coalesce: true }`
  third argument accumulates state mutations from synchronous dispatches and
  flushes the signal once per microtask via `queueMicrotask`. Pairs with
  beta.12's v-for source coalescing — the signal write is deferred, Vue's runtime
  coalesces the resulting DOM update into one pass. 10 rapid `dispatchBatch` items
  → 1 signal write instead of 10. Default: `false` (immediate write, unchanged).

  ```ts
  const { state } = useCommandState(
    [] as Item[],
    { append: (s, cmd) => [...s, cmd.target] },
    { coalesce: true }, // flush once per microtask burst
  );
  ```

### Performance

- **`syncQuery` bare-bus fast path** (`command-bus.ts`): `bus.query()` now skips
  the plugin runner and hook walk when the bus has no plugins, after-hooks, or
  listeners — matching the existing optimization in `bus.dispatch()`. CQRS read
  calls on a bare bus hit the handler directly with no indirection. Bench
  confirms `syncQuery` bare (2,393 hz) now matches `syncDispatch` bare (2,259 hz).

### Internal

- **`stampMeta` signature simplified** (`command-bus.ts`): Changed from
  `stampMeta({ action, target, payload })` to `stampMeta(payload)` — `action`
  and `target` were never read inside the function. Eliminates a temporary
  object at all 9 call sites.

- **`_prefixCache` FIFO eviction** (`command-bus.ts`): On overflow, the wildcard
  prefix cache previously called `Map.clear()`, wiping all 256 entries. Now
  evicts only the oldest entry (`Map` insertion order), keeping the cache warm.

- **`getCurrentScope()` in `tryAutoCleanup`** (`chamber.ts`): Replaced the
  `try { onScopeDispose(fn) } catch {}` pattern with `if (getCurrentScope())`.
  The unreachable `onUnmounted` fallback (dead code under Vue ≥ 3.5) is removed.
  `tryKeepAliveHooks` simplified the same way using `getCurrentInstance()`.

- **`command-bus.ts` — 10 duplicate sync/async functions collapsed to shared
  implementations.** Both buses now call the same underlying functions:
  `register`, `on`, `once`, `offAll`, `addHook`, `clearState`, `inspect`.
  `syncRegister` and `asyncRegister` were byte-for-byte identical at runtime
  (type annotations only differed) — merged into a single `register`.
  `asyncClear` shared 8 of 10 lines with `syncClear` — common body extracted
  to `clearState`. Both bus factories shared the same 12-line inspection object
  — extracted to `inspect()`.

- **`plugins-extra.ts`** — Four identical `matchesActions` closures (one per
  plugin) replaced by a single module-level `makeActionFilter(patterns)` factory.

- **`plugins-io.ts`** — Local `matchesRetryActions` deleted; `matchesPattern`
  imported from `command-bus` instead (which additionally has prefix caching).

- **`plugins-core.ts`** — `debounce` and `throttle` were building throttle keys
  with `JSON.stringify(cmd.target)` (no key-sort, no circular-ref safety).
  Replaced with `commandKey(cmd.action, cmd.target)` which sorts keys for stable
  output and handles circular references.

- **`transports.ts`** — Local `matchesActions` wrapper and `abortResultForBridge`
  deleted. Both replaced by imports: `matchesPattern` (inline) and
  `abortedResult` (now exported `@internal` from `command-bus.ts`).

- **`chamber.ts` / `chamber-vapor.ts`** — `useCommand.dispatch`,
  `useVaporCommand.dispatch`, and `useCommandQuery.query` shared the same
  20-line loading/error wrapper. Extracted to `runDispatch(busCall, loading,
  lastError, onSuccess?)` in `chamber.ts`, imported by `chamber-vapor.ts`.

### Bundle sizes (min / brotli / gzip)

| variant | v1.2.0 | v1.3.0 |
|---|---|---|
| full    | 32 KB / 8.7 KB / 9.8 KB | 33.7 KB / 9.9 KB / 11.1 KB |
| core    | 23 KB / 6.1 KB / 6.8 KB  | 23.0 KB / 6.7 KB / 7.5 KB  |
| elements| 24 KB / 6.4 KB / 7.2 KB  | 24.4 KB / 7.1 KB / 7.9 KB  |

Net size increase over v1.2.0 is from new features (`useCommandState` coalesce,
`runDispatch`, `getCurrentScope` detection). The internal refactoring offset
~1.1 KB raw across all variants.

### Tests

- New `tests/plugins-extra.test.ts` — 30 cases covering `cache`,
  `circuitBreaker`, `rateLimit`, and `metrics` (previously 0% coverage).
- New `tests/utilities.test.ts` — 17 cases covering `createChamber`,
  `createWorkflow`, and `createReaction` (previously 0% coverage).
- Targeted additions to `tests/chamber.test.ts` — `useCommandState` coalesce
  mode, `useCommandHistory` undo handler invocation and error recovery.
- Targeted additions to `tests/command-bus.test.ts` — `configureUid`,
  `syncQuery` bare-bus fast path, `offAll` with wildcard pattern, async batch
  mid-flight abort.

## v1.2.0 — Vue 3.6.0-beta.11 alignment

### Changed

- **Build pipeline migrated to Vite** (`scripts/build.mjs`). Replaces the custom
  esbuild IIFE script and tsc JS emit with a single orchestrator using Vite's
  programmatic API. Rollup tree-shaking + multi-entry library mode in one pass.
  `tsc` now emits types only (`emitDeclarationOnly: true`).
- **IIFE bundle split into three audience-based variants.** Variants reflect
  *deployment shapes*, not Vue feature axes — split by who is consuming the
  bundle, not by which Vue API happens to be inside.
  - `core` — sprinkled JS on server-rendered pages (Blade / Rails / Django /
    .NET MVC / WordPress). Bus + HTTP transport + lightweight plugins
    (logger, validator, debounce, throttle, retry, authGuard) + `connect()`
    one-liner with auto-CSRF.
  - `elements` — embeddable widgets via custom elements. Everything in `core`
    plus `defineVaporCustomElement` and a `defineWidget(tag, options)` helper.
  - `full` — kitchen sink for SPAs. Everything in `elements` plus realtime
    transports (WebSocket / SSE), heavy plugins (persist, sync, history,
    optimistic), `mount()`, and the full Vapor composables surface.

  New audience-specific helpers `connect()` (CORE/ELEMENTS/FULL) and
  `defineWidget()` (ELEMENTS/FULL) are also exposed in larger variants so the
  same call site works regardless of which bundle is loaded.

  Sub-path exports: `vapor-chamber/iife`, `/iife-core`, `/iife-elements`.

  Measured sizes (v1.2.0, min / brotli q=11 / gzip -9):
  - core: 23 KB / 6.1 KB / 6.8 KB
  - elements: 24 KB / 6.4 KB / 7.2 KB
  - full: 32 KB / 8.7 KB / 9.8 KB

  **Variant contents are not under semver before v2.0** — see ROADMAP.md.
  ESM consumers (the main entry) get the full surface and obey strict semver.
- **peerDependencies** bumped to `vue: ">=3.5.0 || >=3.6.0-beta.11"`.

### Documented

- `defineVaporComponent` JSDoc now describes Vue 3.6.0-beta.11 alignment:
  generics + runtime props inference (Vue PR #14770), and the emits-vs-attrs
  split (declared `emits` listeners are excluded from `$attrs`). The wrapper
  forwards `options` unchanged so both behaviors flow through to Vue.

### Tests

- New regression test asserting `defineVaporComponent` passes options through
  unmodified — locks in the emits/attrs and generics flow-through.
- New IIFE bundle smoke test asserting the three variants ship the expected
  exports (and don't accidentally bloat with unwanted ones).
- New SSR rehydrate benchmarks (`tests/perf.bench.ts`) at 10 / 100 / 1000
  command scales, plus the ignoreUnhandled skip path. Locks the lib's replay
  cost so any regression is visible regardless of Vue version. (Vue's
  beta.11 hydration fast path is orthogonal — it speeds Vue's part of SSR,
  not command replay.)

### Performance

- **`signal` extracted into a side-effect-free `src/signal.ts` module.** The
  minimal signal API (lazy sync `globalThis.__VUE__` probe + plain fallback
  + `configureSignal()`) lives standalone with no module-load side effects.
  `chamber.ts` re-exports it for backward compat and pushes Vue's `ref()`
  into it via `configureSignal()` once its async probe completes.
  - `transports.ts` and `form.ts` now import `signal` from `./signal`,
    breaking their transitive dependency on `chamber.ts`'s Vapor-detection
    registry (the module-load `probeVue()` side effect, ~9 Vue API probes,
    `defineVaporCustomElement` / `defineVaporAsyncComponent` references,
    `waitForVueDetection` machinery).
  - **Result:** every ESM consumer using transports/form/plugins without
    Vue composables ships a smaller bundle. Measured against a typical
    Blade scenario (`createCommandBus` + `createHttpBridge` + `logger`):
    bundle dropped from ~6.2 KB brotli to **5.7 KB brotli (~9% reduction,
    535 bytes saved)**, with zero remaining references to `probeVue`,
    `_vueOnScopeDispose`, `defineVaporCustomElement`, `applyVueModule`, or
    `waitForVueDetection` in the consumer output. Public API unchanged.
- **Listener bucketing in core.** `on()` / `once()` listeners are now split
  between `exactListeners: Map<action, Listener[]>` (O(1) lookup on the
  dispatch hot path) and `wildcardListeners: Array<{pattern, listener}>`
  (walked with `matchesPattern` only when wildcards exist). The split is
  internal — no API change. Measured against the 5k-dispatch × 55-listener
  bench:
  - dispatch: 415 → 466 ops/sec (**+12%**)
  - emit: 403 → 507 ops/sec (**+26%**)
  Real-world wins scale with listener count: silent at 3 listeners, larger
  beyond ~50.
- **`persist` plugin gains opt-in `coalesce: true`.** Collapses back-to-back
  `getState()` + `JSON.stringify()` + `setItem()` cycles within one microtask
  burst into a single save. Use when many rapid commands touch the same
  state (form input, scroll tracking, batched cart updates). Trade-off: 1
  microtask of save latency. Measured against the 100-dispatch × 50-item
  array bench: 3,300 → 28,887 ops/sec (**8.75×**). Default behavior unchanged
  (per-dispatch save).
- **Default `meta.id` generator swapped from `crypto.randomUUID()` to a
  counter + per-process random prefix.** Command IDs are correlation tokens,
  not security tokens — uniqueness across one process is sufficient for tracing
  and observability. Measured 2.26× speedup on the 10k-dispatch hot path
  (default 1460 ops/sec vs randomUUID 645 ops/sec on the dev machine).
- **`configureUid(fn)` exported** — opt-in to `crypto.randomUUID` (or any
  custom generator) for distributed tracing or cross-process auditing use cases.
- Verified `okResult` / `errResult` / `stampMeta` / `AsyncState` already
  produce monomorphic hidden classes — the existing code is V8-aligned. No
  changes needed beyond the uid swap.

### Infrastructure

- **CI/CD pipeline** added at [.github/workflows/ci.yml](./.github/workflows/ci.yml).
  Test matrix runs typecheck, lint, full test suite (559 tests), build, and
  size budget guard on Node 20.19 + Node 22, on Linux + macOS. A separate
  `bench smoke` job runs `vitest bench` and uploads the result as an artifact
  for trend tracking.
- **Biome config** ([biome.json](./biome.json)) replaces the absence of a
  linter. Tuned to match the project's existing style (no auto-format
  pass — formatter disabled to avoid touching every file). Three new
  scripts: `npm run lint` (auto-fix), `npm run lint:check` (CI), and
  `npm run typecheck` (tsc --noEmit).
- **`scripts/check-size.mjs`** — bundle-size budget guard. Fails if any IIFE
  variant exceeds its raw or brotli budget. Locks v1.2.0 sizes so future
  changes can't silently regress the headline numbers. Bumping budgets
  requires an explicit edit + CHANGELOG note. Wired as `npm run size:check`
  and into `prepublishOnly`.
- **`tests/esm-treeshake.test.ts`** — bundles a synthetic Blade-style consumer
  (`createCommandBus` + `createHttpBridge` + `logger`) and asserts the bundle
  stays under 6.5 KB brotli with zero leaked references to `probeVue`,
  `applyVueModule`, `defineVaporCustomElement`, `defineVaporAsyncComponent`,
  `defineVaporComponent`, `waitForVueDetection`, or `_vueOnScopeDispose`.
  Locks the v1.2.0 signal-extraction win — if a future side-effect import
  drags chamber.ts back into transports/plugins consumers, this test fires.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — dev setup, project layout,
  workflow, performance-work expectations ("only ship perf changes that
  benches confirm"), release process.
- **[SECURITY.md](./SECURITY.md)** — supported version policy, vulnerability
  reporting via GitHub Security Advisories, response timeline (≤72h ack,
  ≤30d patch for high/critical), in-scope and out-of-scope items.
- **Issue + PR templates** — bug report, feature request, and PR templates
  under `.github/`. PR template includes the perf-bench requirement and a
  CHANGELOG-entry slot.
- **`prepublishOnly`** now runs the full quality pipeline: typecheck → lint
  → tests → build → size guard. No accidental publishes with broken builds
  or oversized bundles.

### AbortController integration (async bus + HTTP bridge)

Cancelable async dispatches landed in v1.2.x with a tight scope:

- **`asyncBus.dispatch(action, target, payload, { signal })`** — 4th arg is
  an optional `DispatchOptions`. Backward compatible (existing 3-arg call
  sites work unchanged).
- **`Command.signal: AbortSignal | undefined`** — handlers can read
  `cmd.signal.aborted` or attach `cmd.signal.addEventListener('abort', …)`
  to short-circuit work mid-flight.
- **Pre-flight abort:** if `signal.aborted` at dispatch time, the bus skips
  the handler entirely and resolves with `{ ok: false, error }`. The error
  is the explicit reason if the user passed one (`ac.abort(new MyError())`),
  otherwise a `BusError('VC_CORE_ABORTED', …)` so consumers can switch on
  `error.code`. Added `VC_CORE_ABORTED` to the `BusErrorCode` union.
- **HTTP bridge auto-propagation:** `createHttpBridge()` now merges
  `cmd.signal` with any bridge-level `signal` / `scopeController` via
  `AbortSignal.any()` (with a fallback for older runtimes). Consumers no
  longer need to thread the signal through the bridge config — pass it at
  the call site and the fetch picks it up.
- **After-hooks fire** for aborted dispatches so loggers / metrics see the
  aborted command. Observability stays intact regardless of cancellation.

### Sync bus accepts but ignores `{ signal }`

The sync `CommandBus.dispatch` signature accepts the 4th `DispatchOptions`
arg for type compatibility with `AsyncCommandBus`, but the signal is ignored
at runtime — sync dispatches are atomic and not cancelable. Pass a signal
here only if you also use the async bus and want a uniform call site.

### Test coverage gate

CI now enforces a coverage floor via [vitest.config.ts](./vitest.config.ts)
+ a `test:coverage` step in [.github/workflows/ci.yml](./.github/workflows/ci.yml).
Current floor:

| Metric     | Threshold |
|------------|-----------|
| lines      | 75%       |
| functions  | 80%       |
| branches   | 65%       |
| statements | 73%       |

Set ~1–2 points below current measured coverage — acts as a real floor
without tightening on trivial test additions. Tightens over time as
coverage improves; only loosened with an explicit CHANGELOG note.

**Excluded** (covered indirectly or not unit-testable):
- `index.ts`, `plugins.ts` — pure re-export aggregators
- `iife*.ts` — namespace builders; underlying surface tested elsewhere
- `vite-hmr.ts` — Vite plugin (real Vite server required)
- `testing.ts` — test-only utility (would test the test helper)
- `devtools.ts`, `directives.ts` — require real Vue runtime

**Known gaps for follow-up** (reflected in the floor, not hidden):
- `plugins-extra.ts` — 0% (cache, circuitBreaker, rateLimit, metrics)
- `utilities.ts` — 0% (createChamber, createWorkflow, createReaction)

### `emitDOMEvent` — bridge widget events to host pages

Vue's component `emit(...)` goes through Vue's event system; it does NOT
bubble out as a real DOM event. For embeddable widgets that need to
communicate with the surrounding page (e.g. a `<cart-bubble>` notifying
its container that a product was added), the new `emitDOMEvent(el, name,
detail, options?)` helper dispatches a real `CustomEvent` so host pages
can `addEventListener` on the widget tag.

```ts
// In a widget
VaporChamber.defineWidget('cart-bubble', {
  setup() {
    return () => h('button', {
      onClick: (e) =>
        VaporChamber.emitDOMEvent(e.target.getRootNode().host, 'cart-added', { sku: 'X' })
    }, 'Add');
  }
});

// On the host page
document.querySelector('cart-bubble').addEventListener('cart-added', (e) => {
  console.log(e.detail.sku);   // 'X'
});
```

Defaults: `bubbles: true`, `composed: true` (the latter escapes shadow DOM
so events reach light-DOM listeners on the host). Options override per
call.

Exposed in `elements` and `full` IIFE namespaces. 8 tests in
[tests/emit-dom-event.test.ts](./tests/emit-dom-event.test.ts) cover
every-type detail, preventDefault behavior, missing-CustomEvent fallback,
null-element defensive return, options overrides.

**Pattern adapted from
[vue-custom-element](https://github.com/karol-f/vue-custom-element)'s
`customEmit` helper** (Karol-F, MIT). vue-custom-element predates Vue 3.6
Vapor by years, but the underlying gap (Vue emit ≠ DOM event) still
exists today and the helper shape is timeless. The rest of
vue-custom-element's surface (string→typed-prop coercion, slot handling,
shadow-DOM strategy, async loading, disconnect cleanup) is now native to
Vue 3.6's `defineVaporCustomElement` — no other harvest needed.

**Particularly relevant for Laravel integration.** Laravel projects
typically have multiple coexisting reactive layers (Blade + Alpine +
Livewire + Filament). vapor-chamber widgets are none of those — they're
Vue Vapor — so they need an interop primitive that doesn't couple to any
specific layer. `emitDOMEvent` is that primitive: a widget dispatches a
`CustomEvent`, and any of Alpine's `@event.window`, Livewire 3's
`#[On('event')]`, or vanilla `addEventListener` can pick it up. New
section in [docs/integrations/laravel.md](./docs/integrations/laravel.md)
("Widget ↔ Livewire / Alpine / Blade event bridging") shows the four
patterns: Blade+Alpine, Livewire 3, Filament panel widget, vanilla DOM.

### `vapor-chamber/alien-signals` — connector for non-Vue contexts

[src/alien-signals.ts](./src/alien-signals.ts) — a tiny adapter that bridges
[alien-signals](https://github.com/stackblitz/alien-signals)' function-call
API (`s()` / `s(value)`) to vapor-chamber's `.value`-style `Signal`
interface.

```ts
import { signal as alienSignal } from 'alien-signals';
import { configureAlienSignals } from 'vapor-chamber/alien-signals';

configureAlienSignals(alienSignal);

// Every vapor-chamber signal() — including useCommand, useSharedCommandState,
// FormBus signals — is now backed by alien-signals' push-pull propagation.
```

**Why ship this:** Vue 3.6's `ref()` is itself a port of alien-signals
([vuejs/core#12349](https://github.com/vuejs/core/pull/12349)), so Vue
consumers already get alien-signals reactivity via the lib's
auto-detection. The connector serves **non-Vue contexts** — SSR / Node
services, Web Workers, embedded widgets, anywhere you want push-pull
reactivity without Vue's full runtime.

**No runtime dep added.** The connector takes alien-signals' `signal`
function as an argument rather than importing it; consumers install
alien-signals themselves (~7.5 KB raw / ~2.5 KB brotli). vapor-chamber
stays Vue-agnostic on the runtime side.

7 tests in [tests/alien-signals.test.ts](./tests/alien-signals.test.ts)
verify the adapter against the real published alien-signals package,
including: value reads/writes, multi-type coverage,
`configureAlienSignals` flipping the global signal factory, propagation
through alien-signals `computed`/`effect`, and a full integration test
running `useSharedCommandState` on top of the alien-signals-backed
factory.

### Migration guides

- [docs/migrating/from-mitt.md](./docs/migrating/from-mitt.md) — API mapping,
  listener-signature change, when not to migrate (and pointer to fast-lane
  if you only need pub/sub).
- [docs/migrating/from-event-emitter.md](./docs/migrating/from-event-emitter.md) —
  Node EventEmitter / eventemitter3 mapping, multi-arg-emit→single-payload,
  class-based vs functional, listener leak detection.

### Inertia 2 integration flags (Inertia + vapor-chamber coexistence)

[transports.ts](src/transports.ts) — `HttpBridgeOptions` gains two flags
that the whitepaper §11.3 documented but the code never shipped:

- **`csrf: 'inertia'`** — defer CSRF token management to Inertia's Axios
  instance. The bridge skips its own DOM-based CSRF reading and relies on
  the consumer's `@inertiajs/inertia` axios setup to inject the token.
- **`onRedirect: (url) => router.visit(url)`** — handle 3xx / `{ redirect }`
  body responses. When set, vapor-chamber resolves the dispatch as failed
  with a "Redirected to ..." message and calls the callback with the URL.
  Use this to hand 302s to Inertia's router for navigation.

### `vapor-chamber/observable` — Symbol.observable / RxJS interop

[src/observable.ts](src/observable.ts) — bridges `bus.on(pattern)` and
`bus.dispatch()` into the TC39 Observable protocol via `Symbol.observable`.
Zero RxJS dependency — RxJS reads the interop natively via `from()`.

```ts
import { from } from 'rxjs';
import { filter, debounceTime } from 'rxjs/operators';
import { observe } from 'vapor-chamber/observable';

from(observe(bus, 'cart*'))
  .pipe(filter(({ result }) => result.ok), debounceTime(200))
  .subscribe(({ cmd }) => console.log(cmd.action));
```

Inverse: `dispatchFrom(bus, action, observable)` pipes Observable values
into the bus as dispatches. 9 tests in
[tests/observable.test.ts](./tests/observable.test.ts).

### `vapor-chamber/standard-schema` — schema-lib-agnostic validation plugin

[src/plugins-schema.ts](src/plugins-schema.ts) — `validateSchemas` and
`validateSchemasAsync` plugins that work with any schema library
implementing [Standard Schema v1](https://standardschema.dev/): Zod,
Valibot, ArkType, Effect Schema. The plugin only depends on the
`'~standard'` interop shape — no schema lib is bundled or required.

```ts
import { z } from 'zod';
import { validateSchemas } from 'vapor-chamber/standard-schema';

bus.use(validateSchemas({
  cartAdd:     z.object({ id: z.number(), qty: z.number().min(1) }),
  orderCreate: z.object({ items: z.array(z.any()).min(1) }),
}));

// Failures resolve with { ok: false, error: BusError(VC_VALIDATION_FAILED) }.
```

Options: `field` (`'target' | 'payload' | 'both' | (cmd) => unknown`),
`onInvalid` (`'reject' | 'warn'`). New `VC_VALIDATION_FAILED` BusErrorCode.
7 tests in [tests/plugins-schema.test.ts](./tests/plugins-schema.test.ts).

Distinct from the existing `schemaValidator` in [schema.ts](src/schema.ts)
which serves the LLM tool-use layer with field-type strings — the two
have intentionally different shapes for different use cases.

### Comparative bench expansion (3 → 7 peer libraries)

[tests/perf.bench.ts](./tests/perf.bench.ts) now benches against:
mitt, nanoevents, eventemitter3, tiny-emitter, RxJS Subject, raw Map, plus
vapor-chamber's general bus and fast lane. Multi-listener emit (3 listeners,
10k events):

| Lib                                 | ops/sec |
|-------------------------------------|---------|
| eventemitter3                       | ~5,990  |
| nanoevents                          | ~5,830  |
| raw `Map<string, Set<fn>>`          | ~5,310  |
| **vapor-chamber `bus.emit`**        | **~4,660** |
| mitt                                | ~2,620  |
| tiny-emitter                        | ~2,240  |
| rxjs Subject                        | ~2,030  |

vapor-chamber's general `bus.emit` is now competitive with the fastest
event emitters (#4 of 7), beats mitt/tiny-emitter/RxJS by 1.8–2.3×, ~80%
of eventemitter3/nanoevents. The fast lane (separately) remains 1.9×
faster than nanoevents on single-handler dispatch.

### TypeDoc → GitHub Pages auto-deploy

[.github/workflows/docs.yml](./.github/workflows/docs.yml) — when `main`
gets pushes to `src/**.ts`, `typedoc.json`, or `README.md`, regenerates
the API site and deploys to GitHub Pages. The site is `.gitignore`d
locally; CI is the source of truth for the published version.

### `examples/sprinkled-blade/` — runnable demo

[examples/sprinkled-blade/](./examples/sprinkled-blade/) — minimal
end-to-end example of the sprinkled-JS pattern with a Node mock backend
that emulates what `VaporChamberController.php` does. Two-terminal
`node mock-server.mjs` + `npx serve .` and the demo is interactive.
Pairs with the runnable PHP companions in
[`examples/laravel-backend/`](./examples/laravel-backend/).

### Deferred to v1.3

- **`command-bus.ts` file split** (1388 → 5–7 focused modules). Pure
  maintainability, no API change. Best done alongside v1.3's wrapper
  elimination so the elimination diff stays clean.

### `createFastLane()` — new dispatch path for real-real-hot loops

Sub-path export `vapor-chamber/fast-lane` adds a deliberately-narrow
dispatcher for workloads where the general bus's per-call overhead
(Command envelope, CommandResult, plugin chain) is measurably the
bottleneck. **Not a faster bus** — a different tool for a different
audience. Game ticks, trading data feeds, audio buffer processing,
scroll/mousemove sampling, physics steps.

```ts
import { createFastLane } from 'vapor-chamber/fast-lane';

const lane = createFastLane();
const onTick = lane.compile<TickData, void>('tick', (data) => {
  updateChart(data.symbol, data.price);
});

// Hot loop — pure function call, no envelope or result allocation
for (const tick of feed) onTick(tick);

// Multi-subscriber fan-out
lane.on('frame', dt => animate(dt));
lane.on('frame', dt => render(dt));
lane.emit('frame', deltaSeconds);
```

**Surface (intentionally minimal):**
- `compile(action, handler)` → returns a pre-bound dispatcher callable
- `on(action, listener)` / `emit(action, data)` → multi-subscriber fan-out
- `remove(action)` / unsubscribe closures
- `registeredActions()` / `clear()`

**Intentionally NOT in fast-lane:**
- Command/Result envelopes — handler receives `data` directly, returns whatever
- Plugins, hooks, listeners on `compile`'s dispatch path
- Wildcards
- Schema validation, batch, request/response, AbortController
- meta / id / correlation / causation tracing
- Auto-cleanup hooks (no Vue scope integration)
- Any of the bus's transports / persistence / retry

**Measured against the same 10k-dispatch bench used elsewhere:**

| Lib / Path                              | ops/sec     | vs fast-lane |
|-----------------------------------------|-------------|--------------|
| direct function call (theoretical floor)| ~348,000    | 13.7× faster |
| **vapor-chamber `fast-lane.compile`**   | **~25,400** | 1.0×         |
| nanoevents emit                         | ~13,300     | 1.9× slower  |
| mitt emit                               | ~4,750      | 5.3× slower  |
| vapor-chamber `bus.dispatch` (general)  | ~700        | 36× slower   |

Multi-listener emit (3 listeners): fast-lane ~5,980 ops/sec ties nanoevents
(~5,700) within 5%, beats mitt (~2,580) by 2.3×, beats `bus.emit` (~3,100)
by 1.9×.

**Implementation:** ~50 lines in `src/fast-lane.ts`. Two parallel `Map`s
(handlers + listeners). `compile` returns a closure that captures the
action key and reads from the handler map (one Map.get + one call per
dispatch). The Map.get indirection is the only thing keeping it from
matching direct-function-call throughput; that indirection enables
`remove()` and `clear()` without breaking previously-returned dispatchers.

**Tests:** 12 in [tests/fast-lane.test.ts](./tests/fast-lane.test.ts) —
correctness for compile/dispatch/on/emit/remove/clear, isolation between
instances, error propagation (no try/catch wrapping), late re-compile
re-routing the dispatcher.

**Doc positioning:** [docs/performance.md](./docs/performance.md) opens
with a "two doorways" section explaining when to pick each path. The
[ROADMAP.md](./ROADMAP.md) reflects this is a permanent two-path design,
not a v2 migration target.

Inspired by [splice](https://github.com/lucianofedericopereira/splice) but
keeps **string-keyed actions** (debuggable in stack traces, devtools, logs)
rather than splice's numeric IDs. The trade-off: ~13.7× behind theoretical
floor instead of ~3-5× — paying ~2-3× for debuggability vs splice. For a
tradeoff curve where the next bigger workload is "I'm building HFT", the
right tool is splice; for "I have a hot loop in my Vue app", the fast lane
is the right tool.

### Performance — splice-inspired optimization sweep (kept 2 of 5)

Inspired by the [splice](https://github.com/lucianofedericopereira/splice)
architecture (which trades ergonomics for raw speed at every junction). I
tested five candidate optimizations against vapor-chamber's hot path —
**only kept what bench-confirmed a clear win**, the rest reverted with the
finding documented so future contributors don't re-investigate.

| # | Candidate                                              | Outcome  | Δ on bare-bus dispatch (10k ops/sec) |
|---|--------------------------------------------------------|----------|--------------------------------------|
| 1 | Bare-bus fast path (sync) — bypass runner when no plugins/hooks/listeners | ✅ **KEPT**   | 595 → ~700 (**+18%**)                |
| 2 | Skip `validateNaming` when no naming option configured | ✅ **KEPT**   | ~700 → ~728 (**+4%**)                |
| 3 | Bare-bus fast path (async)                             | ✗ reverted | 3,586 → 3,360 (within noise, possible regression) |
| 4 | Cache `isBare` boolean (vs five inline property reads) | ✗ reverted | ~700 → ~536 (**-25%** — V8 already optimizes the inline reads; adding the field changed `SyncState`'s hidden class and slowed the dispatch site) |
| 5 | Inline `tryCatchHandler` in bare path                  | ✗ reverted | ~700 → ~651 (no measurable win — V8 was already inlining) |
| 6 | `stampMeta(payload)` instead of `stampMeta({action, target, payload})` (drop temporary wrapper) | ✗ reverted | ~728 → ~682 (slight regression — possibly V8 IC polymorphism on the `any` arg) |

**Net result for v1.2.x dispatch:** +22% on the bare-bus path (sync, no
plugins/hooks/listeners). Specifically:

```ts
// In _syncDispatchInner, before the normal path:
if (s.opts.naming !== undefined) validateNaming(action, s.opts.naming);  // skip if no naming option
const cmd: Command = { ... };

if (
  executeOverride === undefined &&
  s.pluginEntries.length === 0 &&
  s.beforeHooks.length === 0 &&
  s.afterHooks.length === 0 &&
  s.exactListeners.size === 0 &&
  s.wildcardListeners.length === 0
) {
  const handler = s.handlers.get(action);
  if (handler === undefined) return handleMissing(s.opts, cmd);
  return tryCatchHandler(handler, cmd);
}
```

**Lessons documented for future investigators:**
- **Don't add fields to hot-path state objects to "cache" simple inline
  checks.** V8's tight ICs on `Map.size` / `Array.length` already optimize
  those reads; introducing a new field shifts the hidden class and can
  regress the receiver-site IC. Inline reads won by 25%.
- **V8 inlines small functions like `tryCatchHandler` automatically.**
  Manual inlining didn't measure.
- **Async dispatch's `await` + Promise microtask machinery dominates** —
  skipping the runner indirection doesn't help because the runner cost is
  a small fraction of total async dispatch cost.
- **Removing temporary object allocation can regress IC behavior** when the
  argument type becomes more polymorphic (`any` payloads). The bench
  showed regression even though escape analysis "should" elide the wrapper.
  Keep the wrapper for stable IC.
- **Skipping a function call (validateNaming) when its body would early-
  return anyway IS a real win** because the call itself is the cost on the
  hot path, not the body.

### Performance — sync dispatch bare-bus fast path (+18%)

For sync `bus.dispatch` calls where the bus has no plugins, no
before/after hooks, and no listeners (a common configuration: register +
dispatch with nothing else), the implementation now bypasses the runner
indirection and fans out directly to the handler. Same correctness, fewer
function calls.

```ts
// In _syncDispatchInner, before the normal path:
if (
  executeOverride === undefined &&
  s.pluginEntries.length === 0 &&
  s.beforeHooks.length === 0 &&
  s.afterHooks.length === 0 &&
  s.exactListeners.size === 0 &&
  s.wildcardListeners.length === 0
) {
  const handler = s.handlers.get(action);
  if (handler === undefined) return handleMissing(s.opts, cmd);
  return tryCatchHandler(handler, cmd);
}
```

Measured 10k-dispatch bench, average across 3 runs:

| Path                                    | Before    | After     | Δ       |
|-----------------------------------------|-----------|-----------|---------|
| sync dispatch — bare bus (no plugins)   | ~595 ops/sec | **~705 ops/sec** | **+18%** |
| sync dispatch — with plugins/hooks/listeners | unchanged | unchanged | 0%      |

The fast path's five length/size checks (`pluginEntries.length`,
`beforeHooks.length`, `afterHooks.length`, `exactListeners.size`,
`wildcardListeners.length`) are all O(1) property reads — cheaper than
allocating the per-dispatch arrow + invoking the runner closure.

### Performance — async dispatch fast path: tested, NOT shipped

The same bare-bus fast path was tested for async dispatch and showed no
measurable win (3,586 → 3,360 ops/sec across 3 runs — within noise, possible
slight regression). The async path's `await` + Promise microtask machinery
dominates the per-call cost, so skipping the runner doesn't help. Reverted.

A comment in `_asyncDispatchInner` records this finding so future
contributors don't repeat the same investigation.

### Performance — pre-bound dispatcher Map: tested, NOT shipped

A second optimization was tested: pre-bind a `(cmd) => tryCatchHandler(h, cmd)`
closure per action at register time, store in a parallel `dispatchers: Map`,
and reference it in dispatch instead of building the arrow per call. **Failed
to win** because the runner's `execute` parameter is parameterless — the
pre-bound dispatcher takes `cmd`, so dispatch still has to allocate
`() => dispatcher(cmd)` to bridge into the runner. Same alloc cost as before.
Reverted; insight noted for any future runner-signature change.

### Performance — `emit` fast path (9.9× speedup)

The v1.2.x `bus.emit()` path now skips three per-call allocations that were
present before:

1. **No-listener short-circuit** — `if (!exactListeners.has(event) && wildcardListeners.length === 0) return;` before allocating anything. Real apps emit many events that nobody listens for; this turns them into a hash lookup + length check.
2. **Singleton `EMIT_RESULT`** — frozen `{ ok: true, value: undefined, error: undefined }` shared by every emit, replacing per-call `okResult(undefined)`.
3. **Skip `stampMeta` on emit** — emit is fire-and-forget; the typical listener doesn't read `cmd.meta.id` / `correlationId` / `causationId` / `ts`. `Command.meta` is left `undefined` for emit-fired commands. Listeners that need meta on a fire-and-forget event should use `dispatch`.

Measured on the same 10k-event × 3-listener bench used for v1.2.0:

| Path                              | Before    | After     | Speedup |
|-----------------------------------|-----------|-----------|---------|
| `bus.emit` — 3 listeners          | ~470 ops/sec | **~4,640 ops/sec** | **9.9×** |
| `bus.emit` — NO listeners         | (also ~470, allocated unconditionally) | **~24,500 ops/sec** | **52×** |

Comparative repositioning:

| Bench                             | vapor-chamber | mitt   | nanoevents |
|-----------------------------------|---------------|--------|------------|
| emit, 3 listeners                 | **4,640**     | 2,550  | 5,620      |
| emit, no listeners (fast path)    | **24,500**    | 9,820  | 81,800     |

vapor-chamber `emit` is now **1.8× faster than mitt** with subscribers and
**2.5× faster without**. Within 20% of nanoevents on the loaded path; about
3× behind on the empty path (nanoevents' single-property check vs the lib's
two-step Map+array check).

`bus.dispatch` is unchanged in this pass — it does meaningfully more per
call than `emit` (CommandResult, plugin chain, meta stamping for
correlation/causation tracing) and a fair comparison is to other bus /
middleware libraries, not to event emitters.

Comparative bench harness lives in
[tests/perf.bench.ts](./tests/perf.bench.ts) under `describe('emit fast
path — no listeners')`, `describe('comparative emit fan-out')`, and
`describe('comparative dispatch')`. `mitt` and `nanoevents` are devDeps
(bench-only).

Inspiration: [splice](https://github.com/lucianofedericopereira/splice)
ships similar tricks (frame pooling, no-listener fast path, minimal
envelopes). vapor-chamber didn't adopt splice's full architecture
(numeric action IDs, binary headers, frozen action tables) because it
would mean a v2 rewrite; the targeted fast paths capture most of the win
without breaking existing API.

### TypeDoc → API reference site (`npm run docs`)

Added [typedoc.json](./typedoc.json) and `npm run docs` / `npm run docs:watch`
scripts. Generates a navigable HTML API reference from existing JSDoc into
`docs/api/`, covering the main entry plus all sub-path entries
(`transports`, `directives`, `transitions`, `ssr`, `vite-hmr`).

The output is `.gitignore`d so it stays fresh per release. Public hosting
(GitHub Pages or Netlify) is queued for v1.3.

`typedoc` and `typedoc-plugin-markdown` added as devDeps.

### Vapor SFC end-to-end example

Added [examples/vapor-sfc/](./examples/vapor-sfc/) — a runnable Vapor SFC
demo (`npm install && npm run dev`) showing three composable patterns side
by side:

- `CartPanel.vue` uses `useVaporCommand()` for per-button reactive
  loading state
- `SearchPanel.vue` uses `defineVaporCommand()` for fire-and-forget
  search-as-you-type without reactive overhead
- `StatusBar.vue` uses `useSharedCommandState()` for cross-component
  aggregate state (loading + recent errors)

Pinned to `vue@^3.6.0-beta.11` and `@vitejs/plugin-vue@^5.2.0`. Uses the
local checkout (`"file:../.."`); swap to a published version when
testing v1.2.0 from npm.

### `useSharedCommandState()` composable

Aggregate loading / error signals **shared** across every subscriber on the
same bus, instead of allocating a private `loading` + `lastError` pair per
caller. Designed for component-heavy pages where many components only need
to react to "is *anything* in flight?" or "what was the last error?".

```ts
import { useSharedCommandState } from 'vapor-chamber';

const { dispatch, isAnyLoading, lastError, errors, errorCount, clear } =
  useSharedCommandState({ errorCap: 10 });

// Bind across components:
//   <Button :disabled="isAnyLoading.value">Save</Button>
//   <Toast v-if="lastError.value">{{ lastError.value.message }}</Toast>
```

Behavior:
- **Same signal instances** for every caller on the same bus (verified by
  identity).
- **Per-bus isolation** — separate buses get separate shared states (kept in
  a `WeakMap<CommandBus, SharedState>`).
- **Ref-counted disposal** — state is dropped when the last subscriber
  disposes, allowing the WeakMap entry to be GC'd.
- **`inFlight` counter** aggregates concurrent dispatches across all
  subscribers; never goes negative.
- **`errors` ring buffer** newest-last, capped at `errorCap` (default 10).
  Custom caps respected; if multiple subscribers request different caps the
  smallest wins (avoids surprise memory growth).
- **`{ signal }` option** forwards to the underlying bus dispatch — the
  AbortController integration shipped earlier in v1.2 works through this
  composable too.
- **Auto-cleanup** via `tryAutoCleanup` so Vue scope / component unmount
  drops the subscription without manual disposal.

12 tests in [tests/shared-state.test.ts](./tests/shared-state.test.ts)
covering identity, isolation, inFlight aggregation, error ring buffer,
clear semantics, async/sync paths, abort propagation, ref-counted disposal.

### AbortController extensions (v1.2.x continuation)

The AbortController story shipped in v1.2.0 was deliberately minimal (async
dispatch + HTTP bridge). These extensions complete the cancellation surface:

- **`bus.request(action, target, payload, { signal, timeout })`** — async
  request/response now accepts `signal`. Pre-aborted signal short-circuits
  with `VC_CORE_ABORTED` before the responder runs; mid-flight abort races
  against the responder + timeout so callers can cancel without waiting.
  After settlement, the listener is removed and the dedup key cleared.
- **`bus.dispatchBatch(commands, { signal })`** — batch-level cancellation.
  Pre-aborted signal returns immediately with empty results;
  mid-batch abort stops further dispatches (already-completed results are
  preserved). Per-command `cmd.signal` flows to handlers via the underlying
  `dispatch` so individual handlers can observe abort. With `transactional:
  true`, mid-batch abort triggers rollback of already-succeeded commands.
- **WebSocket bridge auto-propagation** — `createWsBridge` now honors
  `cmd.signal` per dispatch. Pre-aborted skips the send; mid-flight abort
  removes the request from the pending map and resolves the dispatch
  immediately (server may still process the command — WS protocol has no
  per-message cancellation, this only cancels the client-side wait).
- **Child signal pattern documented**, not auto-derived. True auto-derivation
  would require AsyncLocalStorage (Node-only) or a module-level dispatch
  stack (race-condition prone in browsers under concurrent dispatches). The
  reliable pattern is explicit threading:
  ```ts
  bus.register('parent', async (cmd) => {
    return await bus.dispatch('child', target, payload, { signal: cmd.signal });
  });
  ```
  Already works since v1.2.0 — no new code needed.

### SSE bridge — intentionally not wired

`createSseBridge` is receive-only (server-pushes to client; no per-command
request/response cycle), so `cmd.signal` doesn't apply at the bridge level.
Consumers wanting to cancel an SSE subscription call `sse.teardown()`.

### Bundle-size budget bumped

The new signal-handling code (WS/request/batch) plus `useSharedCommandState`
in chamber.ts added bytes. Budgets in `scripts/check-size.mjs` raised
accordingly:
- `vapor-chamber.iife.min.js`: 9.5 KB → **10.0 KB brotli max** (full variant
  picked up both AbortController extensions and useSharedCommandState)
- `vapor-chamber-core.iife.min.js`: 6.7 KB → 6.9 KB brotli max
  (AbortController extensions only — chamber.ts not bundled here)
- `vapor-chamber-elements.iife.min.js`: 7.0 KB → 7.2 KB brotli max (same)

Measured sizes after both changes:
- full: 35.2 KB raw / **9.8 KB brotli** / 11.0 KB gzip
- core: 24.6 KB raw / **6.6 KB brotli** / 7.4 KB gzip
- elements: 25.8 KB raw / **6.9 KB brotli** / 7.8 KB gzip

### Laravel integration documentation

- **[docs/integrations/laravel.md](./docs/integrations/laravel.md)** — single
  consolidated reference covering the backend deliverables: minimum-viable
  shape (one route + one controller + action classes), CSRF flows (Blade
  meta tag vs Sanctum SPA cookie), Inertia coexistence, Filament panel
  islands, Reverb / Echo realtime, queued / long-running commands,
  per-command authorization and validation patterns. Smoke-test snippet
  included.
- **[examples/laravel-backend/](./examples/laravel-backend/)** — drop-in PHP
  companion files: `VaporChamberController.php`, `config-vapor-chamber.php`,
  `routes-web.php`, plus three example action classes
  (`AddToCart.php`, `CancelOrder.php`, `ProcessCheckout.php`) covering
  inline validation, Gate authorization, and queued commands.
- **Comment cleanup pass** in `src/http.ts`, `src/transports.ts`,
  `src/chamber.ts`, `src/signal.ts` — JSDoc and inline comments now frame
  Laravel as one of several supported server-rendered frameworks (Rails,
  Django, .NET MVC, custom stacks) rather than the singular target.
  Behavior unchanged.
- **Whitepaper §11.5 trimmed.** The previous reference to
  `createEchoBridge` "v0.8.0" overstated shipped surface — the protocol-aware
  Echo bridge isn't shipped yet. §11.5 now describes the generic
  `createWsBridge` + Echo-event-to-`bus.emit()` pattern that works today,
  with the protocol-aware adapter on the v1.3 ROADMAP.

### Roadmap

- New [ROADMAP.md](./ROADMAP.md) makes the beta-tracking posture explicit:
  what is stable today regardless of Vue's beta cycle, what is transitional
  (Vapor wrappers, `useVaporCommand` / `useCommand` split, runtime feature
  registry), and the v1.3 / v2 cutover plan tied to Vue 3.6 RC and stable.
  Includes the build-flag wrapper-elimination strategy (Vite `define` +
  `package.json` conditional `vue36` export) so the wrappers can compile to
  identity calls and be DCE'd for consumers on Vue 3.6 stable.

### Audited, no change needed

- Defensive try/catch blocks around scope cleanup in `chamber.ts` were audited
  against beta.11's `runtime-core: cleanup stopped async setup scopes` fix.
  The lib's guards target a different condition (called outside any scope at
  all, not a stopped async scope), so nothing is now obsolete. All guards
  remain load-bearing.

### Removed

- `scripts/build-iife.mjs` (replaced by `scripts/build.mjs`).
- Stale hardcoded `version: '0.4.2'` in `src/iife.ts`.

## v1.1.0 — Vue 3.6.0-beta.10 alignment

### Added

- **`defineVaporCustomElement(options)`** (`chamber-vapor.ts`) — wrapper for Vue 3.6.0-beta.10's
  `defineVaporCustomElement()`. Creates custom elements backed by Vapor rendering with zero-overhead
  DOM updates inside shadow DOM. SSR runtime is automatically tree-shaken (beta.10 fix). Returns
  `null` when Vue 3.6.0-beta.10+ is not detected.

- **`defineVaporComponent(options)`** (`chamber-vapor.ts`) — wrapper for Vue 3.6.0-beta.10's
  `defineVaporComponent()`. Provides full TypeScript inference for props, emits, and slots in
  Vapor components. Returns `null` when not available.

- **`defineVaporAsyncComponent(loader)`** (`chamber-vapor.ts`) — wrapper for Vue 3.6.0-beta.10's
  `defineVaporAsyncComponent()`. Async Vapor components are properly cached by VaporKeepAlive and
  hydrate under VDOM Suspense boundaries. Returns `null` when not available.

- **`useVaporAsyncCommand(asyncBus?)`** (`chamber-vapor.ts`) — async-aware command dispatch
  composable for Vapor components under Suspense. Returns `Promise<CommandResult>` from dispatch,
  with reactive `loading` and `lastError` signals. Safe for `<script setup vapor>`.

### Changed

- **Vue detection** (`chamber.ts`) — now probes for `defineVaporCustomElement`,
  `defineVaporComponent`, and `defineVaporAsyncComponent` from Vue 3.6.0-beta.10+.

- **Directive warning** (`directives.ts`) — updated Vapor compatibility warning to mention
  `useVaporAsyncCommand()` and clarify that directives work in VDOM components within mixed
  Vapor/VDOM trees when the interop plugin is installed.

- **Vite HMR** (`vite-hmr.ts`) — tracks Vapor↔VDOM mode switching during HMR reloads. When a
  component switches rendering mode (e.g. template-only HMR between Vapor and VDOM), the bus state
  is preserved and the mode change is logged in verbose mode.

- **`createTransitionBridge(options)`** (`transitions.ts`) — framework-agnostic factory that
  wires Vue `<Transition>` / `<TransitionGroup>` lifecycle hooks to bus commands. All 8 hooks
  (`onBeforeEnter`, `onEnter`, `onAfterEnter`, `onEnterCancelled`, `onBeforeLeave`, `onLeave`,
  `onAfterLeave`, `onLeaveCancelled`) dispatch namespaced actions with the DOM element as target.
  The `done()` callback is called automatically after sync or async handler completion.

- **`useTransitionCommand(options?)`** (`transitions.ts`) — Vue composable version of the
  transition bridge. Uses the shared bus, reactive `phase` signal (`'idle' | 'entering' | 'leaving'`),
  and auto-cleanup via `tryAutoCleanup`. Bind directly to `<Transition v-bind="hooks">`.

- **Sub-path export** `vapor-chamber/transitions` — tree-shakeable, zero cost when not imported.

- **`useCommandQuery()`** (`chamber.ts`) — CQRS read-side composable with reactive `data`,
  `loading`, and `lastError` signals. Wraps `bus.query()` which skips `onBefore` hooks (no auth
  gates or loading spinners for reads). Supports both sync and async buses.

- **`createSSRPlugin(options?)`** (`ssr.ts`) — server-side plugin that records dispatched
  commands for dehydration. Options: `filter`, `maxCommands`. Methods: `dehydrate()`, `clear()`.

- **`rehydrate(bus, commands, options?)`** (`ssr.ts`) — client-side replay of dehydrated commands.
  Skips unhandled commands by default (`ignoreUnhandled: true`). Options: `filter` to suppress
  side-effectful commands during replay.

- **Sub-path export** `vapor-chamber/ssr` — tree-shakeable SSR hydration utilities.

- **`createHttpClient(defaults?)`** (`http.ts`) — multi-method HTTP client factory aligned with
  useFetch patterns. All HTTP methods (GET/POST/PUT/PATCH/DELETE), request deduplication for GETs,
  LRU response caching with TTL, request/response interceptors (Axios-style), safe mode
  (`client.safe.post()` returns `{ data, error, status }` instead of throwing), file download
  with Content-Disposition parsing, instance creation with `client.create({ baseURL })`, query
  params builder (arrays, nested objects). `postCommand` retained for backward compatibility.

- **Configurable XSRF cookie name** (`http.ts`) — reads `<meta name="xsrf-cookie">` to
  configure the cookie name for CSRF token detection. Defaults to `XSRF-TOKEN` (backward compat).

- **`createHttpBridge` httpClient option** (`transports.ts`) — inject a custom `HttpClient`
  instance for advanced use cases (interceptors, custom baseURL). Falls back to `postCommand`.

- **`persist` validate option** (`plugins-io.ts`) — `persist({ validate: (state) => bool })`
  rejects stale or structurally invalid persisted state on `load()`. Returns `null` with a
  console warning when validation fails. Prevents silent shape drift after deploys.

### Fixed

- **`useCommand()` / `useVaporCommand()` async loading** — `loading` signal now stays `true`
  until async handler results resolve. Previously it flashed `true→false` in the same tick,
  making it invisible in templates when using async transports (HTTP bridge, WS bridge).

### Changed

- **`useVaporCommand()` now exposes `emit()`** — fire domain events directly from the composable
  without dropping to `useCommandBus()`.

- **KeepAlive-aware composables** — `useCommandHistory` and `useCommandError` now pause their
  bus subscriptions when the host component is deactivated by `<KeepAlive>`, and resume when
  reactivated. Prevents silent subscription loss in cached components.

- **Transition bridge `onMove` hook** — `TransitionBridge` now includes `onMove(el)` for
  `<TransitionGroup>` reorder animations. Dispatches `{namespace}Move` action.

- **`useCommandGroup()` now exposes `query()` and `emit()`** — namespaced CQRS reads and domain
  events. `cart.query('getTotal', {})` dispatches `cartGetTotal` via `bus.query()` (skips onBefore).
  `cart.emit('updated', data)` dispatches `cartUpdated` via `bus.emit()`.

- **`useCommandHistory` redo re-dispatches** — `redo()` now re-dispatches the command through
  the bus (matching the plugin version's behavior). Previously it only moved the command between
  stacks without executing the handler.

- **`createFormBus` bus injection** — `createFormBus({ bus: sharedBus })` injects an external
  command bus instead of creating an isolated one. Form commands (`formSet`, `formTouch`, etc.)
  become visible to DevTools, metrics, logger, and global listeners.

- **Peer dependency** — `vue` peer dep updated to `>=3.5.0 || >=3.6.0-beta.10` to align with
  the APIs used by the new wrappers.

---

### Added — v1.0 e-commerce hardening

- **Transactional batch dispatch** (`command-bus.ts`) — `dispatchBatch(commands, { transactional: true })`
  rolls back all successful commands on first failure using registered undo handlers. Returns
  `BatchResult.rollbacks?: CommandResult[]` with compensation results in reverse order. Essential
  for e-commerce checkout flows where partial execution is worse than total failure:
  ```ts
  const result = bus.dispatchBatch([
    { action: 'inventoryReserve', target: item },
    { action: 'paymentCharge',    target: payment },
    { action: 'orderCreate',      target: order },
  ], { transactional: true });
  // If paymentCharge fails → inventoryReserve's undo handler runs automatically
  // result.rollbacks contains the compensation results
  ```

- **`optimisticUndo(bus, actions, options?)` plugin** (`plugins-core.ts`) — automatic rollback
  using registered undo handlers. On async failure, executes `bus.getUndoHandler(action)` to
  revert. On sync failure, rolls back immediately. Options: `predict` (return optimistic value),
  `onRollback` (notification callback), `onRollbackError` (undo itself failed). Pairs with
  `register(action, handler, { undo })` for zero-config rollback:
  ```ts
  bus.register('cartAdd', addHandler, { undo: (cmd) => removeFromCart(cmd.target) });
  bus.use(optimisticUndo(bus, ['cartAdd'], {
    predict: (cmd) => ({ ...cart, items: [...cart.items, cmd.target] }),
    onRollback: (cmd, err) => toast.error(`Failed: ${err.message}`),
  }));
  ```

- **Auto-validation in `createSchemaCommandBus`** (`schema.ts`) — `schemaValidator` plugin is
  now installed automatically when creating a schema bus. Validates field types against the schema
  before the handler runs. Opt out with `{ validate: false }`:
  ```ts
  const bus = createSchemaCommandBus(schema);           // validates by default
  const bus = createSchemaCommandBus(schema, { validate: false }); // skip
  ```
  `SchemaCommandBusOptions` type exported: `CommandBusOptions & { validate?: boolean }`.

- **`inspectBus(bus)` introspection** (`command-bus.ts`) — tree-shakeable standalone function
  that returns a full `BusInspection` snapshot of bus topology: registered actions, undo actions,
  responder actions, plugin count/priorities, hook counts, listener patterns, sealed state,
  dispatch depth, and active timers. Uses Symbol key pattern (same as `unsealBus`):
  ```ts
  import { inspectBus } from 'vapor-chamber';
  const info = inspectBus(bus);
  // { actions: ['cartAdd', ...], pluginCount: 3, sealed: false, ... }
  ```
  `TestBus.inspect()` also available for test assertions.

- **`createCommandPool(size)`** (`command-bus.ts`) — pre-allocated object pool for `Command`
  instances in hot paths. Eliminates GC pressure in high-frequency dispatch scenarios (10k+/sec).

- **`bus.seal()` / `unsealBus(bus)`** (`command-bus.ts`) — freeze bus configuration after setup.
  Sealed buses reject `register()`, `use()`, and `clear()` calls with `BusError`. `unsealBus()`
  is a tree-shakeable escape hatch using Symbol key.

- **`bus.dispose()`** (`command-bus.ts`) — clean teardown: clears all state, cancels active
  timers, and marks the bus as disposed. Subsequent dispatch/register calls throw. Safe for
  component-scoped buses and SSR per-request teardown.

- **Recursion depth guard** (`command-bus.ts`) — dispatch depth is tracked and capped at 10.
  Prevents infinite dispatch loops (e.g. handler A dispatches B which dispatches A). Throws
  `BusError` with code `VC_CORE_MAX_DEPTH` and the current depth in context.

### Added — v1.0 performance, LLM-friendliness, structured errors

- **V8 engine optimizations** (`command-bus.ts`) — monomorphic `okResult()`/`errResult()` factories
  ensure stable hidden classes; extracted `tryCatchHandler()` so V8 TurboFan can optimize callers;
  replaced all `.slice()` + `for...of` in hot paths with index-based `for` loops and length snapshots.
  10k dispatches: ~15ms.

- **`BusError` class** (`command-bus.ts`) — structured errors with machine-readable `code`,
  `severity` (error/warn/info), `emitter` (core/plugin/hook/listener/transport/workflow), `action`,
  and optional `context` bag. All core error paths now produce `BusError` instances. Extends `Error`.
  ```ts
  if (result.error instanceof BusError) {
    switch (result.error.code) {
      case 'VC_CORE_NO_HANDLER': /* register handler */ break;
      case 'VC_PLUGIN_CIRCUIT_OPEN': /* wait for reset */ break;
    }
  }
  ```

- **`BusErrorCode` type** — union of all error codes: `VC_CORE_NO_HANDLER`, `VC_CORE_THROTTLED`,
  `VC_CORE_REQUEST_TIMEOUT`, `VC_PLUGIN_CIRCUIT_OPEN`, `VC_PLUGIN_RATE_LIMITED`, etc.

- **`ERROR_CODE_REGISTRY`** (`schema.ts`) — frozen lookup table of all error codes with severity,
  emitter, message, and fix suggestion. Single source of truth for docs, i18n, and LLM prompts.

- **`getErrorEntry(code)`** — lookup function for error code metadata.

- **`describeErrorCodes()`** — plain-text table of all error codes for LLM system prompts.

- **`busApiSchema()`** (`schema.ts`) — JSON schema of every bus method (dispatch, query, emit,
  register, use, on, etc.) with param types and return types. Prevents LLM hallucination of
  non-existent methods.

- **LLM-friendly naming** (`command-bus.ts`) — renamed internal type helpers `_T`/`_P`/`_R` to
  `TargetOf`/`PayloadOf`/`ResultOf` with JSDoc. Added `@example` blocks to `createCommandBus`
  and `createAsyncCommandBus`.

- **Self-correcting error messages** — all errors now include actionable fix text (e.g.
  `"No handler registered for 'X'. Call bus.register('X', handler) first."`).

- **`createChamber(namespace, handlers)`** (`utilities.ts`) — declarative namespace grouping with
  camelCase prefixing. Returns `{ install, actionName, namespace }`.

- **`createWorkflow(steps)`** (`utilities.ts`) — sequential command execution with automatic saga
  compensation on failure. Returns `{ run, steps }`.

- **`createReaction(pattern, action, opts)`** (`utilities.ts`) — declarative cross-domain dispatch
  rules via `bus.on()`. Returns `{ install }`.

- **`cache(opts)`** (`plugins-extra.ts`) — LRU query result caching with TTL, maxSize, glob action
  filter. Methods: `invalidate()`, `clear()`, `size()`.

- **`circuitBreaker(opts)`** (`plugins-extra.ts`) — per-action circuit with closed/open/half-open
  states. Threshold, resetTimeout, onOpen/onClose callbacks.

- **`rateLimit(opts)`** (`plugins-extra.ts`) — per-action sliding window rate limiter.

- **`metrics(opts)`** (`plugins-extra.ts`) — lightweight telemetry: dispatch count, duration,
  success rate per action. Methods: `entries()`, `summary()`, `clear()`.

### Added — core 1.0 readiness

- **`Command.meta?: CommandMeta`** (`command-bus.ts`) — auto-stamped metadata on every dispatched
  command: `{ ts, id, correlationId?, causationId? }`. `ts` is `Date.now()`, `id` is
  `crypto.randomUUID()` with Math.random fallback. Propagate tracing IDs via
  `payload.__correlationId` and `payload.__causationId`. Optional on the type level — userland
  code that constructs `Command` objects manually does not need to provide it.

- **`bus.query(action, target, payload?)`** (`command-bus.ts`) — read-only dispatch that skips
  `onBefore` hooks (no mutation gating). Runs handler through the plugin pipeline and fires
  `onAfter` hooks and `on()` listeners. CQRS separation: use `dispatch()` for writes,
  `query()` for reads.

- **`bus.emit(event, data?)`** (`command-bus.ts`) — fire a domain event that notifies `on()`
  listeners without requiring a registered handler and without returning a result. Clean path
  for domain events (e.g., `orderCreated`, `cartCleared`) that are observations, not commands.

- **`bus.registeredActions(): string[]`** (`command-bus.ts`) — returns all registered action
  names. Essential for introspection, DevTools panels, and debugging.

- **`TestBus.onBefore` now fires for real** (`testing.ts`) — was previously a no-op stub.
  Hooks can now cancel dispatch on TestBus, matching real bus behavior.

- **`TestBus.query()`, `TestBus.emit()`, `TestBus.registeredActions()`** (`testing.ts`) — full
  parity with the real buses.

### Added — core quality & gap fixes (v0.6.0 candidate)

- **`bus.onBefore(hook)`** (`command-bus.ts`) — pre-dispatch hook on both sync and async buses.
  Throw (or reject, on async bus) to cancel the dispatch — returns `{ ok: false, error }`.
  After hooks still fire on cancellation. Use for auth gates, loading spinners, pre-validation:
  ```ts
  bus.onBefore((cmd) => {
    if (!isAuth()) throw new Error('Unauthenticated');
  });
  ```

- **`bus.offAll(pattern?)`** — remove all `on()` listeners matching an exact pattern, or all
  listeners if called with no argument. Useful for component teardown without tracking individual
  unsub functions:
  ```ts
  bus.on('cart*', listenerA);
  bus.on('cart*', listenerB);
  bus.offAll('cart*');  // removes both
  bus.offAll();         // removes everything
  ```

- **`bus.once(pattern, listener)`** — one-shot subscription on both sync and async buses.
  Auto-unsubscribes after first matching command. The returned unsub cancels before it fires.
  `TestBus` now also has a real `once()` implementation.

- **`BatchResult.successCount` and `BatchResult.failCount`** — always present on batch results
  regardless of `continueOnError`. Allows precise "3 of 5 succeeded" reporting:
  ```ts
  const { results, successCount, failCount } = bus.dispatchBatch(cmds, { continueOnError: true });
  console.log(`${successCount}/${results.length} succeeded`);
  ```

- **`HttpError.code`** — machine-readable error code extracted from response body `{ code: '...' }`.
  Enables pattern-matching on application errors without string comparison on `.message`:
  ```ts
  } catch (e) {
    if ((e as HttpError).code === 'CART_ITEM_LIMIT_EXCEEDED') showLimitWarning();
  }
  ```

- **`HttpBridgeOptions.noRetry: string[]`** — list of action names that must never be retried,
  regardless of the `retry` setting. Prevents double-execution of payment and checkout commands:
  ```ts
  createHttpBridge({ endpoint: '/api/vc', retry: 2, noRetry: ['paymentCharge', 'orderPlace'] })
  ```

- **`WsBridgeOptions.maxQueueSize?: number`** (default: `100`) — caps the in-memory queue that
  accumulates messages during a WebSocket disconnect. When exceeded, the oldest queued message
  is resolved with `{ ok: false, error }` before the new message is enqueued. Prevents unbounded
  memory growth during long disconnects or reconnect storms.

- **`SynthesizeOptions.adapter?: LlmAdapter`** (`schema.ts`) — custom LLM adapter for `synthesize()`.
  When provided, bypasses the built-in Anthropic API call entirely. Receives Anthropic-format tool
  definitions, user text, and options; returns a `ToolCallInput`. Use for proxied APIs, OpenAI, or
  any other provider:
  ```ts
  const adapter: LlmAdapter = async (tools, text) => {
    const res = await myOpenAiProxy.complete({ tools, prompt: text });
    return { name: res.toolName, input: res.args };
  };
  await bus.synthesize('add 2 of item 5', { adapter });
  ```
  `LlmAdapter` type exported from main entry point.

- **`BaseBus` interface** — structural escape hatch for utilities that work with both sync and async
  buses. Exported from main entry point. Use as parameter type in `createChamber`, `createWorkflow`,
  and any cross-bus utilities to avoid `as any` casts.

- **`commandKey(action, target)`** — stable `action:target` string key, exported from core.
  Handles circular references safely. Useful for cache invalidation (TanStack Query integration).

- **`buildRunner` and `matchesPattern`** — exported from `command-bus.ts` for use in utilities
  and custom test doubles without internal duplication.

- **`BeforeHook`, `AsyncBeforeHook`, `LlmAdapter`** types exported from main entry point.

- **`WHITEPAPER.md`** — comprehensive architectural document covering: design decisions from
  nine comparative analysis rounds (RTK, VueUse, XState, TanStack Query, DDD, Svelte Stores,
  RxJS, GraphQL, ArangoDB), CQRS positioning, DDD application service layer pattern,
  integration guide for Pinia / TanStack Query / Inertia 3 / XState / Laravel Reverb,
  utility layer design (`createChamber`, `createWorkflow`, `createReaction`), and v1.0 roadmap.

### Fixed — v1.0 review rounds (3 full audits)

- **Per-instance throttle timers** (`command-bus.ts`) — throttle `setTimeout` handles were stored
  per action but not per bus instance. Two buses with the same throttled action shared timers.
  Fixed: timers are now stored in per-instance `SyncState.activeTimers` / `AsyncState.activeTimers`.

- **`BusError` native `cause` propagation** (`command-bus.ts`) — `BusError` constructor now passes
  `{ cause: originalError }` to `Error` super constructor when wrapping an existing error. Enables
  `error.cause` chaining for debugging.

- **`commandKey` fast-path for primitives** (`command-bus.ts`) — `commandKey()` now returns
  `action:target` directly when target is a string/number/boolean, skipping `JSON.stringify`.
  ~3× faster for the common case of ID-based targets.

- **History plugin `_replaying` flag** (`plugins-core.ts`) — `history.undo()` and `history.redo()`
  now set a `_replaying` flag that prevents re-recording the replayed command into history. Previously,
  undo/redo could create infinite history loops.

- **Cache plugin async compatibility** (`plugins-extra.ts`) — `cache()` now correctly awaits
  async handler results before caching. Previously, cache stored the Promise object instead of
  the resolved value on async buses.

- **Metrics plugin O(1) entry access** (`plugins-extra.ts`) — `metrics.entries()` now returns
  a frozen snapshot instead of rebuilding from internal maps on every call.

- **`TestBus.on()` fires listeners on `query()` and `emit()`** (`testing.ts`) — previously only
  fired on `dispatch()`. Now consistent with real bus behavior.

### Fixed

- **419 CSRF expiry incorrectly triggered session-expired callbacks** (`http.ts`) — 419 was
  included in `SESSION_EXPIRED_STATUS`. It is now correctly excluded: 419 is CSRF expiry,
  not a session expiry. Only 401 fires `onSessionExpired` and dispatches the `session-expired`
  `CustomEvent`.

- **CSRF refresh was a no-op** (`http.ts`) — `refreshCsrfOnce` re-read the stale DOM token
  instead of fetching a fresh one. Now fetches `csrfCookieUrl` (default `/sanctum/csrf-cookie`)
  to let Laravel issue a fresh `XSRF-TOKEN` cookie before re-reading. Concurrent 419s still
  coalesce — no duplicate refresh requests.

- **`ReferenceError: installedBus is not defined`** (`transports.ts`) — leftover assignment
  after removing the `installedBus` variable from the SSE bridge `install()` function.

- **SSE bridge `install(bus)` accepted `CommandBus` (sync only)** (`transports.ts`) — the `bus`
  parameter in `SseBridgeOptions.onEvent` and `install()` was typed as `CommandBus`. Changed to
  `BaseBus` so both sync and async buses can be passed without `as any`.

- **WS timeout was hardcoded** (`transports.ts`) — the per-message response timeout in
  `createWsBridge` was hardcoded to 10_000ms. Now reads `WsBridgeOptions.timeout` (default
  still 10_000).

- **HTTP bridge swallowed error response bodies** (`transports.ts`) — error messages from the
  bridge were `HTTP {status}`. Now includes `data.message ?? data.error` from the response JSON
  when the server returns an error object.

- **HTTP bridge always retried even non-idempotent actions** — mitigated by `noRetry` option
  (see above).

- **Error response bodies were never parsed** (`http.ts`) — `doFetch` only parsed JSON when
  `raw.ok`. Now always attempts `raw.json()` so error body fields (`code`, `message`, `error`)
  are available in `HttpError.response.data` and `HttpError.code`.

- **`once()` mutation-during-iteration bug** (`command-bus.ts`) — when a `once()` listener fired
  and called its own `unsub()` inside the loop, subsequent listeners in the same array were
  skipped. Fixed by iterating `.slice()` of `patternListeners` and `afterHooks` in both
  `syncRunHooks` and `asyncRunHooks`.

- **`isAsyncFn` fragile in minified builds** (`command-bus.ts`) — used `fn.constructor?.name`
  which minifiers rename to single characters. Fixed to `fn[Symbol.toStringTag]`.

- **`TestBus.on()` was a no-op stub** (`testing.ts`) — stored listeners but never called them.
  Now fires matching listeners after every dispatch, consistent with the real buses.

### Added — Vue 3.6 Vapor alignment (v0.6.0 candidate)

- **`useVaporCommand()` composable** (`chamber-vapor.ts`) — full-featured Vapor-safe composable
  with `dispatch()`, `register()`, `on()`, reactive `loading`/`lastError` signals, and `dispose()`.
  Does not use `getCurrentInstance()` — safe in Vapor's scope-based lifecycle. Auto-cleans up
  via `onScopeDispose` when available.

- **`tryAutoCleanup` dev warning** (`chamber.ts`) — in development mode, logs a console warning
  when no Vue scope or component instance is found. Helps catch accidental usage outside
  `setup()` or `effectScope()` in Vapor components where `getCurrentInstance()` returns null.

- **Vapor directive compatibility warning** (`directives.ts`) — `createDirectivePlugin.install()`
  now emits a console warning when Vapor mode is detected, explaining that `v-vc:command`
  directives are VDOM-only and suggesting `useVaporCommand()` or `defineVaporCommand()` instead.

- **Vite HMR `.vapor.vue` file support** (`vite-hmr.ts`) — the `transform()` hook now matches
  `.vapor.vue` files (Vue 3.6+ Vapor SFCs) in addition to `.ts`, `.js`, `.vue`, `.tsx`, `.jsx`.

- **`FormBusOptions.reactive?: boolean`** (`form.ts`) — set to `false` to skip Vue signal
  allocations (saves 7 signal allocations per form). All APIs work identically via plain
  get/set wrappers. Useful for headless, server-side, or batch form processing.

- **`HttpBridgeOptions.scopeController?: AbortController`** (`transports.ts`) — pass an
  AbortController tied to a Vapor component's lifecycle. When the component is disposed and
  the controller is aborted, all in-flight HTTP requests are cancelled automatically. Merges
  with the existing `signal` option via `AbortSignal.any()` when available.

- **`WsBridge.connected: Signal<boolean>`** (`transports.ts`) — reactive signal for WebSocket
  connection state. Bindable directly in Vapor/VDOM templates without polling. Updates on
  `ws.onopen`, `ws.onclose`, and `disconnect()`.

### Changed

- **`FormRules` now supports async validators** (`form.ts`) — rule functions may return
  `string | null | Promise<string | null>`. `set()` uses sync-only rules for live per-field
  feedback (no UI jank). `submit()` awaits all rules including async ones before gating
  `onSubmit`. Fully backward-compatible — existing sync rules unchanged.

---

### Added

- **`createAsyncSchemaCommandBus<S>(schema, options?)`** (`src/schema.ts`) — async variant of
  `createSchemaCommandBus`. Use when handlers perform async work (API calls, LLM, DB).
  Same interface: `toTools()`, `synthesize()`, `getSchema()`, `fromToolCall()`, `describe()`.

- **`schemaValidator(schema)`** (`src/schema.ts`) — plugin that blocks dispatch when field types
  don't match the schema. Returns `{ ok: false, error }` before the handler runs. Uses the same
  `validateFields` helper as `schemaLogger`.

- **`describeSchema(schema)`** (`src/schema.ts`) — returns a plain-text summary of all commands
  for use in LLM system prompts: `"Available commands:\n- cartAdd: Add item to cart (target: id:number, ...)"`.
  Also available as `bus.describe()` on schema buses.

- **`bus.fromToolCall(toolUse)`** on `SchemaCommandBus` / `AsyncSchemaCommandBus` — dispatch
  directly from a pre-existing LLM `tool_use` block without a full `synthesize()` round-trip.
  Accepts `{ name, input: { target?, payload? } }` — the same shape the LLM returns.

- **Schema layer** (`src/schema.ts`) — flat runtime schema as single source of truth:
  - `BusSchema` / `ActionSchema` / `FieldMap` — flat type definitions (`{ id: 'number' }`)
  - `InferMap<S>` — derives TypeScript `CommandMap` types from the runtime schema automatically;
    no separate type definition needed
  - `createSchemaCommandBus<S>(schema)` — sync bus typed from schema
  - `createAsyncSchemaCommandBus<S>(schema)` — async bus typed from schema
  - `toTools(schema, provider?)` / `toAnthropicTools` / `toOpenAITools` — LLM tool definitions;
    `target` and `payload` kept as separate nested objects (no field merging/splitting)
  - `schemaLogger(schema, options?)` — schema-aware plugin: logs description, validates field types
    with `✓` / `⚠` indicators
  - `synthesize(schema, bus, text, options?)` — natural language → LLM tool use → dispatch;
    injectable `fetch` for testing; supports both sync and async buses
  - Schema keys are normalized to camelCase on creation (`cart_add` → `cartAdd` with a warn)

- **8 core bus fixes** (`src/command-bus.ts`):
  - `request()` now routes through the plugin chain when a responder exists (was bypassing it)
  - `request()` signature: `(action, target, payload?, options?)` — payload added as 3rd arg
  - `onMissing` custom function wrapped in try/catch — throws return `{ ok: false, error }`
  - `bus.hasHandler(action)` — introspection method on both `CommandBus` and `AsyncCommandBus`
  - `register()` warns on silent handler overwrite
  - `CommandBus<M extends CommandMap>` and `AsyncCommandBus<M>` are now generic — typed dispatch
    and register via `createCommandBus<MyMap>()`
  - `wrapThrottle` key: `JSON.stringify` wrapped in try/catch for circular ref safety
  - `dispatchBatch(commands, options?)` — new `BatchOptions = { continueOnError?: boolean }`;
    when true, collects all results and returns the first error instead of stopping

- **`CommandMap`** and **`BatchOptions`** exported from main entry point.

---

## [0.5.0] - 2026-03-22

### Breaking Changes

- **camelCase action names enforced throughout** — all built-in examples, wildcard patterns, and
  `useCommandGroup` now use camelCase (`cartAdd`, `ordersCancel`). The naming convention regex
  changed from snake_case `/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/` to camelCase
  `/^[a-z][a-zA-Z0-9]+$/`. Rationale: Pereira (2026) proved camelCase produces 1.12–1.20× fewer
  BPE tokens than dot-notation (p<0.001, Spearman ρ=1.000 across all tested tokenizer pairs),
  saving ~$54,499/year at enterprise-scale LLM usage.
  See `docs/whitepaper.md` §2.5.

- **Wildcard patterns now use `*` suffix** (was `.*` / `_*`) — `cart*` matches `cartAdd`,
  `cartRemove`, etc. Affects `bus.on()`, `useCommandGroup`, `createHttpBridge`, `retry`.

- **`wrapThrottle` now throws on throttled calls** (was returning an invalid `CommandResult`).
  Throttled dispatches return `{ ok: false, error }` with `error.message === 'throttled'` and
  `error.retryIn` (ms until retry is safe). Callers should check `result.ok` before using
  `result.value`.

### Added

- **`useCommandGroup(namespace)`** (`src/chamber.ts`) — namespace isolation for large apps:
  - All `dispatch`/`register`/`on` calls are automatically prefixed in camelCase
  - `cart.dispatch('add', product)` → dispatches `'cartAdd'`
  - `cart.register('add', handler)` → registers `'cartAdd'`
  - `cart.on('*', listener)` → listens to `'cart*'`
  - Auto-cleanup on Vue scope disposal
  - `group.namespace` exposes the namespace string

- **`useCommandError(options?)`** (`src/chamber.ts`) — reactive error boundary:
  - `errors` — signal containing all failed dispatches
  - `latestError` — signal with the most recent error
  - `clearErrors()` — reset state
  - Optional `filter` narrows which actions are tracked

- **Transport layer** (`src/transports.ts`):
  - `createHttpBridge(options)` — async plugin that forwards commands to a backend endpoint via POST
  - `createWsBridge(options)` — WebSocket transport with auto-reconnect
  - `createSseBridge(options)` — Server-sent events bridge (server-push commands)
  - All transports accept an `actions` filter: `['cart*']` sends only matching commands over the wire
  - `createHttpBridge` uses `postCommand` from `http.ts` for retry, CSRF, and timeout support

- **`retry` plugin** (`src/plugins-io.ts`) — async plugin with configurable backoff:
  - `maxAttempts`, `baseDelay`, `strategy` (`'fixed'` | `'linear'` | `'exponential'`)
  - `actions` glob filter — only retry matching action patterns
  - `isRetryable(error, attempt)` — stop retrying on non-recoverable errors early

- **`persist` plugin** (`src/plugins-io.ts`) — auto-save state to localStorage after each command:
  - Custom `storage` backend (sessionStorage, IndexedDB adapter, etc.)
  - `plugin.load()`, `plugin.save()`, `plugin.clear()` methods
  - SSR-safe: resolves localStorage at call time, no-ops when unavailable

- **`sync` plugin** (`src/plugins-io.ts`) — broadcast commands across browser tabs via `BroadcastChannel`:
  - `filter` option to select which actions to broadcast
  - `onReceive` callback to intercept or suppress incoming commands
  - `plugin.close()`, `plugin.isOpen()` methods
  - Echo prevention: re-dispatched commands from other tabs are not re-broadcast

- **`createTestBus` snapshot & time-travel** (`src/testing.ts`):
  - `bus.snapshot()` — returns a deep copy of the recorded dispatch list (mutations don't affect `recorded`)
  - `bus.travelTo(index)` — returns commands from 0 to index inclusive
  - `bus.travelToAction(action)` — returns all commands up to the last occurrence of `action`
  - All time-travel methods return the `Command` array (not `RecordedDispatch`) for easy assertion

- **`src/http.ts`** — TypeScript HTTP client, adapted from `fetch/useFetch.js`:
  - `postCommand<T>(url, body, config)` — POST with retry, CSRF, timeout, session detection
  - `readCsrfToken()` — multi-source CSRF: meta tag → `XSRF-TOKEN` cookie → hidden `_token` input; 5-min TTL cache
  - `invalidateCsrfCache()` — force cache clear (e.g. after logout)
  - `AbortSignal.any` with manual fallback for older environments
  - Jittered exponential backoff (avoids thundering herd)
  - `X-RateLimit-Reset` as `Retry-After` fallback
  - 419 CSRF refresh coalesces concurrent requests (no duplicate refreshes)
  - `session-expired` CustomEvent + `onSessionExpired` callback
  - `TimeoutError` distinct from `AbortError`

- **`src/chamber-vapor.ts`** — Vapor-specific API extracted from `chamber.ts` for CDCC compliance:
  - `createVaporChamberApp()`, `getVaporInteropPlugin()`, `defineVaporCommand()`

- **`src/plugins-core.ts`** / **`src/plugins-io.ts`** — `plugins.ts` split for CDCC compliance:
  - `plugins-core.ts`: logger, validator, history, debounce, throttle, authGuard, optimistic
  - `plugins-io.ts`: retry, persist, sync
  - `plugins.ts` now a barrel re-export

- **SSR concurrency tests** — 4 new tests in `tests/new-features.test.ts` verifying that
  independent buses don't share handlers, plugins, or state across simulated SSR requests.

- **`useCommandGroup` camelCase tests** — 2 new tests verifying that
  `cart.register('add')` registers `'cartAdd'` and `cart.dispatch('remove')` dispatches `'cartRemove'`.

- **`createFormBus<T>(options)`** (`src/form.ts`) — reactive form state manager built on the command bus:
  - `values`, `errors`, `touched`, `isDirty`, `isValid`, `isSubmitting` — reactive signals
  - `set(field, value)` — update a field and re-run all validation rules
  - `touch(field)` — mark a field as interacted with (triggers error display)
  - `submit()` — validate all fields, call `onSubmit`, return `boolean`
  - `reset()` — restore initial field values and clear all state
  - `use(plugin)` — attach any command bus plugin (logger, throttle, authGuard, etc.)
  - `bus` — exposes the underlying `CommandBus` for DevTools, testing, and advanced use
  - 13 new tests in `tests/form.test.ts`

- **`@types/node`** added as dev dependency (required by `vite-hmr.ts`).

### Changed

- **`command-bus.ts` refactored** to CDCC-compliant module-level functions with explicit state
  threading (`SyncState` / `AsyncState`). Factory functions dropped from ~179 lines to ~20 lines
  each. All inner functions promoted to module scope.

- **Async-on-sync guard** — `syncUse()` now warns when an async plugin is installed on a sync bus:
  ```
  [vapor-chamber] Async plugin installed on sync bus — use createAsyncCommandBus() instead.
  ```

- **`chamber.ts`** exports `tryAutoCleanup` (previously private) and internal Vapor state getters
  (`getVaporAppFn`, `getVaporInteropRef`) for use by `chamber-vapor.ts`.

---

## [0.4.0] - 2026-03-20

### Vue 3.6 + Vite 7/8 Alignment

This release aligns vapor-chamber with the Vue 3.6 beta (Vapor mode feature-complete)
and the Vite 7/8 toolchain (Rolldown bundler).

### Added

- **`isVaporAvailable()`** — runtime detection of Vue 3.6+ Vapor mode support
- **`createVaporChamberApp()`** — helper to create a Vapor app instance (requires Vue 3.6+)
- **`getVaporInteropPlugin()`** — returns `vaporInteropPlugin` for mixed VDOM/Vapor trees
- **`defineVaporCommand()`** — zero-overhead composable for hot-path dispatches in Vapor mode.
  Skips reactive `loading`/`lastError` signal creation that `useCommand()` provides.
  Ideal for telemetry events, scroll-position sampling, debounced search, autosave,
  and any fire-and-forget pattern where reactive loading state would be wasted overhead.

### Changed

- **`tryAutoCleanup()` now prefers `onScopeDispose`** (Vue 3.5+) over `onUnmounted`.
  `onScopeDispose` works in component setup, `effectScope()`, Vapor components, and SSR —
  making it the correct lifecycle hook for library composables.
- **Node.js requirement bumped to `>=20.19.0`** to align with Vite 7/8 minimum.
- **`tsconfig.json` module target changed from `ESNext` to `ES2022`** for deterministic output
  that matches Vite 7's baseline-widely-available target.
- **Dynamic imports in `devtools.ts` now use `@vite-ignore`** comment for Rolldown compatibility.
  Prevents Vite 8 (Rolldown) from statically analyzing the optional `@vue/devtools-api` import.
- **Package keywords updated** with `alien-signals`, `vue-3.6`, `vapor-mode`.

### Notes on Vue 3.6 Vapor + alien-signals

- Vue 3.6 rewrites `@vue/reactivity` atop alien-signals (by Johnson Chu / StackBlitz).
  `ref()` is now backed by fine-grained signals internally — **no separate signal API needed**.
- vapor-chamber's `configureSignal()` remains available as an escape hatch but is no longer
  required in Vue 3.6+; the auto-detected `ref()` is already alien-signals powered.
- The command bus core (`command-bus.ts`) remains framework-agnostic — zero Vue dependency.
- All composables work identically in VDOM, Vapor, and mixed trees.

---

## [0.3.0] - 2026-03-20

### Fixed

- **Debounce plugin stale closure** (`src/plugins.ts`): The previous implementation called `next()` inside a `setTimeout`, invoking the middleware chain continuation from a stale closure context. After the debounce timer fired, the `next` function still referenced the original dispatch's middleware state — not the latest one. Fixed by storing the latest `next` closure per debounce key and executing the most recent one when the timer fires.

- **History undo was data-only** (`src/plugins.ts`): `history.undo()` popped the command from the stack but never executed an inverse handler, so the UI state didn't actually revert. Now accepts an optional `{ bus }` reference. When provided, `undo()` calls `bus.getUndoHandler(action)` and executes the inverse handler. `redo()` re-dispatches through the bus. Fully backward-compatible — without `{ bus }`, behavior is unchanged.

- **Signal shim had no reactivity in standard Vue 3** (`src/chamber.ts`): The fallback signal was a plain getter/setter object. When Vue Vapor was not available (i.e., standard Vue 3), changing `signal.value` did not trigger Vue's reactivity system, so `useCommandState` would not update the UI. Fixed by detecting Vue's `ref()` at module load and using it as the signal implementation when available.

- **Shared bus leaked between tests** (`src/chamber.ts`): The module-level `sharedBus` singleton persisted across test files. If a test forgot to call `setCommandBus(createCommandBus())` in `beforeEach`, handlers and hooks from previous tests would leak. Added `resetCommandBus()` export that sets the singleton to `null`, ensuring a clean slate in `afterEach`.

### Added

- **Naming convention enforcement** (`src/command-bus.ts`): New `naming` option on `createCommandBus()` validates action names at both registration and dispatch time. Supports any regex pattern with configurable violation mode (`'warn'`, `'throw'`, or `'ignore'`).

- **Wildcard / pattern listeners** (`src/command-bus.ts`): New `bus.on(pattern, listener)` method. Supports `'*'` (all events), `'prefix*'` (namespace glob), or exact match.

- **Request/response pattern** (`src/command-bus.ts`): New `bus.request()` and `bus.respond()`. Supports timeout (default 5s). Falls back to normal `dispatch()` if no responder is registered.

- **Per-command throttle/undo at register time** (`src/command-bus.ts`): `register()` now accepts `{ throttle, undo }` options.

- **Auto-cleanup on Vue component unmount** (`src/chamber.ts`): All composables now detect Vue lifecycle context and register cleanup automatically.

- **`resetCommandBus()` export** (`src/chamber.ts`).

- **`authGuard` plugin** and **`optimistic` plugin** (`src/plugins.ts`).

### Tests

- Added tests for: naming convention, wildcard listeners, request/response, undo handler, per-command throttle, `resetCommandBus`, `authGuard`, `optimistic`, history with bus-backed undo/redo.

---

## [0.2.0] - 2026-03-18

### Added

- **Async command bus** (`createAsyncCommandBus`): Full async support for handlers, plugins, and hooks.
- **Command batching** (`dispatchBatch`): Execute multiple commands sequentially, stops on first failure.
- **Plugin priority** (`use(plugin, { priority })`): Higher priority runs first (outermost).
- **Dead letter handling** (`onMissing`): Configurable behavior for unhandled commands.
- **Testing utilities** (`createTestBus`): Record and assert dispatched commands.
- **DevTools integration** (`setupDevtools`): Timeline + inspector panel for Vue DevTools.

---

## [0.1.0] - 2026-03-16

### Fixed

- **`newTodoText` reactivity bug** (`examples/vue-vapor-component.vue`): Form input was declared as a plain `let` variable. Changed to `const newTodoText = signal('')`.

- **Redundant stats recomputation** (`examples/vue-vapor-component.vue`): `getStats()` was called four times in the template. Replaced with a `stats` signal updated once via `bus.onAfter()`.

- **Debounce plugin memory leak** (`src/plugins.ts`): The `results` map was never cleared.

- **Throttle plugin memory leak** (`src/plugins.ts`): The `lastRun` map was never pruned.

- **`useCommand` lifecycle leak** (`src/chamber.ts`): `register` and `use` were forwarded with no shared cleanup path.

- **Proxy trap breakage via private global access** (`src/chamber.ts`): Replaced `window.__VUE_VAPOR__` probe with explicit `configureSignal(fn)` API.

- **Reactivity loss from destructuring** (`examples/vue-vapor-component.vue`).

- **`v-model` on a signal object** (`examples/vue-vapor-component.vue`).

- **`.trim()` called on signal object** (`examples/vue-vapor-component.vue`).

- **`bus.onAfter()` return value discarded** (`examples/vue-vapor-component.vue`).

- **`AsyncHandler` type collapsed to `any`** (`src/command-bus.ts`).

- **Dead `listeners` array in fallback signal** (`src/chamber.ts`).

- **Stale `~1KB` size claim** (`src/index.ts`, `src/command-bus.ts`).

- **Wrong import path in JSDoc** (`src/devtools.ts`).

### Performance

- **Plugin chain no longer rebuilt on every dispatch** (`src/command-bus.ts`): Replaced per-dispatch `reduceRight` with a cached `runner` function rebuilt only on `use()`.

### Added

- **`signal` and `configureSignal` exports**.
- **DevTools integration** (`src/devtools.ts`).
- **Roadmap in README**.
