/**
 * vapor-chamber - Schema layer
 *
 * Flat runtime schema. One source of truth for:
 *   - TypeScript types (inferred, no separate CommandMap needed)
 *   - schemaLogger: enriched logging with descriptions and field validation
 *   - toTools(): Anthropic / OpenAI tool definitions
 *   - synthesize(): natural language -> dispatch via LLM tool use
 */

import { createCommandBus, createAsyncCommandBus, _errResult, _failures } from './command-bus';
import { _report } from './report';
import { GLYPH_COMMAND, GLYPH_OK, GLYPH_WARN } from './glyphs';
import { DEV } from './dev';
import { toolInputSchema, type ToolInputSchema } from './tool-schema';
import type { Command, CommandBus, AsyncCommandBus, PluginParts, CommandResult, CommandBusOptions, AsyncCommandBusOptions, RetryPolicy, CommandMap, Fail } from './command-bus';

/** Failures of this module's functions that are not a plugin (synthesize). */
const schemaFail = _failures('schema');

// ---------------------------------------------------------------------------
// Schema types - flat and explicit
// ---------------------------------------------------------------------------

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';
export type FieldMap  = Record<string, FieldType>;

export type ActionSchema = {
  description?: string;
  target?:  FieldMap;
  payload?: FieldMap;
  result?:  FieldMap;
  /**
   * Laravel Gate ability name required to run this action - declarative,
   * server-enforced authorization. Purely descriptive on the bus itself
   * (auth must be server-side, so
   * `schemaValidator` never checks it); `scripts/generate-laravel.mjs` reads
   * it to emit `Gate::forUser($user)->authorize('<ability>', ...)` into the
   * generated action-class stub, ahead of the existing validation block.
   *
   * @example
   * cartCheckout: {
   *   authorize: 'checkout',
   *   target: { cartId: 'number' },
   * },
   */
  authorize?: string;
  /**
   * What the async bus's retry may do with this action (docs/retry.md):
   * `'idempotent'` (running it twice is safe: an uncertain failure is re-sent
   * too, under one idempotency key), `false` (never re-sent) or an attempt
   * count. Unset, the bus default: a transient failure is re-sent.
   *
   * @example
   * cartAdd:      { retry: 'idempotent', target: { id: 'number' } },
   * cartCheckout: { retry: false,        target: { cartId: 'number' } },
   */
  retry?: RetryPolicy;
  /**
   * Facts about the action, MCP's `ToolAnnotations` (schema 2025-06-18):
   * `tools/list` emits them on the tool. `readOnlyHint` or `idempotentHint`
   * true, with `retry` unset, reads as `retry: 'idempotent'` (RFC 9110 9.2.2:
   * idempotency is the operation's). tests/schema-annotations.test.ts.
   */
  annotations?: ActionAnnotations;
};

/**
 * MCP's `ToolAnnotations`, verbatim: hints about what an action does.
 * `readOnlyHint` (default false), `destructiveHint` (default true, meaningful
 * when not read-only), `idempotentHint` (default false, meaningful when not
 * read-only), `openWorldHint` (default true), and a display `title`.
 */
export type ActionAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type BusSchema = Record<string, ActionSchema>;

// ---------------------------------------------------------------------------
// Type inference - schema -> TypeScript types (single source of truth)
// ---------------------------------------------------------------------------

type InferField<F extends FieldType> =
  F extends 'string'  ? string  :
  F extends 'number'  ? number  :
  F extends 'boolean' ? boolean :
  F extends 'array'   ? any[]   :
  F extends 'object'  ? Record<string, any> : any;

type InferFields<M extends FieldMap | undefined> =
  M extends FieldMap ? { [K in keyof M]: InferField<M[K]> } : any;

// `toCamel` at the type level, so the name the bus validates is a typed name:
// a run of separators drops and upper-cases the next character, then a
// leading capital is lowered. A trailing run stays, as the regex leaves it.
type Separator = '_' | '.' | '-' | ' ' | '\t' | '\n' | '\r';
type CamelRest<S extends string> = S extends `${infer H}${infer T}` ? (H extends Separator ? CamelRun<T, H> : `${H}${CamelRest<T>}`) : S;
type CamelRun<S extends string, Run extends string> = S extends `${infer H}${infer T}` ? (H extends Separator ? CamelRun<T, `${Run}${H}`> : `${Uppercase<H>}${CamelRest<T>}`) : Run;
type ToCamel<S extends string> = CamelRest<S> extends `${infer F}${infer R}` ? `${F extends Uppercase<F> ? Lowercase<F> : F}${R}` : CamelRest<S>;

