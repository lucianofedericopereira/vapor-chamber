/**
 * `vaporChamberTest()` from `vapor-chamber/vite`, the plugin object.
 *
 * Acceptance assertion A11 (vitest5-plugin-study.md Rev 3 section 6, R5), plus
 * the plugin's own contract. Whether a real Vitest honours what the plugin
 * returns is asserted on a packed consumer in tests/vitest-consumer.test.ts;
 * this file drives the hooks with the arguments Vitest passes them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { vaporChamberTest } from '../src/vite-hmr';
import { stubEnv, VcTestError } from '../src/vitest-pure';

const SETUP = 'vapor-chamber/vitest';

/** The config hook's view of `test.setupFiles` after it ran on `test`. */
function setupFilesAfter(test?: Record<string, unknown>): unknown {
  const config: { test?: Record<string, unknown> } = test === undefined ? {} : { test };
  vaporChamberTest().config(config);
  return config.test?.setupFiles;
}

/** A configureVitest context as Vitest 5 builds it, with the parts the plugin touches observable. */
function context({ version = '5.0.1', name = '', root = '/app', exclude = ['**/node_modules/**'], reporters = [] as unknown[] } = {}) {
  const provided: Record<string, unknown> = {};
  const project = {
    name,
    config: { root, exclude },
    provide: (key: string, value: unknown) => {
      provided[key] = value;
    },
  };
  return {
    ctx: {
      vitest: { version, config: { reporters }, logger: { warn: vi.fn(), error: vi.fn() } },
      project,
      injectTestProjects: vi.fn(async () => []),
    },
    project,
    provided,
  };
}

describe('A11 setup-file merge', () => {
  it('no user setupFiles: ours is the only entry', () => {
    expect(setupFilesAfter()).toEqual([SETUP]);
    expect(setupFilesAfter({})).toEqual([SETUP]);
  });

  it('a string setupFiles: ours first, theirs kept', () => {
    expect(setupFilesAfter({ setupFiles: './setup.ts' })).toEqual([SETUP, './setup.ts']);
  });

  it('an array setupFiles: ours first, theirs kept in order', () => {
    expect(setupFilesAfter({ setupFiles: ['./a.ts', './b.ts'] })).toEqual([SETUP, './a.ts', './b.ts']);
  });

  it('already containing ours: ours exactly once, first', () => {
    expect(setupFilesAfter({ setupFiles: ['./a.ts', SETUP] })).toEqual([SETUP, './a.ts']);
    expect(setupFilesAfter({ setupFiles: SETUP })).toEqual([SETUP]);
  });
});

describe('options reach the setup file (R6)', () => {
  it('the shared-bus exclude list is provided to the worker, as sources anchored at the project root', async () => {
    const { ctx, provided } = context({ root: '/app/' });
    await vaporChamberTest({
      sharedBus: { exclude: ['tests/a.test.ts', '**/detect-?.test.ts', 'tests/*/b.test.ts', 'tests/legacy/**'] },
      islands: false,
    }).configureVitest(ctx);
    const [plain, anyDepth, oneLevel, subtree] = (provided.vaporChamber as { exclude: string[] }).exclude.map((s) => new RegExp(s));

    expect(subtree.test('/app/tests/legacy/a/b.test.ts')).toBe(true);
    expect(subtree.test('/app/tests/legacyish.test.ts')).toBe(false);

    expect(plain.test('/app/tests/a.test.ts')).toBe(true);
    expect(plain.test('/app/pkg/tests/a.test.ts')).toBe(false);
    // Anchored at the root itself, not at any path that ends with it.
    expect(plain.test('/srv/app/tests/a.test.ts')).toBe(false);
    // `.` in a glob is a literal dot, not "any character".
    expect(plain.test('/app/tests/aXtest.ts')).toBe(false);

    expect(anyDepth.test('/app/detect-1.test.ts')).toBe(true);
    expect(anyDepth.test('/app/deep/er/detect-2.test.ts')).toBe(true);
    expect(anyDepth.test('/app/detect-12.test.ts')).toBe(false);
    expect(anyDepth.test('/elsewhere/detect-1.test.ts')).toBe(false);

    expect(oneLevel.test('/app/tests/x/b.test.ts')).toBe(true);
    expect(oneLevel.test('/app/tests/x/y/b.test.ts')).toBe(false);
  });

  it('without options an empty list is provided, so a file is never skipped by accident', async () => {
    const { ctx, provided } = context();
    await vaporChamberTest({ islands: false }).configureVitest(ctx);
    expect(provided).toEqual({ vaporChamber: { exclude: [] } });
  });

  it('the provided key is the one src/vitest.ts injects', () => {
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
    const plugin = read('src/vite-hmr.ts').match(/const TEST_PROVIDED = '([^']+)';/)?.[1];
    const setup = read('src/vitest.ts').match(/const PROVIDED = '([^']+)';/)?.[1];
    expect(plugin).toBe('vaporChamber');
    expect(setup).toBe(plugin);
  });
});

