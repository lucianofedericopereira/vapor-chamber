/**
 * vapor-chamber - prototype-free dictionaries.
 *
 * ONE rule, stated once, because this bug class has now been found six times in
 * this codebase and each site had been written as if it were the first:
 *
 *   **A string that came from outside must never be used as a key on, or looked
 *   up in, an object that inherits from `Object.prototype`.**
 *
 * `{}` inherits `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * `isPrototypeOf`, `__proto__` and friends. Two distinct failures follow, and
 * both have shipped here:
 *
 * 1. **Reads answer for keys that were never set.** `obj[key] !== undefined`,
 *    `key in obj` and `obj[key]` all walk the prototype chain.
 *    - `mcp.ts` (fixed v1.15.0): `tools/call` admitted `constructor`,
 *      `__proto__`, `toString`, `hasOwnProperty` and `valueOf` as tool names
 *      that `tools/list` never advertised.
 *    - `router/url.ts` `parseQuery`: the repeated-key check saw inherited
 *      members as "already set", so `?constructor=1` produced `[Object, '1']`
 *      instead of `'1'` - an array where callers expect a scalar.
 *    - `router/loaders.ts` `defaultAffects`: `key in record.queryDefs` reported
 *      `?toString=` / `?valueOf=` as DECLARED query params, refetching a
 *      record's loader for a key it never declared.
 *    - `router/index.ts` `loadComponent`: `options.components?.[key]` with `key`
 *      taken from the ROUTES PAYLOAD (fetched or server-inlined). A row naming
 *      `constructor` resolved to `Object`, passed the `component_missing`
 *      check, was called as a lazy import and rendered as a BLANK component -
 *      a coded error degraded into a silently empty outlet.
 *
 * 2. **Writes to `__proto__` are swallowed by the inherited setter.** The key
 *    never becomes an own property.
 *    - `command-bus.ts` `commandKey`: an own `__proto__` key - exactly what
 *      `JSON.parse` of a server response produces - was dropped from the
 *      canonical serialization, so two different targets produced the SAME key.
 *      That key backs `idempotent`, `cache`, `serialize` and `supersede`, so
 *      distinct commands collapsed into one.
 *    - `router/url.ts` `parseQuery`: `?__proto__=a` assigned an array through
 *      that setter, replacing the parsed object's prototype outright.
 *    - `router/engine.ts` `setQuery`: built the merged query with a SPREAD of
 *      the current one. A spread of a null-prototype object produces a plain
 *      one, so the fix above survived only until the first typed query write -
 *      `location.query` was prototype-free after navigate() and plain after
 *      setQuery(), and a `__proto__` write vanished through the setter again.
 *      Spreading is not prototype-preserving; `Object.assign(dict(), x)` is.
 *
 * Use `dict()` to build any map keyed by strings you did not author, and
 * `Object.hasOwn()` (never `in`, never `!== undefined`) to test membership on
 * one you did.
 *
 * Deliberately not a public export: this is an internal invariant, not API.
 */

/**
 * A `Record` with **no prototype** - safe to key with untrusted strings.
 *
 * `JSON.stringify`, `Object.keys`, spread and `Object.freeze` all behave
 * identically to a plain object; only the inherited members are gone, which is
 * the entire point.
 */
export function dict<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
