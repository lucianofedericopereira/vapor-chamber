#!/usr/bin/env node
/**
 * check-console-shape - a value a developer would INSPECT is an argument, not
 * a substring.
 *
 * The convention, already followed at every console site in `src/`:
 *
 *     console.warn(`[vapor-chamber] ... "${cmd.action}" ...`, el)
 *
 * Identifying text - an action name, a storage key, a count, a limit, a code,
 * a pattern - is interpolated into the message, because that is what the
 * sentence is about. Anything with structure - a caught error, a DOM element,
 * a command, a result, an options bag, an array of schema issues - is passed as
 * a SEPARATE argument, where devtools renders it live and expandable. Put the
 * same value in the template and it flattens to "[object Object]", or to a
 * truncated form, and the one thing the reader needed is the thing that was
 * thrown away.
 *
 * WHY A CHECK, WHEN NOTHING IS BROKEN. Censused 2026-09-22 over every
 * `console.*` call in `src/`: every interpolated value was identifying text,
 * 35 sites already passed the inspectable value as a second argument, and
 * `JSON.stringify`, `String(...)` and `.toString()` appeared zero times inside a
 * console argument. The convention held at every site and was held by nothing
 * but memory - the position `src/dict.ts` was in before its sweep, and
 * `onSettled` before `tests/settled-sweep.test.ts`. The next site is what this
 * is for. (Totals are not quoted here on purpose: a run computes them, and the
 * OK line prints them.)
 *
 * TYPES, NOT AN ALPHABET. The obvious implementation is a list of names that
 * look inspectable (`el`, `cmd`, `plugin`, `result`, `opts`). This repo has
 * measured what that costs three separate times - `check-ascii.mjs` reported a
 * clean sweep while 48 arrows sat in 15 files, because its alphabet held one
 * arrow; `check-line-citations.mjs` was blind to 73 of 2,524 test titles. A
 * guard is worth exactly its alphabet. So the rule inverts, the way check-ascii
 * inverted for `src/`: a value may be interpolated only if the TYPE CHECKER
 * says it is a string, number, boolean or bigint (or a union of those, which is
 * what a string enum and `typeof x` are). Everything else fails, including
 * `any` and `unknown` - not because they are certainly objects, but because
 * nothing shows they are not, and there is no such site in `src/` today to
 * grandfather. There is nothing here to enumerate and nothing to forget.
 *
 * THE `any` ESCAPE, stated because this codebase has a lot of `any` and the
 * first person to hit this will otherwise think the guard is broken. A value
 * that is genuinely a string but typed `any` fails here, and `String(...)` is
 * rejected by the same check - so the way out is a cast at the call site
 * (`${action as string}`), which is a claim someone made on purpose and can be
 * reviewed, rather than a flattening that hides whatever the value really was.
 * The failure message says so.
 *
 * NO ALLOWLIST, AND TWO SITES THAT EARN IT. Both of the calls that look like
 * exceptions pass on SHAPE, with nothing written down about them:
 *
 *   - `command-bus.ts` `console.warn(msg)` - `validateNaming` builds one string
 *     and either throws it or logs it. The call interpolates nothing, so there
 *     is nothing here to classify.
 *   - `router/index.ts` `console.error(error)` - the error IS the argument.
 *     That is the convention, in its purest form.
 *
 * Both are in `--self-test` below, mutated into the violating shape, because a
 * shape-based exemption that quietly matches too much is indistinguishable from
 * a working check - the same failure the `onSettled` sweep had when it was
 * scoped by filename.
 *
 * SCOPE, stated so it is not over-trusted. This reads the arguments of the
 * console call and nothing else. A message assembled into a local first, then
 * logged (`validateNaming`'s `msg` is the one such site), passes unexamined -
 * following an initializer would mean deciding which declaration a name refers
 * to, and being wrong about that is worse than a stated blind spot. It also
 * says nothing about whether the sentence is worth printing, or whether the
 * right value was chosen. `src/` only: that is what ships in `dist/`, and it is
 * where the census was taken.
 *
 * USAGE
 *   node scripts/check-console-shape.mjs              # the gate (in lint:check)
 *   node scripts/check-console-shape.mjs --self-test  # prove the gate can fail
 *
 * `--self-test` injects each violation this guard exists to catch into a REAL
 * module, confirms the scan fails on it, and restores the file by copy in a
 * `finally`. It refuses to start unless git says every file it will write is
 * clean - a `finally` does not run on SIGKILL, and a mutation left behind by an
 * interrupted run would land in somebody's next diff (see assertTargetsClean).
 * It is not in `lint:check`: it rebuilds the program once per mutation and it
 * writes to `src/`. It is here rather than in the suite because
 * no test in this repo drives a `scripts/check-*.mjs`, and a second-long
 * `ts.createProgram` does not belong in a vitest run. A guard that has never
 * been watched to fail is a guard nobody has tested.
 */
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `fileURLToPath`, not `.pathname` - the latter yields `/C:/...` on Windows,
// as check-env-guards.mjs next door already notes.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Trailing separator: a bare prefix would also match a sibling directory whose
// name merely starts with "src".
const SRC = join(ROOT, 'src') + sep;

