# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
- For Luxury's migration: start with `vaporInteropPlugin` in `createApp()`, convert hot-path
  components to `<script setup vapor>` incrementally, eventually move to `createVaporApp()`.

## [0.3.0] - 2026-03-20

### Fixed

- **Debounce plugin stale closure** (`src/plugins.ts`): The previous implementation called `next()` inside a `setTimeout`, invoking the middleware chain continuation from a stale closure context. After the debounce timer fired, the `next` function still referenced the original dispatch's middleware state — not the latest one. Fixed by storing the latest `next` closure per debounce key and executing the most recent one when the timer fires.

- **History undo was data-only** (`src/plugins.ts`): `history.undo()` popped the command from the stack but never executed an inverse handler, so the UI state didn't actually revert. Now accepts an optional `{ bus }` reference. When provided, `undo()` calls `bus.getUndoHandler(action)` and executes the inverse handler. `redo()` re-dispatches through the bus. Fully backward-compatible — without `{ bus }`, behavior is unchanged.

- **Signal shim had no reactivity in standard Vue 3** (`src/chamber.ts`): The fallback signal was a plain getter/setter object. When Vue Vapor was not available (i.e., standard Vue 3), changing `signal.value` did not trigger Vue's reactivity system, so `useCommandState` would not update the UI. Fixed by detecting Vue's `ref()` at module load and using it as the signal implementation when available.

- **Shared bus leaked between tests** (`src/chamber.ts`): The module-level `sharedBus` singleton persisted across test files. If a test forgot to call `setCommandBus(createCommandBus())` in `beforeEach`, handlers and hooks from previous tests would leak. Added `resetCommandBus()` export that sets the singleton to `null`, ensuring a clean slate in `afterEach`.

### Added

- **Naming convention enforcement** (`src/command-bus.ts`): New `naming` option on `createCommandBus()` validates action names at both registration and dispatch time. Supports any regex pattern with configurable violation mode (`'warn'`, `'throw'`, or `'ignore'`). Designed for Luxury's LLM-first snake_case convention (`/^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/`).

  ```typescript
  const bus = createCommandBus({
    naming: {
      pattern: /^[a-z][a-z0-9]*(_[a-z][a-z0-9]*)+$/,
      onViolation: 'throw',
    }
  });
  ```

- **Wildcard / pattern listeners** (`src/command-bus.ts`): New `bus.on(pattern, listener)` method. Supports `'*'` (all events), `'prefix_*'` (namespace glob), or exact match. Listeners receive both the command and its result. Returns unsubscribe function. Designed for analytics subscribers and debugging.

  ```typescript
  bus.on('shop_*', (cmd, result) => trackShopEvent(cmd));
  bus.on('*', (cmd, result) => console.log(cmd.action));
  ```

- **Request/response pattern** (`src/command-bus.ts`): New `bus.request(action, target, { timeout })` and `bus.respond(action, handler)` methods. `request()` returns a Promise that resolves with the responder's return value, or falls back to normal `dispatch()` if no responder is registered. Supports timeout (default 5s). Designed for cross-component queries: payment gateway tokens, address validation, modal confirmations.

  ```typescript
  bus.respond('payment_get_token', async (cmd) => {
    return await stripe.createToken(cmd.target);
  });
  const result = await bus.request('payment_get_token', { amount: 100 });
  ```

- **Per-command debounce/throttle at register time** (`src/command-bus.ts`): `register()` now accepts an optional third argument with `{ debounce, throttle }` in milliseconds. Wraps the handler transparently — no need for a global debounce/throttle plugin for individual commands.

  ```typescript
  bus.register('shop_cart_item_updated', handler, { throttle: 500 });
  bus.register('shop_selection_updated', trackHandler, { debounce: 3000 });
  ```

- **Undo handler registration** (`src/command-bus.ts`): `register()` now accepts `{ undo: handler }` to associate an inverse handler with a command. Retrieved via `bus.getUndoHandler(action)`. Used by the `history` plugin and `useCommandHistory` composable to execute real undo operations.

  ```typescript
  bus.register('cart_add', addHandler, {
    undo: (cmd) => removeFromCart(cmd.target.productId)
  });
  ```

