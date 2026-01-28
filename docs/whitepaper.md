# Vapor Chamber: Design Philosophy and Architecture

<p align="center">
  <img src="../assets/vapor-chamber.png" alt="Vapor Chamber" width="200" />
</p>

## Abstract

Vapor Chamber is a lightweight (~1KB) command bus designed specifically for Vue Vapor, Vue's upcoming Virtual DOM-less compilation strategy. This document describes the design philosophy, architectural decisions, and technical implementation of the library.

## 1. Introduction

### 1.1 The Problem

Modern frontend applications face a common architectural challenge: managing complex state transitions and side effects across many components. Traditional approaches include:

- **Event Emitters**: Scatter logic across components, making it hard to trace data flow
- **Global State Stores**: Often over-engineered for simple applications, introduce boilerplate
- **Direct Method Calls**: Create tight coupling between components

### 1.2 The Solution

Vapor Chamber introduces the **Command Bus** pattern to Vue applications:

```
User Action → Command → Handler → Result
                ↓
            Plugins (observe, validate, transform)
```

A command bus centralizes action handling while remaining lightweight and composable.

## 2. Design Principles

### 2.1 Minimal by Default

The core library weighs approximately 1KB minified. This is achieved through:

- Zero external dependencies
- No runtime framework abstractions
- Simple data structures (Maps, Arrays)
- Tree-shakeable exports

### 2.2 Vapor-Native

Vue Vapor eliminates the Virtual DOM in favor of direct DOM updates via **signals**. Vapor Chamber aligns with this philosophy:

- Uses signal-based reactivity for composables
- No VDOM reconciliation overhead
- Direct state updates without intermediate representations

### 2.3 Composition Over Configuration

Instead of a monolithic configuration object, Vapor Chamber uses composable plugins:

```typescript
const bus = createCommandBus();
bus.use(logger());           // Add logging
bus.use(validator(rules));   // Add validation
bus.use(history());          // Add undo/redo
```

Each plugin is independent and can be added or removed at runtime.

### 2.4 Predictable Execution

- **Synchronous by default**: `dispatch()` returns immediately with a result
- **Explicit async**: Use `createAsyncCommandBus()` when async is needed
- **Result objects**: Every dispatch returns `{ ok, value?, error? }`

## 3. Architecture

### 3.1 Core Components

```
┌─────────────────────────────────────────────────────────┐
│                    Command Bus                          │
├─────────────────────────────────────────────────────────┤
│  Handlers Map        │  Plugins Array   │  Hooks Array  │
│  action → handler    │  [p1, p2, p3]    │  [h1, h2]     │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│                   Dispatch Flow                         │
├─────────────────────────────────────────────────────────┤
│  1. Create Command { action, target, payload }          │
│  2. Look up handler                                     │
│  3. Build plugin chain (right-to-left)                  │
│  4. Execute chain                                       │
│  5. Run after hooks                                     │
│  6. Return result                                       │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Command Structure

A command consists of three parts:

| Property | Type | Description |
|----------|------|-------------|
| `action` | `string` | Identifier for the command (e.g., `cart.add`) |
| `target` | `any` | The entity being acted upon |
| `payload` | `any?` | Additional data for the action |

This structure separates **what** (action) from **whom** (target) and **how** (payload).

### 3.3 Plugin Pipeline

Plugins form a middleware chain using function composition:

```typescript
// Plugins are applied right-to-left
const chain = plugins.reduceRight(
  (next, plugin) => () => plugin(cmd, next),
  execute  // innermost: the actual handler
);
```

This means the first plugin added wraps the outermost layer:

```
dispatch() → Plugin1 → Plugin2 → Plugin3 → Handler
         ←          ←          ←          ←
