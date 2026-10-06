/**
 * vapor-chamber - Model Context Protocol (MCP) server layer
 *
 * Exposes a schema command bus as an MCP server: every schema action becomes
 * an MCP tool, and `tools/call` requests dispatch through the bus. Zero
 * dependencies - the JSON-RPC 2.0 / MCP handshake is implemented inline, no
 * SDK required.
 *
 * Three layers, use what you need:
 *   - `busToMcpTools(schema)` - schema -> MCP tool definitions (pure mapping)
 *   - `createMcpHandler(bus)` - transport-agnostic JSON-RPC message handler
 *   - `serveMcpStdio(bus)`    - Node-only newline-delimited stdio transport
 *
 * @example
 * import { createActionFilter, createSchemaCommandBus } from 'vapor-chamber';
 * import { createMcpHandler, serveMcpStdio } from 'vapor-chamber/mcp';
 *
 * const bus = createSchemaCommandBus(schema);
 * bus.register('cartAdd', (cmd) => addToCart(cmd.target.id, cmd.payload.qty));
 * // meta.origin='agent' is stamped by the core; nothing to install.
 * const cart = createActionFilter([{ prefix: { action: 'cart' } }]);
 *
 * // Wire to any transport (HTTP body, WebSocket message, test harness, ...):
 * const handle = createMcpHandler(bus, { actionFilter: cart });
 * const reply = await handle(jsonRpcMessage); // null for notifications
 *
 * // Or run as a stdio MCP server (e.g. for Claude Desktop / claude_desktop_config.json):
 * const dispose = serveMcpStdio(bus, { actionFilter: cart });
 */

import { DEV } from './dev';
import { countOption } from './bounds';
import { BusError, _withOrigin, _errResult } from './command-bus';
import type { CommandResult } from './command-bus';
import type { ActionFilter } from './action-filter';
import type { ActionAnnotations, ActionSchema, BusSchema, FieldMap } from './schema';

// ---------------------------------------------------------------------------
// MCP tool mapping
// ---------------------------------------------------------------------------

/** An MCP tool definition, as returned by the `tools/list` method. */
export type McpTool = {
  name: string;
  description?: string;
  /** The action's `ActionSchema.annotations`, when it declares any. */
  annotations?: ActionAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
};

/** JSON Schema property map for a FieldMap ('any' -> no type constraint). */
function fieldsToJsonProps(fields: FieldMap): Record<string, { type?: string }> {
  return Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, v === 'any' ? {} : { type: v }]),
  );
}

/** Field names that carry a concrete type - 'any' fields are optional/untyped. */
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
  if (def.annotations) tool.annotations = { ...def.annotations };
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
 * // -> [{ name: 'cartAdd', description: 'Add item', inputSchema: {
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
// createMcpHandler - transport-agnostic JSON-RPC 2.0 message handler
// ---------------------------------------------------------------------------

/** Minimal bus surface the MCP layer needs - any schema bus (sync or async) satisfies it. */
export type McpBus = {
  dispatch: (action: string, target: any, payload?: any) => CommandResult | Promise<CommandResult>;
  getSchema: () => BusSchema;
};

export type McpHandlerOptions = {
  /**
   * The allowlist: an {@link ActionFilter} (`createActionFilter`). Only the
   * schema actions it selects are listed by `tools/list` and callable through
   * `tools/call`.
   *
   * **Pass this.** Omitting it exposes EVERY schema action - writes included -
   * to an LLM-driven caller, and dev-warns to say so. An MCP client is the one
   * caller class this library treats as untrusted by construction, and least
   * privilege applies: expose reads broadly, writes narrowly.
   * `createActionFilter([])` selects every action explicitly and silences the
   * warning, which is the point: demo convenience should be a deliberate
   * keystroke, not a default. To expose nothing, do not mount the handler:
   * CloudEvents rejects an empty `any`. Log s35.180.
   */
  actionFilter?: ActionFilter;
  /** Server name reported by `initialize`. Default: `'vapor-chamber'`. */
  serverName?: string;
  /** Server version reported by `initialize`. Default: the package version. */
  serverVersion?: string;
};

/**
 * Version reported by the MCP `initialize` handshake.
 *
 * Kept in sync with package.json by `tests/mcp.test.ts`, not by discipline -
 * it sat at a hardcoded '1.7.0' for four releases, so every handshake
 * advertised a version that had not existed for months. A failing test at
 * release time is the cheapest possible checklist.
 */
export const MCP_SERVER_VERSION = '1.27.0';

