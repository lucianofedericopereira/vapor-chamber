/**
 * vapor-chamber - Lightweight command bus for Vue Vapor
 *
 * Architecture:
 *   CORE (zero dependencies, framework-agnostic):
 *     command-bus  - dispatch, register, plugins, hooks, wildcard, request/respond
 *     testing      - createTestBus, snapshot, time-travel
 *
 *   OPTIONAL (tree-shaken when unused):
 *     plugins      - logger, validator, history, debounce, throttle, authGuard, optimistic
 *     plugins-io   - persist, createChannel
 *     chamber      - Vue composables: useCommand, useCommandGroup, useCommandState, ...
 *     chamber-vapor - Vue 3.6+ Vapor-specific API (requires Vue 3.6)
 *     http         - postCommand, createHttpClient, CSRF token reading
 *     transports   - createHttpBridge, createBatchingHttpBridge, createWsBridge, createSseBridge
 *     form         - createFormBus, reactive form state
 *     schema       - LLM tool-use layer, synthesize, toTools
 *     devtools     - @vue/devtools-api integration (requires @vue/devtools-api)
 *     transitions   - <Transition> hook -> bus dispatch bridge
 *     ssr          - SSR dehydrate/rehydrate plugin
 *     directives   - v-command Vue directive (requires Vue)
 *     vite         - HMR plugin (requires Vite, see 'vapor-chamber/vite')
 *     iife         - UMD/IIFE bundle (see 'vapor-chamber/iife')
 *
 * Sub-path exports that avoid pulling in optional code:
 *   'vapor-chamber/transports'      - HTTP + WS + SSE bridges
 *   'vapor-chamber/transitions'     - <Transition> hook -> bus dispatch
 *   'vapor-chamber/ssr'             - SSR dehydrate/rehydrate
 *   'vapor-chamber/directives'      - v-command directive
 *   'vapor-chamber/vite'            - Vite HMR plugin
 *   'vapor-chamber/fast-lane'       - minimal-allocation dispatcher for hot loops
 *   'vapor-chamber/observable'      - Symbol.observable interop (RxJS / xstream / callbag)
 *   'vapor-chamber/standard-schema' - Standard Schema v1 validator plugin (Zod / Valibot / ArkType)
 *   'vapor-chamber/alien-signals'   - alien-signals as the reactive primitive (non-Vue)
 *   'vapor-chamber/reactive'        - opt-in deep reactivity (deepSignal + useDeepCommandState)
 *   'vapor-chamber/outbox'          - offline outbox (durable queue + Idempotency-Key replay)
 *   'vapor-chamber/mcp'             - MCP server from a schema bus (agent surface)
 *   'vapor-chamber/stream-parser'   - incremental JSON parser for streamed fetch/SSE bodies
 *   'vapor-chamber/iife'            - IIFE bundle (full)
 *   'vapor-chamber/iife-core'       - IIFE bundle (no Vapor custom-element, no Suspense paths)
 *   'vapor-chamber/iife-elements'   - IIFE bundle (core + Vapor custom-element)
 *
 * History: CHANGELOG.md.
 */

// -- CORE ---------------------------------------------------------------------
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
  RETRYABLE_CONDITIONS,
  conditionOf,
  conditionOfStatus,
  failureCondition,
  ownerOf,
  type CommandPool,
  type BusInspection,
  type BusErrorCode,
  type Condition,
  type FailCode,
  type Fail,
  type BusSeverity,
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
  type SyncPlugin,
  type PluginParts,
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
  type AsyncCommandBusOptions,
  type RetryOptions,
  type RetryDeclaration,
  type NamingConvention,
  type RegisterOptions,
  type Listener,
  type CommandMap,
  type TargetOf,
  type PayloadOf,
  type ResultOf,
} from './command-bus';

// Settling what `next()` gave a plugin, on either bus: what a `Plugin` uses to
// read the result (see Plugin).
export { onSettled, type MaybeAsyncResult } from './settled';

// Testing utilities (CORE - zero runtime deps, for test environments only)
export { createTestBus, wired, type TestBus, type RecordedDispatch } from './testing';

// -- UTILITIES ----------------------------------------------------------------
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

// -- EXTRA PLUGINS ------------------------------------------------------------
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

// -- OPTIONAL ------------------------------------------------------------------

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
  persist,
  createChannel,
  type HistoryState,
  type OptimisticUndoOptions,
  type PersistOptions,
  type ChannelOptions,
} from './plugins';

