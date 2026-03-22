/**
 * vapor-chamber — Lightweight command bus for Vue Vapor
 *
 * Architecture:
 *   CORE (zero dependencies, framework-agnostic):
 *     command-bus  — dispatch, register, plugins, hooks, wildcard, request/respond
 *     testing      — createTestBus, snapshot, time-travel
 *
 *   OPTIONAL (tree-shaken when unused):
 *     plugins      — logger, validator, history, debounce, throttle, authGuard, optimistic
 *     plugins-io   — retry, persist, sync
 *     chamber      — Vue composables: useCommand, useCommandBus, useCommandGroup, …
 *     chamber-vapor — Vue 3.6+ Vapor-specific API (requires Vue 3.6)
 *     http         — postCommand, CSRF token reading
 *     transports   — createHttpBridge, createWsBridge, createSseBridge
 *     form         — createFormBus, reactive form state
 *     schema       — LLM tool-use layer, synthesize, toTools
 *     devtools     — @vue/devtools-api integration (requires @vue/devtools-api)
 *     directives   — v-command Vue directive (requires Vue)
 *     vite         — HMR plugin (requires Vite, see 'vapor-chamber/vite')
 *     iife         — UMD/IIFE bundle (see 'vapor-chamber/iife')
 *
 * Sub-path exports that avoid pulling in optional code:
 *   'vapor-chamber/transports' — HTTP + WS + SSE bridges
 *   'vapor-chamber/directives' — v-command directive
 *   'vapor-chamber/vite'       — Vite HMR plugin
 *   'vapor-chamber/iife'       — IIFE bundle
 *
 * Changelog:
 *   v0.3.0 — Naming convention, wildcard listeners, request/response, authGuard, optimistic
 *   v0.4.0 — Vue 3.6 Vapor alignment, defineVaporCommand, onScopeDispose
 *   v0.4.1 — useCommandGroup, useCommandError
 *   v0.4.2 — Transport layer, retry/persist/sync plugins
 *   v0.4.3 — createTestBus snapshot/time-travel
 *   v0.5.0 — camelCase naming, HTTP client, CDCC splits, createFormBus, schema/LLM layer
 *   v0.6.0 — onBefore, once, offAll, BaseBus, commandKey; BatchResult successCount/failCount;
 *             form async validation; HttpError.code; noRetry; WS maxQueueSize; LlmAdapter;
 *             419≠401 fix; CSRF refresh fix; WS timeout configurable; SSE BaseBus
 */

// ── CORE ─────────────────────────────────────────────────────────────────────
export {
  createCommandBus,
  createAsyncCommandBus,
  commandKey,
  buildRunner,
  matchesPattern,
  type BaseBus,
  type Command,
  type CommandResult,
  type CommandBus,
  type AsyncCommandBus,
  type Handler,
  type AsyncHandler,
  type Plugin,
  type AsyncPlugin,
  type Hook,
  type AsyncHook,
  type BeforeHook,
  type AsyncBeforeHook,
  type PluginOptions,
  type BatchCommand,
  type BatchOptions,
  type BatchResult,
  type DeadLetterMode,
  type CommandBusOptions,
  type NamingConvention,
  type RegisterOptions,
  type Listener,
  type CommandMap,
} from './command-bus';

// Testing utilities (CORE — zero runtime deps, for test environments only)
export { createTestBus, type TestBus, type RecordedDispatch } from './testing';

// ── OPTIONAL ──────────────────────────────────────────────────────────────────

// Plugins
export {
  logger,
  validator,
  history,
  debounce,
  throttle,
  authGuard,
  optimistic,
  retry,
  persist,
  sync,
  type HistoryState,
  type RetryOptions,
  type PersistOptions,
  type SyncOptions,
} from './plugins';

// Vue composables — optional, requires Vue ≥ 3.5
export {
  signal,
  configureSignal,
  type Signal,
  type CreateSignal,
  getCommandBus,
  setCommandBus,
  resetCommandBus,
  useCommandBus,
  useCommand,
  useCommandState,
  useCommandHistory,
  // v0.4.1
  useCommandGroup,
  useCommandError,
  // v0.4.0: Vue 3.6 Vapor detection
  isVaporAvailable,
} from './chamber';

// Vue 3.6+ Vapor-specific API — optional, requires Vue 3.6
export {
  createVaporChamberApp,
  getVaporInteropPlugin,
  defineVaporCommand,
} from './chamber-vapor';

// HTTP client — optional, used by createHttpBridge; also available standalone
export {
  readCsrfToken,
  invalidateCsrfCache,
  postCommand,
  type HttpConfig,
  type HttpResponse,
  type HttpError,
} from './http';

// Transport plugins — optional; prefer 'vapor-chamber/transports' to avoid pulling http.ts
export {
  createHttpBridge,
  createWsBridge,
  createSseBridge,
  type HttpBridgeOptions,
  type WsBridgeOptions,
  type SseBridgeOptions,
  type CommandEnvelope,
  type BackendResponse,
} from './transports';

// Vue directive — optional, requires Vue; prefer 'vapor-chamber/directives'
export { createDirectivePlugin } from './directives';

// Form management — optional, no extra runtime deps
export {
  createFormBus,
  type FormBusOptions,
  type FormBus,
  type FormRules,
} from './form';

// DevTools integration — optional, requires @vue/devtools-api (loaded dynamically)
export { setupDevtools } from './devtools';

// Schema / LLM layer — optional, for AI-assisted command dispatch
export {
  createSchemaCommandBus,
  createAsyncSchemaCommandBus,
  schemaLogger,
  toTools,
  toAnthropicTools,
  toOpenAITools,
  synthesize,
  type BusSchema,
  type ActionSchema,
  type FieldMap,
  type FieldType,
  type InferMap,
  type SchemaCommandBus,
  type AsyncSchemaCommandBus,
  type SynthesizeOptions,
  type LlmAdapter,
  type AnthropicTool,
  type OpenAITool,
  type ToolCallInput,
  schemaValidator,
  describeSchema,
} from './schema';