/** Latest MCP protocol revision this handler speaks. */
const MCP_PROTOCOL_VERSION = '2025-06-18';
/** Every revision it speaks: `initialize` echoes one of these, else answers the latest (MCP lifecycle). */
const MCP_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', MCP_PROTOCOL_VERSION];

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
 * Takes one parsed JSON-RPC 2.0 message, returns the reply object - or `null`
 * for notifications (messages without an `id`), which MUST NOT be answered.
 * Wire it to any transport: stdio (see {@link serveMcpStdio}), an HTTP POST
 * body, a WebSocket frame, or a test harness.
 *
 * Protocol methods handled:
 *   - `initialize` - echoes the client's `protocolVersion` when it is one the
 *     handler speaks (`2024-11-05`, `2025-03-26`, `2025-06-18`), else answers
 *     `'2025-06-18'`; declares `capabilities: { tools: {} }`
 *   - `notifications/initialized` - notification, no reply
 *   - `ping` - replies `{}`
 *   - `tools/list` - the schema actions `actionFilter` allows, as {@link McpTool}s
 *   - `tools/call` - dispatches `{ target, payload }` from `params.arguments`
 *     through the bus; the CommandResult is serialized as a text content
 *     block (`result.value` as JSON on success; `error.message` with
 *     `isError: true` on failure - tool errors are results, not JSON-RPC errors).
 *     A tool not listed (unknown or not allowed) is JSON-RPC error `-32602`.
 *   - anything else with an `id` - JSON-RPC error `-32601` (method not found)
 *   - a request with `id: null` - JSON-RPC error `-32600`, id null (MCP forbids a null id)
 *
 * Origin stamping: MCP-driven dispatches carry `meta.origin='agent'` on their
 * own, stamped onto the dispatch itself, so no local dispatch interleaved with
 * an awaiting tool call can be misattributed. Nothing to install.
 *
 * @example
 * const reads = createActionFilter([{ any: [{ exact: { action: 'cartGet' } }, { exact: { action: 'userGet' } }] }]);
 * const handle = createMcpHandler(bus, { actionFilter: reads });
 * const reply = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
 * // -> { jsonrpc: '2.0', id: 1, result: { tools: [...] } }
 */