/**
 * The CommandMap a schema types: each key under its camelCase name, the one
 * the bus validates and lists. tests/schema-camel-keys.test.ts.
 */
export type InferMap<S extends BusSchema> = {
  [K in keyof S as K extends string ? ToCamel<K> : K]: {
    target:  InferFields<S[K]['target']>;
    payload: InferFields<S[K]['payload']>;
    result:  InferFields<S[K]['result']>;
  }
};


/**
 * defineSchema - identity helper that PRESERVES field-type literals, so the
 * schema keeps its inference power. Without it, `{ id: 'number' }` widens to
 * `Record<string, string>` and every inferred type collapses to `any`.
 *
 * The complete one-source-of-truth wiring:
 *
 * @example
 * // commands.ts - define once
 * export const schema = defineSchema({
 *   cartAdd: {
 *     description: 'Add a product to the cart',
 *     target:  { id: 'number', name: 'string' },
 *     payload: { qty: 'number' },
 *     result:  { count: 'number', total: 'number' },
 *   },
 *   cartCheckout: {
 *     description: 'Charge the cart and place the order',
 *     authorize: 'checkout',           // -> Gate::forUser($user)->authorize('checkout', ...)
 *     target:  { cartId: 'number' },
 *   },
 * });
 *
 * // -> typed schema bus (validation + LLM tools included)
 * const bus = createSchemaCommandBus(schema);
 *
 * // -> typed SHARED bus for every useCommand()/getCommandBus() call site
 * declare module 'vapor-chamber' {
 *   interface GlobalCommands extends InferMap<typeof schema> {}
 * }
 * setCommandBus(bus);
 *
 * // -> Laravel stubs + registry: node scripts/generate-laravel.mjs commands.mjs
 * // -> agent tools: bus.toTools() / vapor-chamber/mcp
 */
export function defineSchema<const S extends BusSchema>(schema: S): S {
  return schema;
}

// ---------------------------------------------------------------------------
// Tool format types (minimal - only what's needed externally)
// ---------------------------------------------------------------------------

export type AnthropicTool = {
  name: string;
  description?: string;
  input_schema: ToolInputSchema;
};

export type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: ToolInputSchema;
  };
};

// ---------------------------------------------------------------------------
// Naming - normalize any style to camelCase
// ---------------------------------------------------------------------------

function toCamel(s: string): string {
  return s
    .replace(/[_.\-\s]+(.)/g, (_, c: string) => c.toUpperCase())
    .replace(/^[A-Z]/, c => c.toLowerCase());
}

/**
 * Normalize all schema keys to camelCase. Write in any style, get camelCase on the bus.
 * Two keys with one camel name (`cart.add`, `cart_add`) throw: the second would
 * replace the first's definition (contract rule 8, a configuration mistake throws
 * at setup). tests/schema-camel-keys.test.ts.
 */
