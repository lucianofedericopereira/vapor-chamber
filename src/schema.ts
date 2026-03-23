/**
 * vapor-chamber — Schema layer
 *
 * Flat runtime schema. One source of truth for:
 *   - TypeScript types (inferred, no separate CommandMap needed)
 *   - schemaLogger: enriched logging with descriptions and field validation
 *   - toTools(): Anthropic / OpenAI tool definitions
 *   - synthesize(): natural language → dispatch via LLM tool use
 */

import { createCommandBus, createAsyncCommandBus, BusError } from './command-bus';
import type { CommandBus, AsyncCommandBus, Plugin, CommandResult, CommandBusOptions, CommandMap, BusErrorCode, BusSeverity, BusEmitter } from './command-bus';

// ---------------------------------------------------------------------------
// Schema types — flat and explicit
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
export type FieldMap  = Record<string, FieldType>;

export type ActionSchema = {
  description?: string;
  target?:  FieldMap;
  payload?: FieldMap;
  result?:  FieldMap;
};

export type BusSchema = Record<string, ActionSchema>;

// ---------------------------------------------------------------------------
// Type inference — schema → TypeScript types (single source of truth)
// ---------------------------------------------------------------------------

type InferField<F extends FieldType> =
  F extends 'string'  ? string  :
  F extends 'number'  ? number  :
  F extends 'boolean' ? boolean :
  F extends 'array'   ? any[]   :
  F extends 'object'  ? Record<string, any> : any;

type InferFields<M extends FieldMap | undefined> =
  M extends FieldMap ? { [K in keyof M]: InferField<M[K]> } : any;

export type InferMap<S extends BusSchema> = {
  [K in keyof S]: {
    target:  InferFields<S[K]['target']>;
    payload: InferFields<S[K]['payload']>;
    result:  InferFields<S[K]['result']>;
  }
};

// ---------------------------------------------------------------------------
// Tool format types (minimal — only what's needed externally)
// ---------------------------------------------------------------------------

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: {
      target?:  { type: 'object'; properties: Record<string, { type: string }> };
      payload?: { type: 'object'; properties: Record<string, { type: string }> };
    };
  };
};

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: {
      type: 'object';
      properties: {
        target?:  { type: 'object'; properties: Record<string, { type: string }> };
        payload?: { type: 'object'; properties: Record<string, { type: string }> };
      };
    };
  };
};

// ---------------------------------------------------------------------------
// Naming — normalize any style to camelCase
// ---------------------------------------------------------------------------

function toCamel(s: string): string {
  return s
    .replace(/[_.\-\s]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, c => c.toLowerCase());
}

/** Normalize all schema keys to camelCase. Write in any style, get camelCase on the bus. */
function normalizeSchema(schema: BusSchema): BusSchema {
  const out: BusSchema = {};
  for (const [key, def] of Object.entries(schema)) {
    const normalized = toCamel(key);
    if (normalized !== key) {
      console.warn(`[vapor-chamber] Schema key "${key}" normalized to "${normalized}"`);
    }
    out[normalized] = def;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toProps(fields?: FieldMap): Record<string, { type: string }> {
  if (!fields) return {};
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { type: v }]));
}

function buildInputProperties(def: ActionSchema) {
  const props: AnthropicTool['input_schema']['properties'] = {};
  if (def.target)  props.target  = { type: 'object', properties: toProps(def.target) };
  if (def.payload) props.payload = { type: 'object', properties: toProps(def.payload) };
  return props;
}

