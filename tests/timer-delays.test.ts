/** Every timer delay in src is a Delay or a number literal, and only bounds.ts casts to Delay. Rationale at the end. */
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

/** Every violation in src, by the checker; `extra` adds virtual files by absolute path. */
function violations(extra: Record<string, string> = {}): string[] {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, 'tsconfig.json'), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  })!;
  const host = ts.createCompilerHost(config.options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, lang, ...rest) =>
    name in extra ? ts.createSourceFile(name, extra[name]!, lang) : getSourceFile.call(host, name, lang, ...rest);
  const fileExists = host.fileExists;
  host.fileExists = (name) => name in extra || fileExists.call(host, name);
  const program = ts.createProgram([...config.fileNames, ...Object.keys(extra)], { ...config.options, noEmit: true }, host);
  const checker = program.getTypeChecker();

  const isDelay = (t: ts.Type): boolean => checker.getPropertiesOfType(t).some((p) => String(p.escapedName).includes('delayBrand'));
  const accepted = (t: ts.Type): boolean =>
    (t.isUnion() ? t.types : [t]).every((c) => (c.flags & ts.TypeFlags.NumberLiteral) !== 0 || isDelay(c));

  const out: string[] = [];
  for (const sf of program.getSourceFiles()) {
    const path = sf.fileName;
    if (!path.startsWith(join(root, 'src') + '/')) continue;
    const at = (node: ts.Node): string => `${relative(root, path)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if ((name === 'setTimeout' || name === 'setInterval') && node.arguments.length > 1) {
          const delay = node.arguments[1]!;
          const type = checker.getTypeAtLocation(delay);
          if (!accepted(type)) out.push(`${at(delay)}: ${name} delay is ${checker.typeToString(type)}`);
        }
      }
      if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) && !path.endsWith('/src/bounds.ts')
        && /\bDelay\b/.test(node.type.getText(sf))) {
        out.push(`${at(node)}: cast to Delay`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe('timer delays', () => {
  it('every setTimeout and setInterval in src takes a Delay or a number literal', () => {
    expect(violations()).toEqual([]);
  });

  it('control: a number delay, a cast and setInterval are each caught; a Delay and a literal pass', () => {
    const control = join(root, 'src', '__timer_delays_control__.ts');
    const source = [
      "import { delayOption, type Delay } from './bounds';",
      'declare const n: number;',
      'setTimeout(() => {}, n);',
      'setTimeout(() => {}, 5 as Delay);',
      'setInterval(() => {}, n);',
      'globalThis.setTimeout(() => {}, n);',
      'setTimeout(() => {}, delayOption(n, 10));',
      'setTimeout(() => {}, 0);',
      'setTimeout(() => {});',
    ].join('\n');
    expect(violations({ [control]: source }).filter((v) => v.startsWith('src/__timer_delays_control__.ts'))).toEqual([
      'src/__timer_delays_control__.ts:3: setTimeout delay is number',
      'src/__timer_delays_control__.ts:4: cast to Delay',
      'src/__timer_delays_control__.ts:5: setInterval delay is number',
      'src/__timer_delays_control__.ts:6: setTimeout delay is number',
    ]);
  });
});

/*
 * A timer fires AT ONCE on a delay it cannot hold: NaN, a negative, Infinity,
 * anything past 2^31-1. bounds.ts has the rule for a caller's number (NaN is
 * the default, a larger value the maximum), but each site applied it by hand,
 * and nothing checked that it did. Five sites missed it (audit D7, D8, D9 and
 * debounce, log 36.11), each found one at a time.
 *
 * So the rule is a type. `Delay` (src/bounds.ts) is a number only
 * `delayOption` and `isDelay` make, and this test reads every timer call in
 * src through the TypeScript checker: the delay must be a Delay, a number
 * literal, or a union of those. A cast to Delay anywhere but bounds.ts fails
 * too, so the type cannot be claimed without the check. The internal sleep
 * helpers take `ms: Delay`, so the compiler checks their callers.
 *
 * The control file is virtual: it is added to the program in memory, never
 * written to src.
 */
