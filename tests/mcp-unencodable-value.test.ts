/**
 * createMcpHandler: a tool whose value JSON cannot encode (a BigInt, a cycle).
 * Why: if the encoding error rejects the whole reply, a stdio client's request gets `-32603` with `id: null` and is never answered.
 * Shows: the call is answered with its own id and `isError: true`, for both a BigInt and a circular value.
 */
import { describe, expect, it } from 'vitest';
import { createMcpHandler } from '../src/mcp';
import { createSchemaCommandBus } from '../src/schema';
import { createActionFilter } from '../src/index';

describe('MCP tools/call - a value JSON cannot encode', () => {
  it.each([['a BigInt', { id: 9007199254740993n }], ['a cycle', (() => { const o: any = {}; o.self = o; return o; })()]])('answers the call with its id (%s)', async (_l, value) => {
    const bus = createSchemaCommandBus({ orderRead: { description: 'Read an order', target: { id: 'number' } } });
    bus.register('orderRead', () => value);
    const handle = createMcpHandler(bus as never, { actionFilter: createActionFilter([]) });
    const reply = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'orderRead', arguments: { target: { id: 1 } } } }).catch((e) => ({ rejected: String(e) }));
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 7, result: { isError: true } });
  });
});
