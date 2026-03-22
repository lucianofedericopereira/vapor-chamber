/**
 * vapor-chamber - Lightweight command bus for Vue Vapor
 *
 * ~2KB gzipped (core + plugins + composables). DevTools loaded dynamically.
 *
 * v0.3.0 — Naming convention, wildcard listeners, request/response, authGuard, optimistic
 * v0.4.0 — Vue 3.6 Vapor alignment, defineVaporCommand, onScopeDispose
 * v0.4.1 — useCommandGroup, useCommandError
 * v0.4.2 — Transport layer (see 'vapor-chamber/transports'), retry/persist/sync plugins
 * v0.4.3 — createTestBus snapshot/time-travel
 * v0.5.0 — camelCase naming, TypeScript HTTP client, CDCC splits, createFormBus,
 *           Directive plugin (see 'vapor-chamber/directives'),
 *           Vite HMR plugin (see 'vapor-chamber/vite')
 */

// Core
export {
  createCommandBus,
  createAsyncCommandBus,
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

// Testing utilities
export { createTestBus, type TestBus, type RecordedDispatch } from './testing';

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

// Vapor integration — core composables
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

// Vapor integration — Vue 3.6+ Vapor-specific API
export {
  createVaporChamberApp,
  getVaporInteropPlugin,
  defineVaporCommand,
} from './chamber-vapor';

// HTTP client utilities
export {
  readCsrfToken,
  invalidateCsrfCache,
  postCommand,
  type HttpConfig,
  type HttpResponse,
  type HttpError,
} from './http';

// Transport plugins (v0.4.2)
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

// Directive plugin (v0.4.4) — opt-in, 0KB when not imported
export { createDirectivePlugin } from './directives';

// Form bus (v0.5.0)
export {
  createFormBus,
  type FormBusOptions,
  type FormBus,
  type FormRules,
} from './form';

// DevTools integration (optional — requires @vue/devtools-api)
export { setupDevtools } from './devtools';

// Schema layer — LLM tool use, schema-aware logging, synthesize (v0.5.0)
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
  type AnthropicTool,
  type OpenAITool,
  type ToolCallInput,
  schemaValidator,
  describeSchema,
} from './schema';