export function createMcpHandler(
  bus: McpBus,
  options: McpHandlerOptions = {},
): (message: unknown) => Promise<object | null> {
  const serverName = options.serverName ?? 'vapor-chamber';
  const serverVersion = options.serverVersion ?? MCP_SERVER_VERSION;
  const allowed = options.actionFilter;
  if (allowed === undefined && DEV) {
    const exposed = Object.keys(bus.getSchema());
    console.warn(
      `[vapor-chamber] createMcpHandler({ actionFilter }) was omitted - all ${exposed.length} schema ` +
        `action(s) are exposed to the MCP client, writes included: ${exposed.join(', ')}. ` +
        'An MCP client is an LLM-driven caller; pass an allowlist ' +
        "(e.g. actionFilter: createActionFilter([{ prefix: { action: 'cartRead' } }])), " +
        'or actionFilter: createActionFilter([]) to accept full exposure deliberately.',
    );
  }
  const isAllowed = (name: string): boolean => allowed === undefined || allowed(name);

  // A tool that is not listed, unknown or not allowed, is a protocol error
  // (MCP tools: "Standard JSON-RPC errors for issues like: Unknown tools",
  // -32602); a listed tool's failure is a result. Returns the whole reply.
  async function callTool(id: JsonRpcId, params: any): Promise<object> {
    const name = params?.name;
    const args = params?.arguments;
    if (typeof name !== 'string' || name.length === 0) {
      return rpcError(id, -32602, 'Invalid params: missing tool name');
    }
    // Object.hasOwn, not `schema[name] === undefined`: a plain-object schema
    // inherits Object.prototype, so `constructor` / `toString` / `__proto__` /
    // `hasOwnProperty` all read back as defined and passed this gate - names
    // `tools/list` never advertises (busToMcpTools uses Object.entries) yet
    // reached bus.dispatch. An MCP client is untrusted by construction; a tool
    // that is not listed must not be callable.
    if (!isAllowed(name) || !Object.hasOwn(bus.getSchema(), name)) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const target = args?.target ?? {};
    // `__origin` rides the payload into stampMeta, which is the only
    // race-free place to put it: it travels with this dispatch instead of
    // sitting in a module flag that a concurrent local dispatch can read.
    // Non-object payloads (a bare string an LLM sent where an object belongs)
    // are passed through untouched - schema validation owns that complaint.
    const rawPayload = args?.payload;
    // An absent payload is legitimate - `actionToMcpTool` only declares (and
    // requires) `payload` for actions whose schema has one, so an action
    // without a payload schema has no payload checks to fail. Stamping the
    // marker anyway keeps the audit trail hole-free.
    //
    // A non-object payload is REFUSED rather than passed through. The marker
    // cannot ride on a primitive or an array, so such a dispatch would reach
    // its handler with `meta.origin === undefined`, indistinguishable from a
    // local command, and an audit trail filtering on `origin === 'agent'`
    // would miss it. schemaValidator does not catch it for an action that
    // declares no payload fields (`cartClear`-shaped), and this boundary is
    // untrusted by construction (see above).
    //
    // Refusing costs nothing legitimate: `actionToMcpTool` only ever advertises
    // `payload` as `{ type: 'object' }`, so a non-object payload is already off
    // -contract for every tool this server exposes. A counter or module flag
    // (the `_mcpDispatching` shape) is NOT an option here - this handler awaits
    // its dispatch, so a flag would span the await and reintroduce the original
    // race the marker was built to kill.
    if (
      rawPayload !== null &&
      rawPayload !== undefined &&
      (typeof rawPayload !== 'object' || Array.isArray(rawPayload))
    ) {
      return rpcResult(id, toolResult(
        `Tool "${name}": payload must be an object (got ${Array.isArray(rawPayload) ? 'array' : typeof rawPayload})`,
        true,
      ));
    }
    let result: CommandResult;
    try {
      // `await` handles both sync and async buses (thenable or plain result).
      // `_withOrigin` stamps `meta.origin = 'agent'` from the core rather than
      // by spreading a key into the caller's payload: no allocation, and the
      // handler receives exactly the object the client sent. Awaiting is safe -
      // the slot is consumed in dispatch's synchronous prologue, long before
      // this promise settles.
      result = await _withOrigin('agent', () => bus.dispatch(name, target, rawPayload));
    } catch (e) {
      result = _errResult(e as Error);
    }
    if (result.ok) return rpcResult(id, toolResult(JSON.stringify(result.value ?? null)));
    const code = result.error instanceof BusError ? ` (${result.error.code})` : '';
    return rpcResult(id, toolResult(`${result.error.message}${code}`, true));
  }

  return async (message: unknown): Promise<object | null> => {
    // Malformed envelope - not an object, missing jsonrpc/method.
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'Invalid Request');
    }
    const msg = message as Record<string, any>;
    // MCP: "Unlike base JSON-RPC, the ID MUST NOT be null": a request with
    // one is invalid, answered with id null (JSON-RPC 2.0), never ignored as
    // a notification.
    if (msg.id === null) return rpcError(null, -32600, 'Invalid Request');
    const hasId = msg.id !== undefined;
    const id: JsonRpcId = hasId ? msg.id : null;
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      // Never reply to notifications, even malformed ones.
      return hasId ? rpcError(id, -32600, 'Invalid Request') : null;
    }
    const method: string = msg.method;

    // Notifications (no id) never get a reply - process known ones silently.
    if (!hasId) return null;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion:
            MCP_PROTOCOL_VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : MCP_PROTOCOL_VERSION,
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
        return callTool(id, msg.params);
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

// ---------------------------------------------------------------------------
// serveMcpStdio - Node-only newline-delimited stdio transport
// ---------------------------------------------------------------------------

export type McpStdioOptions = McpHandlerOptions & {
  /**
   * Cap on a single line's length (UTF-16 code units) before it is abandoned.
   * A client that never sends a newline would otherwise grow the read buffer
   * without bound - same class of input-driven memory guard as the stream
   * parser's `maxDepth`. On overflow the partial line is dropped, a `-32700`
   * is written, and input is skipped to the next newline so the stream
   * resynchronises instead of dying. Default: 1 MiB. Clamped to at least 1 -
   * see the note at the destructure.
   */
  maxLineLength?: number;
  /**
   * Cap on concurrently-dispatched messages. Reaching it pauses `stdin` until
   * in-flight work drains, so a client that pipes thousands of lines cannot
   * open thousands of simultaneous dispatches. Deliberately NOT 1: MCP clients
   * legitimately issue parallel tool calls, and serialising them would make
   * every slow tool block every fast one. Default: 32. Clamped to at least 1 -
   * see the note at the destructure.
   */
  maxInFlight?: number;
};

