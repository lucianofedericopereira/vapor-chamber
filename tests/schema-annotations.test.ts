/** ActionSchema.annotations: MCP ToolAnnotations on the action, read by tools/list and by the retry (plan 1.27 item 9, B3). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { BusError } from '../src/command-bus';
import { createActionFilter } from '../src/action-filter';
import { createMcpHandler } from '../src/mcp';
import { createAsyncSchemaCommandBus, createSchemaCommandBus, type BusSchema } from '../src/schema';

/** How many times an action that loses its reply runs, on an async schema bus. */
async function runs(schema: BusSchema, retry?: Record<string, false>) {
  const bus = createAsyncSchemaCommandBus(schema, { retry: { baseDelay: 1, ...(retry ? { actionPolicies: retry } : {}) } });
  let n = 0;
  bus.register('cartGet' as never, async () => { n++; throw new BusError('lost:reply', 'no reply'); });
  await bus.dispatch('cartGet' as never, {} as never);
  return n;
}

describe('annotations', () => {
  it('tools/list carries them as the tool\'s annotations', async () => {
    const bus = createSchemaCommandBus({ cartGet: { description: 'Read the cart', annotations: { readOnlyHint: true, title: 'Cart' } } });
    const reply = await createMcpHandler(bus as never, { actionFilter: createActionFilter([]) })({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: Array<{ annotations?: object }> } };
    expect(reply.result.tools[0].annotations).toEqual({ readOnlyHint: true, title: 'Cart' });
  });

  it('idempotentHint or readOnlyHint, with no retry set, is declared idempotent: an uncertain failure is re-sent', async () => {
    expect(await runs({ cartGet: { annotations: { idempotentHint: true } } })).toBe(3);
    expect(await runs({ cartGet: { annotations: { readOnlyHint: true } } })).toBe(3);
  });

  it('an explicit retry wins over the hint, and the bus map wins over both', async () => {
    expect(await runs({ cartGet: { retry: false, annotations: { idempotentHint: true } } })).toBe(1);
    expect(await runs({ cartGet: { retry: 'idempotent', annotations: { idempotentHint: true } } }, { cartGet: false })).toBe(1);
  });
});

describe('controls', () => {
  it('no annotations: the tool has none, and an uncertain failure runs once', async () => {
    const bus = createSchemaCommandBus({ cartGet: { description: 'Read the cart' } });
    const reply = await createMcpHandler(bus as never, { actionFilter: createActionFilter([]) })({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) as { result: { tools: object[] } };
    expect(reply.result.tools[0]).toEqual({ name: 'cartGet', description: 'Read the cart', inputSchema: { type: 'object', properties: {} } });
    expect(await runs({ cartGet: {} })).toBe(1);
  });

  it('Anthropic and OpenAI tools carry no annotations', () => {
    const bus = createSchemaCommandBus({ cartGet: { description: 'Read', annotations: { readOnlyHint: true } } });
    expect(JSON.stringify(bus.toTools('anthropic'))).not.toContain('Hint');
    expect(JSON.stringify(bus.toTools('openai'))).not.toContain('Hint');
  });
});

/*
 * One fact, declared once, read by every consumer: MCP schema 2025-06-18's
 * ToolAnnotations (`title`, `readOnlyHint`, `destructiveHint`,
 * `idempotentHint`, `openWorldHint`; hints) sit on the action, `tools/list`
 * emits them, and the retry reads them. RFC 9110 9.2.2 makes idempotency a
 * property of the operation; Smithy's `readonly` and `idempotent` traits are
 * "considered idempotent", and Protocol Buffers' NO_SIDE_EFFECTS "implies
 * idempotent". So either hint, with no `retry` set, reads as `retry:
 * 'idempotent'`; an explicit `retry` is policy and wins, and the bus's own
 * map wins over both, as released. The server reads its own declaration, not
 * a client trusting a server's hints. Log s35.178.
 */
