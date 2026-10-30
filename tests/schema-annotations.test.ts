/**
 * ActionSchema.annotations: MCP ToolAnnotations declared once on an action, read by tools/list and by the retry.
 * Why: if the hints were not read, MCP clients would see none, and an action declared idempotent or read-only would not be re-sent after an uncertain failure; an explicit retry setting must still win as policy.
 * Shows: tools/list carries the annotations; idempotentHint or readOnlyHint with no retry set gives 3 runs; an explicit retry or the bus map gives 1; no annotations give 1 run, and the Anthropic and OpenAI tool lists carry no hint.
 * See: log s35.178, RFC 9110 9.2.2
 */
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
