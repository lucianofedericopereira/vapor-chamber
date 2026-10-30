/**
 * toAnthropicTools and toOpenAITools: a field typed 'any' becomes the empty schema {}.
 * Why: a type outside JSON Schema would make the whole Anthropic or OpenAI tool schema invalid.
 * Shows: both generators emit {} for the field, matching busToMcpTools, and no emitted type is outside JSON Schema.
 * See: tests/mcp-gaps.test.ts
 */
import { describe, expect, it } from 'vitest';
import { busToMcpTools } from '../src/mcp';
import { toAnthropicTools, toOpenAITools, type BusSchema } from '../src/schema';

const schema: BusSchema = { noteSave: { description: 'Save a note', target: { id: 'number' }, payload: { body: 'string', meta: 'any' } } };

describe("toTools - an 'any' field", () => {
  it('is {} for Anthropic and OpenAI, as for MCP', () => {
    expect(toAnthropicTools(schema)[0]!.input_schema.properties.payload!.properties).toEqual({ body: { type: 'string' }, meta: {} });
    expect(toOpenAITools(schema)[0]!.function.parameters.properties.payload!.properties.meta).toEqual({});
    expect(busToMcpTools(schema)[0]!.inputSchema.properties.payload.properties.meta).toEqual({});
  });

  it('no emitted field carries a type outside JSON Schema', () => {
    const types = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
    for (const field of Object.values(toAnthropicTools(schema)[0]!.input_schema.properties.payload!.properties)) {
      if (field.type !== undefined) expect(types.has(field.type)).toBe(true);
    }
  });
});
