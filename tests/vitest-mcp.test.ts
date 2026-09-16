/**
 * `mcpClient` and the tool-result matchers from `vapor-chamber/vitest/pure`
 * (plan 11.6, F1): test an MCP surface the way an agent reaches it, through a
 * real `createMcpHandler`, without writing JSON-RPC envelopes by hand.
 */
import { describe, expect, it } from 'vitest';
import { createMcpHandler } from '../src/mcp';
import { createAsyncSchemaCommandBus, createSchemaCommandBus } from '../src/schema';
import type { BusSchema } from '../src/schema';
import { mcpClient, tap } from '../src/vitest-pure';

const schema: BusSchema = {
  cartAdd: { description: 'Add item', target: { id: 'number' }, payload: { qty: 'number' } },
  cartClear: { description: 'Empty the cart', target: { force: 'boolean' } },
};

function shop() {
  const bus = tap(createSchemaCommandBus(schema));
  bus.register('cartAdd', (cmd) => ({ count: cmd.payload.qty }));
  bus.register('cartClear', () => {
    throw new Error('cart is locked');
  });
  return bus;
}

/** Runs a matcher and returns its failure message, or throws if it passed. */
function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return withoutColors(String((e as Error).message));
  }
  throw new Error('expected a failure');
}

// Vitest colors a diff in a color terminal (FORCE_COLOR, a TTY); the text read is the same.
const withoutColors = (text: string) => text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');

describe('mcpClient', () => {
  it('calls a tool through the real handler: the value comes back parsed, and the bus saw an agent dispatch', async () => {
    const bus = shop();
    const mcp = mcpClient(createMcpHandler(bus, { actions: ['cart*'] }));

    expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: { qty: 2 } })).toBeToolResult({ count: 2 });
    expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 2 });
  });

  it('lists what an agent can see', async () => {
    const mcp = mcpClient(createMcpHandler(shop(), { actions: ['cartAdd'] }));
    expect(await mcp.toolNames()).toEqual(['cartAdd']);
    expect((await mcp.tools())[0]).toMatchObject({ name: 'cartAdd', description: 'Add item' });
  });

  it('a refused or failing tool is a tool error, not a thrown one', async () => {
    const mcp = mcpClient(createMcpHandler(shop(), { actions: ['cartAdd', 'cartClear'] }));
    expect(await mcp.call('cartClear', { target: { force: true } })).toBeToolError('cart is locked');
    expect(await mcp.call('orderCreate')).toBeToolError(/unknown or not permitted/);
    expect(await mcp.call('cartAdd', { target: { id: 1 }, payload: 'bare' })).toBeToolError();
  });

  it('initialize and raw requests number their ids; a protocol error throws with its JSON-RPC code', async () => {
    const mcp = mcpClient(createMcpHandler(shop(), { actions: ['*'] }));
    expect(await mcp.initialize({ protocolVersion: '2024-11-05' })).toMatchObject({ protocolVersion: '2024-11-05' });
    expect(await mcp.request('ping')).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    // request() hands back the raw reply, errors included: it is for testing the envelope.
    expect(await mcp.request('resources/list')).toMatchObject({ id: 3, error: { code: -32601 } });
    // The typed calls throw on a protocol error, with its code.
    const broken = mcpClient(async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found: tools/list' } }));
    await expect(broken.tools()).rejects.toMatchObject({ message: 'MCP tools/list failed: -32601 Method not found: tools/list', code: -32601 });
    await expect(broken.call('a')).rejects.toMatchObject({ code: -32601 });
    await expect(broken.initialize()).rejects.toMatchObject({ code: -32601 });
  });

  it('a notification gets no reply', async () => {
    const mcp = mcpClient(createMcpHandler(shop(), { actions: ['*'] }));
    expect(await mcp.notify('notifications/initialized')).toBeNull();
    expect(await mcp.notify('notifications/cancelled', { requestId: 1 })).toBeNull();
  });

  it('works on an async bus', async () => {
    const bus = createAsyncSchemaCommandBus(schema);
    bus.register('cartAdd', async (cmd) => cmd.payload.qty * 2);
    expect(await mcpClient(createMcpHandler(bus, { actions: ['*'] })).call('cartAdd', { target: { id: 1 }, payload: { qty: 4 } })).toBeToolResult(8);
  });
});

describe('toBeToolResult / toBeToolError', () => {
  const ok = { content: [{ type: 'text', text: '{"count":2}' }] };
  const bad = { content: [{ type: 'text', text: 'Tool "x" is unknown or not permitted' }], isError: true };

  it('toBeToolResult: success alone, success with the parsed value, and .not', () => {
    expect(ok).toBeToolResult();
    expect(ok).toBeToolResult({ count: 2 });
    expect(ok).not.toBeToolResult({ count: 3 });
    expect(bad).not.toBeToolResult();
    const message = failure(() => expect(ok).toBeToolResult({ count: 3 }));
    expect(message).toContain('expected tool result to succeed with Object {\n  "count": 3,\n}');
    expect(message).toContain('-   "count": 3,\n+   "count": 2,');
    expect(failure(() => expect(bad).toBeToolResult())).toContain('Tool "x" is unknown or not permitted');
    // A server that answers plain text: compared as text.
    expect({ content: [{ type: 'text', text: 'hello' }] }).toBeToolResult('hello');
  });

  it('toBeToolError: any error, a substring, a RegExp, and .not', () => {
    expect(bad).toBeToolError();
    expect(bad).toBeToolError('not permitted');
    expect(bad).toBeToolError(/unknown/);
    expect(bad).not.toBeToolError('locked');
    expect(ok).not.toBeToolError();
    expect(failure(() => expect(bad).toBeToolError('locked'))).toContain('expected tool result to be an error containing "locked"');
    expect(failure(() => expect(ok).toBeToolError(/x/))).toContain('expected tool result to be an error matching /x/');
    expect(failure(() => expect(ok).not.toBeToolResult())).toContain('expected tool result not to succeed');
  });

  it('a value that is not a tool result is refused, naming the await', async () => {
    const pending = Promise.resolve(ok);
    for (const received of [pending, null, { content: 'text' }]) {
      expect(() => expect(received).toBeToolResult()).toThrow(/await the call first/);
      expect(() => expect(received).toBeToolError()).toThrow(TypeError);
    }
    await pending;
  });
});
