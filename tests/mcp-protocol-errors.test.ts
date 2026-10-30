/**
 * MCP: version negotiation and protocol errors as the 2025-06-18 spec states them.
 * Why: a server must answer a protocol version it does not speak with one it does, report an unknown
 * tool as the JSON-RPC error -32602 (identical for unknown and not-allowed, so a client cannot tell
 * them apart), answer a request with id null as Invalid Request with id null, and never reply to a
 * notification. A listed tool's execution failure stays a result with isError.
 * Shows: the answered version for unsupported, supported and absent versions, the exact -32602 and
 * -32600 replies, an isError result for a failing tool, and null for a notification.
 * See: log s35.172, MCP spec 2025-06-18
 */
import { describe, expect, it } from 'vitest';
import { createSchemaCommandBus } from '../src/schema';
import { createActionFilter } from '../src/action-filter';
import { createMcpHandler } from '../src/mcp';

function handler() {
  const bus = createSchemaCommandBus({ cartGet: { target: { id: 'number' } }, cartFail: { target: {} } });
  bus.register('cartGet', () => ({ items: [] }));
  bus.register('cartFail', () => { throw new Error('out of stock'); });
  return createMcpHandler(bus as never, { actionFilter: createActionFilter([{ any: [{ exact: { action: 'cartGet' } }, { exact: { action: 'cartFail' } }] }]) });
}
const init = (version?: string) => handler()({ jsonrpc: '2.0', id: 1, method: 'initialize', params: version === undefined ? {} : { protocolVersion: version } }) as Promise<{ result: { protocolVersion: string } }>;

describe('MCP protocol', () => {
  it('initialize with a version the server does not speak answers its own', async () => {
    expect((await init('1999-01-01')).result.protocolVersion).toBe('2025-06-18');
  });

  it('a tool that is not listed is the JSON-RPC error -32602, whether unknown or not allowed', async () => {
    const h = handler();
    for (const name of ['nope', 'constructor']) {
      expect(await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } }))
        .toEqual({ jsonrpc: '2.0', id: 3, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    expect(await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { arguments: {} } }))
      .toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32602, message: 'Invalid params: missing tool name' } });
  });

  it('a request with id null is an Invalid Request, answered with id null', async () => {
    expect(await handler()({ jsonrpc: '2.0', id: null, method: 'ping' }))
      .toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  });
});

describe('controls', () => {
  it('a supported version is echoed; none sent advertises 2025-06-18', async () => {
    for (const v of ['2024-11-05', '2025-03-26', '2025-06-18']) expect((await init(v)).result.protocolVersion).toBe(v);
    expect((await init()).result.protocolVersion).toBe('2025-06-18');
  });

  it("a listed tool's failure stays a tool result with isError", async () => {
    const r = await handler()({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cartFail', arguments: { target: {} } } }) as { result: { isError?: boolean } };
    expect(r.result.isError).toBe(true);
  });

  it('a notification gets no reply', async () => {
    expect(await handler()({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
  });
});
