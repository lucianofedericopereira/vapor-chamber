/**
 * generate-api-docs contract test - locks the compiler -> Markdown output.
 *
 * Runs scripts/generate-api-docs.mjs against a throwaway fixture package
 * (its own package.json, tsconfig and src tree) and asserts the properties the
 * generator exists to guarantee. Every case here corresponds to something that
 * was WRONG in a draft of that script and was found by reading the rendered
 * output rather than by any test:
 *
 *   - entry points come from `exports`, so a published subpath cannot go
 *     undocumented (the hand-kept typedoc list had drifted by five)
 *   - `iife` subpaths are skipped: they install a global, not a module
 *   - aliases are resolved, or a re-export barrel documents 193 symbols with
 *     empty doc comments and bare types
 *   - `@internal` is honoured on the RESOLVED symbol, since the barrel's
 *     re-export never carries the tag
 *   - a generic type alias prints its DECLARATION, because asking the checker
 *     to stringify one yields the bare word "any"
 *   - plurals are spelled, not suffixed ("Type aliases", not "Type aliass")
 *
 * The script resolves `typescript` from its own location, so running it with
 * cwd set to the fixture works without installing anything there.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts', 'generate-api-docs.mjs');

let dir: string;

function read(name: string): string {
  return readFileSync(join(dir, 'docs', 'api', name), 'utf8');
}

function run(args: string[] = []): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-api-docs-'));
  mkdirSync(join(dir, 'src'), { recursive: true });

  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture-lib',
      version: '9.9.9',
      repository: { type: 'git', url: 'git+https://github.com/fixture/lib.git' },
      exports: {
        '.': { import: './dist/index.js' },
        './extra': { import: './dist/extra.js' },
        './iife': { import: './dist/iife.js' },
        './package.json': './package.json',
      },
    }),
  );

  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ES2022',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src/**/*'],
    }),
  );

  // The real declarations live here; index.ts only re-exports them, which is
  // what makes this fixture exercise alias resolution rather than assume it.
  writeFileSync(
    join(dir, 'src', 'core.ts'),
    `/**
 * Creates a widget.
 *
 * @param name what to call it
 * @returns the widget
 * @example
 * const w = makeWidget('a');
 */
export function makeWidget(name: string): Widget<string> {
  return { name, tags: [] } as Widget<string>;
}

/** A widget, parameterised so the checker cannot stringify it. */
export type Widget<T> = {
  /** Its name. */
  name: T;
  tags: string[];
};

/** @internal Not part of the public surface. */
export function secretHelper(): void {}

/** A plain counter. */
export const counter = 0;
`,
  );

  writeFileSync(join(dir, 'src', 'index.ts'), `export { makeWidget, secretHelper, counter } from './core';\nexport type { Widget } from './core';\n`);
  writeFileSync(join(dir, 'src', 'extra.ts'), `/** Extra thing. */\nexport function extraThing(): void {}\n`);
  writeFileSync(join(dir, 'src', 'iife.ts'), `export const globalNamespace = {};\n`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('generate-api-docs', () => {
  it('derives entry points from package.json exports and skips iife', () => {
    const { status, stdout } = run(['--list']);
    expect(status).toBe(0);
    expect(stdout).toContain('fixture-lib');
    expect(stdout).toContain('fixture-lib/extra');
    expect(stdout).not.toContain('iife');
    expect(stdout).not.toContain('package.json');
  });

  // Spawns a node process that runs the real compiler over the fixture, so the
  // default 5000ms budget is not a measure of anything - under `test:coverage`
  // the instrumented run clears it on slower hardware while nothing is wrong.
  it('writes one page per entry point plus an index', () => {
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toContain('2 entry points');

    const index = read('README.md');
    expect(index).toContain('fixture-lib v9.9.9 API reference');
    expect(index).toContain('[`fixture-lib`](index.md)');
    expect(index).toContain('[`fixture-lib/extra`](extra.md)');
    // The word itself appears in the prose explaining the omission, so this
    // asserts there is no iife ROW rather than no mention.
    expect(index).not.toContain('](iife.md)');
    expect(index).toContain('2 entry points');
  });

  it('resolves aliases through a re-export barrel', () => {
    const page = read('index.md');
    // The doc comment and the tags live on the declaration in core.ts, not on
    // the barrel's re-export - unresolved, all three of these are empty.
    expect(page).toContain('Creates a widget.');
    expect(page).toContain('what to call it');
    expect(page).toContain("const w = makeWidget('a');");
  });

  it('excludes @internal declarations', () => {
    expect(read('index.md')).not.toContain('secretHelper');
  });

  it('prints a generic type alias as its declaration, not as "any"', () => {
    const page = read('index.md');
    expect(page).toContain('export type Widget<T> = {');
    expect(page).toContain('/** Its name. */');
    expect(page).not.toMatch(/^Widget: any$/m);
  });

  it('labels kinds and spells plurals', () => {
    const page = read('index.md');
    expect(page).toContain('## Functions');
    expect(page).toContain('## Type aliases');
    expect(page).not.toContain('Type aliass');
    expect(page).toContain('**Function**');
    expect(page).toContain('**Type alias**');
    expect(page).toContain('**Variable**');
  });

  // The repository URL and the package name are read from package.json, not
  // hardcoded. They were literals until this fixture rendered the wrong
  // project's name and repo into its own reference.
  it('builds source links from the package repository field', () => {
    expect(read('index.md')).toMatch(
      /\[src\/core\.ts:\d+\]\(https:\/\/github\.com\/fixture\/lib\/blob\/main\/src\/core\.ts#L\d+\)/,
    );
  });

  it('separates Contents entries with a space, not a comma', () => {
    const page = read('index.md');
    expect(page).toMatch(/\*\*Type aliases:\*\* /);
    expect(page).not.toMatch(/\]\(#\w+\), \[/);
  });

  // Same spawn, same reason as above.
  it('regenerates deterministically', () => {
    const first = read('index.md');
    run();
    expect(read('index.md')).toBe(first);
  });
});