- **Auto-cleanup on Vue component unmount** (`src/chamber.ts`): `useCommand()`, `useCommandState()`, and `useCommandHistory()` now detect if they're called inside a Vue component's `setup()` context. If so, they automatically register their `dispose()` function on `onUnmounted()`. Falls back to manual `dispose()` when called outside a component (Node, tests, non-Vue contexts).

- **`resetCommandBus()` export** (`src/chamber.ts`): Resets the shared singleton bus to `null`. Call in `afterEach()` to prevent handler leaks between test files.

- **`authGuard` plugin** (`src/plugins.ts`): Blocks commands matching protected action prefixes when the user is not authenticated. Calls an optional `onUnauthenticated` callback with the blocked command for intent storage / login redirect.

  ```typescript
  bus.use(authGuard({
    isAuthenticated: () => window.isCustomer,
    protected: ['shop_cart_', 'shop_wishlist_', 'shop_checkout_'],
    onUnauthenticated: (cmd) => storeIntent(cmd),
  }));
  ```

- **`optimistic` plugin** (`src/plugins.ts`): Applies optimistic state updates before the handler executes. If the handler fails, automatically calls the rollback function returned by `apply()`.

  ```typescript
  bus.use(optimistic({
    'cart_update_qty': {
      apply: (cmd) => {
        const prev = cart.qty;
        cart.qty = cmd.target.qty;
        return () => { cart.qty = prev; }; // rollback
      }
    }
  }));
  ```

- **Generic type parameters** (`src/command-bus.ts`): `Command`, `CommandResult`, and `Handler` types now accept generic type parameters for type-safe payloads and return values at the application level.

### Tests

- Added tests for: naming convention enforcement, wildcard listeners, request/response, undo handler registration, per-command throttle, `resetCommandBus`, `authGuard` plugin, `optimistic` plugin, history with bus-backed undo/redo.
- All test files now use `resetCommandBus()` in `afterEach` to prevent cross-test contamination.

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

- **`newTodoText` reactivity bug** (`examples/vue-vapor-component.vue`): Form input was declared as a plain `let` variable. Mutations to it never triggered re-renders because the value was outside the signal system. Changed to `const newTodoText = signal('')` so input changes propagate correctly through Vapor's reactivity.

- **Redundant stats recomputation** (`examples/vue-vapor-component.vue`): `getStats()` was called four times in the template, re-filtering the items array on each binding. Replaced with a `stats` signal updated once via `bus.onAfter()`, so the template reads stable signal values across all bindings.

- **Debounce plugin memory leak** (`src/plugins.ts`): The `results` map was never cleared — every debounced key accumulated an entry for the lifetime of the plugin. Added a `setTimeout(..., 0)` after result storage to delete the entry after the current tick.

- **Throttle plugin memory leak** (`src/plugins.ts`): The `lastRun` map was never pruned — every unique `action:target` key stayed in the map indefinitely. Added a `setTimeout` equal to `wait` to delete the entry once the throttle window expires.

- **`useCommand` lifecycle leak** (`src/chamber.ts`): `register` and `use` were forwarded directly from the raw bus with no shared cleanup path. Wrapped both in local tracker functions that collect unregister callbacks and exposed a `dispose()` method to tear them all down together.

- **Proxy trap breakage via private global access** (`src/chamber.ts`): The signal factory was detected by probing `window.__VUE_VAPOR__`, a non-standard internal property. Accessing private properties on proxy-backed objects bypasses proxy traps and relies on unstable implementation details. Removed the runtime probe entirely and replaced it with an explicit `configureSignal(fn)` API that lets the host app inject the Vapor signal factory at setup time.

- **Reactivity loss from destructuring** (`examples/vue-vapor-component.vue`): `getFilteredItems` destructured `{ items, filter }` from `todos.value`. Destructuring a signal's value into local bindings loses reactivity if the binding is ever captured in a longer-lived closure. Changed to direct property access (`todos.value.items`, `todos.value.filter`) so all reads go through the signal getter.

- **`v-model` on a signal object** (`examples/vue-vapor-component.vue`): After `newTodoText` became a signal, the template still used `v-model="newTodoText"`. Vue's `v-model` shorthand only works with plain reactive refs — on a custom signal object it binds to the object reference, not `.value`. Replaced with explicit `:value="newTodoText.value"` + `@input` handler.

