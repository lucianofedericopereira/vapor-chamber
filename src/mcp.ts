/**
 * vapor-chamber — Model Context Protocol (MCP) server layer
 *
 * Exposes a schema command bus as an MCP server: every schema action becomes
 * an MCP tool, and `tools/call` requests dispatch through the bus. Zero
 * dependencies — the JSON-RPC 2.0 / MCP handshake is implemented inline, no
 * SDK required.
 *
 * Three layers, use what you need:
 *   - `busToMcpTools(schema)` — schema → MCP tool definitions (pure mapping)
 *   - `createMcpHandler(bus)` — transport-agnostic JSON-RPC message handler
 *   - `serveMcpStdio(bus)`    — Node-only newline-delimited stdio transport
 *
 * @example
 * import { createSchemaCommandBus } from 'vapor-chamber';
 * import { createMcpHandler, agentOrigin, serveMcpStdio } from 'vapor-chamber/mcp';
 *
 * const bus = createSchemaCommandBus(schema);
 * bus.use(agentOrigin(), { priority: 150 }); // stamp meta.origin='agent' on MCP dispatches
 * bus.register('cartAdd', (cmd) => addToCart(cmd.target.id, cmd.payload.qty));
 *
 * // Wire to any transport (HTTP body, WebSocket message, test harness, ...):
 * const handle = createMcpHandler(bus, { actions: ['cartAdd', 'cart*'] });
 * const reply = await handle(jsonRpcMessage); // null for notifications
 *
 * // Or run as a stdio MCP server (e.g. for Claude Desktop / claude_desktop_config.json):
 * const stop = serveMcpStdio(bus, { actions: ['cart*'] });
 */

import { DEV } from './dev';
import { BusError, matchesPattern } from './command-bus';
import type { CommandResult, Plugin } from './command-bus';
import type { ActionSchema, BusSchema, FieldMap } from './schema';

// ---------------------------------------------------------------------------
// MCP tool mapping
// ---------------------------------------------------------------------------

/** An MCP tool definition, as returned by the `tools/list` method. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
};

/** JSON Schema property map for a FieldMap ('any' → no type constraint). */
function fieldsToJsonProps(fields: FieldMap): Record<string, { type?: string }> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v === 'any' ? {} : { type: v }]),
  );
}

/** Field names that carry a concrete type — 'any' fields are optional/untyped. */
function requiredFieldNames(fields: FieldMap): string[] {
  return Object.entries(fields)
    .filter(([, v]) => v !== 'any')
    .map(([k]) => k);
}

function fieldsToObjectSchema(fields: FieldMap): Record<string, any> {
  const schema: Record<string, any> = { type: 'object', properties: fieldsToJsonProps(fields) };
  const required = requiredFieldNames(fields);
  if (required.length) schema.required = required;
  return schema;
}

function actionToMcpTool(name: string, def: ActionSchema): McpTool {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  if (def.target) {
    properties.target = fieldsToObjectSchema(def.target);
    required.push('target');
  }
  if (def.payload) {
    properties.payload = fieldsToObjectSchema(def.payload);
    required.push('payload');
  }
  const tool: McpTool = { name, inputSchema: { type: 'object', properties } };
  if (def.description !== undefined) tool.description = def.description;
  if (required.length) tool.inputSchema.required = required;
  return tool;
}

/**
 * Convert a BusSchema into MCP tool definitions (the `tools/list` shape).
 *
 * Mirrors `toAnthropicTools` (from the schema module): each action becomes one tool, with
 * `target` and `payload` as nested object properties. Field types map 1:1 to
 * JSON Schema types; `'any'` fields get no type constraint and are excluded
 * from `required` (all other fields are required).
 *
 * @example
 * const tools = busToMcpTools({
 *   cartAdd: { description: 'Add item', target: { id: 'number' }, payload: { qty: 'number' } },
 * });
 * // → [{ name: 'cartAdd', description: 'Add item', inputSchema: {
 * //      type: 'object',
 * //      properties: {
 * //        target:  { type: 'object', properties: { id:  { type: 'number' } }, required: ['id'] },
 * //        payload: { type: 'object', properties: { qty: { type: 'number' } }, required: ['qty'] },
 * //      },
 * //      required: ['target', 'payload'],
 * //    } }]
 */
export function busToMcpTools(schema: BusSchema): McpTool[] {
  return Object.entries(schema).map(([name, def]) => actionToMcpTool(name, def));
}

// ---------------------------------------------------------------------------
// agentOrigin — stamp meta.origin on MCP-driven dispatches
// ---------------------------------------------------------------------------

