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
 *     http         — postCommand, createHttpClient, CSRF token reading
 *     transports   — createHttpBridge, createBatchingHttpBridge, createWsBridge, createSseBridge
 *     form         — createFormBus, reactive form state
 *     schema       — LLM tool-use layer, synthesize, toTools
 *     devtools     — @vue/devtools-api integration (requires @vue/devtools-api)
 *     transitions   — <Transition> hook → bus dispatch bridge
 *     ssr          — SSR dehydrate/rehydrate plugin
 *     directives   — v-command Vue directive (requires Vue)
 *     vite         — HMR plugin (requires Vite, see 'vapor-chamber/vite')
 *     iife         — UMD/IIFE bundle (see 'vapor-chamber/iife')
 *
 * Sub-path exports that avoid pulling in optional code:
 *   'vapor-chamber/transports'      — HTTP + WS + SSE bridges
 *   'vapor-chamber/transitions'     — <Transition> hook → bus dispatch
 *   'vapor-chamber/ssr'             — SSR dehydrate/rehydrate
 *   'vapor-chamber/directives'      — v-command directive
 *   'vapor-chamber/vite'            — Vite HMR plugin
 *   'vapor-chamber/fast-lane'       — minimal-allocation dispatcher for hot loops
 *   'vapor-chamber/observable'      — Symbol.observable interop (RxJS / xstream / callbag)
 *   'vapor-chamber/standard-schema' — Standard Schema v1 validator plugin (Zod / Valibot / ArkType)
 *   'vapor-chamber/alien-signals'   — alien-signals as the reactive primitive (non-Vue)
 *   'vapor-chamber/reactive'        — opt-in deep reactivity (deepSignal + useDeepCommandState)
 *   'vapor-chamber/outbox'          — offline outbox (durable queue + Idempotency-Key replay)
 *   'vapor-chamber/mcp'             — MCP server from a schema bus (agent surface)
 *   'vapor-chamber/stream-parser'   — incremental JSON parser for streamed fetch/SSE bodies
 *   'vapor-chamber/iife'            — IIFE bundle (full)
 *   'vapor-chamber/iife-core'       — IIFE bundle (no Vapor custom-element, no Suspense paths)
 *   'vapor-chamber/iife-elements'   — IIFE bundle (core + Vapor custom-element)
 *
 * Changelog:
 *   v0.3.0 — Naming convention, wildcard listeners, request/response, authGuard, optimistic
 *   v0.4.0 — Vue 3.6 Vapor alignment, defineVaporCommand, onScopeDispose
 *   v0.4.1 — useCommandGroup, useCommandError
 *   v0.4.2 — Transport layer, retry/persist/sync plugins
 *   v0.4.3 — createTestBus snapshot/time-travel
 *   v0.5.0 — camelCase naming, HTTP client, CDCC splits, createFormBus, schema/LLM layer
 *   v0.6.0 — onBefore, once, offAll, BaseBus, commandKey; BatchResult successCount/failCount;
 *             form async validation (isValidating, isBusy); HttpError.code; noRetry;
 *             WS maxQueueSize; LlmAdapter; 419≠401 fix; CSRF refresh error propagation;
 *             WS queue expiry on reconnect; async request dedup; directive dispatch timeout;
 *             signal detection sync probe (globalThis.__VUE__); waitForVueDetection();
 *             passthroughHandlers fix in TestBus; Vue >=3.6.0-beta.1 peer dep;
 *             useVaporCommand() composable; Vapor directive compat warning;
 *             tryAutoCleanup dev warning; Vite HMR .vapor.vue support;
 *             FormBus reactive:false headless mode; HttpBridge scopeController;
 *             WsBridge reactive connected signal
 *   v1.1.0 — Vue 3.6.0-beta.10 alignment: defineVaporCustomElement, defineVaporComponent,
 *             defineVaporAsyncComponent wrappers; useVaporAsyncCommand for Suspense-aware
 *             async dispatch; createTransitionBridge + useTransitionCommand; persist validate
 *             option; improved Vapor/VDOM interop awareness; HMR vapor↔vdom switch
 *   v1.2.0 — Vue 3.6.0-beta.11 alignment: peerDep bumped; defineVaporComponent
 *             JSDoc documents generics (#14770) + emits-vs-attrs split; build
 *             pipeline migrated from custom esbuild script to Vite programmatic
 *             API (scripts/build.mjs); IIFE split into three sized variants
 *             (full / core / elements) mirroring Vue's tree-shake axes; tsc
 *             now emits types only (`emitDeclarationOnly`)
 *   v1.0.0 — bus.query() CQRS read-only dispatch; bus.emit() domain events;
 *             Command.meta auto-stamped metadata (ts, id, correlationId, causationId);
 *             bus.registeredActions() introspection; TestBus.onBefore fires for real;
 *             TestBus.query/emit/registeredActions parity
 */

// ── CORE ─────────────────────────────────────────────────────────────────────
export {
  createCommandBus,
  createAsyncCommandBus,
  commandKey,
  configureUid,
  createCommandPool,
  unsealBus,
  inspectBus,
  buildRunner,
  matchesPattern,
  BusError,
  RETRYABLE_CODES,
  type CommandPool,
  type BusInspection,
  type BusErrorCode,
  type BusSeverity,
  type BusEmitter,
  type BaseBus,
  type Command,
  type CommandResult,
  type CommandMeta,
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
  type TargetOf,
  type PayloadOf,
  type ResultOf,
} from './command-bus';

// Testing utilities (CORE — zero runtime deps, for test environments only)
export { createTestBus, type TestBus, type RecordedDispatch } from './testing';

// ── UTILITIES ────────────────────────────────────────────────────────────────
// Declarative patterns for common bus usage. Tree-shaken when unused.
export {
  createChamber,
  createWorkflow,
  createReaction,
  type Chamber,
  type ChamberHandlers,
  type ChamberOptions,
  type WorkflowStep,
  type WorkflowResult,
  type Workflow,
  type ReactionOptions,
  type Reaction,
} from './utilities';

// ── EXTRA PLUGINS ────────────────────────────────────────────────────────────
// Production-ready plugins: caching, resilience, observability. Tree-shaken.
export {
  cache,
  circuitBreaker,
  rateLimit,
  metrics,
  serialize,
  idempotent,
  supersede,
  type CacheOptions,
  type CircuitBreakerOptions,
  type RateLimitOptions,
  type MetricsEntry,
  type MetricsOptions,
  type SerializeOptions,
  type IdempotentOptions,
  type SupersedeOptions,
} from './plugins-extra';

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
  optimisticUndo,
  retry,
  persist,
  sync,
  type HistoryState,
  type OptimisticUndoOptions,
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
  // v1.8.0: typed command contract — augment GlobalCommands for typed dispatch
  type GlobalCommands,
  type SharedCommandMap,
  useSharedCommandState,
  type UseSharedCommandStateOptions,
  useCommandState,
  type UseCommandStateOptions,
  useCommandHistory,
  // v0.4.1
  useCommandGroup,
  useCommandError,
  // v1.1.0: CQRS read-side composable
  useCommandQuery,
  // v0.4.0: Vue 3.6 Vapor detection
  isVaporAvailable,
  // v0.6.0: Await Vue detection for guaranteed signal availability
  waitForVueDetection,
} from './chamber';