```

### 3.4 Result Type

All dispatches return a discriminated result:

```typescript
type CommandResult = {
  ok: boolean;     // Success or failure
  value?: any;     // Handler return value (if ok)
  error?: Error;   // Error thrown (if not ok)
};
```

This enables explicit error handling without try-catch:

```typescript
const result = bus.dispatch('cart.add', product);
if (result.ok) {
  notify('Added to cart');
} else {
  showError(result.error.message);
}
```

## 4. Plugin System

### 4.1 Plugin Contract

A plugin is a function that receives a command and a `next` function:

```typescript
type Plugin = (cmd: Command, next: () => CommandResult) => CommandResult;
```

Plugins can:
- **Observe**: Log, track analytics, measure timing
- **Modify**: Transform commands before execution
- **Short-circuit**: Return early without calling `next()`
- **Transform**: Modify results after execution

### 4.2 Built-in Plugins

| Plugin | Purpose | Key Feature |
|--------|---------|-------------|
| `logger` | Debug output | Grouped console logs |
| `validator` | Pre-execution validation | Short-circuits on failure |
| `history` | Undo/redo tracking | Exposes `undo()`, `redo()` methods |
| `debounce` | Rate limiting | Delays until activity stops |
| `throttle` | Rate limiting | Executes at fixed intervals |

### 4.3 Custom Plugin Example

```typescript
const analyticsPlugin: Plugin = (cmd, next) => {
  const start = performance.now();
  const result = next();

  analytics.track({
    action: cmd.action,
    duration: performance.now() - start,
    success: result.ok
  });

  return result;
};
```

## 5. Vue Vapor Integration

### 5.1 Signal Detection

Vapor Chamber detects Vue Vapor's signal API at runtime:

```typescript
function getSignalFn(): CreateSignal {
  if (window.__VUE_VAPOR__?.signal) {
    return window.__VUE_VAPOR__.signal;
  }
  // Fallback for non-Vapor environments
  return createFallbackSignal;
}
```

### 5.2 Composables

Three composables provide Vapor-native integration:

**useCommand**: Dispatch with reactive loading state
```typescript
const { dispatch, loading, lastError } = useCommand();
```

**useCommandState**: State managed by commands
```typescript
const { state } = useCommandState(initial, {
  'action': (state, cmd) => newState
});
```

**useCommandHistory**: Reactive undo/redo
```typescript
const { canUndo, canRedo, undo, redo } = useCommandHistory();
```

### 5.3 Shared Bus Instance

A singleton pattern ensures all composables share the same bus:

```typescript
let sharedBus: CommandBus | null = null;

export function getCommandBus(): CommandBus {
  if (!sharedBus) {
    sharedBus = createCommandBus();
  }
  return sharedBus;
}
```

## 6. Async Support

### 6.1 Async Command Bus

For applications requiring async handlers:

```typescript
const bus = createAsyncCommandBus();

bus.register('user.fetch', async (cmd) => {
  const response = await fetch(`/api/users/${cmd.target.id}`);
  return response.json();
});

const result = await bus.dispatch('user.fetch', { id: 1 });
```

### 6.2 Async Plugins

Async plugins can perform async operations:

```typescript
const retryPlugin: AsyncPlugin = async (cmd, next) => {
  for (let i = 0; i < 3; i++) {
    const result = await next();
    if (result.ok) return result;
    await delay(1000 * i);
  }
  return { ok: false, error: new Error('Max retries') };
};
```

## 7. Comparison with Alternatives

| Feature | Vapor Chamber | Vuex/Pinia | Event Bus |
|---------|--------------|------------|-----------|
| Size | ~1KB | 10-20KB | <1KB |
| Type Safety | Full | Partial | None |
| Plugin System | Yes | Limited | No |
| Undo/Redo | Built-in | Manual | No |
| Async Support | Explicit | Implicit | N/A |
| Vue Vapor Ready | Yes | No | N/A |

## 8. Performance Considerations

### 8.1 Handler Lookup

Handlers are stored in a `Map<string, Handler>` for O(1) lookup.

### 8.2 Plugin Chain

The plugin chain is built on each dispatch using `reduceRight`. For applications with many plugins and high-frequency dispatches, consider caching the chain.

### 8.3 Memory

- Commands are plain objects (no class instances)
- History plugin limits stored commands with `maxSize`
- Cleanup functions prevent memory leaks

## 9. Future Directions

### 9.1 Planned Features

- Persistence plugin for localStorage/IndexedDB
- DevTools integration
- Command batching
- Middleware ordering API

### 9.2 Vue Vapor Stabilization

As Vue Vapor stabilizes, Vapor Chamber will:
- Update signal detection for official API
- Add SSR support
- Optimize for Vapor's compilation output

## 10. Conclusion

Vapor Chamber provides a minimal, composable command bus that aligns with Vue Vapor's philosophy of direct, efficient updates. By centralizing action handling and providing a powerful plugin system, it enables better architecture without sacrificing performance or simplicity.

---

## References

1. Vue Vapor RFC: https://github.com/vuejs/vue-vapor
2. Command Pattern: https://en.wikipedia.org/wiki/Command_pattern
3. Middleware Pattern: https://en.wikipedia.org/wiki/Middleware

## License

GNU Lesser General Public License v2.1
