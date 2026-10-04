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
import { GLYPH_COMMAND, GLYPH_OK, GLYPH_WARN } from './glyphs';
import { onSettled } from './settled';
import type { CommandBus, AsyncCommandBus, Plugin, CommandResult, CommandBusOptions, AsyncCommandBusOptions, RetryDeclaration, CommandMap, BusSeverity, Fail } from './command-bus';

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
   * What the async bus's retry may do with this action (docs/plan-shape.md 4):
   * `'idempotent'` (running it twice is safe: an uncertain failure is re-sent
   * too, under one idempotency key), `false` (never re-sent) or an attempt
   * count. Unset, the bus default: a transient failure is re-sent.
   *
   * @example
   * cartAdd:      { retry: 'idempotent', target: { id: 'number' } },
   * cartCheckout: { retry: false,        target: { cartId: 'number' } },
   */
  retry?: RetryDeclaration;
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

export type InferMap<S extends BusSchema> = {
  [K in keyof S]: {
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
// Naming - normalize any style to camelCase
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

// Required, not optional: both call sites below are inside `if (def.target)` /
// `if (def.payload)`, so an optional `fields?` would need a `!fields` guard
// nothing could reach. Typechecked, not assumed - an unguarded caller fails to
// compile rather than silently returning {}.
function toProps(fields: FieldMap): Record<string, { type: string }> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { type: v }]));
}

function buildInputProperties(def: ActionSchema) {
  const props: AnthropicTool['input_schema']['properties'] = {};
  if (def.target)  props.target  = { type: 'object', properties: toProps(def.target) };
  if (def.payload) props.payload = { type: 'object', properties: toProps(def.payload) };
  return props;
}

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
  // Precompile per-action checks once. The validator sits on the default-on
  // dispatch path of createSchemaCommandBus and the schema is fixed at creation,
  // so walking Object.entries(fields) per command is pure re-allocation.
  const compiled = new Map<string, { target: CompiledChecks | null; payload: CompiledChecks | null }>();
  for (const [action, def] of Object.entries(schema)) {
    compiled.set(action, {
      target: def.target ? compileFields(def.target) : null,
      payload: def.payload !== undefined ? compileFields(def.payload) : null,
    });
  }
  // Coded through the plugin's own `fail`: `schemaValidator:invalid:payload`,
  // a verdict (as a plain Error it read `failed`, and an outbox kept the record
  // at its head for ever: tests/errors-match-catalogue.test.ts). _errResult,
  // not a literal: one hidden class with the bus's results.
  const reject = (fail: Fail, action: string, errs: string[]): CommandResult =>
    _errResult(fail('invalid:payload', `[vapor-chamber] Validation failed for "${action}": ${errs.join(', ')}`, { action }));
  const plugin: Plugin = (cmd, next, fail) => {
    const c = compiled.get(cmd.action);
    if (!c) return next();
    // A NON-OBJECT value must fail, not skip: otherwise `target: null` / `42`
    // / `"oops"` bypasses every required field and reaches the handler
    // malformed. This gate's most important caller is an LLM (the MCP layer
    // forwards `args?.payload` raw), the caller most likely to send a string
    // where an object belongs.
    if (c.target && c.target.length > 0 && !isPlainObject(cmd.target)) {
      return reject(fail, cmd.action, [`target: expected object, got ${describe(cmd.target)}`]);
    }
    if (c.target && isPlainObject(cmd.target)) {
      const errs = runChecks(c.target, cmd.target);
      if (errs.length) return reject(fail, cmd.action, errs);
    }
    // An ABSENT payload still skips: `actionToMcpTool` only declares (and
    // requires) `payload` for actions whose schema has one, and a schema with
    // no payload fields compiles to zero checks anyway.
    if (c.payload && c.payload.length > 0 && cmd.payload !== undefined && !isPlainObject(cmd.payload)) {
      return reject(fail, cmd.action, [`payload: expected object, got ${describe(cmd.payload)}`]);
    }
    if (c.payload && isPlainObject(cmd.payload)) {
      const errs = runChecks(c.payload, cmd.payload);
      if (errs.length) return reject(fail, cmd.action, errs);
    }
    return next();
  };
  return Object.assign(plugin, { id: 'schemaValidator' });
}

