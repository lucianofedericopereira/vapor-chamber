/**
 * The JSON Schema an action's tool takes: one generator for the three tool
 * outputs, `toAnthropicTools` / `toOpenAITools` (schema.ts) and
 * `busToMcpTools` (mcp.ts). There were two: the schema module's emitted
 * `{ type: 'any' }` (no JSON Schema type, so the whole tool schema was
 * invalid) and declared nothing `required`, so a model was told it could leave
 * out what the validator then refused. tests/tools-any-field.test.ts.
 *
 * A typed field is required; an `'any'` field is `{}` (no constraint) and
 * optional. `target` and `payload` are required when the action declares them.
 */
import type { ActionSchema, FieldMap } from './schema';

/** A FieldMap as a JSON Schema object. */
export type ToolObjectSchema = { type: 'object'; properties: Record<string, { type?: string }>; required?: string[] };

/** An action's tool input: `target` and `payload`, each when declared. */
export type ToolInputSchema = {
  type: 'object';
  properties: { target?: ToolObjectSchema; payload?: ToolObjectSchema };
  required?: string[];
};

function objectSchema(fields: FieldMap): ToolObjectSchema {
  const properties: Record<string, { type?: string }> = {};
  const required: string[] = [];
  for (const [key, type] of Object.entries(fields)) {
    if (type === 'any') properties[key] = {};
    else {
      properties[key] = { type };
      required.push(key);
    }
  }
  const schema: ToolObjectSchema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

/** @internal */
export function toolInputSchema(def: ActionSchema): ToolInputSchema {
  const schema: ToolInputSchema = { type: 'object', properties: {} };
  const required: string[] = [];
  if (def.target) {
    schema.properties.target = objectSchema(def.target);
    required.push('target');
  }
  if (def.payload) {
    schema.properties.payload = objectSchema(def.payload);
    required.push('payload');
  }
  if (required.length) schema.required = required;
  return schema;
}