function normalizeSchema(schema: BusSchema): BusSchema {
  const out: BusSchema = {};
  // Keys are the app's strings: a Map, so none reads an inherited name (src/dict.ts).
  const from = new Map<string, string>();
  for (const [key, def] of Object.entries(schema)) {
    const normalized = toCamel(key);
    const first = from.get(normalized);
    if (first !== undefined) {
      throw schemaFail('already:action', `Schema keys "${first}" and "${key}" both name the action "${normalized}": one definition would be lost.${DEV ? ' Rename one.' : ''}`, { context: { keys: [first, key], action: normalized } });
    }
    from.set(normalized, key);
    // The one place the rename happens, so the one place it is reported.
    if (DEV && normalized !== key) {
      _report('warn', 'schema:invalid:key', `Schema key "${key}" is "${normalized}" on the bus: register and dispatch it as "${normalized}", the name it validates and lists.`);
    }
    out[normalized] = def;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Pre-extracted [field, expectedType] pairs ('any' filtered out at compile).
type CompiledChecks = Array<readonly [string, string]>;

function compileFields(fields: FieldMap): CompiledChecks {
  const checks: CompiledChecks = [];
  for (const [key, expected] of Object.entries(fields)) {
    if (expected !== 'any') checks.push([key, expected] as const);
  }
  return checks;
}

/** True for a plain object - arrays excluded, matching JSON Schema's `object`. */
function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function runChecks(checks: CompiledChecks, value: Record<string, any>): string[] {
  const errors: string[] = [];
  for (let i = 0, len = checks.length; i < len; i++) {
    const key = checks[i][0];
    const expected = checks[i][1];
    const v = value[key];
    if (v === undefined) { errors.push(`${key}: missing`); continue; }
    if (expected === 'array') {
      if (!Array.isArray(v)) errors.push(`${key}: expected array, got ${describe(v)}`);
    } else if (expected === 'object') {
      // A plain object, not mere presence (`filters: 42` fails). Arrays do not
      // satisfy `'object'`, per JSON Schema (and per `InferField`, which maps
      // it to Record<string, any>).
      if (!isPlainObject(v)) errors.push(`${key}: expected object, got ${describe(v)}`);
    } else if (typeof v !== expected) {
      errors.push(`${key}: expected ${expected}, got ${typeof v}`);
    }
  }
  return errors;
}

/** typeof, but distinguishing null and arrays - the two that matter here. */
function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function validateFields(fields: FieldMap, value: Record<string, any>): string[] {
  return runChecks(compileFields(fields), value);
}

// ---------------------------------------------------------------------------
// toTools
// ---------------------------------------------------------------------------

export function toAnthropicTools(schema: BusSchema): AnthropicTool[] {
  return Object.entries(schema).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: toolInputSchema(def),
  }));
}

export function toOpenAITools(schema: BusSchema): OpenAITool[] {
  return Object.entries(schema).map(([name, def]) => ({
    type: 'function',
    function: {
      name,
      description: def.description,
      parameters: toolInputSchema(def),
    },
  }));
}

export function toTools(schema: BusSchema, provider: 'anthropic' | 'openai' = 'anthropic') {
  return provider === 'openai' ? toOpenAITools(schema) : toAnthropicTools(schema);
}

// ---------------------------------------------------------------------------
// schemaValidator plugin
// ---------------------------------------------------------------------------

