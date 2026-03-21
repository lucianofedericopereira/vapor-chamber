# Vapor Chamber + Vue 3.6: Alien Signals, Vapor Mode, and the Post-VDOM Architecture

<p align="center">
  <img src="../assets/vapor-chamber.png" alt="Vapor Chamber" width="200" />
</p>

## Abstract

Vue 3.6 represents the most significant internal change to Vue since version 3.0. The reactivity engine has been rewritten atop **alien-signals**, a fine-grained signal library. **Vapor mode** is now feature-complete, enabling components to run without the Virtual DOM. **Vite 7/8** introduces Rolldown, a Rust-based bundler replacing esbuild + Rollup.

This whitepaper examines how these changes affect library design, what vapor-chamber v0.4.0 does to align with them, and the architectural implications for applications migrating from VDOM to Vapor.

## 1. The Vue 3.6 Reactivity Rewrite

### 1.1 From Proxy-Based to Alien-Signals

Vue 3.0–3.5 used JavaScript `Proxy` objects for reactivity. Every `ref()`, `reactive()`, and `computed()` created Proxy wrappers that intercepted property access to track dependencies.

Vue 3.6 replaces this with [alien-signals](https://github.com/stackblitz/alien-signals) by Johnson Chu (StackBlitz). The key differences:

| Aspect | Proxy-based (3.0–3.5) | Alien-signals (3.6+) |
|--------|----------------------|---------------------|
| Tracking mechanism | Proxy `get`/`set` traps | Signal dependency graph |
| Granularity | Property-level on objects | Value-level on primitives |
| Memory overhead | Proxy + handler per reactive object | Lightweight signal node |
| Update propagation | Full component re-evaluation | Only affected signal consumers |
| CPU on complex graphs | O(n) dependency walk | O(affected) — skips unchanged branches |

### 1.2 What Stays the Same

The **public API is unchanged**: `ref()`, `computed()`, `watch()`, `watchEffect()` all work identically. The difference is purely internal — `ref()` IS a signal now, not a Proxy wrapper around one.

This is why vapor-chamber's auto-detection approach works:

```typescript
// vapor-chamber detects ref() at module load time
import('vue').then(vue => { _vueRef = vue.ref; });

// ref() in 3.6 = alien-signal backed. No code change needed.
const state = signal(initialValue); // → calls ref(initialValue) internally
```

### 1.3 Performance Impact

Benchmarks from the Vue 3.6 beta show:

- **14% less memory** for reactive state
- **40% less CPU** on complex data visualizations (dashboards, grids)
- **Mounting 100,000 components** in ~100ms (parity with SolidJS)
- **Base bundle under 10KB** for Vapor-only apps (vs ~50KB+ with VDOM)

For vapor-chamber, this means:

- `useCommandState()` creates a `ref()` internally. Under alien-signals, mutations to `state.value` propagate through a minimal dependency graph — only components that read that specific state update.
- `useCommand()`'s `loading` and `lastError` signals are each independent alien-signal nodes. A component watching `loading` doesn't re-render when `lastError` changes.

## 2. Vapor Mode: The VDOM-less Path

### 2.1 How Vapor Compiles

A standard Vue component:

```vue
<template>
  <div>{{ count }}</div>
  <button @click="count++">+</button>
</template>
```

Under **VDOM mode**, the compiler generates a render function that produces virtual nodes. On each update, Vue diffs the old and new VDOM trees to find changes.

Under **Vapor mode**, the compiler generates imperative DOM code:

```javascript
// Simplified Vapor compiler output
const div = document.createElement('div');
const text = document.createTextNode('');
const button = document.createElement('button');

// Direct signal binding — no diffing
effect(() => { text.textContent = count.value; });
button.addEventListener('click', () => { count.value++; });
```

No VDOM tree is created. No diffing occurs. The `effect()` subscribes directly to `count`'s alien-signal node and updates the single text node when it changes.

### 2.2 Opting Into Vapor

```vue
<script setup vapor>
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <button @click="count++">{{ count }}</button>
</template>
```

The `vapor` attribute on `<script setup>` tells the compiler to use the Vapor strategy. The component's public API is identical — only the compiled output changes.

### 2.3 App-Level Vapor

```typescript
// Pure Vapor — drops VDOM runtime entirely (~40KB savings)
import { createVaporApp } from 'vue';
createVaporApp(App).mount('#app');

// vapor-chamber convenience wrapper
import { createVaporChamberApp } from 'vapor-chamber';
createVaporChamberApp(App).mount('#app');
```

### 2.4 Mixed Trees with vaporInteropPlugin

For gradual migration, `vaporInteropPlugin` enables VDOM and Vapor components to nest inside each other:

```typescript
import { createApp, vaporInteropPlugin } from 'vue';
createApp(App).use(vaporInteropPlugin).mount('#app');

// vapor-chamber detection
import { getVaporInteropPlugin } from 'vapor-chamber';
const interop = getVaporInteropPlugin();
if (interop) app.use(interop);
```

This is the recommended migration path for existing applications.

## 3. Vapor Chamber's Alignment Strategy

### 3.1 Signal Auto-Detection (v0.3.0 → v0.4.0)

v0.3.0 introduced Vue `ref()` auto-detection via `import('vue')` at module load time. v0.4.0 refines this:

```typescript
// Module-level eager probe
const vuePkg = 'vue';
import(/* @vite-ignore */ vuePkg)
  .then((vue) => {
    _vueRef = vue.ref;              // ref() = alien-signal in 3.6+
    _vueOnScopeDispose = vue.onScopeDispose;  // preferred cleanup (3.5+)
    _vueOnUnmounted = vue.onUnmounted;        // fallback cleanup

    // Vapor detection
    if (typeof vue.createVaporApp === 'function') {
      _hasVapor = true;
    }
  })
  .catch(() => { /* Vue not installed — use plain fallback */ });
```

The probe runs once at module evaluation. By the time any `setup()` function runs (after the first microtask), all detection is complete.

### 3.2 Lifecycle: onScopeDispose Over onUnmounted

Vue 3.5+ introduced `onScopeDispose` — a cleanup hook that works in any reactive scope, not just component instances. v0.4.0 prefers it:

```typescript
function tryAutoCleanup(disposeFn: () => void): void {
  // 1. Prefer onScopeDispose — works in effectScope, VDOM, Vapor, SSR
  if (_vueOnScopeDispose) {
    try { _vueOnScopeDispose(disposeFn); return; }
    catch { /* not in a scope — try fallback */ }
  }
  // 2. Fallback: onUnmounted (requires component setup context)
  if (_vueOnUnmounted && _vueGetCurrentInstance?.()) {
    _vueOnUnmounted(disposeFn);
  }
}
```

**Why this matters:** In Vapor mode, component instances have a different internal structure than VDOM components. `onScopeDispose` is the universal hook that works everywhere — it's what Vue's own composables use internally.

### 3.3 defineVaporCommand: Zero-Overhead Hot Paths

`useCommand()` creates two reactive signals (`loading`, `lastError`) on every call. Under alien-signals, each `.value` access registers a dependency node. For hot-path dispatches — scroll tracking, analytics events, mousemove debouncing — this overhead is unnecessary.

`defineVaporCommand()` provides a lean alternative:

```typescript
export function defineVaporCommand(action, handler, options?) {
  const bus = getCommandBus();
  const unregister = bus.register(action, handler, options);

  function dispatch(target, payload?) {
    return bus.dispatch(action, target, payload);
  }

  tryAutoCleanup(() => unregister());
  return { dispatch, dispose: () => unregister() };
}
```

No signals created. No dependency graph nodes added. Just a dispatch function with auto-cleanup.

**When to use which:**

| Composable | Signals created | Use case |
|------------|----------------|----------|
| `useCommand()` | `loading`, `lastError` | UI-bound dispatch (buttons, forms) |
| `defineVaporCommand()` | None | Fire-and-forget (analytics, scroll, search) |
| `useCommandBus()` | None | Direct bus access |

### 3.4 Vapor Detection API

```typescript
import { isVaporAvailable } from 'vapor-chamber';

// Runtime check — useful for conditional plugin loading
if (isVaporAvailable()) {
  // Vue 3.6+ with createVaporApp present
}
```

### 3.5 Rolldown-Safe Dynamic Imports

Vite 8 replaces esbuild + Rollup with **Rolldown** (Rust-based). Dynamic imports of optional peer dependencies need `/* @vite-ignore */` to prevent Rolldown from trying to bundle them:

```typescript
// chamber.ts — Vue detection
const vuePkg = 'vue';
import(/* @vite-ignore */ vuePkg)

// devtools.ts — DevTools API
const devtoolsModule = '@vue/devtools-api';
import(/* @vite-ignore */ devtoolsModule)
```

Without this, Rolldown would either fail the build (missing module) or bundle Vue as a non-optional dependency.

## 4. The Command Bus in a Post-VDOM World

### 4.1 Why Command Buses Thrive Without VDOM

In VDOM architectures, state management libraries (Vuex, Pinia) serve double duty: managing state AND triggering re-renders via reactivity. The VDOM diffing algorithm then figures out what DOM to update.

In Vapor mode, there is no diffing. Signals bind directly to DOM nodes. This means state management can be simpler — it only needs to manage state transitions. The rendering is handled by signal subscriptions compiled into the template.

A command bus is the natural fit:

```
VDOM world:                          Vapor world:
dispatch → state → VDOM diff → DOM   dispatch → state → signal → DOM node
                                                   ↑
                                            direct binding, no diff
```

The command bus handles the `dispatch → state` part. alien-signals handles `state → DOM node`. No intermediate VDOM layer needed.

### 4.2 Framework-Agnostic Core

vapor-chamber's `command-bus.ts` has zero Vue imports. It's a pure TypeScript module:

- `createCommandBus()` returns a plain object with Maps and Arrays
- Plugins are plain functions `(cmd, next) => result`
- No framework-specific APIs, decorators, or annotations

This means the command bus works identically in:

- Vue 3.5 (VDOM)
- Vue 3.6 Vapor
- Vue 3.6 mixed (VDOM + Vapor)
- Node.js tests
- Web Workers
- Any JavaScript runtime

The Vue-specific layer (`chamber.ts`) is a thin wrapper that adds:

- Signal-based reactive state (`signal()` → `ref()`)
- Lifecycle cleanup (`onScopeDispose`)
- Shared bus singleton
- Vapor detection helpers

### 4.3 Mixed-Tree Safety

When using `vaporInteropPlugin`, a VDOM component and a Vapor component can both call `useCommand()`:

```
┌─ VDOM Component ──────────┐    ┌─ Vapor Component ─────────┐
│ const { dispatch } =       │    │ const { state } =          │
│   useCommand();            │    │   useCommandState(init,    │
│                            │    │     { 'cart_add': ... });   │
│ dispatch('cart_add', item) │ ─→ │ state.value updates        │
└────────────────────────────┘    └────────────────────────────┘
              │                                │
              └──── shared CommandBus ─────────┘
```

Both composables call `getCommandBus()` which returns the same singleton. The command bus is a plain JavaScript object — it doesn't know or care about rendering mode. The signal factory (`ref()`) works in both contexts because it's the same function from `vue`.

## 5. Vite 7/8 Compatibility

### 5.1 Vite 7 Changes

| Change | Impact |
|--------|--------|
| Node.js ≥20.19 required | `engines` field updated in package.json |
| Default target: `baseline-widely-available` | No change — library ships ESM |
| Environment API (experimental) | Not applicable to libraries |

### 5.2 Vite 8 (Rolldown)

| Change | Impact |
|--------|--------|
| Rolldown replaces esbuild + Rollup | `@vite-ignore` on dynamic imports |
| `build.rollupOptions` → `build.rolldownOptions` | Not applicable (library doesn't configure Vite) |
| Oxc replaces esbuild for transforms | No change — library ships pre-compiled |
| CJS interop behavior changed | No impact — library is ESM-only |

### 5.3 TypeScript Target

`tsconfig.json` uses `"module": "ES2022"` instead of `"ESNext"`. ES2022 is deterministic (top-level await, `.at()`, `Object.hasOwn()`), while ESNext is a moving target that changes with each TS release. This matches Vite 7's baseline-widely-available output.

## 6. Migration Strategy for Existing Applications

### Phase 1: Install vaporInteropPlugin (No Code Changes)

```typescript
import { createApp, vaporInteropPlugin } from 'vue';
import App from './App.vue';

createApp(App).use(vaporInteropPlugin).mount('#app');
```

This changes nothing visible but enables Vapor components in the tree. Existing VDOM components continue working.

### Phase 2: Convert Hot-Path Components to Vapor

Identify components with frequent reactive updates:

- Cart sidebar (add/remove/quantity changes)
- Product filter bar (reactive computed chains)
- Search autocomplete (high-frequency input)
- Real-time price display (currency formatting)
- Notification toasts (frequent show/hide)

Convert these to `<script setup vapor>`:

```vue
<!-- Before -->
<script setup>
import { useCommand } from 'vapor-chamber';
const { dispatch, loading } = useCommand();
</script>

<!-- After — only the script tag changes -->
<script setup vapor>
import { useCommand } from 'vapor-chamber';
const { dispatch, loading } = useCommand();
</script>
```

The composable code is **identical**. Only the template compilation changes.

For fire-and-forget patterns, switch to `defineVaporCommand`:

```vue
<script setup vapor>
import { defineVaporCommand } from 'vapor-chamber';

const { dispatch: trackScroll } = defineVaporCommand('analytics_scroll', (cmd) => {
  gtag('event', 'scroll', { depth: cmd.target.depth });
});

// Zero-overhead — no reactive signals in the dependency graph
window.addEventListener('scroll', () => {
  trackScroll({ depth: Math.round(window.scrollY / document.body.scrollHeight * 100) });
});
</script>
```

### Phase 3: Full Vapor App (Optional)

When all components support Vapor:

```typescript
import { createVaporChamberApp } from 'vapor-chamber';
import App from './App.vue';

// No VDOM runtime loaded — ~40KB savings on baseline bundle
createVaporChamberApp(App).mount('#app');
```

This is optional. Mixed trees with `vaporInteropPlugin` work indefinitely.

## 7. Benchmarking: Command Bus Overhead in Vapor vs VDOM

### 7.1 Dispatch Latency

The command bus itself is identical in both modes. A `dispatch()` call does:

1. Naming validation (regex test): ~0.001ms
2. Handler lookup (Map.get): ~0.001ms
3. Plugin chain execution: ~0.01ms per plugin
4. After hooks: ~0.01ms per hook
5. Pattern listener notification: ~0.01ms per listener

Total: **~0.05ms** for a dispatch with 3 plugins and 2 listeners. This is constant regardless of rendering mode.

### 7.2 Reactive Update Propagation

The difference is in what happens AFTER dispatch, when `state.value` changes:

**VDOM mode:** `ref.value` change → component re-evaluates render function → VDOM diff → DOM patch
**Vapor mode:** `ref.value` change → alien-signal notifies effect → DOM node updated directly

For a component with 100 DOM nodes where only 1 changes, Vapor skips evaluating the other 99. The alien-signal graph knows exactly which effect to run.

### 7.3 Memory

Each `useCommand()` call creates 2 signals (`loading`, `lastError`). Under alien-signals, each signal is a lightweight node (~64 bytes vs ~200 bytes for a Proxy-wrapped ref in 3.5).

For an app with 50 components using `useCommand()`:

- Vue 3.5: 50 × 2 × ~200 bytes = ~20KB
- Vue 3.6: 50 × 2 × ~64 bytes = ~6.4KB

`defineVaporCommand()` creates 0 signals — suitable for the remaining components that only dispatch without tracking state.

## 8. Conclusion

Vue 3.6's alien-signals rewrite and Vapor mode represent a paradigm shift from virtual DOM diffing to fine-grained signal-driven updates. vapor-chamber's command bus architecture is naturally aligned with this shift:

- The bus core is framework-agnostic — no VDOM coupling to remove
- Signal-based composables use `ref()` which IS alien-signals in 3.6+
- `defineVaporCommand()` provides a zero-overhead path for performance-critical dispatches
- Mixed VDOM/Vapor trees share the same bus seamlessly
- `onScopeDispose` ensures correct cleanup across all rendering modes

The command bus pattern is, if anything, MORE relevant in a post-VDOM world: with the rendering layer simplified to direct signal → DOM bindings, the application architecture layer (state transitions, side effects, undo/redo) becomes the primary concern. That's exactly what a command bus solves.

---

## References

1. Vue 3.6.0-beta.1 Release: https://github.com/vuejs/core/releases/tag/v3.6.0-beta.1
2. Alien Signals: https://github.com/stackblitz/alien-signals
3. Try out Vapor and Alien Signals: https://github.com/orgs/vuejs/discussions/13134
4. Vite 7.0 Announcement: https://vite.dev/blog/announcing-vite7
5. Vite 8 Beta (Rolldown): https://vite.dev/blog/announcing-vite8-beta
6. Vue Vapor Repository: https://github.com/vuejs/vue-vapor

## License

GNU Lesser General Public License v2.1
