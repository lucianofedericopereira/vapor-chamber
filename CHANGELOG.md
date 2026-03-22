# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
  Ideal for GA4 tracking, scroll events, debounced search, and fire-and-forget patterns.

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
