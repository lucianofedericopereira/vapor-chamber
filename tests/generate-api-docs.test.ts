/**
 * scripts/generate-api-docs.mjs run against a throwaway fixture package (own package.json, tsconfig and src tree).
 * Why: the API reference is generated; if entry points, alias resolution, @internal filtering or type printing were wrong, a published subpath would go undocumented or the pages would show empty comments and "any".
 * Shows: entry points come from `exports` and skip iife; one page per entry plus an index; aliases resolve through a re-export barrel; a whole re-export links instead of repeating; @internal is excluded; a generic alias prints its declaration; kinds and plurals are labelled; source links use the repository field; Contents are space-separated; output is deterministic.
 * See: scripts/generate-api-docs.mjs.
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

  // The declarations live here; index.ts only re-exports them, so alias resolution is exercised.
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
  // extra re-exports the root whole, and one of its names by name as well.
  writeFileSync(join(dir, 'src', 'extra.ts'), `/** Extra thing. */\nexport function extraThing(): void {}\nexport { counter } from './core';\nexport * from './index';\n`);
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

  // Spawns a node process that runs the real compiler over the fixture.
  it('writes one page per entry point plus an index', () => {
    const { status, stdout } = run();
    expect(status).toBe(0);
    expect(stdout).toContain('2 entry points');

    const index = read('README.md');
    expect(index).toContain('fixture-lib v9.9.9 API reference');
    expect(index).toContain('[`fixture-lib`](index.md)');
    expect(index).toContain('[`fixture-lib/extra`](extra.md)');
    // The index prose mentions iife, so assert there is no iife row.
    expect(index).not.toContain('](iife.md)');
    expect(index).toContain('2 entry points');
  });

  it('resolves aliases through a re-export barrel', () => {
    const page = read('index.md');
    // The doc comment and tags live on the declaration in core.ts, not on the barrel's re-export.
    expect(page).toContain('Creates a widget.');
    expect(page).toContain('what to call it');
    expect(page).toContain("const w = makeWidget('a');");
  });

  it('links to an entry it re-exports whole instead of repeating it, and keeps what it names', () => {
    expect(run().status).toBe(0);
    const page = read('extra.md');
    expect(page).toContain('Also exports everything from [`fixture-lib`](index.md), documented there.');
    expect(page).not.toContain('Creates a widget.');
    expect(page).toContain('Extra thing.');
    expect(page).toContain('A plain counter.');
    // Control: the root's own page still documents it.
    expect(read('index.md')).toContain('Creates a widget.');
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

  it('regenerates deterministically', () => {
    const first = read('index.md');
    run();
    expect(read('index.md')).toBe(first);
  });
});
