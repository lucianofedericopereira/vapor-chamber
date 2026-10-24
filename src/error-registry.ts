/**
 * vapor-chamber - the error code registry: every code the library returns or
 * reports, with its severity, its retry class and its fix. It holds no bus
 * state, so it sits in the foundation beside failure.ts, where the reporter
 * reads a code's fix in development.
 */
import type { BusSeverity } from './command-bus';

/** The errors page: a failure's RFC 9457 `type` and a report's docs link end in its condition. */
export const ERRORS_PAGE = 'https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/errors.md#';

// ---------------------------------------------------------------------------
// Error code registry - machine-readable table for LLMs, docs, i18n
// ---------------------------------------------------------------------------

/**
 * Error code definition - every BusError code has a structured entry.
 * Useful for generating documentation, i18n lookups, and LLM error handling.
 */
export type ErrorCodeEntry = {
  /** `owner:condition:subject`; the owner is the code's first part. */
  code: string;
  /** The level a logger defaults to for this code; the logger decides. */
  severity: BusSeverity;
  /**
   * Whether the code's condition is transient by the retry rule
   * (`retryClass`): `limited`, `timeout`, except a transport's own timeout,
   * which got no reply and may have landed. The async bus re-sends such a
   * failure only when the call it retries (a handler, a transport) produced
   * it: a plugin's refusal (`rateLimit:limited:action`) sits outside that
   * call and is never re-sent (tests/retryable-column.test.ts). An uncertain condition reads
   * false here and is re-sent only for an idempotent action or a keyed
   * command. An outcome of the rule, not a judgement per row
   * (tests/schema.test.ts).
   */
  retryable: boolean;
  /** Broad failure category for filtering, telemetry, and LLM error handling. */
  category: 'general' | 'network' | 'validation' | 'internal' | 'logic';
  message: string;
  /** Human-readable fix suggestion for LLMs and developers. */
  fix: string;
};

/**
 * Complete registry of all BusError codes with their metadata.
 * This is the single source of truth for error documentation.
 *
 * @example
 * import { ERROR_CODE_REGISTRY } from 'vapor-chamber';
 * // Lookup an error code
 * const entry = ERROR_CODE_REGISTRY.find(e => e.code === 'core:missing:handler');
 * console.log(entry?.fix); // "Register a handler with bus.register(action, handler)"
 *
 * @example
 * // Generate an LLM system prompt with all error codes
 * const prompt = ERROR_CODE_REGISTRY
 *   .map(e => `${e.code} (${e.severity}): ${e.message} -> Fix: ${e.fix}`)
 *   .join('\n');
 */