/**
 * What may be interpolated: the primitives that print as themselves.
 *
 * `StringLike` carries string literals and template-literal types with it, so a
 * string enum member and `GLYPH_WARN` are covered; `BooleanLike` carries `true`
 * and `false`, which is what `boolean` is a union of. Symbols are deliberately
 * absent - interpolating one is a TypeError, not a style question.
 */
const IDENTIFYING =
  ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike;

function isIdentifyingText(type) {
  // A union is fine when every member is - `typeof x` is a union of eight
  // string literals, and `RouterErrorCode` is a union of string literals too.
  if (type.isUnion()) return type.types.every(isIdentifyingText);
  return (type.flags & IDENTIFYING) !== 0;
}

/** Does this expression produce a string? `+` on two numbers is arithmetic, not a message. */
function isStringResult(type) {
  if (type.isUnion()) return type.types.some(isStringResult);
  return (type.flags & ts.TypeFlags.StringLike) !== 0;
}

/** `JSON.stringify(x)`, `String(x)`, `x.toString()` - the three ways to flatten a value by hand. */
function stringifyCallName(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'toString') return `${callee.expression.getText()}.toString()`;
    if (callee.name.text === 'stringify' && ts.isIdentifier(callee.expression) && callee.expression.text === 'JSON') {
      return 'JSON.stringify()';
    }
    return null;
  }
  return ts.isIdentifier(callee) && callee.text === 'String' ? 'String()' : null;
}

function createProgram() {
  const configPath = join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    console.error(`console-shape: cannot read ${configPath} - ${config.error.messageText}`);
    process.exit(1);
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  // `noEmit`: this program exists to answer type questions, not to build. Type
  // ERRORS are not reported here either - `npm run typecheck` owns those, over
  // four projects, and a second opinion on them from a style guard would only
  // ever disagree confusingly.
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
}

/**
 * One pass over `src/`. Builds its own program, so `--self-test` gets a fresh
 * read of a file it has just rewritten - a cached program would report the
 * source that was there before the mutation, which is the one result this
 * script must never produce.
 */
