/**
 * toTools(): a field typed `'any'` is the empty schema, `{}`.
 *
 * It was emitted as `{ type: 'any' }`, which is no JSON Schema type, so the
 * whole Anthropic or OpenAI tool schema was invalid (compiled with Ajv: "type
 * must be equal to one of the allowed values"). busToMcpTools already emits
 * `{}` (mcp-gaps.test.ts); the two generators now agree on it.
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