describe('R4 the setup file is a package specifier', () => {
  it('setupFiles names vapor-chamber/vitest, never a path or a virtual id', () => {
    const [ours] = setupFilesAfter({ setupFiles: [] }) as string[];
    expect(ours).toBe(SETUP);
    // The specifier is published, so Vitest's resolver can find it from a consumer's root.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.exports['./vitest'].import).toBe('./dist/vitest.js');
  });
});

describe('VC_TEST_VITEST_MAJOR (R13)', () => {
  it('an unknown Vitest major warns once, with the catalogue message, and does not fail', async () => {
    const plugin = vaporChamberTest({ islands: false });
    const { ctx } = context({ version: '6.0.0' });
    await plugin.configureVitest(ctx);
    await plugin.configureVitest(ctx);
    expect(ctx.vitest.logger.warn).toHaveBeenCalledOnce();
    expect(ctx.vitest.logger.warn).toHaveBeenCalledWith(new VcTestError('VC_TEST_VITEST_MAJOR', ' (Vitest 6.0.0)').message);
  });

  it('control: Vitest 5 warns nothing', async () => {
    const { ctx } = context({ version: '5.0.1' });
    await vaporChamberTest({ islands: false }).configureVitest(ctx);
    expect(ctx.vitest.logger.warn).not.toHaveBeenCalled();
  });
});

describe('the vc-vitest-plugin line on top of a run', () => {
  const PLAIN = ' \\\\//  powered by vc-vitest-plugin';
  const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  const strip = (s: string) => s.replace(ANSI, '');

  /** Every color switch unset (TERM dumb), restored by `using`; each test turns on the one it needs. */
  function colorsOff(): Disposable {
    const stubs = [
      stubEnv('NO_COLOR', undefined), stubEnv('FORCE_COLOR', undefined), stubEnv('CI', undefined),
      stubEnv('FORCE_TTY', undefined), stubEnv('COLORTERM', undefined), stubEnv('TERM', 'dumb'),
    ];
    return { [Symbol.dispose]: () => { for (const stub of stubs.reverse()) stub[Symbol.dispose](); } };
  }

  async function linesFor(reporters: unknown[]) {
    const { ctx } = context({ reporters });
    await vaporChamberTest({ islands: false }).configureVitest(ctx);
    return ctx.vitest.logger.error.mock.calls.map((call) => call[0] as string);
  }

  it('prints once, on stderr, with a reporter that prints Vitest\'s own banner', async () => {
    using _env = colorsOff();
    for (const name of ['default', 'minimal', 'agent', 'verbose', 'dot', 'tree']) {
      expect(await linesFor([[name, {}]]), name).toEqual([PLAIN]);
    }
    // Beside a machine reporter it still prints: the terminal shows Vitest's banner.
    expect(await linesFor([['json', { outputFile: 'r.json' }], ['dot', {}]])).toEqual([PLAIN]);
  });

  it('control: nothing with only machine, custom or inline reporters, where Vitest prints no banner', async () => {
    for (const reporters of [[], [['json', {}]], [['junit', {}], ['tap', {}]], [['./my-reporter.js', {}]], [{ onInit() {} }]]) {
      expect(await linesFor(reporters)).toEqual([]);
    }
  });

  it('once per Vitest instance: its other projects, the island project included, print nothing more', async () => {
    const plugin = vaporChamberTest();
    const { ctx } = context({ reporters: [['default', {}]] });
    await plugin.configureVitest(ctx);
    await plugin.configureVitest({ ...ctx, project: { ...ctx.project, name: 'vapor-chamber-islands' } });
    await vaporChamberTest().configureVitest(ctx);
    expect(ctx.vitest.logger.error).toHaveBeenCalledOnce();
    // A new Vitest instance (a restarted run) prints again.
    const next = context({ reporters: [['default', {}]] });
    await plugin.configureVitest(next.ctx);
    expect(next.ctx.vitest.logger.error).toHaveBeenCalledOnce();
  });

  it('in Vue\'s colors, 24-bit where COLORTERM says so: green #42B883 on slate #35495E', async () => {
    using _env = colorsOff();
    using _force = stubEnv('FORCE_COLOR', '1');
    using _truecolor = stubEnv('COLORTERM', 'truecolor');
    const [line] = await linesFor([['default', {}]]);
    expect(line).toContain(`${String.fromCharCode(27)}[48;2;53;73;94m`);
    expect(line).toContain(`${String.fromCharCode(27)}[38;2;66;184;131m`);
    expect(strip(line)).toBe(PLAIN);
    // COLORTERM=24bit is the other spelling.
    using _24bit = stubEnv('COLORTERM', '24bit');
    expect((await linesFor([['default', {}]]))[0]).toContain('[38;2;66;184;131m');
  });

  it('the nearest xterm-256 shades without 24-bit support', async () => {
    using _env = colorsOff();
    using _ci = stubEnv('CI', 'true');
    const [line] = await linesFor([['default', {}]]);
    expect(line).toContain(`${String.fromCharCode(27)}[48;5;239m`);
    expect(line).toContain(`${String.fromCharCode(27)}[38;5;72m`);
    expect(line).not.toContain(';2;');
    expect(strip(line)).toBe(PLAIN);
  });

  it('colors follow Vitest\'s own rules: a terminal that is not dumb, FORCE_TTY=false, and NO_COLOR over everything', async () => {
    using _env = colorsOff();
    using _term = stubEnv('TERM', 'xterm-256color');
    expect((await linesFor([['default', {}]]))[0]).not.toBe(PLAIN);
    {
      using _tty = stubEnv('FORCE_TTY', 'false');
      expect(await linesFor([['default', {}]])).toEqual([PLAIN]);
    }
    using _no = stubEnv('NO_COLOR', '1');
    using _force = stubEnv('FORCE_COLOR', '1');
    expect(await linesFor([['default', {}]])).toEqual([PLAIN]);
  });
});

