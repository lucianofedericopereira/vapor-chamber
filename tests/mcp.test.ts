/**
 * Tests for the MCP layer: busToMcpTools, createMcpHandler, agentOrigin, serveMcpStdio
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { busToMcpTools, createMcpHandler, agentOrigin, serveMcpStdio } from '../src/mcp';
import type { McpTool } from '../src/mcp';
import { createSchemaCommandBus, createAsyncSchemaCommandBus } from '../src/schema';
import type { BusSchema } from '../src/schema';

afterEach(() => vi.restoreAllMocks());

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

// ---------------------------------------------------------------------------
// busToMcpTools
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createMcpHandler — protocol methods
// ---------------------------------------------------------------------------

describe('createMcpHandler — protocol', () => {
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
    expect(reply.result.serverInfo).toEqual({ name: 'vapor-chamber', version: '1.7.0' });
  });

  it('ping replies with an empty result', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 'p1', method: 'ping' });

    expect(reply).toEqual({ jsonrpc: '2.0', id: 'p1', result: {} });
  });

  it('tools/list returns all schema actions by default', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });

    const names = reply.result.tools.map((t: McpTool) => t.name);
    expect(names).toEqual(['cartAdd', 'cartClear', 'ping']);
  });

  it('tools/list respects the actions whitelist (glob patterns)', async () => {
    const handle = createMcpHandler(makeBus(), { actions: ['cart*'] });

    const reply: any = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/list' });

    const names = reply.result.tools.map((t: McpTool) => t.name);
    expect(names).toEqual(['cartAdd', 'cartClear']);
  });

  it('notifications (no id) get null — including notifications/initialized', async () => {
    const handle = createMcpHandler(makeBus());

    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })).toBeNull();
    // Unknown notification method: still no reply.
    expect(await handle({ jsonrpc: '2.0', method: 'nope/nothing' })).toBeNull();
  });

  it('unknown method with an id → -32601 with matching id', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 42, method: 'resources/list' });

    expect(reply.id).toBe(42);
    expect(reply.error.code).toBe(-32601);
    expect(reply.error.message).toContain('resources/list');
  });

  it('malformed messages → -32600', async () => {
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

// ---------------------------------------------------------------------------
// createMcpHandler — tools/call
// ---------------------------------------------------------------------------

describe('createMcpHandler — tools/call', () => {
  it('dispatches on a real schema bus and returns the value as JSON text', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'cartAdd', arguments: { target: { id: 5 }, payload: { qty: 2 } } },
    });

    expect(reply.id).toBe(10);
    expect(reply.result.isError).toBeUndefined();
    expect(reply.result.content).toEqual([{ type: 'text', text: JSON.stringify({ count: 2, id: 5 }) }]);
  });

  it('works with an async bus (awaits thenable dispatch results)', async () => {
    const bus = createAsyncSchemaCommandBus(cartSchema);
    bus.register('cartClear', async () => ({ cleared: true }));
    const handle = createMcpHandler(bus);

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'cartClear', arguments: { target: { force: true } } },
    });

    expect(JSON.parse(reply.result.content[0].text)).toEqual({ cleared: true });
  });

  it('serializes a void success as null', async () => {
    const bus = makeBus();
    bus.register('ping', () => undefined);
    const handle = createMcpHandler(bus);

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'ping', arguments: {} },
    });

    expect(reply.result.content[0].text).toBe('null');
  });

  it('failing handler → isError result with the error message (not a protocol error)', async () => {
    const bus = makeBus();
    bus.register('cartClear', () => {
      throw new Error('cart is locked');
    });
    const handle = createMcpHandler(bus);

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'cartClear', arguments: { target: { force: true } } },
    });

    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('cart is locked');
  });

  it('unhandled action → isError result including the BusError code', async () => {
    const bus = createSchemaCommandBus(cartSchema); // no handlers registered
    const handle = createMcpHandler(bus);

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'cartAdd', arguments: { target: { id: 1 }, payload: { qty: 1 } } },
    });

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('VC_CORE_NO_HANDLER');
  });

  it('non-whitelisted action → isError, and the handler is never invoked', async () => {
    const bus = makeBus();
    const spy = vi.fn();
    bus.on('*', spy);
    const handle = createMcpHandler(bus, { actions: ['cartClear'] });

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'cartAdd', arguments: { target: { id: 1 }, payload: { qty: 1 } } },
    });

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('unknown or not permitted');
    expect(spy).not.toHaveBeenCalled();
  });

  it('unknown tool name → isError', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'notATool', arguments: {} },
    });

    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('unknown or not permitted');
  });

  it('missing tool name → isError', async () => {
    const handle = createMcpHandler(makeBus());

    const reply: any = await handle({ jsonrpc: '2.0', id: 17, method: 'tools/call', params: {} });

    expect(reply.result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agentOrigin
// ---------------------------------------------------------------------------

describe('agentOrigin', () => {
  it("stamps meta.origin='agent' on MCP-driven dispatches only", async () => {
    const bus = makeBus();
    bus.use(agentOrigin(), { priority: 150 });
    const origins: Array<string | undefined> = [];
    bus.on('cartAdd', (cmd) => origins.push(cmd.meta?.origin));
    const handle = createMcpHandler(bus);

    // Direct dispatch — no stamp.
    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });
    // MCP-driven dispatch — stamped.
    await handle({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'cartAdd', arguments: { target: { id: 2 }, payload: { qty: 2 } } },
    });
    // Direct dispatch after the MCP call — flag was cleared, no stamp.
    bus.dispatch('cartAdd', { id: 3 }, { qty: 3 });

    expect(origins).toEqual([undefined, 'agent', undefined]);
  });

  it('clears the flag even when the MCP dispatch fails', async () => {
    const bus = makeBus();
    bus.use(agentOrigin(), { priority: 150 });
    bus.register('cartClear', () => {
      throw new Error('boom');
    });
    const handle = createMcpHandler(bus);

    await handle({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: { name: 'cartClear', arguments: { target: { force: true } } },
    });
    const origins: Array<string | undefined> = [];
    bus.on('cartAdd', (cmd) => origins.push(cmd.meta?.origin));
    bus.dispatch('cartAdd', { id: 1 }, { qty: 1 });

    expect(origins).toEqual([undefined]);
  });
});

// ---------------------------------------------------------------------------
// serveMcpStdio
// ---------------------------------------------------------------------------

describe('serveMcpStdio', () => {
  it('answers newline-delimited JSON-RPC on stdin via stdout and stops cleanly', async () => {
    const writes: string[] = [];
    const writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: any) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const stop = serveMcpStdio(makeBus());

    try {
      process.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'));
      process.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
      process.stdin.emit('data', Buffer.from('not json\n'));
      // Split across chunks to exercise the line buffer.
      process.stdin.emit('data', Buffer.from('{"jsonrpc":"2.0","id":2,'));
      process.stdin.emit('data', Buffer.from('"method":"tools/list"}\n'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      stop();
      writeSpy.mockRestore();
    }

    const replies = writes
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{"jsonrpc"'))
      .map((line) => JSON.parse(line));
    // Parse errors are written synchronously, handler replies on a microtask —
    // so match by id rather than arrival order.
    expect(replies).toHaveLength(3); // ping + parse error + tools/list; the notification got no reply
    expect(replies.find((r) => r.id === 1)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(replies.find((r) => r.error)?.error.code).toBe(-32700);
    const toolsReply = replies.find((r) => r.id === 2);
    expect(toolsReply.result.tools.map((t: McpTool) => t.name)).toEqual(['cartAdd', 'cartClear', 'ping']);
  });
});
