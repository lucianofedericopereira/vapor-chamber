# SSR with Vapor Chamber

> **Status:** Vue Vapor SSR is not yet stable. This document describes the intended approach — update as the Vapor compiler and runtime mature.

## The Challenge

Vue Vapor's signal-based reactivity is designed for direct DOM updates. On the server there is no DOM, so signals work as plain values. The challenge is **hydration**: commands that ran on the server (e.g. to populate initial state) need to replay on the client so reactive signals reflect the same values from the start.

## Approach: Dehydrate & Rehydrate

### 1. Server: capture dispatched commands

Use `onAfter` to collect every command that shapes initial state:

```typescript
// server-entry.ts
import { getCommandBus } from 'vapor-chamber';

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
```

### 2. Client: replay before mount

Before mounting the app, replay the captured commands so signals are pre-populated:

```typescript
// client-entry.ts
import { getCommandBus, configureSignal } from 'vapor-chamber';
import { signal } from 'vue-vapor';

configureSignal(signal);

const bus = getCommandBus();
const commands = window.__VAPOR_COMMANDS__ ?? [];

// Replay synchronously — signals update before any component reads them
for (const { action, target, payload } of commands) {
  bus.dispatch(action, target, payload);
}

// Now mount — signals already hold server-rendered values
app.mount('#app');
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
    'cart.add': (state, cmd) => ({ ... }),
  }
);
```

This is simpler and avoids the replay mechanism altogether when initial state can be serialized directly.

## Recommendations

| Scenario | Recommended approach |
|----------|---------------------|
| Simple initial state (list of items, user profile) | Seed signals from JSON, no replay needed |
| State that results from a sequence of commands | Dehydrate command log on server, replay on client |
| Side-effectful commands (analytics, API calls) | Use a `hydrating` plugin to suppress during replay |
| Commands with non-serializable targets (DOM nodes, class instances) | Serialize only the essential fields; reconstruct on client |

## Notes

- `createTestBus()` already bypasses real handlers, making it straightforward to test server-rendered state without DOM or network.
- As Vue Vapor's SSR API stabilizes, `configureSignal` will be updated to accept Vapor's official server signal factory.
- Track progress in the [Vue Vapor repository](https://github.com/vuejs/vue-vapor).
