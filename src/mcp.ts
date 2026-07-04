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
 * Mirrors {@link toAnthropicTools}: each action becomes one tool, with
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
 * Module-level flag raised by the MCP handler around its dispatch call.
 * The {@link agentOrigin} plugin reads it to tell MCP-driven dispatches apart
 * from direct local dispatches on the same bus.
 */
let _mcpDispatching = false;

/**
 * Plugin factory: stamps `cmd.meta.origin = 'agent'` on commands dispatched
 * through an MCP handler ({@link createMcpHandler} / {@link serveMcpStdio}),
 * and leaves direct `bus.dispatch()` calls untouched.
 *
 * Install it with a high priority so the stamp is visible to every other
 * plugin, hook, and listener in the chain:
 *
 * @example
 * const bus = createSchemaCommandBus(schema);
 * bus.use(agentOrigin(), { priority: 150 });
 * bus.use((cmd, next) => {
 *   if (cmd.meta?.origin === 'agent') auditLog(cmd); // only MCP traffic
 *   return next();
 * });
 *
 * Known limitation — the detection is a module-scoped flag set synchronously
 * around the handler's dispatch call. On a sync bus this is exact. On an
 * async bus with concurrent mixed traffic (an MCP tool call awaiting an async
 * handler while local code dispatches on the same bus), an interleaved local
 * dispatch that enters the plugin chain during that window can be stamped
 * too. It is best-effort for that scenario; treat `origin === 'agent'` as
 * advisory, not a security boundary.
 */
export function agentOrigin(): Plugin {
  return (cmd, next) => {
    if (_mcpDispatching && cmd.meta) cmd.meta.origin = 'agent';
    return next();
  };
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
   * Default: ALL schema actions are exposed. That is convenient for demos,
   * but for anything that mutates state you should pass an explicit
   * whitelist — an MCP client is an LLM-driven caller, and least privilege
   * applies: expose reads broadly, writes narrowly.
   */
  actions?: string[];
  /** Server name reported by `initialize`. Default: `'vapor-chamber'`. */
  serverName?: string;
  /** Server version reported by `initialize`. Default: `'1.7.0'`. */
  serverVersion?: string;
};

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
  const serverVersion = options.serverVersion ?? '1.7.0';
  const whitelist = options.actions;
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
    const payload = args?.payload;
    let result: CommandResult;
    _mcpDispatching = true;
    try {
      // `await` handles both sync and async buses (thenable or plain result).
      result = await bus.dispatch(name, target, payload);
    } catch (e) {
      result = { ok: false, error: e as Error };
    } finally {
      _mcpDispatching = false;
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