// Vue composables - optional, requires Vue >= 3.5
export {
  signal,
  configureSignal,
  type Signal,
  type CreateSignal,
  getCommandBus,
  setCommandBus,
  resetCommandBus,
  useCommand,
  // typed command contract - augment GlobalCommands for typed dispatch
  type GlobalCommands,
  type SharedCommandMap,
  useSharedCommandState,
  type UseSharedCommandStateOptions,
  useCommandState,
  type UseCommandStateOptions,
  useCommandHistory,
  useCommandGroup,
  useCommandError,
  // CQRS read-side composable
  useCommandQuery,
  // Vue 3.6 Vapor detection
  isVaporAvailable,
  // Await Vue detection for guaranteed signal availability
  waitForVueDetection,
  // Hand the library Vue's namespace explicitly - the reliable channel when
  // neither automatic one can reach it (no-bundler pages especially).
  configureVue,
  // Run a raw-bus dispatch without its handler's reads becoming dependencies
  // of the surrounding effect. Composables apply this themselves.
  untracked,
} from './chamber';

// Vue 3.6+ Vapor-specific API - optional, requires Vue 3.6
export {
  createVaporChamberApp,
  getVaporInteropPlugin,
  defineVaporCommand,
  // Vue 3.6+ Vapor APIs
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  useVaporAsyncCommand,
} from './chamber-vapor';

// HTTP client - optional, used by createHttpBridge; also available standalone
export {
  readCsrfToken,
  invalidateCsrfCache,
  postCommand,
  // Multi-method HTTP client
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

// The HTTP contract (see http-errors.ts): what a status declares, what may be
// re-sent, what a cached response may stand in for, and the problem shape.
// Zero cost when unimported.
export {
  classifyError,
  isRetryableStatus,
  type ErrorClassification,
  type ProblemDetails,
} from './http-errors';

// Transport plugins - optional; prefer 'vapor-chamber/transports' to avoid pulling http.ts
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

// Transition integration - optional; prefer 'vapor-chamber/transitions'
export {
  createTransitionBridge,
  useTransitionCommand,
  type TransitionPhase,
  type TransitionBridgeOptions,
  type TransitionHooks,
  type TransitionBridge,
} from './transitions';

// SSR hydration - optional; prefer 'vapor-chamber/ssr'
export {
  createSSRPlugin,
  rehydrate,
  rehydrateAsync,
  type DehydratedCommand,
  type SSRPluginOptions,
  type SSRPlugin,
  type RehydrateOptions,
} from './ssr';

// Status messages for assistive technology (WCAG 4.1.3): one shared pair of
// live regions per document, used by the directive and the router; an app can
// announce through it too, or take it over.
export { announce, setAnnouncer, type AnnounceOptions, type Announcer } from './a11y';

// Vue directive - optional, requires Vue; prefer 'vapor-chamber/directives'
export { createDirectivePlugin } from './directives';

// Form management - optional, no extra runtime deps
export {
  createFormBus,
  type FormBusOptions,
  type FormBus,
  type FormRules,
} from './form';

// DevTools integration lives on its own subpath: `vapor-chamber/devtools`.
// It is NOT re-exported here on purpose. The barrel is what every consumer's
// bundler pre-bundles, and devtools carries a dynamic import of the optional
// `@vue/devtools-api` peer - from the barrel that specifier reaches apps that
// never asked for devtools and do not have the peer installed, and their dev
// server fails to resolve it. On a subpath it only reaches importers who opted
// in, who are exactly the people who installed the peer.
//
//   import { setupDevtools } from 'vapor-chamber/devtools';

// Schema / LLM layer - optional, for AI-assisted command dispatch
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
  // typed command contract
  defineSchema,
  type CommandsOf,
  type SchemaCommandBus,
  type AsyncSchemaCommandBus,
  type SchemaCommandBusOptions,
  type AsyncSchemaCommandBusOptions,
  type SynthesizeOptions,
  type LlmAdapter,
  type AnthropicTool,
  type OpenAITool,
  type ToolCallInput,
  schemaValidator,
  describeSchema,
  // Error code registry and API schema for LLMs
  ERROR_CODE_REGISTRY,
  getErrorEntry,
  describeErrorCodes,
  busApiSchema,
  type ErrorCodeEntry,
  // retryable/category metadata
  isRetryableCode,
} from './schema';