function scan() {
  const program = createProgram();
  const checker = program.getTypeChecker();
  const problems = [];
  const scanned = new Set();
  let sites = 0;
  let interpolations = 0;

  /**
   * Every expression an argument turns into text: template substitutions, and
   * the operands of a `+` whose result is a string.
   *
   * Pushed nodes may nest (a concatenation of a template of a conditional), so
   * the caller de-duplicates by position rather than this walk trying to be
   * clever about which level "owns" a value.
   */
  function stringifiedValues(node, out) {
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        out.push(span.expression);
        stringifiedValues(span.expression, out);
      }
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      isStringResult(checker.getTypeAtLocation(node))
    ) {
      for (const side of [node.left, node.right]) {
        if (!ts.isStringLiteralLike(side)) out.push(side);
        stringifiedValues(side, out);
      }
      return;
    }
    ts.forEachChild(node, (child) => stringifiedValues(child, out));
  }

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (!sourceFile.fileName.startsWith(SRC)) continue;
    const rel = relative(ROOT, sourceFile.fileName);
    scanned.add(rel);

    const at = (node) => `${rel}:${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}`;

    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'console'
      ) {
        sites++;
        const method = `console.${node.expression.name.text}`;

        for (const argument of node.arguments) {
          // Hand-flattening, anywhere in the argument - including in an argument
          // that is otherwise a perfectly good separate one.
          const flatten = (n) => {
            const name = stringifyCallName(n);
            if (name !== null) {
              problems.push(
                `${at(n)}  ${method} calls ${name} on an argument - pass the value ` +
                  'itself as a separate argument and let devtools render it',
              );
            }
            ts.forEachChild(n, flatten);
          };
          flatten(argument);

          const values = [];
          stringifiedValues(argument, values);
          const seen = new Set();
          for (const value of values) {
            if (seen.has(value.pos)) continue;
            seen.add(value.pos);
            interpolations++;
            const type = checker.getTypeAtLocation(value);
            if (isIdentifyingText(type)) continue;
            problems.push(
              `${at(value)}  ${method} interpolates \`${value.getText(sourceFile).replace(/\s+/g, ' ')}\` ` +
                `(type ${checker.typeToString(type)}) into its message`,
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { problems, sites, interpolations, files: scanned.size };
}

const GUIDANCE =
  '\nIdentifying text (an action name, a key, a count, a limit, a code) is interpolated;\n' +
  'a value with structure (an error, an element, a command, a result, an options bag)\n' +
  'is passed as its own argument:\n\n' +
  // Escaped `\${...}` in a template literal rather than a plain string: the
  // example has to show a real placeholder, and in a plain string biome's
  // noTemplateCurlyInString reads that as one written by mistake.
  `    console.warn(\`[vapor-chamber] ... "\${cmd.action}" ...\`, el)\n` +
  '  not\n' +
  `    console.warn(\`[vapor-chamber] ... \${JSON.stringify(el)} ...\`)\n\n` +
  'The first is expandable in devtools; the second is "[object Object]".\n\n' +
  'A value typed `any` or `unknown` fails here too - nothing shows it is identifying\n' +
  'text. If you know it is, say so at the call site with a cast, which is a claim a\n' +
  `reviewer can see (\`\${action as string}\`). Reaching for String(...) instead only\n` +
  'hides what the value was, and this check rejects that as well.\n';

/**
 * The violations this guard exists to catch, each injected into a real module.
 *
 * Three of them are the rule itself, at the buffer-overflow warning in
 * `handleMissing` - a DEV-gated `console.warn` with the command object in scope,
 * which is exactly the inspectable value the convention is about. The other two
 * are the sites that pass on shape rather than on an allowlist: mutating them
 * proves the scan REACHES them, which a passing run alone never shows.
 */
// Every literal below is a TEMPLATE literal with escaped `\${`, for the reason
// GUIDANCE gives: this script has to quote source that contains real
// placeholders, and in a plain string biome reads each one as a mistake.
const BUFFER_WARNING =
  `        console.warn(\`[vapor-chamber] onMissing:'buffer' queue for "\${cmd.action}" hit bufferLimit (\${limit}); dropped the oldest pending command. Register a handler, or raise bufferLimit.\`);`;
const ACTION_SLOT = `\${cmd.action}`;
const mutate = (from, to) => ({ from, to });

const MUTATIONS = [
  {
    file: 'src/command-bus.ts',
    what: 'an object interpolated into a template literal',
    expect: /interpolates `cmd` \(type Command/,
    ...mutate(BUFFER_WARNING, BUFFER_WARNING.replace(ACTION_SLOT, `\${cmd}`)),
  },
  {
    file: 'src/command-bus.ts',
    what: 'JSON.stringify inside the message',
    expect: /calls JSON\.stringify\(\) on an argument/,
    ...mutate(BUFFER_WARNING, BUFFER_WARNING.replace(ACTION_SLOT, `\${JSON.stringify(cmd)}`)),
  },
  {
    file: 'src/command-bus.ts',
    what: 'String() around the value',
    expect: /calls String\(\) on an argument/,
    ...mutate(BUFFER_WARNING, BUFFER_WARNING.replace(ACTION_SLOT, `\${String(cmd.target)}`)),
  },
  {
    file: 'src/command-bus.ts',
    what: 'the exempt console.warn(msg) site, made to interpolate',
    expect: /interpolates `naming\.pattern` \(type RegExp\)/,
    ...mutate(
      "  if (mode === 'warn') console.warn(msg);",
      `  if (mode === 'warn') console.warn(\`\${naming.pattern}\`);`,
    ),
  },
  {
    file: 'src/router/index.ts',
    what: 'the exempt console.error(error) site, made to interpolate',
    expect: /interpolates `error`/,
    ...mutate('    console.error(error);', `    console.error(\`\${error}\`);`),
  },
];

/**
 * Refuse to touch a file that is not exactly what git has.
 *
 * The `finally` below restores every mutation on any normal exit, including a
 * throw - but not on SIGKILL, and not on a machine that dies mid-run. What is
 * left behind then is a real module carrying an injected defect, which lands in
 * somebody's next diff looking like a change they made. This repo has had two
 * sessions editing one working tree at the same time, so that is a live
 * condition rather than a hypothetical.
 *
 * Checking only the files this will write buys the second thing too: an
 * interrupted run becomes DETECTABLE. The target shows as modified next time,
 * and this refuses rather than quietly mutating it again on top.
 *
 * A failing baseline is a different condition, checked separately below - that
 * one is about whether an injected failure would prove anything.
 */
function assertTargetsClean(files) {
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--', ...files], { cwd: ROOT, encoding: 'utf8' });
  } catch {
    // No git, or not a checkout. Nothing can establish the files are safe to
    // rewrite, and the cost of being wrong is a silently mutated module.
    console.error('console-shape --self-test: cannot ask git whether these files are clean, so it will not');
    console.error('rewrite them. Run it in a git checkout.');
    process.exit(1);
  }
  const dirty = status.split('\n').filter((line) => line.trim() !== '');
  if (dirty.length) {
    console.error('console-shape --self-test: it rewrites the files below and restores them, so it refuses');
    console.error('to run while any of them has uncommitted changes - it would clobber that work, and an');
    console.error('earlier interrupted run leaves exactly this trace. Check the diff, then commit or stash.\n');
    for (const line of dirty) console.error(`  ${line}`);
    process.exit(1);
  }
}

function selfTest() {
  let failures = 0;
  const report = (ok, line) => {
    if (!ok) failures++;
    console.log(`${ok ? 'pass' : 'FAIL'}  ${line}`);
  };

  const targets = [...new Set(MUTATIONS.map((mutation) => mutation.file))];
  assertTargetsClean(targets);
  report(true, `targets clean per git: ${targets.join(', ')}`);

  const before = scan();
  if (before.problems.length) {
    console.error('console-shape --self-test: the tree already fails the check, so an injected');
    console.error('failure would prove nothing. Fix these first:\n');
    for (const problem of before.problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  report(true, `clean tree: 0 problems (${before.sites} sites, ${before.interpolations} interpolated values)`);

  for (const mutation of MUTATIONS) {
    const target = join(ROOT, mutation.file);
    const backup = `${target}.self-test-backup`;
    const original = readFileSync(target, 'utf8');
    if (!original.includes(mutation.from)) {
      report(false, `${mutation.file}: the site this injects into has moved - update MUTATIONS`);
      continue;
    }
    copyFileSync(target, backup);
    try {
      writeFileSync(target, original.replace(mutation.from, mutation.to));
      const after = scan();
      const text = after.problems.join('\n');
      report(after.problems.length > 0 && mutation.expect.test(text), `${mutation.what} -> ${after.problems[0] ?? 'NOT CAUGHT'}`);
    } finally {
      // By copy, not by rewriting the string we read: if anything above threw
      // halfway through a write, the backup is still the file as it was.
      copyFileSync(backup, target);
      rmSync(backup, { force: true });
    }
    // Restoration is asserted, not assumed. A guard that leaves src/ mutated
    // has done more damage than the rule it protects.
    report(readFileSync(target, 'utf8') === original, `${mutation.file} restored byte-for-byte`);
  }

  const after = scan();
  report(after.problems.length === 0, `tree clean again: ${after.problems.length} problem(s)`);

  if (failures) {
    console.error(`\nconsole-shape --self-test: ${failures} assertion(s) failed - this guard cannot be trusted as it stands.`);
    process.exit(1);
  }
  console.log('\nconsole-shape --self-test: OK (every injected violation was caught, every file restored)');
}

if (process.argv.includes('--self-test')) {
  selfTest();
} else {
  const { problems, sites, interpolations, files } = scan();
  if (problems.length) {
    console.error(`console-shape: ${problems.length} site(s) put a value in the message that belongs beside it.\n`);
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(GUIDANCE);
    process.exit(1);
  }
  console.log(
    `console-shape: OK (${sites} console.* sites in ${files} files, ` +
      `${interpolations} interpolated values, all identifying text)`,
  );
}
