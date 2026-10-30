/**
 * The MCP layer: busToMcpTools, createMcpHandler, the agent origin, serveMcpStdio.
 * Why: an agent client would see wrong tool definitions, get wrong protocol replies, or dispatch commands that carry no agent attribution.
 * Shows: schema-to-tool mapping, JSON-RPC replies and error codes, tools/call results, `meta.origin = 'agent'` on MCP dispatches only, stdio line framing, and the handler defaults.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createActionFilter } from '../src/action-filter';
import { busToMcpTools, createMcpHandler, serveMcpStdio, MCP_SERVER_VERSION } from '../src/mcp';
import type { McpTool } from '../src/mcp';
import { createSchemaCommandBus, createAsyncSchemaCommandBus } from '../src/schema';
import type { BusSchema } from '../src/schema';
import { mcpClient } from '../src/vitest-pure';


const cartSchema: BusSchema = {
  cartAdd: {
    description: 'Add item to cart',
    target: { id: 'number' },
    payload: { qty: 'number', note: 'any' },
  },
  cartClear: {
    description: 'Empty the cart',
    target: { force: 'boolean' },
  },
  ping: {
    description: 'No target, no payload',
  },
};

function makeBus() {
  const bus = createSchemaCommandBus(cartSchema);
  bus.register('cartAdd', (cmd) => ({ count: cmd.payload.qty, id: cmd.target.id }));
  bus.register('cartClear', () => ({ cleared: true }));
  return bus;
}

describe('busToMcpTools', () => {
  it('maps schema actions to MCP tool definitions', () => {
    const tools = busToMcpTools(cartSchema);

    expect(tools).toHaveLength(3);
    const cartAdd = tools.find((t) => t.name === 'cartAdd')!;
    expect(cartAdd.description).toBe('Add item to cart');
    expect(cartAdd.inputSchema.type).toBe('object');
    expect(cartAdd.inputSchema.properties.target).toEqual({
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    });
    expect(cartAdd.inputSchema.properties.payload.properties.qty).toEqual({ type: 'number' });
    expect(cartAdd.inputSchema.required).toEqual(['target', 'payload']);
  });

  it("excludes 'any' fields from required and gives them no type constraint", () => {
    const tools = busToMcpTools(cartSchema);
    const cartAdd = tools.find((t) => t.name === 'cartAdd')!;

    expect(cartAdd.inputSchema.properties.payload.required).toEqual(['qty']);
    expect(cartAdd.inputSchema.properties.payload.properties.note).toEqual({});
  });

  it('handles actions with no target or payload', () => {
    const tools = busToMcpTools(cartSchema);
    const ping = tools.find((t) => t.name === 'ping')!;

    expect(ping.inputSchema).toEqual({ type: 'object', properties: {} });
  });
});

describe('createMcpHandler - protocol', () => {
  it("initialize echoes the client's protocolVersion and reports serverInfo", async () => {
    const handle = createMcpHandler(makeBus(), { serverName: 'test-server', serverVersion: '9.9.9' });

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
    });

    expect(reply.id).toBe(1);
    expect(reply.result.protocolVersion).toBe('2024-11-05');
    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.serverInfo).toEqual({ name: 'test-server', version: '9.9.9' });
  });

  it('initialize falls back to the default protocol version and server identity', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });

    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.serverInfo).toEqual({ name: 'vapor-chamber', version: MCP_SERVER_VERSION });
  });

  it('ping replies with an empty result', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 'p1', method: 'ping' });

    expect(reply).toEqual({ jsonrpc: '2.0', id: 'p1', result: {} });
  });

  it('tools/list returns all schema actions by default', async () => {
    const mcp = mcpClient(createMcpHandler(makeBus()));

    expect(await mcp.toolNames()).toEqual(['cartAdd', 'cartClear', 'ping']);
  });

  it('tools/list lists what actionFilter allows', async () => {
    const mcp = mcpClient(createMcpHandler(makeBus(), { actionFilter: createActionFilter([{ prefix: { action: 'cart' } }]) }));

    expect(await mcp.toolNames()).toEqual(['cartAdd', 'cartClear']);
  });

  it('notifications (no id) get null - including notifications/initialized', async () => {
    const handle = createMcpHandler(makeBus());

    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })).toBeNull();
    expect(await handle({ jsonrpc: '2.0', method: 'nope/nothing' })).toBeNull();
  });

  it('unknown method with an id -> -32601 with matching id', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 42, method: 'resources/list' });

    expect(reply.id).toBe(42);
    expect(reply.error.code).toBe(-32601);
    expect(reply.error.message).toContain('resources/list');
  });

  it('malformed messages -> -32600', async () => {
    const handle = createMcpHandler(makeBus());

    const notObject: any = await handle('nonsense');
    expect(notObject.error.code).toBe(-32600);

    const noMethod: any = await handle({ jsonrpc: '2.0', id: 5 });
    expect(noMethod.id).toBe(5);
    expect(noMethod.error.code).toBe(-32600);

    const badVersion: any = await handle({ jsonrpc: '1.0', id: 6, method: 'ping' });
    expect(badVersion.error.code).toBe(-32600);
  });
});

describe('createMcpHandler - tools/call', () => {
  it('dispatches on a real schema bus and returns the value as JSON text', async () => {
    const mcp = mcpClient(createMcpHandler(makeBus()));

    const result = await mcp.call('cartAdd', { target: { id: 5 }, payload: { qty: 2 } });

    expect(result).toBeToolResult({ count: 2, id: 5 });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ count: 2, id: 5 }) }] });
  });

  it('never lets an MCP dispatch reach a handler unattributed', async () => {
    // The origin marker rides in the payload, so only an object payload can carry it; a non-object one must be refused.
    const seen: Array<{ action: string; origin: unknown }> = [];
    const bus = createSchemaCommandBus(cartSchema);
    bus.register('cartClear', (cmd: any) => {
      seen.push({ action: cmd.action, origin: cmd.meta?.origin });
      return { cleared: true };
    });
    const mcp = mcpClient(createMcpHandler(bus));

    const call = (payloadArgs: object) => mcp.call('cartClear', { target: { force: true }, ...payloadArgs });

    expect(await call({ payload: { a: 1 } })).toBeToolResult();
    expect(await call({})).toBeToolResult();

    for (const bad of ['bare-string', 42, true, ['a', 'b']]) {
      expect(await call({ payload: bad })).toBeToolError(/payload must be an object/);
    }

    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.origin === 'agent')).toBe(true);
  });

  it('works with an async bus (awaits thenable dispatch results)', async () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    bus.register('cartClear', async () => ({ cleared: true }));
    const mcp = mcpClient(createMcpHandler(bus));

    expect(await mcp.call('cartClear', { target: { force: true } })).toBeToolResult({ cleared: true });
  });

  it('serializes a void success as null', async () => {
    const bus = makeBus();
    bus.register('ping', () => undefined);
    const mcp = mcpClient(createMcpHandler(bus));

    const result = await mcp.call('ping');

    expect(result).toBeToolResult(null);
    expect(result.content[0].text).toBe('null');
  });

  it('failing handler -> isError result with the error message (not a protocol error)', async () => {
    const bus = makeBus();
    bus.register('cartClear', () => {
      throw new Error('cart is locked');
    });
    const mcp = mcpClient(createMcpHandler(bus));

    // call() throws on a protocol error, so a returned result is not one.
    expect(await mcp.call('cartClear', { target: { force: true } })).toBeToolError('cart is locked');
  });

  it('unhandled action -> isError result including the BusError code', async () => {
    const bus = createSchemaCommandBus(cartSchema); // no handlers registered
    const mcp = mcpClient(createMcpHandler(bus));

    expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 1 } })).toBeToolError('core:missing:handler');
  });

  it('an action actionFilter does not allow -> JSON-RPC -32602, and the handler is never invoked', async () => {
    const bus = makeBus();
    const spy = vi.fn();
    bus.on('*', spy);
    const mcp = mcpClient(createMcpHandler(bus, { actionFilter: createActionFilter([{ exact: { action: 'cartClear' } }]) }));

    await expect(mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 1 } })).rejects.toMatchObject({ code: -32602 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('unknown tool name -> JSON-RPC -32602', async () => {
    const mcp = mcpClient(createMcpHandler(makeBus()));

    await expect(mcp.call('notATool')).rejects.toMatchObject({ code: -32602 });
  });

  it('missing tool name -> JSON-RPC -32602', async () => {
    const mcp = mcpClient(createMcpHandler(makeBus()));

    // No `name` at all, which call() cannot send: the raw request.
    expect((await mcp.request('tools/call', {})).error).toMatchObject({ code: -32602 });
  });
});

describe("meta.origin = 'agent'", () => {
  it("stamps meta.origin='agent' on MCP-driven dispatches only", async () => {
    const bus = makeBus();
    const origins: Array<string | undefined> = [];
    bus.on('cartAdd', (cmd) => origins.push(cmd.meta?.origin));
    const mcp = mcpClient(createMcpHandler(bus));

    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
    await mcp.call('cartAdd', { target: { id: 2 }, payload: { qty: 2 } });
    bus.dispatch('cartAdd', { id: 3 }, { qty: 3 });

    expect(origins).toEqual([undefined, 'agent', undefined]);
  });

  it('a failed MCP dispatch leaves no stamp behind', async () => {
    const bus = makeBus();
    bus.register('cartClear', () => {
      throw new Error('boom');
    });
    const mcp = mcpClient(createMcpHandler(bus));

    await mcp.call('cartClear', { target: { force: true } });
    const origins: Array<string | undefined> = [];
    bus.on('cartAdd', (cmd) => origins.push(cmd.meta?.origin));
    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });

    expect(origins).toEqual([undefined]);
  });
});

describe('serveMcpStdio', () => {
  it('answers newline-delimited JSON-RPC on stdin via stdout and stops cleanly', async () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: any) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const dispose = serveMcpStdio(makeBus());

    try {
      process.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'));
      process.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
      process.stdin.emit('data', Buffer.from('not json\n'));
      // One message split across two chunks exercises the line buffer.
      process.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,'));
      process.stdin.emit('data', Buffer.from('"method":"tools/list"}\n'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      dispose();
      writeSpy.mockRestore();
    }

    const replies = writes
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{"jsonrpc"'))
      .map((line) => JSON.parse(line));
    // Parse errors are written synchronously, handler replies on a microtask: match by id, not order.
    expect(replies).toHaveLength(3); // ping + parse error + tools/list; the notification got no reply
    expect(replies.find((r) => r.id === 1)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(replies.find((r) => r.error)?.error.code).toBe(-32700);
    const toolsReply = replies.find((r) => r.id === 2);
    expect(toolsReply.result.tools.map((t: McpTool) => t.name)).toEqual(['cartAdd', 'cartClear', 'ping']);
  });
});

describe('createMcpHandler defaults', () => {
  it('the advertised server version tracks package.json', async () => {
    // Fails after a package bump until the constant follows, so `initialize` never reports a stale version.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
  });

  it('warns when `actionFilter` is omitted, naming what it exposed', () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMcpHandler(makeBus());

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cartAdd'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writes included'));
  });

  it('does not warn when exposure is declared, every action included: createActionFilter([])', () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMcpHandler(makeBus(), { actionFilter: createActionFilter([{ exact: { action: 'cartAdd' } }]) });
    createMcpHandler(makeBus(), { actionFilter: createActionFilter([]) });

    expect(warn).not.toHaveBeenCalled();
  });
});
