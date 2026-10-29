# 14. Quick reference

The functions, options and methods an app uses most, in one place. The generated
[API reference](../api/README.md) is the complete list, with every signature.

## Core functions and bus options

| Function | Description |
|----------|-------------|
| `createCommandBus(options?)` | Create a synchronous command bus |
| `createAsyncCommandBus(options?)` | Create an async command bus |
| `createTestBus(options?)` | Create a test bus that records dispatches |
| `inspectBus(bus)` | `BusInspection` snapshot of bus topology (tree-shakeable) |
| `unsealBus(bus)` | Unseal a sealed bus (tree-shakeable escape hatch) |
| `createCommandPool(size)` | Pre-allocated Command object pool for hot paths |
| `commandKey(action, target)` | Stable `action:target` key for cache integration |

**`CommandBusOptions`**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onMissing` | `'error' \| 'throw' \| 'ignore' \| fn` | `'error'` | What happens when no handler is registered |
| `buffer` | `createBuffer()` | - | Hold a dispatch whose handler registers later, and run it then. A query never waits |
| `naming` | `{ pattern: RegExp, onViolation?: 'warn' \| 'throw' \| 'ignore' }` | `onViolation: 'warn'` | Enforce a naming convention on actions (names containing `$` are the library's and not checked) |

## Command bus methods

| Method | Description |
|--------|-------------|
| `dispatch(action, target, payload?)` | Execute a command (a write). Stamps `cmd.meta` |
| `query(action, target, payload?)` | Read-only dispatch: its rules, steps, handler and after-hooks. Not counted as pending |
| `emit(event, data?)` | Fire a domain event. Notifies `on()` listeners, needs no handler |
| `dispatchBatch(commands[], options?)` | Execute several commands -> `{ successCount, failCount, results }` |
| `register(action, handler, options?)` | Register a handler. Options: `{ undo?, canUndo?, answer?, optimistic?, exclusive?, cacheGroups?, cacheGroupInvalidation? }` |
| `use(plugin)` | Add a plugin: the bus places each part it declares |
| `onAfter(hook)` | Run after every command |
| `on(pattern, listener)` | Subscribe to matching commands (`*`, `prefix*`, exact). Returns the unsubscribe |
| `once(pattern, listener)` | Like `on()`, but unsubscribes after the first match |
| `offAll(pattern?)` | Remove the listeners for a pattern, or all |
| `request(action, target, payload?, options?)` | Async request/response with a timeout (default 5 s). `options.signal` settles it |
| `respond(action, handler)` | Register a responder for `request()` calls |
| `hasHandler(action)` | True if a handler is registered |
| `registeredActions()` | `string[]` of all registered action names |
| `clear()` | Remove all handlers, plugins, hooks and listeners |
| `seal()` | Freeze configuration: rejects register, use and clear after sealing |
| `dispose()` | Teardown: runs each plugin's `dispose()`, clears state, settles waiting `request()`s as `core:aborted:dispatch`. The bus stays usable |

## Composables and helpers

| Composable | Description |
|------------|-------------|
| `useCommand(options?)` | Vapor-safe: dispatch, `pending(action, target?)` (the bus's `commandState`), register, on and emit, with automatic cleanup. A dispatch's own failure is its result |
| `commandState(bus, options?)` | What is in flight on a bus and what failed, for any framework or none. See the notes below the table |
| `useSharedCommandState(options?)` | `commandState` on the component's bus, released with its scope. For toolbars, status bars, global spinners |
| `defineVaporCommand(action, handler, options?)` | Dispatch with no state, for hot paths |
| `useCommandHistory(options?)` | Reactive undo/redo |
| `useCommandGroup(namespace, options?)` | Namespace isolation: prefixes all calls in camelCase |
| `useCommandError(options?)` | Reactive error boundary for failed dispatches |
| `getCommandBus()` | Get the shared bus |
| `untracked(fn)` | Run a **raw-bus** dispatch without its handler's reads becoming dependencies of the surrounding effect. See the notes below the table |
| `setCommandBus(bus)` / `resetCommandBus()` | Set or reset the shared bus (useful in tests). Set it before anything calls `getCommandBus()`: replacing a bus that call already handed out splits the app between two buses, and warns in development |
| `configureSignal(fn)` | Inject a custom signal factory (auto-detected in Vue 3.6+) |
| `isVaporAvailable()` | True if Vue 3.6+ Vapor mode is detected |
| `createVaporChamberApp(component, props?)` | Create a Vapor app instance, typed so `.directive('vc-command', vcCommandVapor)` registers app-wide (`vapor-chamber/vapor`, Vue 3.6+) |
| `getVaporInteropPlugin()` | `vaporInteropPlugin` for mixed trees |
| `setupDevtools(bus, app, { facts? })` | Connect the bus to Vue DevTools (`vapor-chamber/devtools`) |

**`commandState`:**

- `pending(action, target?)` answers "is THIS one in flight?" per `commandKey(action, target)`,
  bus-wide, as its own signal: a reader re-runs only on its key.
- `anyPending` is any command in flight.
- `errors` is a ring buffer (`maxSize`, default 10), and `lastError` the newest.
- `subscribe(fn)` runs after a value moves, for a page whose signals are plain values.
- Counting starts at the first `pending()` call or `anyPending` read, and stops when the last
  handle leaves with nothing in flight. A dispatch already in flight when counting starts reads
  `false`.
- It throws `core:invalid:bus` for a bus this library did not make.

**`untracked`:** the composables above already do this. You need it only when you call
`getCommandBus()` directly from inside a `watchEffect` or `computed`. It does nothing without
Vue. **Import it from `vapor-chamber/vue`** in a Vue app: from the package root it degrades to a
pass-through in a production build.

Every composable above takes `bus` in its options, sync or async. Without it, it uses the shared
bus.

**Router:** see [docs/router.md](../router.md) for the full surface: `createRouter`,
`useRouter`, `useRoute`, `useQueryParam`, `useRouteData`, `useRouteError`, `useMenu`,
`useBreadcrumbs`, `usePagination`, `onBeforeLeave`, `RouterOutlet`.
