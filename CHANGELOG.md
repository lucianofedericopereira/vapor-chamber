# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
