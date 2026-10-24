/**
 * vapor-chamber - Lightweight command bus for Vue Vapor
 *
 * Architecture:
 *   CORE (zero dependencies, framework-agnostic):
 *     command-bus  - dispatch, register, plugins, hooks, wildcard, request/respond
 *     testing      - createTestBus, snapshot, time-travel
 *
 *   OPTIONAL (tree-shaken when unused):
 *     plugins      - logger, validator, authGuard, and history, which installs itself on its bus
 *     pace         - debounce or throttle a dispatch at the sender
 *     plugins-io   - createChannel
 *     chamber      - Vue composables: useCommand, useCommandGroup, useCommandHistory, ...
 *     chamber-vapor - Vue 3.6+ Vapor-specific API (requires Vue 3.6)
 *     http         - postCommand, createHttpClient, CSRF token reading
 *     transports   - httpTransport, wsTransport, defineTransport, createSseBridge
 *     form         - createFormBus, reactive form state
 *     schema       - LLM tool-use layer, synthesize, toTools
 *     devtools     - @vue/devtools-api integration (requires @vue/devtools-api)
 *     transitions   - <Transition> hook -> bus dispatch bridge
 *     ssr          - storeStates, seedStores: the stores' states for a server render
 *     directives   - v-vc-command Vue directive (requires Vue)
 *     vite         - HMR plugin (requires Vite, see 'vapor-chamber/vite')
 *     iife         - IIFE bundles (see 'vapor-chamber/iife')
 *
 * Sub-path exports that avoid pulling in optional code:
 *   'vapor-chamber/transports'      - httpTransport, wsTransport, createSseBridge
 *   'vapor-chamber/transitions'     - <Transition> hook -> bus dispatch
 *   'vapor-chamber/ssr'             - the stores' states for a server render
 *   'vapor-chamber/directives'      - v-vc-command directive
 *   'vapor-chamber/vite'            - Vite HMR plugin
 *   'vapor-chamber/fast-lane'       - minimal-allocation dispatcher for hot loops
 *   'vapor-chamber/observable'      - Symbol.observable interop (RxJS / xstream / callbag)
 *   'vapor-chamber/standard-schema' - Standard Schema v1 validator plugin (Zod / Valibot / ArkType)
 *   'vapor-chamber/alien-signals'   - alien-signals as the reactive primitive (non-Vue)
 *   'vapor-chamber/reactive'        - opt-in deep reactivity (deepSignal)
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
  BusError,
  RETRYABLE_CONDITIONS,
  conditionOf,
  conditionOfStatus,
  failureCondition,
  ownerOf,
  type CommandPool,
  type BusInspection,
  type PluginInspection,
  type BusErrorCode,
  type Condition,
  type FailCode,
  type Fail,
  type BusSeverity,
  type BaseBus,
  type Command,
  type CommandResult,
  type MetaResponse,
  type MetaRequest,
  type CommandMeta,
  type CommandBus,
  type AsyncCommandBus,
  type Handler,
  type AsyncHandler,
  type PluginParts,
  type WorkTicket,
  type Transport,
  type ActionScope,
  type ScopeOptions,
  type Hook,
  type AsyncHook,
  type BatchCommand,
  type BatchOptions,
  type BatchResult,
  type DeadLetterMode,
  type CommandBusOptions,
  type AsyncCommandBusOptions,
  type RetryOptions,
  type RetryPolicy,
  type NamingConvention,
  type RegisterOptions,
  type Listener,
  type CommandMap,
  type TargetOf,
  type PayloadOf,
  type ResultOf,
} from './command-bus';

// Settling a result that may be a promise, on either bus (a dispatch's, a
// step's), and staying sync when it is.
export { onSettled, type MaybeAsyncResult } from './settled';
export { createActionFilter, type ActionFilter, type ActionFilterExpression } from './action-filter';

// What an app plugin builds a result with: the bus's own two factories, so its
// results share the bus's one hidden class (tests/plugin-result-factories).
// A refusal is `err(fail(...))`: `fail`, handed to a rule or an `admit` step,
// mints the owner. And the library's rule for a numeric option.
export { _okResult as ok, _errResult as err } from './command-bus';
export { matchesPattern } from './pattern';
// The reporter: one formatter and the sinks every warning and error the library detects goes to
export { configureReport, consoleSink, formatReport, type Report, type ReportFormat, type ReportLevel, type ReportSink } from './report';
export { countOption } from './bounds';

// Testing utilities (CORE - zero runtime deps, for test environments only)
export { createTestBus, type TestBus, type RecordedDispatch } from './testing';

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
  idempotent,
  supersede,
  type CacheOptions,
  type CircuitBreakerOptions,
  type RateLimitOptions,
  type MetricsEntry,
  type MetricsOptions,
  type IdempotentOptions,
  type SupersedeOptions,
} from './plugins-extra';

// -- OPTIONAL ------------------------------------------------------------------

// Plugins
export {
  logger,
  validator,
  history,
  authGuard,
  createChannel,
  type HistoryState,
  type ChannelOptions,
} from './plugins';

// Pacing at the sender: debounce or throttle a dispatch before it reaches the bus
export { pace, type PaceOptions, type Paced, type Send } from './pace';
export { indexedDbStorage } from './idb';
export { saveTo, type PersistStorage, type SaveToOptions, type StorePersist } from './store-persist';
export { shareTabs, type StoreShare } from './store-share';

// The command state: in flight and failed, per bus, any framework or none
export { commandState, type CommandState, type CommandStateOptions } from './command-state';

// Vue composables - optional, requires Vue >= 3.5
export {
  signal,
  configureSignal,
  type Signal,
  type CreateSignal,
  getCommandBus,
  setCommandBus,
  resetCommandBus,
  type BusOption,
  type ResultOn,
  useCommand,
  // typed command contract - augment GlobalCommands for typed dispatch
  type GlobalCommands,
  type SharedCommandMap,
  useSharedCommandState,
  type UseSharedCommandStateOptions,
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

// Vue 3.6+ Vapor-specific API - optional, requires Vue 3.6. The app factory,
// `createVaporChamberApp`, is on `vapor-chamber/vapor` only: its type names
// Vue's, which this entry never does (tests/vapor-app-types.test.ts).
export {
  getVaporInteropPlugin,
  defineVaporCommand,
  type VaporCommandOptions,
  // Vue 3.6+ Vapor APIs
  defineVaporCustomElement,
  defineVaporComponent,
  defineVaporAsyncComponent,
  useVaporAsyncCommand,
} from './chamber-vapor';

// HTTP client - optional, used by httpTransport; also available standalone
export {
  readCsrfToken,
  invalidateCsrfCache,
  postCommand,
  // Multi-method HTTP client
  createHttpClient,
  type HttpConfig,
  type HttpResponse,
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
  problemOf,
  type ErrorClassification,
  type ProblemDetails,
} from './http-errors';

// A dispatch held until its handler registers (bus option `buffer`).
export { createBuffer, type BufferOptions, type CommandBuffer } from './buffer';

// Transports - optional; prefer 'vapor-chamber/transports' to avoid pulling http.ts
export { Accepted } from './accepted';
export {
  httpTransport,
  wsTransport,
  defineTransport,
  createSseBridge,
  createEchoBridge,
  type HttpTransportOptions,
  type HttpBatchOptions,
  type WsTransportOptions,
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

// SSR by the stores' states - optional; prefer 'vapor-chamber/ssr'
export { storeStates, seedStores, serializeForScript, liveStores } from './ssr';

// Status messages for assistive technology (WCAG 4.1.3): one shared pair of
// live regions per document, used by the directive and the router; an app can
// announce through it too, or take it over.
export { announce, setAnnouncer, type AnnounceOptions, type Announcer } from './a11y';

// Vue directive - optional, requires Vue; prefer 'vapor-chamber/directives'
export { createDirectivePlugin } from './directives';
// The command binding on plain HTML: [data-vc-command], the bus passed in, no Vue
export { bindCommands } from './command-binding';
// Display bindings on plain HTML: data-vc-text, -show, -each, -pending on a store and the command state
export { bindDisplay } from './page-bindings';
// Widgets: a Vapor custom element defined when the page needs it, and a DOM event out of it
export { defineWidget, emitDOMEvent, type WidgetComponent, type WidgetOptions, type WidgetWhen } from './widget';

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
  type ActionAnnotations,
  type ActionSchema,
  type FieldMap,
  type FieldType,
  type InferMap,
  // typed command contract
  defineSchema,
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
  // The API schema for LLMs
  busApiSchema,
} from './schema';
// The error code registry: severity, retry class and fix per code
export { ERROR_CODE_REGISTRY, getErrorEntry, describeErrorCodes, isRetryableCode, type ErrorCodeEntry } from './error-registry';