/**
 * Serve the bus as an MCP server over stdio (Node only): newline-delimited
 * JSON-RPC 2.0 on `process.stdin` in, `process.stdout` out. This is the
 * transport MCP clients like Claude Desktop spawn subprocess servers with.
 *
 * Unparseable lines get a JSON-RPC `-32700` parse error; everything else is
 * routed through {@link createMcpHandler}. Returns its dispose function, which
 * detaches from stdin.
 *
 * Two input-driven limits keep a hostile or broken client from growing memory
 * without bound - see {@link McpStdioOptions.maxLineLength} and
 * {@link McpStdioOptions.maxInFlight}.
 *
 * Replies are written in COMPLETION order, not arrival order: messages are
 * dispatched concurrently, so a fast tool answers before a slow one issued
 * earlier. That is deliberate and JSON-RPC-legal - responses may arrive in any
 * order and `id` correlates them - and it is what keeps one slow tool call from
 * blocking every reply queued behind it.
 *
 * IMPORTANT: while serving, do not `console.log` to stdout - it would corrupt
 * the protocol stream. Log to stderr instead.
 *
 * @example
 * // mcp-server.ts - spawned by an MCP client
 * const bus = createSchemaCommandBus(schema);
 * registerHandlers(bus);
 * const dispose = serveMcpStdio(bus, { actionFilter: createActionFilter([{ prefix: { action: 'cart' } }]) });
 * process.on('SIGTERM', dispose);
 */
export function serveMcpStdio(bus: McpBus, options?: McpStdioOptions): () => void {
  if (typeof process === 'undefined' || !process.stdin || !process.stdout) {
    throw new Error('[vapor-chamber] serveMcpStdio requires a Node.js environment (process.stdin/stdout)');
  }
  const { maxLineLength: rawMaxLineLength = 1_048_576, maxInFlight: rawMaxInFlight = 32 } = options ?? {};
  // Both clamped to at least 1, because both are reachable from the public API
  // and both had a value that stopped the server dead - the same "one bad
  // option" class as `cache({ maxSize: -1 })` in plugins-extra.
  //
  // `maxInFlight: 0` was the sharp one. The first line raised inFlight to 1,
  // `1 >= 0` paused stdin, and when the dispatch finished `0 < 0` was false, so
  // it never resumed: the transport served exactly one message and then hung
  // with nothing in flight. Verified before this clamp - pause called once,
  // resume never.
  //
  // `maxLineLength: 0` is milder but still wrong: every chunk that does not end
  // on a newline is over the cap, so a message split across chunks - which the
  // suite covers as ordinary behaviour - would be abandoned as an over-long
  // line instead of reassembled.
  // Both go through ../bounds, which owns the rule: `inFlight >= maxInFlight`
  // gates REFUSAL, so a NaN bound never pauses and the backpressure this option
  // exists to provide silently does not exist. Floor of 1 because zero of
  // either is nonsense; a bad bound lands on the documented default.
  const maxLineLength = countOption(rawMaxLineLength, 1_048_576, 1);
  const maxInFlight = countOption(rawMaxInFlight, 32, 1);
  const handle = createMcpHandler(bus, options);
  const write = (reply: object): void => {
    process.stdout.write(`${JSON.stringify(reply)}\n`);
  };

  let stopped = false;
  let inFlight = 0;
  let paused = false;

  /** Pause the source while saturated; resume once the backlog clears. */
  const applyBackpressure = (): void => {
    if (stopped) return;
    if (!paused && inFlight >= maxInFlight) {
      paused = true;
      process.stdin.pause();
    } else if (paused && inFlight < maxInFlight) {
      paused = false;
      process.stdin.resume();
    }
  };

  const dispatchLine = (parsed: unknown): void => {
    inFlight++;
    applyBackpressure();
    void handle(parsed)
      // A handler rejection (a bus whose getSchema() throws, say) must not
      // sink the transport: report it and keep serving.
      .catch((): object => rpcError(null, -32603, 'Internal error'))
      .then((reply) => {
        if (reply !== null && !stopped) write(reply);
        inFlight--;
        applyBackpressure();
      });
  };

  let buffer = '';
  // True after an over-long line was abandoned: everything up to the next
  // newline belongs to that line and must be discarded with it.
  let resyncing = false;

  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (resyncing) {
        resyncing = false; // tail of the abandoned line - dropped, stream resynced
        continue;
      }
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        write(rpcError(null, -32700, 'Parse error'));
        continue;
      }
      dispatchLine(parsed);
    }
    // No newline in what remains, and it is already over the cap: drop it
    // rather than buffering an unbounded "line" the client may never end.
    if (buffer.length > maxLineLength) {
      buffer = '';
      resyncing = true;
      write(rpcError(null, -32700, `Parse error: line exceeds ${maxLineLength} characters`));
    }
  };

  process.stdin.on('data', onData);
  process.stdin.resume();
  return () => {
    stopped = true;
    process.stdin.off('data', onData);
    process.stdin.pause();
  };
}
