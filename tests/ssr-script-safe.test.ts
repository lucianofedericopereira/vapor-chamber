/**
 * serializeForScript: dehydrated commands embedded in a <script> element.
 * Why: JSON.stringify leaves `</script>` as it is, so user text in a command's target or payload would close the element and run script of its own.
 * Shows: hostile text cannot close the element, the output parses back to the same value, `<`, `>`, `&`, U+2028 and U+2029 are escaped, and plain values serialize as JSON.stringify does.
 * See: src/ssr.ts
 */
import { describe, expect, it } from 'vitest';
import { serializeForScript } from '../src/ssr';

const hostile = [{ action: 'searchSet', target: 'box', payload: { q: '</script><script>alert(document.cookie)</script>' } }];

describe('serializeForScript', () => {
  it('cannot close the script element it is embedded in', () => {
    const html = `<script>window.__VAPOR_STATES__ = ${serializeForScript(hostile)}</script>`;
    expect(html.indexOf('</script>')).toBe(html.length - '</script>'.length);
    expect(html).not.toMatch(/<script>.*<script>/s);
  });

  it('parses back to the same value', () => {
    const value = { ...hostile[0], amp: 'a & b > c', html: '<!-- x -->', ls: 'a\u2028b\u2029c', unicode: 'é😀' };
    expect(JSON.parse(serializeForScript(value))).toEqual(value);
  });

  it('escapes the characters a script element or an old engine would read', () => {
    const out = serializeForScript({ s: '<>&\u2028\u2029' });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain('\\u003c');
  });

  it('serializes what JSON.stringify does for plain values', () => {
    for (const v of [null, 1, 'x', true, [1, 'a'], { a: { b: [] } }]) expect(serializeForScript(v)).toBe(JSON.stringify(v));
  });
});