- **`.trim()` called on signal object** (`examples/vue-vapor-component.vue`): The submit button's `:disabled` binding read `!newTodoText.trim()` after `newTodoText` became a signal. `Signal<string>` has no `.trim()` method — runtime error. Fixed to `!newTodoText.value.trim()`.

- **`bus.onAfter()` return value discarded** (`examples/vue-vapor-component.vue`): The stats hook returned an unsubscribe function that was never captured. The hook would remain alive after unmount, updating a stale signal. Captured into `unsubscribeStats` and documented the `onUnmounted` call site.

- **`AsyncHandler` type collapsed to `any`** (`src/command-bus.ts`): The type was `(cmd: Command) => any | Promise<any>`. The union `any | Promise<any>` simplifies to `any` in TypeScript's type algebra, erasing all return-type information. Changed to `(cmd: Command) => Promise<any>`.

- **Dead `listeners` array in fallback signal** (`src/chamber.ts`): `fallbackSignal` allocated a `listeners` array and iterated it on every setter call, but nothing could ever push into it (no subscribe API). The array was always empty, making the `forEach` a permanent no-op. Removed; Vapor's compiler tracks signal reads/writes itself without a listener mechanism.

- **Stale `~1KB` size claim** (`src/index.ts`, `src/command-bus.ts`): Header comments still referenced the original size estimate. Updated to reflect the current `~2KB gzipped` figure.

- **Wrong import path in JSDoc** (`src/devtools.ts`): The `@example` block showed `import { setupDevtools } from 'vapor-chamber/devtools'`, but no such subpath export exists. The correct import is from `'vapor-chamber'`. Fixed.

### Performance

- **Plugin chain no longer rebuilt on every dispatch** (`src/command-bus.ts`): Both `createCommandBus` and `createAsyncCommandBus` previously called `plugins.reduceRight(...)` on every `dispatch()`, allocating a new closure per plugin per call. Replaced with a cached `runner` function built once when plugins are added or removed. On each dispatch only the innermost `execute` function is created; the plugin traversal uses a local index counter with no additional allocations. The runner is rebuilt only when `use()` or its unregister function is called — both rare at runtime.

### Added

- **`signal` and `configureSignal` exports** (`src/index.ts`, `src/chamber.ts`): The signal factory and its configuration function are now part of the public API. `configureSignal(fn)` is the supported way to inject Vue Vapor's native signal implementation; `signal` exposes the same factory the composables use internally.

- **DevTools integration** (`src/devtools.ts`): New `setupDevtools(bus, app)` function connects any `CommandBus` or `AsyncCommandBus` to Vue DevTools. Adds a **Commands** timeline layer (green for success, red for error) and a **Vapor Chamber** inspector panel with filterable command history and full target/payload/result detail on selection. Requires `@vue/devtools-api` as an optional peer dependency — dynamically imported, silently no-ops if not installed, zero impact on production bundle size.

- **Roadmap in README** (`README.md`): Added a Roadmap table tracking planned features (DevTools, persistence plugin, command batching, middleware ordering API) and their current status.

### Documentation

- **Whitepaper §5.1 updated** (`docs/whitepaper.md`): Replaced stale `window.__VUE_VAPOR__` code sample with the `configureSignal()` API and an explanation of why explicit injection is preferred.

- **Whitepaper §8.2 updated** (`docs/whitepaper.md`): Updated from "consider caching the chain" to documenting the implemented cached-runner solution.

- **Bundle size claim corrected** (`README.md`, `docs/whitepaper.md`): Updated from the outdated "~1KB" to the current estimate of ~4KB minified / ~2KB gzipped for the core (command bus + plugins + composables). DevTools are dynamically imported and do not count toward this figure.

- **README API table updated** (`README.md`): Added `configureSignal`, `setupDevtools`, and per-composable `dispose()` notes.

### Acknowledgements

Thanks to **@Aniruddha Adak** for the discussion and remarks on Vue reactivity edge cases — specifically around proxy trap safety, `<script setup>` destructuring pitfalls, and the importance of using standard exposed endpoints over internal runtime properties. Those notes directly informed several fixes in this release.
