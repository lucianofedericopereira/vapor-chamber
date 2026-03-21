# SSR with Vapor Chamber

> **Status:** Vue 3.6 Vapor SSR is in beta. This document describes the intended approach — update as the Vapor compiler and runtime mature.

## The Challenge

Vue Vapor's signal-based reactivity (alien-signals in 3.6+) is designed for direct DOM updates. On the server there is no DOM, so signals work as plain values. The challenge is **hydration**: commands that ran on the server (e.g. to populate initial state) need to replay on the client so reactive signals reflect the same values from the start.

## Lifecycle Compatibility

Vapor Chamber v0.4.0 uses `onScopeDispose` (Vue 3.5+) as the primary cleanup hook, falling back to `onUnmounted`. This is important for SSR because:

- `onScopeDispose` works in `effectScope()` contexts on the server
- It does not require a component instance (unlike `onUnmounted`)
- It works identically in VDOM, Vapor, and SSR environments

## Approach: Dehydrate & Rehydrate

### 1. Server: capture dispatched commands

Use `onAfter` to collect every command that shapes initial state:

```typescript
// server-entry.ts
import { getCommandBus, resetCommandBus } from 'vapor-chamber';

// Fresh bus per request — prevents cross-request state leakage
resetCommandBus();
const bus = getCommandBus();

const serverCommands: Array<{ action: string; target: any; payload?: any }> = [];

bus.onAfter((cmd, result) => {
  if (result.ok) {
    serverCommands.push({ action: cmd.action, target: cmd.target, payload: cmd.payload });
  }
});

// Run your app setup (populate state via commands)
await setupApp();

// Serialize for the client
const dehydrated = JSON.stringify(serverCommands);
// Embed in HTML: <script>window.__VAPOR_COMMANDS__ = /* dehydrated */</script>

// Clean up to prevent leaks between requests
resetCommandBus();
```

### 2. Client: replay before mount

Before mounting the app, replay the captured commands so signals are pre-populated:

```typescript
// client-entry.ts — VDOM mode
import { createApp } from 'vue';
import { getCommandBus } from 'vapor-chamber';

const bus = getCommandBus();
const commands = window.__VAPOR_COMMANDS__ ?? [];

// Replay synchronously — signals update before any component reads them
for (const { action, target, payload } of commands) {
  bus.dispatch(action, target, payload);
}

// Now mount — signals already hold server-rendered values
createApp(App).mount('#app');
```

```typescript
// client-entry.ts — Vapor mode (Vue 3.6+)
import { createVaporChamberApp, getCommandBus } from 'vapor-chamber';

const bus = getCommandBus();
const commands = window.__VAPOR_COMMANDS__ ?? [];

for (const { action, target, payload } of commands) {
  bus.dispatch(action, target, payload);
}

// Vapor app — no VDOM runtime
createVaporChamberApp(App).mount('#app');
```

### 3. Avoid double-execution of side effects

Commands replayed during hydration should not re-trigger analytics, network calls, or other side effects. Use a plugin to suppress them during replay:

```typescript
let hydrating = true;

const hydratingPlugin: Plugin = (cmd, next) => {
  if (hydrating && isSideEffect(cmd.action)) {
    // Skip side effect, still run the state update
    return { ok: true, value: undefined };
  }
  return next();
};

bus.use(hydratingPlugin);

// Replay commands
for (const cmd of commands) {
  bus.dispatch(cmd.action, cmd.target, cmd.payload);
}

hydrating = false;
```

## Signal Hydration Without Replay

If your server renders state into JSON separately (e.g. via `useAsyncData`), you can seed signals directly without replaying commands:

```typescript
import { useCommandState } from 'vapor-chamber';

// State initialized from server-rendered JSON, not from command replay
const { state } = useCommandState(
  window.__INITIAL_CART__ ?? { items: [], total: 0 },
  {
    'cart_add': (state, cmd) => ({ ... }),
  }
);
```

This is simpler and avoids the replay mechanism altogether when initial state can be serialized directly.

## Mixed VDOM/Vapor SSR

When using `vaporInteropPlugin` for mixed component trees:

```typescript
import { createApp, vaporInteropPlugin } from 'vue';
import { getVaporInteropPlugin, getCommandBus } from 'vapor-chamber';

const app = createApp(App);

// Enable mixed rendering
const interop = getVaporInteropPlugin();
if (interop) app.use(interop);

// Hydrate commands first
const bus = getCommandBus();
for (const cmd of window.__VAPOR_COMMANDS__ ?? []) {
  bus.dispatch(cmd.action, cmd.target, cmd.payload);
}

app.mount('#app');
```

Both VDOM and Vapor components share the same command bus singleton, so hydrated state is available to all components regardless of rendering mode.

## Recommendations

| Scenario | Recommended approach |
|----------|---------------------|
| Simple initial state (list of items, user profile) | Seed signals from JSON, no replay needed |
| State that results from a sequence of commands | Dehydrate command log on server, replay on client |
| Side-effectful commands (analytics, API calls) | Use a `hydrating` plugin to suppress during replay |
| Commands with non-serializable targets | Serialize only essential fields; reconstruct on client |
| Multiple SSR requests in parallel | Use `resetCommandBus()` per request to prevent leaks |

## Per-Request Bus Isolation

For production SSR with concurrent requests, create a fresh bus per request instead of using the singleton:

```typescript
import { createCommandBus, setCommandBus, resetCommandBus } from 'vapor-chamber';

export async function handleRequest(req, res) {
  // Fresh bus for this request
  const bus = createCommandBus();
  setCommandBus(bus);

  try {
    // ... render app, dispatch commands ...
  } finally {
    resetCommandBus(); // prevent cross-request contamination
  }
}
```

## Notes

- `createTestBus()` already bypasses real handlers, making it straightforward to test server-rendered state.
- `resetCommandBus()` (v0.3.0+) is essential for SSR — always call it in request teardown.
- `onScopeDispose` (v0.4.0) is the correct cleanup hook for SSR composable usage.
- As Vue Vapor's SSR API stabilizes, `configureSignal` will be updated to accept Vapor's official server signal factory.
- Track progress in the [Vue core repository](https://github.com/vuejs/core).