describe('the island project (R7)', () => {
  it('injects one project with the convention globs and a DOM environment, and excludes them from the root', async () => {
    const { ctx, project } = context({ exclude: ['**/node_modules/**'] });
    const theirs = project.config.exclude;
    await vaporChamberTest().configureVitest(ctx);

    expect(ctx.injectTestProjects).toHaveBeenCalledOnce();
    expect(ctx.injectTestProjects).toHaveBeenCalledWith({
      test: {
        name: 'vapor-chamber-islands',
        include: ['**/*.island.{test,spec}.*', '{test,tests}/islands/**'],
        environment: 'happy-dom',
      },
    });
    expect(project.config.exclude).toEqual(['**/node_modules/**', '**/*.island.{test,spec}.*', '{test,tests}/islands/**']);
    // A new array: the injected project resolves its exclude to the SAME array
    // object, and a push hid every island file from the island project.
    expect(project.config.exclude).not.toBe(theirs);
    expect(theirs).toEqual(['**/node_modules/**']);
  });

  it('islands.environment is passed through', async () => {
    const { ctx } = context();
    await vaporChamberTest({ islands: { environment: 'jsdom' } }).configureVitest(ctx);
    expect(ctx.injectTestProjects.mock.calls[0][0]).toMatchObject({ test: { environment: 'jsdom' } });
  });

  it('islands: false injects nothing and leaves the root exclude alone', async () => {
    const { ctx, project } = context();
    const theirs = project.config.exclude;
    await vaporChamberTest({ islands: false }).configureVitest(ctx);
    expect(ctx.injectTestProjects).not.toHaveBeenCalled();
    expect(project.config.exclude).toBe(theirs);
  });

  it('inside the island project it injects nothing, and its include replaces the inherited one', async () => {
    const { ctx, provided } = context({ name: 'vapor-chamber-islands' });
    await vaporChamberTest().configureVitest(ctx);
    expect(ctx.injectTestProjects).not.toHaveBeenCalled();
    // The project still gets the exclude list: it runs the same setup file.
    expect(provided).toHaveProperty('vaporChamber');

    // Vitest merges the project's options into the inherited config with Vite's
    // merge, so its include arrives EXTENDED with the root's; the hook replaces it.
    const config = { test: { name: 'vapor-chamber-islands', include: ['tests/**/*.test.ts', '**/*.island.{test,spec}.*'] } };
    vaporChamberTest().config(config);
    expect(config.test.include).toEqual(['**/*.island.{test,spec}.*', '{test,tests}/islands/**']);
    // Control: any other project keeps its include.
    const other = { test: { name: 'unit', include: ['tests/**/*.test.ts'] } };
    vaporChamberTest().config(other);
    expect(other.test.include).toEqual(['tests/**/*.test.ts']);
  });

  it('inside the island project the inherited benchmark include is emptied, so bench files run once', () => {
    const config = { test: { name: 'vapor-chamber-islands', benchmark: { include: ['**/*.bench.ts'], exclude: ['legacy/**'] } } };
    vaporChamberTest().config(config);
    // Only the include is emptied; any other benchmark option is kept.
    expect(config.test.benchmark).toEqual({ include: [], exclude: ['legacy/**'] });
    // Control: any other project keeps its benchmark include.
    const other = { test: { name: 'unit', benchmark: { include: ['**/*.bench.ts'] } } };
    vaporChamberTest().config(other);
    expect(other.test.benchmark.include).toEqual(['**/*.bench.ts']);
  });
});

const haveDist = existsSync(resolve(process.cwd(), 'dist/vite-hmr.d.ts'));

describe.skipIf(!haveDist)('R14 the public type stays structural', () => {
  it('dist/vite-hmr.d.ts references no vitest module', () => {
    const text = readFileSync(resolve(process.cwd(), 'dist/vite-hmr.d.ts'), 'utf8');
    const info = ts.preProcessFile(text, true, true);
    expect(info.importedFiles.map((f) => f.fileName)).toEqual([]);
    expect(info.typeReferenceDirectives).toEqual([]);
    expect(text).toMatch(/export declare function vaporChamberTest\(options\?: VaporChamberTestOptions\): any;/);
  });
});