// The pure-call annotation just below lets bundlers tree-shake the whole
// registry out of consumer bundles that never touch it (Object.freeze at
// module level otherwise reads as a side effect and pins ~1 KB into every
// barrel-import bundle, v1.8.0).
export const ERROR_CODE_REGISTRY: readonly ErrorCodeEntry[] = /* @__PURE__ */ Object.freeze([
  // Core
  { code: 'core:missing:handler',       severity: 'error', retryable: false, category: 'internal',   message: 'No handler registered for action',                  fix: 'Register a handler with bus.register(action, handler) before dispatching.' },
  { code: 'core:invalid:option', severity: 'error', retryable: false, category: 'validation', message: 'A register() option needs another one: optimistic needs an undo', fix: 'Give the action an undo that takes its change back, or drop optimistic.' },
  { code: 'core:invalid:handler', severity: 'error', retryable: false, category: 'validation', message: 'A handler that could never run: a transport sends its action, or null where no transport does, or not a function', fix: 'For a sent action register null to declare its options, add optimistic: true to show the change at once, or declare localFallback on a transport whose send calls local(). Otherwise register a function.' },
  { code: 'core:invalid:name', severity: 'warn',  retryable: false, category: 'validation', message: 'Action name does not match the naming pattern, or carries a "$" (the library\'s names)',     fix: 'Rename the action: match the pattern, or adjust naming config in createCommandBus(); names with $ are the library\'s.' },
  { code: 'core:invalid:filter', severity: 'error', retryable: false, category: 'validation', message: 'An action filter is not a valid CloudEvents filter expression', fix: 'Use one dialect per expression (exact, prefix, suffix, all, any, not), the action attribute only, a non-empty string, and at least one expression in all or any.' },
  { code: 'core:invalid:plugin', severity: 'error', retryable: false, category: 'validation', message: 'use() was given something other than an object with a part the bus places (a function, a transport), or a plugin already installed on this bus', fix: 'Pass an object with a part the bus places: started, settled, authorize, validate, reuse, admit, begin or attach. Install a plugin once, or a new instance. Declare a transport at the bus: createAsyncCommandBus({ transport }).' },
  { code: 'core:invalid:bus', severity: 'error', retryable: false, category: 'validation', message: 'commandState() was given a bus this library did not make', fix: 'Pass a bus from createCommandBus(), createAsyncCommandBus() or createTestBus(): a bus you build yourself has no internal facts observer.' },
  { code: 'core:timeout:request',   severity: 'error', retryable: true,  category: 'network',    message: 'request() timed out waiting for a response',        fix: 'Increase the timeout option or check that respond() is registered for this action.' },
  { code: 'core:aborted:dispatch',           severity: 'warn',  retryable: false, category: 'general',    message: 'Dispatch aborted via its AbortSignal before completion', fix: 'Intentional cancellation (ac.abort()). Re-dispatch explicitly if the abort was premature.' },
  { code: 'validator:invalid:payload',      severity: 'error', retryable: false, category: 'validation', message: 'Schema or per-action validation rejected the dispatch', fix: 'Fix the target/payload fields listed in the error message to match the declared schema.' },
  { code: 'validateSchemas:invalid:payload',    severity: 'error', retryable: false, category: 'validation', message: 'Schema or per-action validation rejected the dispatch', fix: 'Fix the target/payload fields listed in the error message to match the declared schema.' },
  { code: 'schemaValidator:invalid:payload',    severity: 'error', retryable: false, category: 'validation', message: 'The bus schema rejected the dispatch', fix: 'Fix the target/payload fields listed in the error message to match the schema the bus was created with.' },
  // Plugins
  { code: 'circuitBreaker:limited:action',    severity: 'error', retryable: true,  category: 'network',    message: 'Circuit breaker is open due to consecutive failures', fix: 'Wait for resetTimeout to elapse. The circuit will transition to half-open and retry.' },
  { code: 'authGuard:unauthenticated:action', severity: 'warn',  retryable: false, category: 'logic',      message: 'The action is protected and the user is not authenticated', fix: 'Sign in first, or remove the action from authGuard({ protected }).' },
  { code: 'supersede:invalid:bus',     severity: 'error', retryable: false, category: 'validation', message: 'supersede() was installed on a sync bus, where no command is in flight when the next starts', fix: 'Install supersede on an async bus: createAsyncCommandBus().use(supersede()).' },
  { code: 'rateLimit:limited:action',    severity: 'error', retryable: true,  category: 'general',    message: 'Rate limit exceeded for this action',               fix: 'Reduce call frequency or increase the max/window in rateLimit() options.' },
  { code: 'plugin:failed:plugin',           severity: 'error', retryable: false, category: 'internal',   message: 'A plugin threw or rejected in one of its parts',   fix: 'A pipeline bug, not a server failure: error.cause is the original and context.part names the part (a rule or a work step). Return an errResult (err(fail(...))) instead of throwing.' },
  // Transports
  { code: 'transport:refused:redirect',    severity: 'error', retryable: false,category: 'logic',    message: 'The backend answered with a redirect instead of a result', fix: 'Pass an onRedirect handler to httpTransport (e.g. Inertia\'s router.visit), or stop the backend redirecting this command.' },
  { code: 'transport:lost:result',    severity: 'error', retryable: false, category: 'internal', message: 'A batch answered without this command\'s result: it may have run',     fix: 'The backend must answer every batched command by the id it was sent. The outcome is unknown, so it is re-sent only with an idempotency key.' },
  { code: 'transport:failed:send', severity: 'error', retryable: false, category: 'internal', message: 'A transport threw or rejected in its own send', fix: 'A bug in the transport, not a server failure: error.cause is the original. Make send() answer a result instead of throwing.' },
  { code: 'transport:limited:socket', severity: 'warn', retryable: true, category: 'network', message: 'The socket was not open: the command was not sent', fix: 'The outbox keeps the record and sends it when the socket opens. Outside an outbox (a send racing a close), the async bus re-sends it after its backoff.' },
  { code: 'transport:lost:reply',      severity: 'error', retryable: false, category: 'network',  message: 'The socket closed or was torn down before the reply arrived',  fix: 'Reconnect and dispatch again. The outcome is unknown, so the async bus re-sends it only for an idempotent action or a keyed command.' },
  { code: 'transport:missing:csrf', severity: 'error', retryable: false, category: 'logic', message: 'No CSRF token was found after refreshing it', fix: 'The csrfCookieUrl endpoint must set the XSRF-TOKEN cookie (Laravel Sanctum: /sanctum/csrf-cookie), or the page must carry the csrf-token meta tag.' },
  { code: 'transport:aborted:request', severity: 'warn', retryable: false, category: 'general', message: 'The caller aborted the request (its AbortSignal)', fix: 'Intentional cancellation. Send the request again if the abort was premature.' },
  { code: 'transport:invalid:json', severity: 'error', retryable: false, category: 'validation', message: 'The request holds a value JSON cannot encode: nothing was sent', fix: 'Send only what JSON holds: a BigInt or a cycle cannot be encoded. context.url names the request; the cause is the platform\'s TypeError. It is never re-sent.' },
  { code: 'transport:limited:held', severity: 'warn', retryable: true, category: 'network', message: 'The server declared a limit for this action: the command was not sent', fix: 'Wait context.retryIn ms, the time left of the server\'s Retry-After (or RateLimit, X-RateLimit-Reset). The async bus waits it and sends then, unless it is over maxDelay or retry is off. The outbox keeps the record.' },
  { code: 'outbox:exceeded:queue', severity: 'warn', retryable: false, category: 'network', message: 'The outbox held more than maxSize records and dropped the oldest: it was never sent', fix: 'Raise createOutbox({ maxSize }), or flush more often. context.maxSize is the bound.' },
  { code: 'outbox:timeout:queue', severity: 'warn', retryable: true, category: 'network', message: 'The command waited longer than the outbox\'s ttl to be sent: dropped, never sent', fix: 'Raise createOutbox({ ttl }), or wsTransport({ timeout }) for its own outbox. context.ttl is the limit.' },
  { code: 'outbox:aborted:clear', severity: 'warn', retryable: false, category: 'general', message: 'The queue lost the record before it was sent: outbox.clear() in this tab or another, or another tab dropped it by its maxSize', fix: 'Intentional when the app cleared the queue. Dispatch again to send it; raise maxSize if another tab dropped it.' },
  { code: 'buffer:exceeded:queue', severity: 'warn', retryable: false, category: 'logic', message: 'More commands waited for their handler than the buffer holds: the oldest was dropped, never run', fix: 'Register the handler sooner, or raise createBuffer({ maxSize }). context.maxSize is the bound.' },
  { code: 'buffer:timeout:queue', severity: 'warn', retryable: true, category: 'logic', message: 'The command waited longer than the buffer\'s ttl for its handler: dropped, never run', fix: 'The handler never registered in time (an island that failed to hydrate?). Raise createBuffer({ ttl }), or dispatch again once it has. context.ttl is the limit.' },
  { code: 'buffer:aborted:clear', severity: 'warn', retryable: false, category: 'general', message: 'The bus was cleared while the command waited for its handler', fix: 'Intentional: bus.clear() or dispose() ran. Dispatch again on a live bus.' },
  { code: 'remote:unexpected:json', severity: 'error', retryable: false, category: 'network', message: 'The response is not valid JSON, or not the command envelope', fix: 'The backend answered off-protocol: fix the body, its Content-Type, or the envelope shape. Re-sent only for an idempotent request.' },
  { code: 'transport:timeout:job',       severity: 'error', retryable: false, category: 'network',  message: 'An accepted job was not done within maxWait',          fix: 'The backend answered 202 and its status monitor kept answering 202: raise httpTransport({ poll: { maxWait } }) or check the job. Dispatching again starts the job again.' },
  { code: 'transport:timeout:reply',    severity: 'error', retryable: false, category: 'network',  message: 'No reply arrived within the transport\'s own timeout',          fix: 'Raise the transport timeout option, or check the backend is answering. It may have landed, so the async bus re-sends it only for an idempotent action or a keyed command. Otherwise context.outcome is unknown: check its status on the server.' },
  // Functions that are not a plugin (owner: their feature)
  { code: 'schema:missing:adapter',   severity: 'error', retryable: false, category: 'logic',    message: 'synthesize() was called without an adapter',  fix: 'Pass options.adapter, an LlmAdapter function that calls your LLM provider.' },
  { code: 'schema:already:action',    severity: 'error', retryable: false, category: 'logic',    message: 'Two schema keys name one action on the bus', fix: 'Rename one key: each must give its own camelCase name (cart.add and cart_add are both cartAdd).' },
  { code: 'store:already:member',     severity: 'error', retryable: false, category: 'logic',    message: 'A store action is named like a store member', fix: 'Rename the action: $id, state, url, $reset, $dispose, $onField and $ready are the store\'s own.' },
  { code: 'store:invalid:name',      severity: 'error', retryable: false, category: 'validation', message: 'A store id or action key carries a "$", which names the library\'s commands', fix: 'Rename it: names with $ are the library\'s ($reset, $undo).' },
  { code: 'store:invalid:coalesce',  severity: 'error', retryable: false, category: 'logic',    message: 'A store declares both coalesce and undo', fix: 'Drop one: the undo ring records each write as it lands, and a coalesced write lands a microtask later.' },
  { code: 'store:missing:bus',        severity: 'error', retryable: false, category: 'logic',    message: 'useStore() was called without a bus',          fix: 'Pass the bus: useStore(bus). Stores are keyed per bus and never fall back to the shared one.' },
  { code: 'store:missing:router',     severity: 'error', retryable: false, category: 'logic',    message: 'A store with url fields was given no router',  fix: 'Pass the router: useStore(bus, router).' },
  { code: 'directive:timeout:dispatch', severity: 'error', retryable: true, category: 'network', message: 'A v-vc-command dispatch did not settle within its timeout', fix: 'Raise the timeout modifier (v-vc-command.60000; default 30000 ms), or check that the handler or backend answers. context.timeout is the limit that passed.' },
  { code: 'pace:limited:dispatch', severity: 'warn', retryable: true, category: 'general', message: 'Throttled at the sender: this action and target ran within the wait', fix: 'Wait for the throttle window to pass. Check context.retryIn for the remaining wait time.' },
  { code: 'pace:aborted:dispatch', severity: 'info', retryable: false, category: 'general', message: 'A newer debounced call (or dispose) superseded this one before it ran', fix: 'Normal flow: the latest call of a burst runs. Pass what changes per call as the payload, so a burst shares one key.' },
  // Router (owner: its feature, shape rule 3)
  { code: 'router:missing:route', severity: 'info', retryable: false, category: 'logic', message: 'The URL matches no route', fix: 'Expected for a server-side page: the default onError hard-navigates and the server renders it. Add a row if the client should own this URL.' },
  { code: 'router:refused:guard', severity: 'info', retryable: false, category: 'logic', message: 'A beforeEach guard returned false', fix: 'Intentional: the navigation is refused and the URL stays. Returned to the caller, not dispatched to onError.' },
  { code: 'router:aborted:navigation', severity: 'info', retryable: false, category: 'general', message: 'A newer navigation (or dispose) superseded this one', fix: 'Normal flow: the latest navigation wins. Returned to the caller, not dispatched to onError.' },
  { code: 'router:missing:routes', severity: 'error', retryable: false, category: 'logic', message: 'The route table is not loaded yet', fix: 'Await router.isReady() before resolving or navigating.' },
  { code: 'router:missing:record', severity: 'error', retryable: false, category: 'logic', message: 'No route record has this name', fix: 'Check the route name against the table (or the loader-bearing records named to revalidateRoutes).' },
  { code: 'router:exceeded:redirects', severity: 'error', retryable: false, category: 'logic', message: 'Guard redirects did not settle within the hop limit', fix: 'Two guards redirect at each other. Break the cycle; a page reload cannot fix it, so this does not hard-navigate.' },
  { code: 'router:failed:guard', severity: 'error', retryable: false, category: 'internal', message: 'A beforeEach guard threw', fix: 'A bug in the guard: error.cause is its throw. Return false or a location instead of throwing; this does not hard-navigate.' },
  { code: 'router:failed:history', severity: 'error', retryable: false, category: 'internal', message: 'The router history threw writing the URL', fix: 'A history the app supplied (createRouter({ history })) threw: error.cause is its throw. The navigation is reverted; this does not hard-navigate.' },
  { code: 'router:already:route', severity: 'error', retryable: false, category: 'validation', message: 'Two route rows share a name (dev only)', fix: 'Give every row a unique name; the generator should emit them unique.' },
  { code: 'router:missing:parent', severity: 'error', retryable: false, category: 'validation', message: 'A route row names a parent that does not exist (dev only)', fix: 'Add the parent row or fix the parent name.' },
  { code: 'router:invalid:parent', severity: 'error', retryable: false, category: 'validation', message: 'A route\'s parent chain loops back on itself (dev only)', fix: 'A route cannot be its own ancestor: fix the parent names in the cycle the message lists.' },
  { code: 'router:missing:param', severity: 'error', retryable: false, category: 'logic', message: 'A required param was not given to build a route\'s path', fix: 'Pass every required param to the link or push() for that route.' },
  { code: 'router:invalid:menu', severity: 'error', retryable: false, category: 'validation', message: 'A menu row breaks the menu rules', fix: 'meta.menu must be a number, meta.title an i18n key, and a menu route\'s path must be static.' },
  { code: 'router:invalid:path', severity: 'error', retryable: false, category: 'validation', message: 'A route path segment starting with \':\' is not a valid param (dev only)', fix: 'Use :name, :name(regex), :name? or a trailing /* splat.' },
  { code: 'router:unexpected:routes', severity: 'error', retryable: false, category: 'network', message: 'The routes payload is not JSON or has no routes array', fix: 'The server sent the table off-protocol: answer { routes: [...] } from the endpoint or the inline element. error.cause holds a parse error.' },
  { code: 'router:failed:routes', severity: 'error', retryable: false, category: 'network', message: 'The routes endpoint failed', fix: 'error.cause is the transport\'s failure; check the endpoint. start() rejects and onError receives it.' },
  { code: 'router:missing:inline', severity: 'error', retryable: false, category: 'logic', message: 'No inline routes element matches the selector (or there is no DOM)', fix: 'Render the element the selector names, or pass rows or { url } instead.' },
  { code: 'router:missing:url', severity: 'error', retryable: false, category: 'logic', message: 'reload() was called without a { url } routes source', fix: 'reload() refetches the table, so only a { url } source can reload; use setRoutes() for rows.' },
  { code: 'router:missing:component', severity: 'error', retryable: false, category: 'logic', message: 'No component is registered for a route\'s component key', fix: 'Register the key in options.components; the default onError hard-navigates so the server renders the page.' },
  { code: 'router:failed:component', severity: 'error', retryable: false, category: 'network', message: 'A lazy component failed to load', fix: 'Usually stale chunk hashes after a deploy: the default onError hard-navigates and the full load recovers. error.cause is the import\'s failure.' },
  { code: 'router:failed:loader', severity: 'error', retryable: false, category: 'network', message: 'A route loader failed', fix: 'error.cause is the loader\'s or the transport\'s failure. The page keeps its data; useRouteError surfaces it.' },
  { code: 'router:missing:loader', severity: 'error', retryable: false, category: 'logic', message: 'A route\'s load has no loader handler', fix: 'Register a preset that serves the template (vapor-chamber/router-fetch, or loaders: { prefixes, url }).' },
  { code: 'router:missing:fetchBlade', severity: 'error', retryable: false, category: 'logic', message: 'A blade route was hit with no fetchBlade available', fix: 'Pass fetchBlade (or an http client) to the router.' },
  { code: 'router:missing:http', severity: 'error', retryable: false, category: 'logic', message: 'routes: { url } was given no http client', fix: 'Pass http: routerHttp() from vapor-chamber/router/remote, or any HttpClient of your own.' },
  { code: 'router:failed:blade', severity: 'error', retryable: false, category: 'network', message: 'Fetching a blade route\'s server HTML failed', fix: 'error.cause is the fetch\'s failure; the default onError hard-navigates so the server renders the page.' },
  { code: 'router:invalid:component', severity: 'error', retryable: false, category: 'logic', message: 'The Vapor outlet was given a non-Vapor component', fix: 'Wrap it in defineVaporComponent (or compile the SFC in vapor mode); blade rows need the vDOM outlet.' },
  { code: 'router:failed:commit', severity: 'error', retryable: false, category: 'internal', message: 'A post-commit hook or a snapshot subscriber threw', fix: 'A bug in the hook or subscriber: the navigation stands.' },
  { code: 'router:failed:hook', severity: 'error', retryable: false, category: 'internal', message: 'An afterEach hook threw', fix: 'A bug in the hook: the navigation stands.' },
  { code: 'router:failed:revalidate', severity: 'error', retryable: false, category: 'network', message: 'A revalidateRoutes refresh failed', fix: 'The error is the refresh\'s failure; the page keeps its data. Pass onError to handle it yourself.' },
  { code: 'router:failed:navigation', severity: 'error', retryable: false, category: 'internal', message: 'A navigation failed with an error that is not a router error', fix: 'The error is its throw, reported by the default onError; pass onError to handle it.' },
  { code: 'router:conflict:base', severity: 'warn', retryable: false, category: 'logic', message: 'A fetched route payload declares a base other than the router\'s', fix: 'Pass base to createRouter() explicitly, or deliver the table inline.' },
  { code: 'router:missing:router', severity: 'error', retryable: false, category: 'logic', message: 'A router composable or outlet ran with no router installed', fix: 'Install the router: app.use(router).' },
  // The bus itself: a dispatch loop, a sealed bus
  { code: 'core:exceeded:depth',         severity: 'error', retryable: false, category: 'logic',      message: 'Recursive dispatch depth exceeded',                 fix: 'A listener or reaction is re-dispatching in a loop. Break the cycle or add a guard condition.' },
  { code: 'core:refused:bus',           severity: 'error', retryable: false, category: 'logic',      message: 'Mutation attempted on a sealed bus',                fix: 'The bus was sealed with bus.seal(). Register all handlers/plugins before calling seal().' },
  // Reported, not returned: what the library detects and goes on from (src/report.ts)
  { code: 'core:failed:listener',     severity: 'error', retryable: false, category: 'internal',   message: 'A listener threw',                                   fix: 'A bug in the listener: the dispatch keeps its result and the other listeners run. Catch inside the listener when the throw is expected.' },
  { code: 'core:failed:hook',         severity: 'error', retryable: false, category: 'internal',   message: 'An onAfter hook threw',                              fix: 'A bug in the hook: the dispatch keeps its result and the listeners run. Catch inside the hook when the throw is expected.' },
  { code: 'core:failed:undo',         severity: 'error', retryable: false, category: 'internal',   message: 'An optimistic action\'s undo failed after its work failed', fix: 'The state may still hold the change: make the undo unable to fail, or reconcile from the server.' },
  { code: 'core:failed:subscriber',   severity: 'error', retryable: false, category: 'internal',   message: 'A command state subscriber threw',                   fix: 'A bug in the subscriber: the dispatch goes on and the counts stay whole.' },
  { code: 'core:failed:report',       severity: 'error', retryable: false, category: 'internal',   message: 'A report formatter or sink threw',                   fix: 'A bug in the formatter or sink given to configureReport: the report printed through the defaults.' },
  { code: 'core:already:handler',     severity: 'warn',  retryable: false, category: 'logic',      message: 'A handler was registered over another for one action (dev only)', fix: 'Call the function register() returned first, or bus.clear() to reset.' },
  { code: 'core:already:plugin',      severity: 'warn',  retryable: false, category: 'logic',      message: 'Two installed plugins share an id (dev only)',      fix: 'Give each plugin its own id: a failure\'s owner names one plugin.' },
  { code: 'core:unexpected:promise',  severity: 'warn',  retryable: false, category: 'logic',      message: 'A sync bus dispatch returned a Promise (dev only)', fix: 'An async step or rule is installed: use createAsyncCommandBus().' },
  { code: 'core:unexpected:signal',   severity: 'warn',  retryable: false, category: 'logic',      message: 'Signals were created before Vue was detected (dev only)', fix: 'await waitForVueDetection() before creating signals at module init; harmless when they are never read reactively.' },
  { code: 'core:invalid:code',        severity: 'warn',  retryable: false, category: 'validation', message: 'A BusError code is not condition:subject from the vocabulary (dev only)', fix: 'Use a condition from the vocabulary: missing, already, conflict, invalid, refused, unauthenticated, limited, timeout, lost, aborted, exceeded, failed, unexpected, unknown.' },
  { code: 'core:missing:key',         severity: 'warn',  retryable: false, category: 'logic',      message: 'A command the library cannot trace to its effect has no idempotency key (dev only)', fix: 'Key it with the idempotent plugin, declare it idempotent (retry: { actionPolicies }), or send an Idempotency-Key header.' },
  { code: 'core:conflict:bus',        severity: 'warn',  retryable: false, category: 'logic',      message: 'setCommandBus() replaced a bus getCommandBus() had handed out (dev only)', fix: 'Call setCommandBus() before anything calls getCommandBus().' },
  { code: 'history:failed:move',      severity: 'error', retryable: false, category: 'internal',   message: 'An undo handler or a redo dispatch threw',          fix: 'The step is reverted: the error is its throw.' },
  { code: 'test:failed:hook',         severity: 'error', retryable: false, category: 'internal',   message: 'An onAfter hook threw on the test bus',              fix: 'A bug in the hook: the dispatch keeps its result.' },
  { code: 'test:failed:listener',     severity: 'error', retryable: false, category: 'internal',   message: 'A listener threw on the test bus',                   fix: 'A bug in the listener: the dispatch keeps its result.' },
  { code: 'mcp:missing:filter',       severity: 'warn',  retryable: false, category: 'validation', message: 'createMcpHandler was given no actionFilter: every schema action is exposed (dev only)', fix: 'Pass an allowlist actionFilter, or createActionFilter([]) to accept full exposure.' },
  { code: 'store:failed:push',        severity: 'error', retryable: false, category: 'internal',   message: 'A server push failed to write a store',              fix: 'The error is the store\'s throw; that store keeps its state.' },
  { code: 'reaction:invalid:pattern', severity: 'error', retryable: false, category: 'logic',      message: 'A reaction\'s pattern matches its own target',       fix: 'Narrow the pattern, or pass { allowSelfMatch: true } with a when guard that ends the chain.' },
  { code: 'reaction:exceeded:hops',   severity: 'error', retryable: false, category: 'logic',      message: 'A reaction chain exceeded maxHops',                  fix: 'A reaction cycle: break it with a when guard, or raise maxHops.' },
  { code: 'store:unexpected:reducer', severity: 'warn',  retryable: false, category: 'logic',      message: 'A reducer gave two different states for one input', fix: 'Mint ids and times in the call, not in the reducer: a rollback replays the reducer and must get the same state.' },
  { code: 'store:invalid:state',      severity: 'warn',  retryable: false, category: 'validation', message: 'A server state for a store is not an object',        fix: 'Answer the store state as an object; this one is not written.' },
  { code: 'store:invalid:version',    severity: 'warn',  retryable: false, category: 'validation', message: 'A store answer\'s version() is not a number',       fix: 'Return a number from version(); answers without one are written in arrival order.' },
  { code: 'store:failed:subscriber',  severity: 'error', retryable: false, category: 'internal',   message: 'A $onField subscriber threw',                        fix: 'A bug in the subscriber: the write stands and the later subscribers run.' },
  { code: 'store:failed:cleanup',     severity: 'error', retryable: false, category: 'internal',   message: 'A store cleanup threw during $dispose',              fix: 'A bug in the cleanup: the other cleanups still run.' },
  { code: 'store:invalid:clone',      severity: 'warn',  retryable: false, category: 'validation', message: 'A shared store state is not structured-cloneable (dev only)', fix: 'Keep the shared state plain data; this write stays in this tab.' },
  { code: 'store:missing:locks',      severity: 'warn',  retryable: false, category: 'logic',      message: 'A shared store found no Web Locks in this page, so it is not shared across tabs (dev only)', fix: 'Run it where the page has Web Locks, as every browser since March 2022 does: without them two tabs could end on two states.' },
  { code: 'persist:failed:save',      severity: 'warn',  retryable: false, category: 'internal',   message: 'Saving a persisted store failed',                    fix: 'The storage threw (full, or blocked): the error is its throw. The store keeps its state.' },
  { code: 'persist:failed:load',      severity: 'warn',  retryable: false, category: 'internal',   message: 'Loading a persisted store failed',                   fix: 'The stored value could not be read or parsed: the store starts fresh.' },
  { code: 'persist:invalid:state',    severity: 'warn',  retryable: false, category: 'validation', message: 'A persisted state failed validate()',                fix: 'The stored value does not pass validate(): the store starts fresh.' },
  { code: 'persist:failed:replay',    severity: 'warn',  retryable: false, category: 'internal',   message: 'Replaying the writes made before the load threw',   fix: 'A write made before the stored value was read threw on replay: the store keeps its state.' },
  { code: 'http:failed:listener',         severity: 'error', retryable: false, category: 'internal',   message: 'An onInvalidateGroup listener threw',              fix: 'A bug in the listener: the other listeners run and the groups are dropped.' },
  { code: 'transport:missing:client',     severity: 'warn',  retryable: false, category: 'logic',      message: 'An answer named cache groups, but nothing on the bus reads them (dev only)', fix: 'Give the transport the http client the router reads, or install cache() on the bus.' },
  { code: 'transport:conflict:client',    severity: 'warn',  retryable: false, category: 'logic',      message: 'Two transports of one bus have different http clients (dev only)', fix: 'Give the bus one client: its groups reach the first client only.' },
  { code: 'transport:failed:onEvent',     severity: 'error', retryable: false, category: 'internal',   message: 'The SSE bridge\'s onEvent threw',                  fix: 'A bug in onEvent: the bridge stays open and reads the next event.' },
  { code: 'transport:failed:onBroadcast', severity: 'error', retryable: false, category: 'internal',   message: 'The Echo bridge\'s broadcast handler threw',       fix: 'A bug in onBroadcast: the bridge keeps listening.' },
  { code: 'vue:missing:vapor',          severity: 'warn',  retryable: false, category: 'logic',      message: 'A Vapor helper returned null: Vue with Vapor mode was not detected (dev only)', fix: 'Run on Vue 3.6+ with Vapor, import from vapor-chamber/vapor, or use the matching define* helper from vue for VDOM mode.' },
  { code: 'vue:unexpected:probe',       severity: 'warn',  retryable: false, category: 'logic',      message: 'Vue was detected at runtime, not at build time (dev only)', fix: 'Import the composables from vapor-chamber/vue (or vapor-chamber/vapor in a Vapor app); a production bundle cannot resolve the runtime import.' },
  { code: 'vue:missing:wiring',         severity: 'warn',  retryable: false, category: 'logic',      message: 'Composables run without reactivity, cleanup or KeepAlive guard', fix: 'Import them from vapor-chamber/vue (or /vapor), or call configureVue(Vue) before the first composable.' },
  { code: 'vue:missing:scope',          severity: 'warn',  retryable: false, category: 'logic',      message: 'A composable ran outside a Vue setup() or effectScope() (dev only)', fix: 'Call the returned dispose() yourself, or run it inside setup() or effectScope(). Expected in tests and scripts.' },
  { code: 'directive:missing:action',   severity: 'warn',  retryable: false, category: 'logic',      message: 'A command binding has no action (dev only)', fix: 'Bind an action name: v-vc-command="\'cartAdd\'" or data-vc-command="cartAdd".' },
  { code: 'directive:invalid:modifier', severity: 'warn',  retryable: false, category: 'validation', message: 'v-vc-command.delegate was given .capture, .once or .passive (dev only)', fix: 'Delegation shares one document listener with no per-element options: drop .delegate, or the other modifier.' },
  { code: 'directive:invalid:app',      severity: 'warn',  retryable: false, category: 'logic',      message: 'The VDOM directive was installed on a Vapor app (dev only)', fix: 'On a Vapor app use vcCommandVapor.' },
  { code: 'bind:missing:store',         severity: 'warn',  retryable: false, category: 'logic',      message: 'A display binding names a store the bus does not have (dev only)', fix: 'Create the store before bindDisplay runs, and name it as "<id>.<field>".' },
  { code: 'mount:missing:element',      severity: 'warn',  retryable: false, category: 'logic',      message: 'VaporChamber.mount found no element for its selector, so nothing is bound (dev only)', fix: 'Call mount after the element is on the page, with a selector that matches it.' },
  { code: 'bind:invalid:router',        severity: 'warn',  retryable: false, category: 'validation', message: 'A data-vc-router names no router flag (dev only)', fix: 'Write data-vc-router="loading" or "revalidating", and call routerFacts(router, bus) so the flags reach the bus.' },
  { code: 'channel:invalid:clone',      severity: 'warn',  retryable: false, category: 'validation', message: 'A channel payload is not structured-cloneable (dev only)', fix: 'Send plain data, no functions or DOM nodes; this message stays in this tab.' },
  { code: 'schema:invalid:key',         severity: 'warn',  retryable: false, category: 'validation', message: 'A schema key normalizes to another action name (dev only)', fix: 'Register and dispatch the action under the normalized name the schema validates and lists.' },
  { code: 'transition:timeout:settle',  severity: 'warn',  retryable: true,  category: 'logic',      message: 'A transition\'s dispatch did not settle within its timeout (dev only)', fix: 'The element goes on so it is not stuck mid-transition. Raise timeout when the handler is legitimately slow.' },
  { code: 'widget:failed:load',         severity: 'error', retryable: false, category: 'network',    message: 'A widget\'s component failed to load',             fix: 'The error is the import\'s failure: check the chunk path, or stale hashes after a deploy.' },
  { code: 'reaction:failed:dispatch', severity: 'error', retryable: false, category: 'internal',   message: 'A reaction\'s dispatch threw',                       fix: 'The error is the throw of the target\'s dispatch.' },
]);