/**
 * @deprecated Since v1.12.0 `meta.origin === 'agent'` is stamped by the core,
 * from the `__origin` key {@link createMcpHandler} puts in the payload it
 * dispatches — so this plugin has nothing left to do and is a no-op kept for
 * one release.
 *
 * It used to work off a module-level boolean raised around the handler's
 * dispatch call, which was exact on a sync bus and wrong on an async one: any
 * LOCAL dispatch entering the plugin chain while an MCP tool call was awaiting
 * an async handler got stamped `'agent'` too. The doc admitted it ("advisory,
 * not a security boundary") — but the first thing anyone builds on `origin`
 * is an audit trail or a permission gate, which is exactly the consumer that
 * needs it exact, on exactly the bus type where it wasn't. A marker that
 * travels ON the dispatch cannot be misattributed by interleaving.
 *
 * Remove the `bus.use(agentOrigin(), ...)` line; the stamp arrives without it.
 */
export function agentOrigin(): Plugin {
  return (_cmd, next) => next();
}

// ---------------------------------------------------------------------------
// createMcpHandler — transport-agnostic JSON-RPC 2.0 message handler
// ---------------------------------------------------------------------------

/** Minimal bus surface the MCP layer needs — any schema bus (sync or async) satisfies it. */
export type McpBus = {
  dispatch: (action: string, target: any, payload?: any) => CommandResult | Promise<CommandResult>;
  getSchema: () => BusSchema;
};

export type McpHandlerOptions = {
  /**
   * Action whitelist — glob patterns matched with {@link matchesPattern}
   * (`'cart*'`, exact names, or `'*'`). Only matching schema actions are
   * listed by `tools/list` and callable via `tools/call`.
   *
   * **Pass this.** Omitting it exposes EVERY schema action — writes included —
   * to an LLM-driven caller, and dev-warns to say so. An MCP client is the one
   * caller class this library treats as untrusted by construction, and least
   * privilege applies: expose reads broadly, writes narrowly. `['*']` opts
   * into everything explicitly and silences the warning, which is the point:
   * demo convenience should be a deliberate keystroke, not a default.
   */
  actions?: string[];
  /** Server name reported by `initialize`. Default: `'vapor-chamber'`. */
  serverName?: string;
  /** Server version reported by `initialize`. Default: the package version. */
  serverVersion?: string;
};

/**
 * Version reported by the MCP `initialize` handshake.
 *
 * Kept in sync with package.json by `tests/mcp.test.ts`, not by discipline —
 * it sat at a hardcoded '1.7.0' for four releases, so every handshake
 * advertised a version that had not existed for months. A failing test at
 * release time is the cheapest possible checklist.
 */
export const MCP_SERVER_VERSION = '1.14.0';

/** Latest MCP protocol revision this handler speaks. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: object): object {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): object {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** CallToolResult with a single text block. Tool failures are results, not protocol errors. */
function toolResult(text: string, isError?: boolean): object {
  const result: { content: Array<{ type: 'text'; text: string }>; isError?: true } = {
    content: [{ type: 'text', text }],
  };
  if (isError) result.isError = true;
  return result;
}

/**
 * Create a transport-agnostic MCP message handler for a schema command bus.
 *
 * Takes one parsed JSON-RPC 2.0 message, returns the reply object — or `null`
 * for notifications (messages without an `id`), which MUST NOT be answered.
 * Wire it to any transport: stdio (see {@link serveMcpStdio}), an HTTP POST
 * body, a WebSocket frame, or a test harness.
 *
 * Protocol methods handled:
 *   - `initialize` — echoes the client's `protocolVersion` (or advertises
 *     `'2025-06-18'`), declares `capabilities: { tools: {} }`
 *   - `notifications/initialized` — notification, no reply
 *   - `ping` — replies `{}`
 *   - `tools/list` — whitelisted schema actions as {@link McpTool}s
 *   - `tools/call` — dispatches `{ target, payload }` from `params.arguments`
 *     through the bus; the CommandResult is serialized as a text content
 *     block (`result.value` as JSON on success; `error.message` with
 *     `isError: true` on failure — tool errors are results, not JSON-RPC errors)
 *   - anything else with an `id` — JSON-RPC error `-32601` (method not found)
 *
 * Origin stamping: install {@link agentOrigin} on the bus
 * (`bus.use(agentOrigin(), { priority: 150 })`) to stamp `meta.origin='agent'`
 * on MCP-driven dispatches. See {@link agentOrigin} for the concurrency
 * caveat on async buses.
 *
 * @example
 * const handle = createMcpHandler(bus, { actions: ['cartGet', 'cartAdd'] });
 * const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
 * // → { jsonrpc: '2.0', id: 1, result: { tools: [...] } }
 */
