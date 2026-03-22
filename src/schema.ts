/**
 * vapor-chamber — Schema layer
 *
 * Flat runtime schema. One source of truth for:
 *   - TypeScript types (inferred, no separate CommandMap needed)
 *   - schemaLogger: enriched logging with descriptions and field validation
 *   - toTools(): Anthropic / OpenAI tool definitions
 *   - synthesize(): natural language → dispatch via LLM tool use
 */

import { createCommandBus, createAsyncCommandBus } from './command-bus';
import type { CommandBus, AsyncCommandBus, Plugin, CommandResult, CommandBusOptions, CommandMap } from './command-bus';

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
  apiKey?:  string;
  model?:   string;
  system?:  string;
  fetch?:   typeof globalThis.fetch;
  /**
   * Custom LLM adapter. When provided, bypasses the built-in Anthropic API call.
   * Receives tool definitions, user text, and options — returns a ToolCallInput.
   */
  adapter?: LlmAdapter;
};

const DEFAULT_SYSTEM =
  'You are a command dispatcher. Use the provided tools to dispatch the ' +
  'appropriate command based on the user intent. Use exactly one tool. ' +
  'Pass arguments as { target: {...}, payload: {...} } matching the schema.';

export async function synthesize(
  schema:  BusSchema,
  bus:     CommandBus | AsyncCommandBus,
  text:    string,
  options: SynthesizeOptions = {},
): Promise<CommandResult> {
  if (options.adapter) {
    let toolUse: ToolCallInput;
    try { toolUse = await options.adapter(toAnthropicTools(schema), text, options); }
    catch (e) { return { ok: false, error: e as Error }; }
    const { target = {}, payload } = toolUse.input ?? {};
    return Promise.resolve((bus as CommandBus).dispatch(toolUse.name, target, payload));
  }

  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiKey  = options.apiKey ?? (typeof process !== 'undefined' ? process.env?.ANTHROPIC_API_KEY : undefined);

  if (!apiKey) return { ok: false, error: new Error('synthesize: apiKey is required') };

  let response: Response;
  try {
    response = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model:       options.model ?? 'claude-haiku-4-5-20251001',
        max_tokens:  256,
        tools:       toAnthropicTools(schema),
        tool_choice: { type: 'any' },
        system:      options.system ?? DEFAULT_SYSTEM,
        messages:    [{ role: 'user', content: text }],
      }),
    });
  } catch (e) {
    return { ok: false, error: e as Error };
  }

  if (!response.ok) {
    return { ok: false, error: new Error(`LLM API ${response.status}: ${await response.text()}`) };
  }

  const data    = await response.json();
  const toolUse = data.content?.find((b: any) => b.type === 'tool_use');

  if (!toolUse) return { ok: false, error: new Error('LLM did not select a tool') };

  // LLM returns { target: {...}, payload: {...} } — pass directly, no splitting
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
 * const result = await bus.synthesize('add 2 of item 5', { apiKey });
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
 * const result = await bus.synthesize('add 2 of item 5', { apiKey });
 */
export function createAsyncSchemaCommandBus<S extends BusSchema>(
  schema:   S,
  options?: CommandBusOptions,
): AsyncSchemaCommandBus<InferMap<S>> {
  const normalized = normalizeSchema(schema);
  const bus = createAsyncCommandBus<InferMap<S>>(options);
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
  options?: CommandBusOptions,
): SchemaCommandBus<InferMap<S>> {
  const normalized = normalizeSchema(schema);
  const bus = createCommandBus<InferMap<S>>(options);
  return Object.assign(bus, {
    toTools:      (provider: 'anthropic' | 'openai' = 'anthropic') => toTools(normalized, provider),
    synthesize:   (text: string, opts?: SynthesizeOptions) => synthesize(normalized, bus as CommandBus, text, opts),
    getSchema:    () => normalized,
    describe:     () => describeSchema(normalized),
    fromToolCall: (toolUse: ToolCallInput) => dispatchToolCall(bus as CommandBus, toolUse),
  }) as SchemaCommandBus<InferMap<S>>;
}