/**
 * Get the error registry entry for a BusError code.
 *
 * @example
 * if (result.error instanceof BusError) {
 *   const entry = getErrorEntry(result.error.code);
 *   console.log(entry?.fix); // actionable fix suggestion
 * }
 */
export function getErrorEntry(code: string): ErrorCodeEntry | undefined {
  // A plugin's throw is `<its id>:failed:plugin` for any id (every built-in
  // plugin declares one), so it answers with the one `plugin:failed:plugin`
  // entry. tests/plugin-ids.test.ts.
  return ERROR_CODE_REGISTRY.find(e => e.code === code)
    ?? (code.endsWith(':failed:plugin') ? ERROR_CODE_REGISTRY.find(e => e.code === 'plugin:failed:plugin') : undefined);
}

/**
 * Is this BusError code a transient (retryable) failure? Consults the registry.
 * Returns undefined for codes not in ERROR_CODE_REGISTRY.
 *
 * @example
 * if (result.error instanceof BusError && isRetryableCode(result.error.code) === false) {
 *   // permanent failure - don't re-dispatch
 * }
 */
export function isRetryableCode(code: string): boolean | undefined {
  return getErrorEntry(code)?.retryable;
}

/**
 * Describe all error codes as plain text - useful for LLM system prompts.
 *
 * @example
 * const systemPrompt = `When the bus returns an error, use this table:\n${describeErrorCodes()}`;
 */
export function describeErrorCodes(): string {
  const lines = ['Error codes (code | severity | fix):'];
  for (const e of ERROR_CODE_REGISTRY) {
    lines.push(`  ${e.code} | ${e.severity} | ${e.fix}`);
  }
  return lines.join('\n');
}

