/**
 * vapor-chamber - the text a key or a hash is made of. Two entries, two
 * meanings, so neither name says more than its text does.
 *
 * `keyTextFor(outside)` - a runtime key: one text for equal values, in one
 * process. It returns the writer, which a caller builds once. JSON.stringify
 * with every object rebuilt with its keys sorted, at every level, arrays in
 * their order. A value JSON cannot carry exactly (a NaN, an Infinity, a
 * BigInt) is written as what the caller's `outside` returns: JSON.stringify
 * wrote NaN and Infinity as `null`, so they keyed with null
 * (tests/commandkey-collisions.test.ts). It is NOT RFC 8785: an object lists
 * keys that look like integers first, so `{ "10", "9" }` comes out as 9, 10.
 * That is still one text per value, which is all a key needs, and it costs
 * 340 B less than the exact writer in the core bundle (log 36.25).
 * commandKey and the HTTP client's dedupe and cache key each build one.
 *
 * `canonical(value)` - RFC 8785, the JSON Canonicalization Scheme, exactly:
 * for a text that crosses sides (a hash another party computes). ECMAScript's
 * own JSON output with these rules: no whitespace, object members sorted by
 * UTF-16 code units at every level (the default `sort()`), arrays in their
 * order, and a refusal of what I-JSON cannot carry: NaN and Infinity
 * (3.2.2.3), lone surrogates (3.2.2.2), BigInt. Written member by member, as
 * the RFC's Appendix A sample does, so "10" sorts before "9". It runs at
 * build time, and no bundle imports it. tests/canonical.test.ts runs the
 * RFC's own examples and its Appendix B number table.
 *
 * Both, as JSON.stringify: `toJSON` is honoured, a value JSON has no text for
 * (undefined, a function, a symbol) is left out of an object, `null` in an
 * array and `undefined` at the top, a Number, String, Boolean or BigInt
 * object is written as its value (by keyTextFor only when it has no fields of
 * its own, log 36.41), and a cycle throws.
 */

import { dict } from './dict';

/** A caller's own text for a value JSON cannot carry exactly: a NaN, an Infinity, a BigInt. */
export type Outside = (value: number | bigint) => unknown;

const refuse = (value: unknown): never => {
  throw new TypeError(`[vapor-chamber] RFC 8785 cannot carry ${String(value)}`);
};

const tagOf = Object.prototype.toString;

/**
 * A Number, String, Boolean or BigInt object's value, read as JSON.stringify
 * reads it (ECMA-262 SerializeJSONProperty step 4), else the object itself.
 * The tag comes from the internal slot, so it holds across realms. An object
 * that fakes a Boolean or BigInt tag throws, as a cycle does.
 */
function unwrap(v: object): unknown {
  switch (tagOf.call(v)) {
    case '[object Number]': return Number(v);
    case '[object String]': return String(v);
    case '[object Boolean]': return Boolean.prototype.valueOf.call(v);
    case '[object BigInt]': return BigInt.prototype.valueOf.call(v);
  }
  return v;
}

/**
 * The runtime key writer for one `outside`: one text per value, keys sorted.
 * Not RFC 8785 (see the module doc). Built once per caller, at module load,
 * so a key allocates no function (docs/V8-RULES.md rule 4). Undefined for a
 * value JSON has no text for (a function, a symbol).
 */
export function keyTextFor(outside: Outside): (value: unknown) => string | undefined {
  const replace = (_k: string, v: any): unknown => {
    // Each test is `typeof v === '...'`, never one typeof kept in a variable.
    // V8 compiles the first to an inline check and the second to a call, once
    // the values mix types (log 36.36).
    if (typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) return outside(v);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // JSON unwraps a Number, String, Boolean or BigInt object only after
      // this replacer ran, so rebuilt below it lost its value: new Number(5)
      // and new Number(6) both keyed `{}` (log 36.41). Such an object has no
      // keys, or a String's index keys from '0'. Only those take the check:
      // a test of the prototype on every object measured 11-13 ns a key.
      const keys = Object.keys(v);
      if (keys.length === 0 || keys[0] === '0') {
        const w = unwrap(v);
        if (w !== v) return typeof w === 'bigint' || (typeof w === 'number' && !Number.isFinite(w)) ? outside(w) : w;
      }
      // Prototype-free, and this one is load-bearing rather than defensive.
      // On a `{}`, `sorted['__proto__'] = value` goes through the inherited
      // setter and the key never becomes an own property, so it vanished from
      // the text - and an own `__proto__` key is exactly what `JSON.parse` of
      // a server response produces. Measured: targets
      // `{"__proto__":"A","id":1}` and `{"__proto__":"B","id":1}` both keyed
      // to `act:{"id":1}` (commandKey), collapsing two commands into one.
      // Rule and full evidence in ./dict.
      const sorted = dict();
      for (const k of keys.sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  };
  return (value) => JSON.stringify(value, replace);
}

/** RFC 8785 exactly. Throws on NaN, Infinity, BigInt, a lone surrogate and a cycle. */
export function canonical(value: unknown): string {
  const text = write(value, '', []) as string;
  if (LONE.test(text)) refuse('a lone surrogate');
  return text;
}

// A primitive is JSON.stringify's own text (undefined for undefined, a
// function or a symbol). An array or an object is written here, each element
// or member led by a comma that the slice drops.
function write(v: any, key: string, open: object[]): string | undefined {
  if (v != null && typeof v.toJSON === 'function') v = v.toJSON(key);
  if (v && typeof v === 'object') v = unwrap(v);
  if (typeof v === 'bigint' || (typeof v === 'number' && !Number.isFinite(v))) refuse(v);
  if (!v || typeof v !== 'object') return JSON.stringify(v);
  if (open.includes(v)) refuse('a cycle');
  open.push(v);
  let s = '';
  const array = Array.isArray(v);
  if (array) for (let i = 0; i < v.length; i++) s += ',' + (write(v[i], '' + i, open) ?? 'null');
  else for (const k of Object.keys(v).sort()) {
    const w = write(v[k], k, open);
    if (w !== undefined) s += ',' + JSON.stringify(k) + ':' + w;
  }
  open.pop();
  return array ? `[${s.slice(1)}]` : `{${s.slice(1)}}`;
}

// JSON.stringify writes a lone surrogate as `\udXXX` (U+D800 to U+DFFF) and
// a paired one as itself, so the finished text holds the escape exactly when
// a lone one was written, after an even run of backslashes (an escaped
// backslash before "ud800" is text). No lookbehind: Safari 16.0-16.3, a build
// target, has none.
const LONE = /(?:^|[^\\])(?:\\\\)*\\ud[89a-f]/;