// ---------------------------------------------------------------------------
// schemaLogger plugin
// ---------------------------------------------------------------------------

export type SchemaLoggerOptions = { collapsed?: boolean };

export function schemaLogger(schema: BusSchema, options: SchemaLoggerOptions = {}): Plugin {
  const collapsed = options.collapsed ?? true;
  // THROUGH `onSettled`, for the reason src/settled.ts spells out: `next()`
  // returns a PROMISE on the async bus, so `result.ok` was `undefined` and the
  // `result:` line printed the ERROR branch for every command, successes
  // included, with `undefined` as the error. `logger()` had exactly this
  // defect and was fixed in the sweep that file records; this logger and the
  // SSR plugin were missed because that sweep was run over `plugins-*.ts` and
  // neither of them lives there.
  //
  // The group is opened INSIDE the callback, so on an async bus the whole
  // group is written when the result settles rather than split across the
  // await - otherwise concurrent dispatches interleave their group contents.
  const plugin: Plugin = (cmd, next) => onSettled(next(), (result) => {
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
    return result;
  }) as CommandResult;
  return Object.assign(plugin, { id: 'schemaLogger' });
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

/**
 * The async schema bus's options. Each action's `retry` joins
 * `retry.actions`; a declaration given here for the same name wins.
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
  const declared: Record<string, RetryDeclaration> = {};
  for (const action in normalized) if (normalized[action].retry !== undefined) declared[action] = normalized[action].retry!;
  const bus = createAsyncCommandBus<InferMap<S>>({
    ...options,
    retry: retry === false ? false : { ...retry, actions: { ...declared, ...retry?.actions } },
  });
  if (options?.validate !== false) bus.use(schemaValidator(normalized) as any);
  return Object.assign(bus, {
    toTools:      (provider: 'anthropic' | 'openai' = 'anthropic') => toTools(normalized, provider),
    synthesize:   (text: string, opts?: SynthesizeOptions) => synthesize(normalized, bus as unknown as AsyncCommandBus, text, opts),
    getSchema:    () => normalized,
    describe:     () => describeSchema(normalized),
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as unknown as AsyncCommandBus, toolUse),
  }) as AsyncSchemaCommandBus<InferMap<S>>;
}

/**
 * Creates a CommandBus typed from a flat runtime schema.
 * No separate CommandMap needed - TypeScript types are inferred automatically.
 *
 * (This block sat ABOVE `createAsyncSchemaCommandBus`'s own docblock, two
 * comments stacked with no declaration between them - so an editor attached
 * only the lower one to that function and this one to nothing, leaving the
 * sync factory with no tooltip at all.)
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
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as CommandBus, toolUse),
  }) as SchemaCommandBus<InferMap<S>>;
}

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
   * Whether the async bus re-sends it for any action: a transient condition
   * (`limited`, `timeout`). An uncertain one is re-sent only for an idempotent
   * action or a keyed command, and reads false here. An outcome of the code's
   * condition under RETRYABLE_CONDITIONS, not a judgement per row (asserted in
   * tests/schema.test.ts).
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
// barrel-import bundle).
export const ERROR_CODE_REGISTRY: readonly ErrorCodeEntry[] = /* @__PURE__ */ Object.freeze([
  // Core
  { code: 'core:missing:handler',       severity: 'error', retryable: false, category: 'internal',   message: 'No handler registered for action',                  fix: 'Register a handler with bus.register(action, handler) before dispatching.' },
  // Not emitted by the bus - see the note on this code in command-bus.ts. The
  // row stays because the code is public and a consumer may construct one, but
  // its text must not promise a handler throw arrives as this code.
  { code: 'core:failed:handler',     severity: 'error', retryable: false, category: 'general',    message: 'Declared for a handler throw; the bus rethrows those unwrapped instead', fix: 'The bus does not emit this. A handler throw arrives as the handler\'s own error in result.error - read that. Only a BusError you construct yourself carries this code; the async bus does not re-send it (a bug would fail again).' },
  { code: 'core:refused:hook',     severity: 'error', retryable: false, category: 'logic',      message: 'A beforeHook threw to cancel the dispatch',         fix: 'This is intentional cancellation. Check the beforeHook logic or remove the hook.' },
  { code: 'core:invalid:name',  severity: 'warn',  retryable: false, category: 'validation', message: 'Action name does not match the naming pattern, or carries a "$" (the library\'s names)',     fix: 'Rename the action: match the pattern, or adjust naming config in createCommandBus(); names with $ are the library\'s.' },
  { code: 'core:already:handler', severity: 'info',  retryable: false, category: 'internal',   message: 'A handler was overwritten without unregistering',   fix: 'Call the unregister function returned by register() before re-registering.' },
  { code: 'core:timeout:request',   severity: 'error', retryable: true,  category: 'network',    message: 'request() timed out waiting for a response',        fix: 'Increase the timeout option or check that respond() is registered for this action.' },
  { code: 'core:limited:handler',         severity: 'warn',  retryable: true,  category: 'general',    message: 'Handler throttled, too many calls in window',       fix: 'Wait for the throttle window to pass. Check context.retryIn for the remaining wait time.' },
  { code: 'core:aborted:dispatch',           severity: 'warn',  retryable: false, category: 'general',    message: 'Dispatch aborted via its AbortSignal before completion', fix: 'Intentional cancellation (ac.abort()). Re-dispatch explicitly if the abort was premature.' },
  { code: 'validator:invalid:payload',      severity: 'error', retryable: false, category: 'validation', message: 'Schema or per-action validation rejected the dispatch', fix: 'Fix the target/payload fields listed in the error message to match the declared schema.' },
  { code: 'validateSchemas:invalid:payload',    severity: 'error', retryable: false, category: 'validation', message: 'Schema or per-action validation rejected the dispatch', fix: 'Fix the target/payload fields listed in the error message to match the declared schema.' },
  { code: 'schemaValidator:invalid:payload',    severity: 'error', retryable: false, category: 'validation', message: 'The bus schema rejected the dispatch', fix: 'Fix the target/payload fields listed in the error message to match the schema the bus was created with.' },
  // Plugins
  { code: 'throttle:limited:handler',    severity: 'warn',  retryable: true,  category: 'general',    message: 'Throttled: this action and target ran within the wait', fix: 'Wait for the throttle window to pass. Check context.retryIn for the remaining wait time.' },
  { code: 'circuitBreaker:limited:action',    severity: 'error', retryable: true,  category: 'network',    message: 'Circuit breaker is open due to consecutive failures', fix: 'Wait for resetTimeout to elapse. The circuit will transition to half-open and retry.' },
  { code: 'authGuard:unauthenticated:action', severity: 'warn',  retryable: false, category: 'logic',      message: 'The action is protected and the user is not authenticated', fix: 'Sign in first, or remove the action from authGuard({ protected }).' },
  { code: 'rateLimit:limited:action',    severity: 'error', retryable: true,  category: 'general',    message: 'Rate limit exceeded for this action',               fix: 'Reduce call frequency or increase the max/window in rateLimit() options.' },
  { code: 'pollWith:timeout:job',        severity: 'error', retryable: true,  category: 'network',    message: 'An accepted job was not done within maxWait',       fix: 'The backend answered 202 and its status monitor kept answering 202: raise maxWait in pollWith() or check the job.' },
  { code: 'plugin:failed:plugin',           severity: 'error', retryable: false, category: 'internal',   message: 'A plugin threw or rejected in its own body',        fix: 'A pipeline bug, not a server failure: error.cause is the original and context.index is the plugin\'s place in the chain (0 = outermost). Make it return next() or an errResult instead of throwing.' },
  // Transports
  { code: 'transport:refused:redirect',    severity: 'error', retryable: false,category: 'logic',    message: 'The backend answered with a redirect instead of a result', fix: 'Pass an onRedirect handler to the bridge (e.g. Inertia\'s router.visit), or stop the backend redirecting this command.' },
  { code: 'transport:lost:result',    severity: 'error', retryable: false, category: 'internal', message: 'A batch answered without this command\'s result: it may have run',     fix: 'The backend must answer every batched command by the id it was sent. The outcome is unknown, so it is re-sent only with an idempotency key.' },
  { code: 'transport:lost:command',  severity: 'error', retryable: false, category: 'general',  message: 'The offline send queue is full; the oldest command was dropped', fix: 'Raise maxQueueSize, or stop dispatching while the socket is down - context.command is the one dropped.' },
  { code: 'transport:lost:reply',      severity: 'error', retryable: false, category: 'network',  message: 'The socket closed or was torn down before the reply arrived',  fix: 'Reconnect and dispatch again. The outcome is unknown, so the async bus re-sends it only for an idempotent action or a keyed command.' },
  { code: 'transport:missing:csrf', severity: 'error', retryable: false, category: 'logic', message: 'No CSRF token was found after refreshing it', fix: 'The csrfCookieUrl endpoint must set the XSRF-TOKEN cookie (Laravel Sanctum: /sanctum/csrf-cookie), or the page must carry the csrf-token meta tag.' },
  { code: 'transport:aborted:request', severity: 'warn', retryable: false, category: 'general', message: 'The caller aborted the request (its AbortSignal)', fix: 'Intentional cancellation. Send the request again if the abort was premature.' },
  { code: 'remote:unexpected:json', severity: 'error', retryable: false, category: 'network', message: 'The response declared JSON and its body is not valid JSON', fix: 'The backend answered off-protocol: fix the body or its Content-Type. Re-sent only for an idempotent request.' },
  { code: 'transport:timeout:reply',     severity: 'error', retryable: true,  category: 'network',  message: 'No reply arrived within the transport\'s own timeout',          fix: 'Raise the bridge timeout option, or check the backend is answering. Transient, so the async bus re-sends it.' },
  // Functions that are not a plugin (owner: their feature)
  { code: 'ssr:invalid:bus',          severity: 'error', retryable: false, category: 'logic',    message: 'rehydrate() was given an async bus',         fix: 'Use await rehydrateAsync(bus, commands) on an AsyncCommandBus.' },
  { code: 'schema:missing:adapter',   severity: 'error', retryable: false, category: 'logic',    message: 'synthesize() was called without an adapter',  fix: 'Pass options.adapter, an LlmAdapter function that calls your LLM provider.' },
  { code: 'store:already:member',     severity: 'error', retryable: false, category: 'logic',    message: 'A store action is named like a store member', fix: 'Rename the action: $id, state, url, $reset and $dispose are the store\'s own.' },
  { code: 'store:invalid:name',      severity: 'error', retryable: false, category: 'validation', message: 'A store id or action key carries a "$", which names the library\'s commands', fix: 'Rename it: names with $ are the library\'s ($reset, $undo).' },
  { code: 'store:missing:bus',        severity: 'error', retryable: false, category: 'logic',    message: 'useStore() was called without a bus',          fix: 'Pass the bus: useStore(bus). Stores are keyed per bus and never fall back to the shared one.' },
  { code: 'store:missing:router',     severity: 'error', retryable: false, category: 'logic',    message: 'A store with url fields was given no router',  fix: 'Pass the router: useStore(bus, router).' },
  { code: 'directive:timeout:dispatch', severity: 'error', retryable: true, category: 'network', message: 'A v-vc-command dispatch did not settle within its timeout', fix: 'Raise the timeout modifier (v-vc-command.60000; default 30000 ms), or check that the handler or backend answers. context.timeout is the limit that passed.' },
  // Router (owner: its feature, shape rule 3)
  { code: 'router:missing:route', severity: 'info', retryable: false, category: 'logic', message: 'The URL matches no route', fix: 'Expected for a server-side page: the default onError hard-navigates and the server renders it. Add a row if the client should own this URL.' },
  { code: 'router:refused:guard', severity: 'info', retryable: false, category: 'logic', message: 'A beforeEach guard returned false', fix: 'Intentional: the navigation is refused and the URL stays. Returned to the caller, not dispatched to onError.' },
  { code: 'router:aborted:navigation', severity: 'info', retryable: false, category: 'general', message: 'A newer navigation (or destroy) superseded this one', fix: 'Normal flow: the latest navigation wins. Returned to the caller, not dispatched to onError.' },
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
  { code: 'router:missing:router', severity: 'error', retryable: false, category: 'logic', message: 'A router composable or outlet ran with no router installed', fix: 'Install the router: app.use(router).' },
  // Workflow
  { code: 'workflow:failed:step',       severity: 'error', retryable: false, category: 'logic',    message: 'A workflow step failed, running compensations',  fix: 'Check the step handler. Compensations run automatically for previous steps.' },
  { code: 'workflow:failed:compensation', severity: 'error', retryable: false, category: 'internal', message: 'A compensation step also failed',               fix: 'Manual intervention needed. Check the compensation handler for errors.' },
  // Hooks/Listeners
  { code: 'core:exceeded:depth',         severity: 'error', retryable: false, category: 'logic',      message: 'Recursive dispatch depth exceeded',                 fix: 'A listener or reaction is re-dispatching in a loop. Break the cycle or add a guard condition.' },
  { code: 'core:refused:bus',           severity: 'error', retryable: false, category: 'logic',      message: 'Mutation attempted on a sealed bus',                fix: 'The bus was sealed with bus.seal(). Register all handlers/plugins before calling seal().' },
  { code: 'core:failed:hook',             severity: 'warn',  retryable: false, category: 'internal',   message: 'An afterHook threw (logged, not fatal)',            fix: 'Fix the error in your onAfter hook. Hook errors do not affect dispatch results.' },
  { code: 'core:failed:listener',         severity: 'warn',  retryable: false, category: 'internal',   message: 'An on() listener threw (logged, not fatal)',        fix: 'Fix the error in your on() listener. Listener errors do not affect dispatch results.' },
  // Generic
  { code: 'core:unknown:error',                severity: 'error', retryable: false, category: 'general',    message: 'Unclassified error',                                fix: 'Check the error message and stack trace for details.' },
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
      description: 'Execute a command through the handler + plugin pipeline. Runs beforeHooks, handler, plugins, afterHooks, listeners.',
      params: { action: 'string - registered action name', target: 'any - primary data (entity, id, etc.)', payload: '(optional) any - secondary data (quantities, flags, etc.)' },
      returns: 'CommandResult { ok: boolean, value?: any, error?: Error }',
    },
    query: {
      description: 'Read-only dispatch - skips beforeHooks (no mutation gating), otherwise same as dispatch. Use for reads/queries.',
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
      params: { action: 'string', handler: '(cmd: Command) => any', options: '(optional) { throttle?: number, undo?: Handler }' },
      returns: '() => void - call to unregister',
    },
    use: {
      description: 'Install a plugin that wraps every dispatch in a middleware chain.',
      params: { plugin: '(cmd, next) => CommandResult', options: '(optional) { priority?: number }' },
      returns: '() => void - call to remove plugin',
    },
    onBefore: {
      description: 'Subscribe a hook that fires before every dispatch. Throw to cancel the dispatch.',
      params: { hook: '(cmd: Command) => void' },
      returns: '() => void - call to unsubscribe',
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