// Vue 3.6+ Vapor-specific API — optional, requires Vue 3.6
export {
  createVaporChamberApp,
  getVaporInteropPlugin,
  defineVaporCommand,
  // v1.1.0: Vue 3.6+ Vapor APIs
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  useVaporAsyncCommand,
} from './chamber-vapor';

// HTTP client — optional, used by createHttpBridge; also available standalone
export {
  readCsrfToken,
  invalidateCsrfCache,
  postCommand,
  // v1.1.0: Multi-method HTTP client
  createHttpClient,
  type HttpConfig,
  type HttpResponse,
  type HttpError,
  type HttpRequestConfig,
  type HttpClient,
  type HttpMethod,
  type ResponseType,
  type SafeResult,
  type DownloadResult,
  type InterceptorManager,
} from './http';

// Transport plugins — optional; prefer 'vapor-chamber/transports' to avoid pulling http.ts
export {
  createHttpBridge,
  createBatchingHttpBridge,
  createWsBridge,
  createSseBridge,
  createEchoBridge,
  type HttpBridgeOptions,
  type BatchingHttpBridgeOptions,
  type WsBridgeOptions,
  type SseBridgeOptions,
  type EchoBridgeOptions,
  type EchoSubscription,
  type EchoChannelType,
  type CommandEnvelope,
  type BackendResponse,
} from './transports';

// Transition integration — optional; prefer 'vapor-chamber/transitions'
export {
  createTransitionBridge,
  useTransitionCommand,
  type TransitionPhase,
  type TransitionBridgeOptions,
  type TransitionHooks,
  type TransitionBridge,
} from './transitions';

// SSR hydration — optional; prefer 'vapor-chamber/ssr'
export {
  createSSRPlugin,
  rehydrate,
  type DehydratedCommand,
  type SSRPluginOptions,
  type SSRPlugin,
  type RehydrateOptions,
} from './ssr';

// Vue directive — optional, requires Vue; prefer 'vapor-chamber/directives'
export { createDirectivePlugin } from './directives';

// Form management — optional, no extra runtime deps
export {
  createFormBus,
  type FormBusOptions,
  type FormBus,
  type FormRules,
} from './form';

// DevTools integration lives on its own subpath: `vapor-chamber/devtools`.
// It is NOT re-exported here on purpose. The barrel is what every consumer's
// bundler pre-bundles, and devtools carries a dynamic import of the optional
// `@vue/devtools-api` peer — from the barrel that specifier reaches apps that
// never asked for devtools and do not have the peer installed, and their dev
// server fails to resolve it. On a subpath it only reaches importers who opted
// in, who are exactly the people who installed the peer.
//
//   import { setupDevtools } from 'vapor-chamber/devtools';

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
  // v1.8.0: typed command contract
  defineSchema,
  type CommandsOf,
  type SchemaCommandBus,
  type AsyncSchemaCommandBus,
  type SchemaCommandBusOptions,
  type SynthesizeOptions,
  type LlmAdapter,
  type AnthropicTool,
  type OpenAITool,
  type ToolCallInput,
  schemaValidator,
  describeSchema,
  // v1.0: Error code registry and API schema for LLMs
  ERROR_CODE_REGISTRY,
  getErrorEntry,
  describeErrorCodes,
  busApiSchema,
  type ErrorCodeEntry,
  // v1.8.0: retryable/category metadata
  isRetryableCode,
} from './schema';
