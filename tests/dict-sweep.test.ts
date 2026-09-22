/**
 * The prototype-key invariant, enforced over every module rather than remembered.
 */

import { describe, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from '../src/vitest';

const SRC = join(import.meta.dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Comments AND string literals out, line numbers and columns preserved.
 * Without the string pass this sweep reports 26 sites, every one of them an
 * error message containing the word "in" ("Retry in 200ms", "no token found in
 * DOM"). Without the comment pass it reports `dict.ts` itself, which spells
 * the banned constructs out in prose.
 */
function blank(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead + ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => '`' + m.slice(1, -1).replace(/[^\n]/g, ' ') + '`');
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length + 1),
  text: blank(readFileSync(path, 'utf8')),
}));

describe('prototype-key sweep', () => {
  // src/dict.ts: "Use `dict()` to build any map keyed by strings you did not
  // author, and `Object.hasOwn()` (never `in`, never `!== undefined`) to test
  // membership on one you did."
  it('no module tests membership with `in` or `!== undefined`', () => {
    const offenders: string[] = [];

    for (const { path, text } of files) {
      text.split('\n').forEach((ln, i) => {
        // `for (const k in obj)` is a different construct, and a TS mapped type
        // `[K in keyof T]` is not a membership test at all.
        if (/for\s*\(/.test(ln)) return;
        if (/\[\s*[A-Za-z_$][\w$]*\s+in\s+keyof/.test(ln)) return;

        if (/(?<![.\w$])([A-Za-z_$][\w$.]*)\s+in\s+([A-Za-z_$][\w$.]*)/.test(ln)) {
          offenders.push(`${path}:${i + 1} - membership via \`in\``);
        } else if (/([A-Za-z_$][\w$.]*)\[\s*[A-Za-z_$][\w$.]*\s*\]\s*!==\s*undefined/.test(ln)) {
          offenders.push(`${path}:${i + 1} - membership via \`!== undefined\``);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  // dict.ts records this as the FIFTH site of the class: router/engine.ts's
  // setQuery rebuilt the merged query with a spread, and a spread of a
  // null-prototype object produces a plain one - so the fix above it survived
  // only until the first typed query write.
  it('never spreads a prototype-free object back into a plain one', () => {
    const offenders: string[] = [];

    for (const { path, text } of files) {
      const lines = text.split('\n');
      const names = new Set<string>();
      for (const ln of lines) {
        const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:dict\s*[<(]|Object\.create\s*\(\s*null\s*\))/.exec(ln);
        if (m) names.add(m[1]);
      }
      if (names.size === 0) continue;

      lines.forEach((ln, i) => {
        for (const n of names) {
          if (new RegExp(`\\{[^}]*\\.\\.\\.\\s*${n}\\b`).test(ln)) {
            offenders.push(`${path}:${i + 1} - spread of \`${n}\` loses its null prototype`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  // The sweep that fixed `onSettled` was scoped by filename to `plugins-*.ts`
  // and missed two modules. This one is scoped by nothing, and this assertion
  // is what keeps it that way: every site dict.ts names must be inside it.
  it('reaches every site src/dict.ts names as fixed', () => {
    const scanned = files.map((f) => f.path);
    for (const site of ['command-bus.ts', 'mcp.ts', 'router/url.ts', 'router/loaders.ts', 'router/index.ts', 'router/engine.ts']) {
      expect(scanned).toContain(site);
    }
    // And the helper is actually reached for, not just documented: every site
    // that builds an externally-keyed map calls it.
    const users = files.filter((f) => /\bdict\s*[<(]/.test(f.text) && f.path !== 'dict.ts');
    expect(users.length).toBeGreaterThanOrEqual(3);
  });
});
