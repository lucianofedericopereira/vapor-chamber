/**
 * vapor-chamber - action filters.
 *
 * `createActionFilter(expressions)` compiles filter expressions from the
 * CloudEvents Subscriptions API (3.2.4) over a command's `action` (the action
 * name is the event's type) into an `ActionFilter`, a predicate on the action
 * name. The six required dialects, with the spec's semantics: `exact`,
 * `prefix`, `suffix` compare the attribute's string (case-sensitive); `all`
 * and `any` combine nested expressions; `not` inverts one. A set of
 * expressions is ANDed, an `all`, and an empty set selects every action. What
 * the spec says MUST be rejected is rejected, when the filter is created: an
 * `all`/`any` with no expression, an empty string, an unknown dialect. An
 * expression names exactly one dialect, and `action` is the one attribute
 * (log s35.152, tests/action-filter.test.ts).
 *
 * The meaning of empty and absent lives here, stated once: the defect class of
 * s35.146-148, where each option decided what `[]` meant, cannot recur.
 *
 * A function the app calls, as Rollup's `createFilter`: only an app that
 * filters carries this code. Measured: compiled inside the bus it cost every
 * app +304 brotli on the Blade consumer bundle; passed in, the bus's glue
 * costs +31 (log s35.152). The bus calls the predicate once per action, when
 * it builds that action's chain, never per dispatch (V8-RULES 3).
 */
import { _failures } from './failure';

/** A CloudEvents filter expression (Subscriptions API 3.2.4) over a command's `action`. */
export type ActionFilterExpression =
  | { exact: { action: string } }
  | { prefix: { action: string } }
  | { suffix: { action: string } }
  | { all: ActionFilterExpression[] }
  | { any: ActionFilterExpression[] }
  | { not: ActionFilterExpression };

/**
 * A predicate on an action NAME: the bus asks it once per action and keeps the
 * answer, so it must depend on the name alone. `createActionFilter` builds one
 * from CloudEvents expressions; any `(action) => boolean` of the name is one.
 */
export type ActionFilter = (action: string) => boolean;

const fail = _failures('core');
const bad = (expression: unknown): never => {
  throw fail('invalid:filter', 'Not a CloudEvents filter expression over the action.', { context: { expression } });
};

function compile(e: any): ActionFilter {
  const k = e !== null && typeof e === 'object' && !Array.isArray(e) ? Object.keys(e) : [];
  if (k.length !== 1) bad(e);
  const d = k[0];
  const v = e[d];
  switch (d) {
    case 'exact':
    case 'prefix':
    case 'suffix': {
      const s = v?.action;
      if (typeof s !== 'string' || s === '' || Object.keys(v).length !== 1) bad(e);
      return d === 'exact' ? (a) => a === s : d === 'prefix' ? (a) => a.startsWith(s) : (a) => a.endsWith(s);
    }
    case 'all':
    case 'any': {
      if (!Array.isArray(v) || v.length === 0) bad(e);
      const parts: ActionFilter[] = v.map(compile);
      return d === 'all' ? (a) => parts.every((p) => p(a)) : (a) => parts.some((p) => p(a));
    }
    case 'not': {
      const p = compile(v);
      return (a) => !p(a);
    }
  }
  return bad(e);
}

/**
 * Compile CloudEvents filter expressions (ANDed; an empty set selects every
 * action) into an {@link ActionFilter}. Throws `core:invalid:filter` on what
 * the spec says MUST be rejected.
 *
 * @example
 * bus.use(cache({ actionFilter: createActionFilter([{ suffix: { action: 'Get' } }]) }));
 * createMcpHandler(bus, { actionFilter: createActionFilter([{ all: [{ prefix: { action: 'cart' } }, { not: { exact: { action: 'cartClear' } } }] }]) });
 */
export const createActionFilter = (expressions: ActionFilterExpression[]): ActionFilter =>
  Array.isArray(expressions) && expressions.length === 0 ? () => true : compile({ all: expressions });