export function createMcpHandler(
  bus: McpBus,
  options: McpHandlerOptions = {},
): (message: unknown) => Promise<object | null> {
  const serverName = options.serverName ?? 'vapor-chamber';
  const serverVersion = options.serverVersion ?? MCP_SERVER_VERSION;
  const whitelist = options.actions;
  if (whitelist === undefined && DEV) {
    const exposed = Object.keys(bus.getSchema());
    console.warn(
      `[vapor-chamber] createMcpHandler({ actions }) was omitted — all ${exposed.length} schema ` +
        `action(s) are exposed to the MCP client, writes included: ${exposed.join(', ')}. ` +
        'An MCP client is an LLM-driven caller; pass an explicit whitelist ' +
        "(e.g. actions: ['cartRead*']), or actions: ['*'] to accept full exposure deliberately.",
    );
  }
  const isAllowed = (name: string): boolean =>
    whitelist === undefined || whitelist.some((pattern) => matchesPattern(pattern, name));

  async function callTool(params: any): Promise<object> {
    const name = params?.name;
    const args = params?.arguments;
    if (typeof name !== 'string' || name.length === 0) {
      return toolResult('tools/call: missing tool name', true);
    }
    if (!isAllowed(name) || bus.getSchema()[name] === undefined) {
      return toolResult(`Tool "${name}" is unknown or not permitted`, true);
    }
    const target = args?.target ?? {};
    // `__origin` rides the payload into stampMeta, which is the only
    // race-free place to put it: it travels with this dispatch instead of
    // sitting in a module flag that a concurrent local dispatch can read.
    // Non-object payloads (a bare string an LLM sent where an object belongs)
    // are passed through untouched — schema validation owns that complaint.
    const rawPayload = args?.payload;
    // An absent payload is legitimate — `actionToMcpTool` only declares (and
    // requires) `payload` for actions whose schema has one, so an action
    // without a payload schema has no payload checks to fail. Stamping the
    // marker anyway keeps the audit trail hole-free.
    // A non-object, non-null payload (a bare string or array where an object
    // belongs) is passed through untouched: there is nothing to spread into,
    // and schemaValidator rejects that shape on its own.
    const payload =
      rawPayload === null || rawPayload === undefined
        ? { __origin: 'agent' }
        : typeof rawPayload === 'object' && !Array.isArray(rawPayload)
          ? { ...rawPayload, __origin: 'agent' }
          : rawPayload;
    let result: CommandResult;
    try {
      // `await` handles both sync and async buses (thenable or plain result).
      result = await bus.dispatch(name, target, payload);
    } catch (e) {
      result = { ok: false, error: e as Error };
    }
    if (result.ok) return toolResult(JSON.stringify(result.value ?? null));
    const code = result.error instanceof BusError ? ` (${result.error.code})` : '';
    return toolResult(`${result.error.message}${code}`, true);
  }

  return async (message: unknown): Promise<object | null> => {
    // Malformed envelope — not an object, missing jsonrpc/method.
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const msg = message as Record<string, any>;
    const hasId = msg.id !== undefined && msg.id !== null;
    const id: JsonRpcId = hasId ? msg.id : null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Never reply to notifications, even malformed ones.
      return hasId ? rpcError(id, -32600, 'Invalid Request') : null;
    }
    const method: string = msg.method;

    // Notifications (no id) never get a reply — process known ones silently.
    if (!hasId) return null;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion:
            typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: serverVersion },
        });
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, {
          tools: busToMcpTools(bus.getSchema()).filter((tool) => isAllowed(tool.name)),
        });
      case 'tools/call':
        return rpcResult(id, await callTool(msg.params));
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

// ---------------------------------------------------------------------------
// serveMcpStdio — Node-only newline-delimited stdio transport
// ---------------------------------------------------------------------------

/**
 * Serve the bus as an MCP server over stdio (Node only): newline-delimited
 * JSON-RPC 2.0 on `process.stdin` in, `process.stdout` out. This is the
 * transport MCP clients like Claude Desktop spawn subprocess servers with.
 *
 * Unparseable lines get a JSON-RPC `-32700` parse error; everything else is
 * routed through {@link createMcpHandler}. Returns a `stop()` function that
 * detaches from stdin.
 *
 * IMPORTANT: while serving, do not `console.log` to stdout — it would corrupt
 * the protocol stream. Log to stderr instead.
 *
 * @example
 * // mcp-server.ts — spawned by an MCP client
 * const bus = createSchemaCommandBus(schema);
 * bus.use(agentOrigin(), { priority: 150 });
 * registerHandlers(bus);
 * const stop = serveMcpStdio(bus, { actions: ['cart*', 'productGet'] });
 * process.on('SIGTERM', stop);
 */
export function serveMcpStdio(bus: McpBus, options?: McpHandlerOptions): () => void {
  if (typeof process === 'undefined' || !process.stdin || !process.stdout) {
    throw new Error('[vapor-chamber] serveMcpStdio requires a Node.js environment (process.stdin/stdout)');
  }
  const handle = createMcpHandler(bus, options);
  const write = (reply: object): void => {
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  };
  let buffer = '';
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, 'Parse error'));
        continue;
      }
      void handle(parsed).then((reply) => {
        if (reply !== null) write(reply);
      });
    }
  };
  process.stdin.on('data', onData);
  process.stdin.resume();
  return () => {
    process.stdin.off('data', onData);
    process.stdin.pause();
  };
}
