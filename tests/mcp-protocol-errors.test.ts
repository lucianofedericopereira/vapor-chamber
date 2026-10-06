/** MCP: version negotiation and protocol errors as the 2025-06-18 spec states them (plan 1.27 section 10.9). Rationale at the end. */
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

/*
 * MCP 2025-06-18, read at the source. Lifecycle: "If the server supports the
 * requested protocol version, it MUST respond with the same version.
 * Otherwise, the server MUST respond with another protocol version it
 * supports." The handler echoed any string (audit S1). Tools: "Protocol
 * Errors: Standard JSON-RPC errors for issues like: Unknown tools" (the
 * example is -32602); an unknown tool came back as a tool result with
 * isError (S2). A tool not listed, unknown or not allowed, gets the same
 * error, so a client cannot tell them apart. Basic: "Unlike base JSON-RPC,
 * the ID MUST NOT be null"; a request with id null got no reply, as if it
 * were a notification. JSON-RPC 2.0 answers an invalid request with -32600
 * and id null. Tool execution errors stay results, as the spec agrees.
 * Log s35.172.
 */