function validateFields(fields: FieldMap, value: Record<string, any>): string[] {
  const errors: string[] = [];
  for (const [key, expected] of Object.entries(fields)) {
    if (expected === 'any') continue;
    const v = value[key];
    if (v === undefined) { errors.push(`${key}: missing`); continue; }
    if (expected === 'array' && !Array.isArray(v)) errors.push(`${key}: expected array`);
    else if (expected !== 'array' && expected !== 'object' && typeof v !== expected) {
      errors.push(`${key}: expected ${expected}, got ${typeof v}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// toTools
// ---------------------------------------------------------------------------

export function toAnthropicTools(schema: BusSchema): AnthropicTool[] {
  return Object.entries(schema).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: { type: 'object', properties: buildInputProperties(def) },
  }));
}

export function toOpenAITools(schema: BusSchema): OpenAITool[] {
  return Object.entries(schema).map(([name, def]) => ({
    type: 'function',
    function: {
      name,
      description: def.description,
      parameters: { type: 'object', properties: buildInputProperties(def) },
    },
  }));
}

export function toTools(schema: BusSchema, provider: 'anthropic' | 'openai' = 'anthropic') {
  return provider === 'openai' ? toOpenAITools(schema) : toAnthropicTools(schema);
}

// ---------------------------------------------------------------------------
// schemaValidator plugin
// ---------------------------------------------------------------------------

export function schemaValidator(schema: BusSchema): Plugin {
  return (cmd, next) => {
    const def = schema[cmd.action];
    if (!def) return next();
    if (def.target && cmd.target && typeof cmd.target === 'object') {
      const errs = validateFields(def.target, cmd.target);
      if (errs.length) return { ok: false, error: new Error(`[vapor-chamber] Validation failed for "${cmd.action}": ${errs.join(', ')}`) };
    }
    if (def.payload !== undefined && cmd.payload !== undefined && typeof cmd.payload === 'object') {
      const errs = validateFields(def.payload, cmd.payload);
      if (errs.length) return { ok: false, error: new Error(`[vapor-chamber] Validation failed for "${cmd.action}": ${errs.join(', ')}`) };
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// schemaLogger plugin
// ---------------------------------------------------------------------------

export type SchemaLoggerOptions = { collapsed?: boolean };

export function schemaLogger(schema: BusSchema, options: SchemaLoggerOptions = {}): Plugin {
  const collapsed = options.collapsed ?? true;
  return (cmd, next) => {
    const def = schema[cmd.action];
    const desc = def?.description ? ` — ${def.description}` : '';
    const result = next();
    const fn = collapsed ? console.groupCollapsed : console.group;
    fn(`⚡ ${cmd.action}${desc}`);
    if (def?.target && cmd.target && typeof cmd.target === 'object') {
      const errs = validateFields(def.target, cmd.target);
      console.log('target:', cmd.target, errs.length ? `⚠ ${errs.join(', ')}` : '✓');
    } else {
      console.log('target:', cmd.target);
    }
    if (cmd.payload !== undefined) {
      if (def?.payload && typeof cmd.payload === 'object') {
        const errs = validateFields(def.payload, cmd.payload);
        console.log('payload:', cmd.payload, errs.length ? `⚠ ${errs.join(', ')}` : '✓');
      } else {
        console.log('payload:', cmd.payload);
      }
    }
    console.log('result:', result.ok ? result.value : result.error);
    console.groupEnd();
    return result;
  };
}

// ---------------------------------------------------------------------------
// synthesize
// ---------------------------------------------------------------------------

/**
 * Custom LLM adapter for synthesize(). Receives the Anthropic-format tools, user text,
 * and options, and must return a ToolCallInput (same shape as an LLM tool_use block).
 * Use this to route LLM calls through your own proxy, OpenAI, or any other provider.
 *
 * @example
 * const adapter: LlmAdapter = async (tools, text) => {
 *   const res = await myLlmProxy.complete({ tools, prompt: text });
 *   return { name: res.toolName, input: res.args };
 * };
 */
export type LlmAdapter = (
  tools: AnthropicTool[],
  text: string,
  options: SynthesizeOptions,
) => Promise<ToolCallInput>;

export type SynthesizeOptions = {
  /** LLM adapter — required. Receives tool definitions + text, returns a ToolCallInput. */
  adapter?: LlmAdapter;
  /** Passed through to the adapter for provider-specific config. */
  [key: string]: unknown;
};

/**
 * synthesize — natural language → bus dispatch via LLM tool use.
 *
 * Requires an `adapter` — a function that takes tool definitions + user text
 * and returns a ToolCallInput. This keeps vapor-chamber vendor-agnostic:
 * bring your own Anthropic SDK, OpenAI SDK, or custom proxy.
 *
 * @example
 * const result = await synthesize(schema, bus, 'add 2 of item 5', {
 *   adapter: async (tools, text) => {
 *     const res = await anthropic.messages.create({ tools, messages: [{ role: 'user', content: text }] });
 *     const toolUse = res.content.find(b => b.type === 'tool_use');
 *     return { name: toolUse.name, input: toolUse.input };
 *   },
 * });
 */
export async function synthesize(
  schema:  BusSchema,
  bus:     CommandBus | AsyncCommandBus,
  text:    string,
  options: SynthesizeOptions = {},
): Promise<CommandResult> {
  if (!options.adapter) {
    return { ok: false, error: new Error('synthesize: adapter is required. Pass an LlmAdapter function that calls your LLM provider.') };
  }
  let toolUse: ToolCallInput;
  try { toolUse = await options.adapter(toAnthropicTools(schema), text, options); }
  catch (e) { return { ok: false, error: e as Error }; }
  const { target = {}, payload } = toolUse.input ?? {};
  return Promise.resolve((bus as CommandBus).dispatch(toolUse.name, target, payload));
}

// ---------------------------------------------------------------------------
// describeSchema — plain-text schema summary for LLM system prompts
// ---------------------------------------------------------------------------

export function describeSchema(schema: BusSchema): string {
  const lines = ['Available commands:'];
  for (const [name, def] of Object.entries(schema)) {
    const parts: string[] = [];
    if (def.target) {
      const fields = Object.entries(def.target).map(([k, v]) => `${k}:${v}`).join(', ');
      parts.push(`target: ${fields}`);
    }
    if (def.payload) {
      const fields = Object.entries(def.payload).map(([k, v]) => `${k}:${v}`).join(', ');
      parts.push(`payload: ${fields}`);
    }
    const signature = parts.length ? ` (${parts.join(', ')})` : '';
    const desc = def.description ? `: ${def.description}` : '';
    lines.push(`- ${name}${desc}${signature}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// fromToolCall — dispatch from a pre-existing LLM tool_use block
// ---------------------------------------------------------------------------

export type ToolCallInput = {
  name: string;
  input?: { target?: Record<string, any>; payload?: Record<string, any> } & Record<string, any>;
};

function dispatchToolCall(bus: CommandBus | AsyncCommandBus, toolUse: ToolCallInput): any {
  const { name, input = {} } = toolUse;
  const { target = {}, payload } = input;
  return (bus as CommandBus).dispatch(name, target, payload);
}

// ---------------------------------------------------------------------------
// createSchemaCommandBus
// ---------------------------------------------------------------------------

export type SchemaCommandBusOptions = CommandBusOptions & {
  /**
   * Auto-install schemaValidator plugin on creation. Default: `true`.
   * Set to `false` to skip validation (e.g. in production with pre-validated inputs).
   */
  validate?: boolean;
};

export type SchemaCommandBus<M extends CommandMap = CommandMap> = CommandBus<M> & {
  toTools(provider?: 'anthropic' | 'openai'): AnthropicTool[] | OpenAITool[];
  synthesize(text: string, options?: SynthesizeOptions): Promise<CommandResult>;
  getSchema(): BusSchema;
  describe(): string;
  fromToolCall(toolUse: ToolCallInput): CommandResult;
};

export type AsyncSchemaCommandBus<M extends CommandMap = CommandMap> = AsyncCommandBus<M> & {
  toTools(provider?: 'anthropic' | 'openai'): AnthropicTool[] | OpenAITool[];
  synthesize(text: string, options?: SynthesizeOptions): Promise<CommandResult>;
  getSchema(): BusSchema;
  describe(): string;
  fromToolCall(toolUse: ToolCallInput): Promise<CommandResult>;
};

/**
 * Creates a CommandBus typed from a flat runtime schema.
 * No separate CommandMap needed — TypeScript types are inferred automatically.
 *
 * @example
 * const bus = createSchemaCommandBus({
 *   cartAdd: {
 *     description: 'Add item to cart',
 *     target:  { id: 'number' },
 *     payload: { qty: 'number' },
 *     result:  { newTotal: 'number' },
 *   },
 * });
 *
 * bus.dispatch('cartAdd', { id: 1 }, { qty: 2 }); // fully typed
 * const tools = bus.toTools();                     // Anthropic tool definitions
 * const result = await bus.synthesize('add 2 of item 5', { adapter: myAdapter });
 */
/**
 * Creates an AsyncCommandBus typed from a flat runtime schema.
 * Use this when handlers perform async work (API calls, DB, LLM).
 *
 * @example
 * const bus = createAsyncSchemaCommandBus({
 *   cartAdd: { description: 'Add item', target: { id: 'number' }, payload: { qty: 'number' } },
 * });
 * bus.register('cartAdd', async (cmd) => fetchCart(cmd.target.id, cmd.payload.qty));
 * const result = await bus.synthesize('add 2 of item 5', { adapter: myAdapter });
 */
export function createAsyncSchemaCommandBus<S extends BusSchema>(
  schema:   S,
  options?: SchemaCommandBusOptions,
): AsyncSchemaCommandBus<InferMap<S>> {
  const normalized = normalizeSchema(schema);
  const bus = createAsyncCommandBus<InferMap<S>>(options);
  if (options?.validate !== false) bus.use(schemaValidator(normalized) as any);
  return Object.assign(bus, {
    toTools:      (provider: 'anthropic' | 'openai' = 'anthropic') => toTools(normalized, provider),
    synthesize:   (text: string, opts?: SynthesizeOptions) => synthesize(normalized, bus as unknown as AsyncCommandBus, text, opts),
    getSchema:    () => normalized,
    describe:     () => describeSchema(normalized),
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as unknown as AsyncCommandBus, toolUse),
  }) as AsyncSchemaCommandBus<InferMap<S>>;
}

export function createSchemaCommandBus<S extends BusSchema>(
  schema:   S,
  options?: SchemaCommandBusOptions,
): SchemaCommandBus<InferMap<S>> {
  const normalized = normalizeSchema(schema);
  const bus = createCommandBus<InferMap<S>>(options);
  if (options?.validate !== false) bus.use(schemaValidator(normalized));
  return Object.assign(bus, {
    toTools:      (provider: 'anthropic' | 'openai' = 'anthropic') => toTools(normalized, provider),
    synthesize:   (text: string, opts?: SynthesizeOptions) => synthesize(normalized, bus as CommandBus, text, opts),
    getSchema:    () => normalized,
    describe:     () => describeSchema(normalized),
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as CommandBus, toolUse),
  }) as SchemaCommandBus<InferMap<S>>;
}

// ---------------------------------------------------------------------------
// Error code registry — machine-readable table for LLMs, docs, i18n
// ---------------------------------------------------------------------------

/**
 * Error code definition — every BusError code has a structured entry.
 * Useful for generating documentation, i18n lookups, and LLM error handling.
 */
export type ErrorCodeEntry = {
  code: BusErrorCode;
  severity: BusSeverity;
  emitter: BusEmitter;
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
 * const entry = ERROR_CODE_REGISTRY.find(e => e.code === 'VC_CORE_NO_HANDLER');
 * console.log(entry?.fix); // "Register a handler with bus.register(action, handler)"
 *
 * @example
 * // Generate an LLM system prompt with all error codes
 * const prompt = ERROR_CODE_REGISTRY
 *   .map(e => `${e.code} (${e.severity}): ${e.message} → Fix: ${e.fix}`)
 *   .join('\n');
 */
export const ERROR_CODE_REGISTRY: readonly ErrorCodeEntry[] = Object.freeze([
  // Core
  { code: 'VC_CORE_NO_HANDLER',       severity: 'error', emitter: 'core',     message: 'No handler registered for action',                  fix: 'Register a handler with bus.register(action, handler) before dispatching.' },
  { code: 'VC_CORE_HANDLER_THREW',     severity: 'error', emitter: 'core',     message: 'Handler threw an exception during execution',       fix: 'Add try/catch in your handler or check the error in result.error.' },
  { code: 'VC_CORE_BEFORE_CANCEL',     severity: 'warn',  emitter: 'hook',     message: 'A beforeHook threw to cancel the dispatch',         fix: 'This is intentional cancellation. Check the beforeHook logic or remove the hook.' },
  { code: 'VC_CORE_NAMING_VIOLATION',  severity: 'warn',  emitter: 'core',     message: 'Action name does not match the naming pattern',     fix: 'Rename the action to match the pattern or adjust naming config in createCommandBus().' },
  { code: 'VC_CORE_HANDLER_OVERWRITE', severity: 'info',  emitter: 'core',     message: 'A handler was overwritten without unregistering',   fix: 'Call the unregister function returned by register() before re-registering.' },
  { code: 'VC_CORE_REQUEST_TIMEOUT',   severity: 'error', emitter: 'core',     message: 'request() timed out waiting for a response',        fix: 'Increase the timeout option or check that respond() is registered for this action.' },
  { code: 'VC_CORE_THROTTLED',         severity: 'warn',  emitter: 'core',     message: 'Handler throttled, too many calls in window',       fix: 'Wait for the throttle window to pass. Check context.retryIn for the remaining wait time.' },
  // Plugins
  { code: 'VC_PLUGIN_CIRCUIT_OPEN',    severity: 'error', emitter: 'plugin',   message: 'Circuit breaker is open due to consecutive failures', fix: 'Wait for resetTimeout to elapse. The circuit will transition to half-open and retry.' },
  { code: 'VC_PLUGIN_RATE_LIMITED',    severity: 'error', emitter: 'plugin',   message: 'Rate limit exceeded for this action',               fix: 'Reduce call frequency or increase the max/window in rateLimit() options.' },
  { code: 'VC_PLUGIN_CACHE_MISS',      severity: 'info',  emitter: 'plugin',   message: 'Cache miss — handler will be called',               fix: 'This is informational. Increase TTL or warm the cache if needed.' },
  // Workflow
  { code: 'VC_WORKFLOW_STEP_FAILED',       severity: 'error', emitter: 'workflow', message: 'A workflow step failed, running compensations',  fix: 'Check the step handler. Compensations run automatically for previous steps.' },
  { code: 'VC_WORKFLOW_COMPENSATE_FAILED', severity: 'error', emitter: 'workflow', message: 'A compensation step also failed',               fix: 'Manual intervention needed. Check the compensation handler for errors.' },
  // Hooks/Listeners
  { code: 'VC_CORE_MAX_DEPTH',         severity: 'error', emitter: 'core',     message: 'Recursive dispatch depth exceeded',                 fix: 'A listener or reaction is re-dispatching in a loop. Break the cycle or add a guard condition.' },
  { code: 'VC_CORE_SEALED',           severity: 'error', emitter: 'core',     message: 'Mutation attempted on a sealed bus',                fix: 'The bus was sealed with bus.seal(). Register all handlers/plugins before calling seal().' },
  { code: 'VC_HOOK_ERROR',             severity: 'warn',  emitter: 'hook',     message: 'An afterHook threw (logged, not fatal)',            fix: 'Fix the error in your onAfter hook. Hook errors do not affect dispatch results.' },
  { code: 'VC_LISTENER_ERROR',         severity: 'warn',  emitter: 'listener', message: 'An on() listener threw (logged, not fatal)',        fix: 'Fix the error in your on() listener. Listener errors do not affect dispatch results.' },
  // Generic
  { code: 'VC_UNKNOWN',                severity: 'error', emitter: 'core',     message: 'Unclassified error',                                fix: 'Check the error message and stack trace for details.' },
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
export function getErrorEntry(code: BusErrorCode): ErrorCodeEntry | undefined {
  return ERROR_CODE_REGISTRY.find(e => e.code === code);
}

/**
 * Describe all error codes as plain text — useful for LLM system prompts.
 *
 * @example
 * const systemPrompt = `When the bus returns an error, use this table:\n${describeErrorCodes()}`;
 */
export function describeErrorCodes(): string {
  const lines = ['Error codes (code | severity | emitter | fix):'];
  for (const e of ERROR_CODE_REGISTRY) {
    lines.push(`  ${e.code} | ${e.severity} | ${e.emitter} | ${e.fix}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// busApiSchema — JSON Schema of the bus API for LLM code generation
// ---------------------------------------------------------------------------

/**
 * Generates a JSON Schema-style description of the bus API.
 * Include this in LLM system prompts so the model knows exactly what methods
 * are available and their signatures — reduces hallucinated method calls.
 *
 * @example
 * const schema = busApiSchema();
 * const systemPrompt = `Use the vapor-chamber bus API:\n${JSON.stringify(schema, null, 2)}`;
 */
export function busApiSchema(): Record<string, {
  description: string;
  params: Record<string, string>;
  returns: string;
}> {
  return {
    dispatch: {
      description: 'Execute a command through the handler + plugin pipeline. Runs beforeHooks, handler, plugins, afterHooks, listeners.',
      params: { action: 'string — registered action name', target: 'any — primary data (entity, id, etc.)', payload: '(optional) any — secondary data (quantities, flags, etc.)' },
      returns: 'CommandResult { ok: boolean, value?: any, error?: Error }',
    },
    query: {
      description: 'Read-only dispatch — skips beforeHooks (no mutation gating), otherwise same as dispatch. Use for reads/queries.',
      params: { action: 'string', target: 'any', payload: '(optional) any' },
      returns: 'CommandResult { ok: boolean, value?: any, error?: Error }',
    },
    emit: {
      description: 'Fire a domain event — notifies on() listeners only, no handler required, no return value.',
      params: { event: 'string — event name', data: '(optional) any — event payload' },
      returns: 'void',
    },
    register: {
      description: 'Register a handler for an action. Returns an unregister function.',
      params: { action: 'string', handler: '(cmd: Command) => any', options: '(optional) { throttle?: number, undo?: Handler }' },
      returns: '() => void — call to unregister',
    },
    use: {
      description: 'Install a plugin that wraps every dispatch in a middleware chain.',
      params: { plugin: '(cmd, next) => CommandResult', options: '(optional) { priority?: number }' },
      returns: '() => void — call to remove plugin',
    },
    onBefore: {
      description: 'Subscribe a hook that fires before every dispatch. Throw to cancel the dispatch.',
      params: { hook: '(cmd: Command) => void' },
      returns: '() => void — call to unsubscribe',
    },
    onAfter: {
      description: 'Subscribe a hook that fires after every dispatch (including failed ones).',
      params: { hook: '(cmd: Command, result: CommandResult) => void' },
      returns: '() => void — call to unsubscribe',
    },
    on: {
      description: 'Subscribe a listener for commands matching a glob pattern (e.g. "cart*", "*").',
      params: { pattern: 'string — glob pattern (* supported at end)', listener: '(cmd: Command, result: CommandResult) => void' },
      returns: '() => void — call to unsubscribe',
    },
    once: {
      description: 'Like on(), but auto-unsubscribes after the first match.',
      params: { pattern: 'string', listener: '(cmd, result) => void' },
      returns: '() => void',
    },
    request: {
      description: 'Async request/response pattern — dispatches and waits for a respond() handler.',
      params: { action: 'string', target: 'any', payload: '(optional) any', options: '(optional) { timeout?: number }' },
      returns: 'Promise<CommandResult>',
    },
    respond: {
      description: 'Register a respond handler for request() calls.',
      params: { action: 'string', handler: '(cmd: Command) => any | Promise<any>' },
      returns: '() => void',
    },
    hasHandler: {
      description: 'Check if a handler is registered for the given action.',
      params: { action: 'string' },
      returns: 'boolean',
    },
    registeredActions: {
      description: 'Returns all registered action names. Useful for introspection and DevTools.',
      params: {},
      returns: 'string[]',
    },
    clear: {
      description: 'Remove all handlers, plugins, hooks, and listeners. Useful for testing and HMR.',
      params: {},
      returns: 'void',
    },
  };
}
