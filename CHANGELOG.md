# Changelog

All notable changes to this project will be documented in this file.

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