export function schemaValidator(schema: BusSchema): PluginParts {
  // Precompile per-action checks once. The validator sits on the default-on
  // dispatch path of createSchemaCommandBus and the schema is fixed at creation,
  // so walking Object.entries(fields) per command is pure re-allocation.
  // A side with no fields is null, not an empty list: it has nothing to check,
  // so a non-object there passes.
  const checksOf = (fields: FieldMap | undefined): CompiledChecks | null => {
    const checks = fields ? compileFields(fields) : [];
    return checks.length > 0 ? checks : null;
  };
  const compiled = new Map<string, { target: CompiledChecks | null; payload: CompiledChecks | null }>();
  for (const [action, def] of Object.entries(schema)) {
    compiled.set(action, { target: checksOf(def.target), payload: checksOf(def.payload) });
  }
  // Coded through the plugin's own `fail`: `schemaValidator:invalid:payload`,
  // a verdict (a plain Error would read `failed`, and an outbox would keep the
  // record at its head for ever: tests/errors-match-catalogue.test.ts). _errResult,
  // not a literal: one hidden class with the bus's results.
  const reject = (fail: Fail, action: string, errs: string[]): CommandResult =>
    _errResult(fail('invalid:payload', `[vapor-chamber] Validation failed for "${action}": ${errs.join(', ')}`, { action }));
  // A `validate` part: the bus asks it once per action and runs the check
  // before every plugin and the work (PluginParts).
  const check = (c: { target: CompiledChecks | null; payload: CompiledChecks | null }) => (cmd: Command, fail: Fail): CommandResult | undefined => {
    // A NON-OBJECT value must fail, not skip: otherwise `target: null` / `42`
    // / `"oops"` bypasses every required field and reaches the handler
    // malformed. This gate's most important caller is an LLM (the MCP layer
    // forwards `args?.payload` raw), the caller most likely to send a string
    // where an object belongs.
    if (c.target) {
      if (!isPlainObject(cmd.target)) return reject(fail, cmd.action, [`target: expected object, got ${describe(cmd.target)}`]);
      const errs = runChecks(c.target, cmd.target);
      if (errs.length) return reject(fail, cmd.action, errs);
    }
    // An ABSENT payload still skips: `actionToMcpTool` only declares (and
    // requires) `payload` for actions whose schema has one.
    if (c.payload && cmd.payload !== undefined) {
      if (!isPlainObject(cmd.payload)) return reject(fail, cmd.action, [`payload: expected object, got ${describe(cmd.payload)}`]);
      const errs = runChecks(c.payload, cmd.payload);
      if (errs.length) return reject(fail, cmd.action, errs);
    }
    return undefined;
  };
  return {
    id: 'schemaValidator',
    validate(action) {
      const c = compiled.get(action);
      return c && (c.target || c.payload) ? check(c) : undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// schemaLogger plugin
// ---------------------------------------------------------------------------

export type SchemaLoggerOptions = { collapsed?: boolean };

export function schemaLogger(schema: BusSchema, options: SchemaLoggerOptions = {}): PluginParts {
  const collapsed = options.collapsed ?? true;
  // A `settled` part, as `logger()`: the bus calls it with the settled result,
  // so a refusal from anywhere is logged, and the whole group is written at
  // once, never split across an await. tests/plugin-settled-part.test.ts.
  return { id: 'schemaLogger', settled(cmd, result) {
    const def = schema[cmd.action];
    const desc = def?.description ? ` - ${def.description}` : '';
    const fn = collapsed ? console.groupCollapsed : console.group;
    fn(`${GLYPH_COMMAND} ${cmd.action}${desc}`);
    if (def?.target && cmd.target && typeof cmd.target === 'object') {
      const errs = validateFields(def.target, cmd.target);
      console.log('target:', cmd.target, errs.length ? `${GLYPH_WARN} ${errs.join(', ')}` : GLYPH_OK);
    } else {
      console.log('target:', cmd.target);
    }
    if (cmd.payload !== undefined) {
      if (def?.payload && typeof cmd.payload === 'object') {
        const errs = validateFields(def.payload, cmd.payload);
        console.log('payload:', cmd.payload, errs.length ? `${GLYPH_WARN} ${errs.join(', ')}` : GLYPH_OK);
      } else {
        console.log('payload:', cmd.payload);
      }
    }
    console.log('result:', result.ok ? result.value : result.error);
    console.groupEnd();
  } };
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
  /** LLM adapter - required. Receives tool definitions + text, returns a ToolCallInput. */
  adapter?: LlmAdapter;
  /** Passed through to the adapter for provider-specific config. */
  [key: string]: unknown;
};

/**
 * synthesize - natural language -> bus dispatch via LLM tool use.
 *
 * Requires an `adapter` - a function that takes tool definitions + user text
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
    return _errResult(schemaFail('missing:adapter', 'synthesize: adapter is required. Pass an LlmAdapter function that calls your LLM provider.'));
  }
  let toolUse: ToolCallInput;
  try { toolUse = await options.adapter(toAnthropicTools(schema), text, options); }
  catch (e) { return _errResult(e as Error); }
  const { target = {}, payload } = toolUse.input ?? {};
  return Promise.resolve((bus as CommandBus).dispatch(toolUse.name, target, payload));
}

// ---------------------------------------------------------------------------
// describeSchema - plain-text schema summary for LLM system prompts
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
// fromToolCall - dispatch from a pre-existing LLM tool_use block
// ---------------------------------------------------------------------------

export type ToolCallInput = {
  name: string;
  input?: { target?: Record<string, any>; payload?: Record<string, any> } & Record<string, any>;
};

function dispatchToolCall(bus: CommandBus | AsyncCommandBus, schema: BusSchema, toolUse: ToolCallInput): any {
  const { name, input = {} } = toolUse;
  const { target = {}, payload } = input;
  // A tool call that leaves out the payload its action declares is checked as
  // an empty one, so the validator names the missing fields, as it does for
  // a left-out target. Undefined, it skipped validation (an absent payload is
  // app code's choice on dispatch()) and reached the handler as undefined;
  // a model's input is not app code. tests/tool-call-payload.test.ts.
  const declared = Object.hasOwn(schema, name) ? schema[name]!.payload : undefined;
  return (bus as CommandBus).dispatch(name, target, payload === undefined && declared ? {} : payload);
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

/**
 * The async schema bus's options. Each action's `retry` joins
 * `retry.actionPolicies`; a policy given here for the same name wins.
 */
export type AsyncSchemaCommandBusOptions = AsyncCommandBusOptions & { validate?: boolean };

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
  options?: AsyncSchemaCommandBusOptions,
): AsyncSchemaCommandBus<InferMap<S>> {
  const normalized = normalizeSchema(schema);
  const retry = options?.retry;
  const declared: Record<string, RetryPolicy> = {};
  for (const action in normalized) {
    const { retry: own, annotations: hints } = normalized[action];
    // An explicit retry is policy and wins; a read-only or idempotent hint is
    // the fact that makes a re-send safe.
    const declaration = own ?? (hints?.readOnlyHint || hints?.idempotentHint ? 'idempotent' : undefined);
    if (declaration !== undefined) declared[action] = declaration;
  }
  const bus = createAsyncCommandBus<InferMap<S>>({
    ...options,
    retry: retry === false ? false : { ...retry, actionPolicies: { ...declared, ...retry?.actionPolicies } },
  });
  if (options?.validate !== false) bus.use(schemaValidator(normalized));
  return Object.assign(bus, {
    toTools:      (provider: 'anthropic' | 'openai' = 'anthropic') => toTools(normalized, provider),
    synthesize:   (text: string, opts?: SynthesizeOptions) => synthesize(normalized, bus as unknown as AsyncCommandBus, text, opts),
    getSchema:    () => normalized,
    describe:     () => describeSchema(normalized),
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as unknown as AsyncCommandBus, normalized, toolUse),
  }) as AsyncSchemaCommandBus<InferMap<S>>;
}

/**
 * Creates a CommandBus typed from a flat runtime schema.
 * No separate CommandMap needed - TypeScript types are inferred automatically.
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
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as CommandBus, normalized, toolUse),
  }) as SchemaCommandBus<InferMap<S>>;
}

// ---------------------------------------------------------------------------
// busApiSchema - JSON Schema of the bus API for LLM code generation
// ---------------------------------------------------------------------------

/**
 * Generates a JSON Schema-style description of the bus API.
 * Include this in LLM system prompts so the model knows exactly what methods
 * are available and their signatures - reduces hallucinated method calls.
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
      description: 'Execute a command: its rules, its steps and its handler, then the afterHooks and listeners.',
      params: { action: 'string - registered action name', target: 'any - primary data (entity, id, etc.)', payload: '(optional) any - secondary data (quantities, flags, etc.)' },
      returns: 'CommandResult { ok: boolean, value?: any, error?: Error }',
    },
    query: {
      description: 'Read-only dispatch: the same as dispatch, its start not counted as pending. Use for reads/queries.',
      params: { action: 'string', target: 'any', payload: '(optional) any' },
      returns: 'CommandResult { ok: boolean, value?: any, error?: Error }',
    },
    emit: {
      description: 'Fire a domain event - notifies on() listeners only, no handler required, no return value.',
      params: { event: 'string - event name', data: '(optional) any - event payload' },
      returns: 'void',
    },
    register: {
      description: 'Register a handler for an action. Returns an unregister function.',
      params: { action: 'string', handler: '(cmd: Command) => any', options: '(optional) { undo?: Handler, optimistic?: boolean, exclusive?: Exclusive }' },
      returns: '() => void - call to unregister',
    },
    use: {
      description: 'Install a plugin: the bus places each part it declares (started, settled, authorize, validate, reuse, admit, begin, attach).',
      params: { plugin: '{ id?, actions?, actionFilter?, ...parts }' },
      returns: '() => void - call to remove plugin',
    },
    onAfter: {
      description: 'Subscribe a hook that fires after every dispatch (including failed ones).',
      params: { hook: '(cmd: Command, result: CommandResult) => void' },
      returns: '() => void - call to unsubscribe',
    },
    on: {
      description: 'Subscribe a listener for commands matching a glob pattern (e.g. "cart*", "*").',
      params: { pattern: 'string - glob pattern (* supported at end)', listener: '(cmd: Command, result: CommandResult) => void' },
      returns: '() => void - call to unsubscribe',
    },
    once: {
      description: 'Like on(), but auto-unsubscribes after the first match.',
      params: { pattern: 'string', listener: '(cmd, result) => void' },
      returns: '() => void',
    },
    request: {
      description: 'Async request/response pattern - dispatches and waits for a respond() handler.',
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
