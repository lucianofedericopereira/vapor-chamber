/**
 * vapor-chamber — Standard Schema validator plugin.
 *
 * Schema-library agnostic. Works with any schema lib implementing
 * [Standard Schema v1](https://standardschema.dev/): Zod, Valibot,
 * ArkType, Effect Schema, etc. The plugin only depends on the
 * `~standard` interop shape — no schema lib is bundled.
 *
 * @example with Zod
 *   import { z } from 'zod';
 *   import { validateSchemas } from 'vapor-chamber';
 *
 *   bus.use(validateSchemas({
 *     cartAdd: z.object({ id: z.number(), qty: z.number().min(1) }),
 *     orderCreate: z.object({ items: z.array(z.any()).min(1) }),
 *   }));
 *
 * @example with Valibot
 *   import * as v from 'valibot';
 *
 *   bus.use(validateSchemas({
 *     cartAdd: v.object({ id: v.number(), qty: v.pipe(v.number(), v.minValue(1)) }),
 *   }));
 *
 * @example with ArkType
 *   import { type } from 'arktype';
 *
 *   bus.use(validateSchemas({
 *     cartAdd: type({ id: 'number', 'qty?': 'number>0' }),
 *   }));
 *
 * Validation runs against `cmd.target` by default. Switch to `payload`,
 * `both`, or a custom selector via the `field` option.
 */

import type { Command, CommandResult, Plugin, AsyncPlugin } from './command-bus';
import { BusError } from './command-bus';

// ---------------------------------------------------------------------------
// Standard Schema v1 — minimal interop types.
// We don't `import` from any schema lib; we duck-type via the `~standard`
// property that all conforming libs expose.
// ---------------------------------------------------------------------------

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | StandardSchemaV1Result<Output>
      | Promise<StandardSchemaV1Result<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaV1Issue> };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export type SchemaValidatorOptions = {
  /**
   * Which field on the Command to validate. Default: `'target'`.
   * - `'target'` — validate `cmd.target`
   * - `'payload'` — validate `cmd.payload`
   * - `'both'` — validate `{ target, payload }` as a single object
   * - `(cmd) => unknown` — extract a custom value from `cmd`
   */
  field?: 'target' | 'payload' | 'both' | ((cmd: Command) => unknown);
  /**
   * What to do on validation failure:
   * - `'reject'` (default) — return `{ ok: false, error: BusError(VC_VALIDATION_FAILED) }`
   *   without invoking the handler
   * - `'warn'` — `console.warn` and continue to the handler with the
   *   original (un-coerced) command
   *
   * Even in 'warn' mode, the schema's `.parse()` coercions are NOT
   * applied — the original command flows through unchanged. To use
   * coerced values, use `'reject'` mode and validate before dispatching.
   */
  onInvalid?: 'reject' | 'warn';
};

function describe(issues: ReadonlyArray<StandardSchemaV1Issue>): string {
  return issues
    .map((issue) => {
      if (!issue.path || issue.path.length === 0) return issue.message;
      const path = issue.path
        .map((p) => (typeof p === 'object' && p !== null ? String((p as { key: PropertyKey }).key) : String(p)))
        .join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function pickValue(cmd: Command, field: SchemaValidatorOptions['field']): unknown {
  if (typeof field === 'function') return field(cmd);
  if (field === 'payload') return cmd.payload;
  if (field === 'both') return { target: cmd.target, payload: cmd.payload };
  return cmd.target;
}

function rejectResult(action: string, message: string): CommandResult {
  return {
    ok: false,
    value: undefined,
    error: new BusError('VC_VALIDATION_FAILED', `Validation failed for "${action}": ${message}`, {
      emitter: 'plugin',
      action,
    }),
  };
}

/**
 * Sync schema validator plugin. Use with `createCommandBus()`.
 *
 * If any of your schemas are async (return a Promise from `~standard.validate`),
 * use {@link validateSchemasAsync} on `createAsyncCommandBus()` instead.
 */
export function validateSchemas(
  schemas: Record<string, StandardSchemaV1>,
  options: SchemaValidatorOptions = {},
): Plugin {
  const { field = 'target', onInvalid = 'reject' } = options;

  return (cmd, next) => {
    const schema = schemas[cmd.action];
    if (schema === undefined) return next();

    const value = pickValue(cmd, field);
    const result = schema['~standard'].validate(value);

    // Sync plugin can't await — if a schema returns a Promise, we treat
    // that as a configuration error and fail the dispatch loudly.
    if (typeof (result as Promise<unknown>).then === 'function') {
      return rejectResult(
        cmd.action,
        'validateSchemas received an async schema on a sync bus. Use validateSchemasAsync on createAsyncCommandBus.',
      );
    }

    const r = result as StandardSchemaV1Result<unknown>;
    if (r.issues !== undefined) {
      const message = describe(r.issues);
      if (onInvalid === 'warn') {
        console.warn(`[vapor-chamber] validateSchemas (${cmd.action}): ${message}`);
        return next();
      }
      return rejectResult(cmd.action, message);
    }
    return next();
  };
}

/**
 * Async variant — supports schemas whose `validate` returns a Promise.
 * Use with `createAsyncCommandBus()`.
 */
export function validateSchemasAsync(
  schemas: Record<string, StandardSchemaV1>,
  options: SchemaValidatorOptions = {},
): AsyncPlugin {
  const { field = 'target', onInvalid = 'reject' } = options;

  return async (cmd, next) => {
    const schema = schemas[cmd.action];
    if (schema === undefined) return next();

    const value = pickValue(cmd, field);
    const r = await schema['~standard'].validate(value);

    if (r.issues !== undefined) {
      const message = describe(r.issues);
      if (onInvalid === 'warn') {
        console.warn(`[vapor-chamber] validateSchemas (${cmd.action}): ${message}`);
        return next();
      }
      return rejectResult(cmd.action, message);
    }
    return next();
  };
}
