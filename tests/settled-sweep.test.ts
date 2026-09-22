/**
 * The `onSettled` rule, enforced over every module rather than remembered.
 */

import { describe, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from '../src/vitest';

const SRC = join(import.meta.dirname, '..', 'src');

/** Every .ts under src/, recursively. */
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
 * Comments out, line numbers kept. `settled.ts`'s own docblock quotes the
 * pattern this sweep looks for ("`const x = next()` followed by a read of
 * `x.ok`"), so scanning raw text reports the file that documents the rule as
 * the one breaking it. Blanking comment bodies in place rather than deleting
 * them keeps every offender's reported line number honest.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

const files = sourceFiles(SRC).map((path) => ({
  path,
  text: stripComments(readFileSync(path, 'utf8')),
}));

describe('onSettled sweep', () => {
  it('no module reads next()\'s result without settling it first', () => {
    const offenders: string[] = [];

    for (const { path, text } of files) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // `const result = next()` / `let r = next()` - the binding form. A
        // bare `return next()` passes the value straight through and is safe
        // whatever it is, which is why it is not matched here.
        const bind = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*next\(\)/.exec(lines[i]);
        if (!bind) continue;
        const name = bind[1];

        // The window is the rest of the enclosing function, approximated as
        // the next 40 lines: every real call site in this repo reads the
        // result within a few lines of binding it.
        const window = lines.slice(i + 1, i + 41).join('\n');
        const readsResult = new RegExp(`\\b${name}\\.(ok|value|error)\\b`).test(window);
        if (!readsResult) continue;

        // Settled either by a helper, or by an explicit thenable check on the
        // same binding before it is read.
        //
        // `isThenable(x)` belongs in this list and was not in it at first:
        // when the hand-rolled predicates were replaced by the core helper,
        // this sweep called the converted site an offender, because it only
        // knew the shapes it had been written against. A guard that encodes a
        // rule is still a thing somebody has to keep current - it just fails
        // loudly instead of silently, which is the whole reason to prefer it.
        const settled =
          new RegExp(`\\bisThenable\\s*\\(\\s*${name}\\s*\\)`).test(window) ||
          new RegExp(`\\b${name}\\s*&&\\s*typeof\\s+${name}\\.then`).test(window) ||
          new RegExp(`typeof\\s+\\(?${name}[^)]*\\)?\\.then`).test(window) ||
          new RegExp(`\\b${name}\\.then\\s*===`).test(window);

        if (!settled) offenders.push(`${path.slice(SRC.length + 1)}:${i + 1} - reads ${name}.ok/.value/.error`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('covers every module that produces a Plugin, not just the plugins-* family', () => {
    // The sweep that introduced onSettled was run over plugins-core/extra/io
    // and missed ssr.ts and schema.ts, which also return Plugins. This asserts
    // the scan above sees all of them, so a new plugin in a new module cannot
    // fall outside it the same way.
    const producers = files
      .filter(({ text }) => /:\s*Plugin\b|:\s*AsyncPlugin\b/.test(text))
      .map(({ path }) => path.slice(SRC.length + 1))
      .sort();

    expect(producers).toContain('ssr.ts');
    expect(producers).toContain('schema.ts');
    expect(producers).toContain('plugins-core.ts');
    // The scan reads every .ts under src/, so coverage is whatever exists.
    const scanned = files.map(({ path }) => path.slice(SRC.length + 1));
    for (const p of producers) expect(scanned).toContain(p);
  });
});
