/**
 * vapor-chamber/vitest/mcp - a Vitest MCP server built on a schema command bus.
 *
 * Three tools. Their names are the bus's action names, camelCase as a schema
 * bus normalizes them (vitest-community/mcp's run_tests is runTests here):
 *
 * - `runTests` runs test files (all, or the `files` filters) in a Vitest that
 *   stays warm between calls, and returns counts and each failure's message;
 * - `getTestResults` returns the last run again, and which files changed
 *   since, so an agent knows when it is stale;
 * - `getCoverageGaps` runs the suite once with coverage, in a separate
 *   `vitest run`, and lists per source file the uncovered lines, functions and
 *   branch arms.
 *
 * WHAT AN AGENT CAN CHOOSE, AND WHAT IT CANNOT. The project root and the config
 * are fixed by whoever starts the server. An agent passes only `files`: Vitest
 * filters that select among the test files the project's own config already
 * includes. A filter that starts with `-` is refused, because the coverage run
 * passes filters on a command line, where it would be read as an option.
 *
 * WARM RUNS SEE EDITS BECAUSE THIS FILE WATCHES FOR THEM. Measured on Vitest
 * 5.0.1: `runTestSpecifications` on a warm instance re-ran the old module
 * after a test file and a source file were edited, until each path was passed
 * to `vitest.invalidateFile()`. The server records changed paths with
 * `fs.watch` and invalidates them just before each run; Vitest runs nothing on
 * its own.
 *
 * COVERAGE RUNS COLD, IN A CHILD PROCESS. A coverage provider initialised in a
 * warm instance slows every run, and in a Vitest created inside a Vitest test
 * worker it wrote no report at all (measured), so the one path that could not
 * be tested for real would be the one that reports coverage.
 *
 * Vitest's own output goes to stderr: on stdio, stdout is the protocol.
 *
 * @example
 * // an MCP client's server entry, in the project root
 * { "command": "npx", "args": ["vc-vitest-mcp"] }
 */

import { spawn } from 'node:child_process';
import { type FSWatcher, existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { type BusSchema, createAsyncSchemaCommandBus } from 'vapor-chamber';
import { serveMcpStdio } from 'vapor-chamber/mcp';
import type { TestModule, Vitest } from 'vitest/node';
import { VcTestError } from './vitest-pure';

/** The tools, as a bus schema: `tools/list` is derived from it. */
export const VITEST_MCP_SCHEMA: BusSchema = {
  runTests: {
    description:
      'Run test files in a warm Vitest: all of them, or those matching target.files (Vitest filters, relative to the project root). Returns counts and every failure with its message.',
    target: { files: 'any' },
  },
  getTestResults: {
    description: 'The last runTests result again, with the files changed since it ran (stale when any did).',
  },
  getCoverageGaps: {
    description:
      'Run the tests (all, or target.files) once with coverage and list, per source file, the uncovered lines, functions and branch arms.',
    target: { files: 'any' },
  },
};

/** Every tool name, the default allow-list. */
export const VITEST_MCP_ACTIONS = Object.keys(VITEST_MCP_SCHEMA);

export interface VitestMcpOptions {
  /** The project root. Default: the working directory. */
  root?: string;
  /** A Vitest config file, as `--config` takes it. Default: Vitest's own lookup from the root. */
  config?: string;
}

/** One failed test, as `runTests` reports it. */
export interface VitestMcpFailure {
  file: string;
  test: string;
  message: string;
}

/** What `runTests` returns. */
export interface VitestMcpRun {
  files: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: VitestMcpFailure[];
  /** Errors outside any test (a file that failed to load, an unhandled rejection). */
  errors: string[];
}

/** One source file with something uncovered, as `getCoverageGaps` reports it. */
export interface VitestMcpGap {
  file: string;
  /** Uncovered statement lines, as ranges: `"3, 8-9"`. */
  uncoveredLines: string;
  uncoveredFunctions: string[];
  uncoveredBranches: { line: number; type: string; uncoveredArms: number[]; arms: number }[];
}

/** A running server: the bus to serve, and `close()`. */
export interface VitestMcpServer {
  bus: ReturnType<typeof createAsyncSchemaCommandBus<BusSchema>>;
  close(): Promise<void>;
}

const MAX_FILTERS = 100;
const MAX_FILTER_LENGTH = 1000;

/** `target.files` as filters, or a coded refusal. Absent means every test file. */
function filtersOf(target: { files?: unknown } | undefined): string[] {
  const files = target?.files;
  if (files === undefined) return [];
  const ok =
    Array.isArray(files) &&
    files.length <= MAX_FILTERS &&
    files.every((f) => typeof f === 'string' && f.length > 0 && f.length <= MAX_FILTER_LENGTH && !f.startsWith('-'));
  if (!ok) throw new VcTestError('VC_TEST_MCP_INVALID_FILES');
  return files as string[];
}

/** `"3, 8-9"` from a set of line numbers. */
function ranges(lines: number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] as number;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i] as number;
    out.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return out.join(', ');
}

type Loc = { start: { line: number }; end: { line: number } };
type FileCoverage = {
  s: Record<string, number>;
  statementMap: Record<string, Loc>;
  f: Record<string, number>;
  fnMap: Record<string, { name: string; loc: Loc }>;
  b: Record<string, number[]>;
  branchMap: Record<string, { type: string; loc: Loc }>;
};

/** Gaps from an Istanbul `coverage-final.json`, files with none left out. */
export function coverageGaps(report: Record<string, FileCoverage>, root: string): VitestMcpGap[] {
  const gaps: VitestMcpGap[] = [];
  for (const [path, c] of Object.entries(report)) {
    const lines = Object.entries(c.s).filter(([, n]) => n === 0).flatMap(([k]) => {
      const { start, end } = (c.statementMap[k] as Loc);
      return Array.from({ length: end.line - start.line + 1 }, (_, i) => start.line + i);
    });
    const functions = Object.entries(c.f).filter(([, n]) => n === 0).map(([k]) => {
      const fn = c.fnMap[k] as { name: string; loc: Loc };
      return `${fn.name} (line ${fn.loc.start.line})`;
    });
    const branches = Object.entries(c.b).flatMap(([k, counts]) => {
      const uncoveredArms = counts.flatMap((n, arm) => (n === 0 ? [arm] : []));
      if (uncoveredArms.length === 0) return [];
      const branch = c.branchMap[k] as { type: string; loc: Loc };
      return [{ line: branch.loc.start.line, type: branch.type, uncoveredArms, arms: counts.length }];
    });
    if (lines.length + functions.length + branches.length === 0) continue;
    gaps.push({ file: relative(root, path), uncoveredLines: ranges(lines), uncoveredFunctions: functions, uncoveredBranches: branches });
  }
  return gaps;
}

/** The failures and counts of the modules a run selected. */
function summarize(modules: readonly TestModule[], selected: Set<string>, errors: unknown[], root: string): VitestMcpRun {
  const run: VitestMcpRun = { files: 0, passed: 0, failed: 0, skipped: 0, failures: [], errors: errors.map((e) => String((e as { message?: unknown }).message)) };
  for (const module of modules) {
    if (!selected.has(module.moduleId)) continue;
    run.files++;
    const file = relative(root, module.moduleId);
    for (const error of module.errors()) run.errors.push(`${file}: ${error.message}`);
    for (const test of module.children.allTests()) {
      const result = test.result();
      if (result.state === 'passed') run.passed++;
      else if (result.state === 'failed') {
        run.failed++;
        run.failures.push({ file, test: test.fullName, message: result.errors.map((e) => e.message).join('\n') });
      } else run.skipped++;
    }
  }
  return run;
}

/**
 * Start the server: a warm Vitest on `root`, a file watcher, and a schema bus
 * whose handlers are the three tools. Serve `bus` with `createMcpHandler` or
 * `serveMcpStdio`, passing {@link VITEST_MCP_ACTIONS} (or fewer) as `actions`.
 */
export async function createVitestMcp(options: VitestMcpOptions = {}): Promise<VitestMcpServer> {
  const root = resolve(options.root ?? process.cwd());
  const { createVitest } = await import('vitest/node');
  const vitest: Vitest = await createVitest(
    'test',
    { root, config: options.config, watch: false, reporters: [] },
    {},
    { stdout: process.stderr, stderr: process.stderr },
  );
  await vitest.standalone();

  const changed = new Set<string>();
  const watcher: FSWatcher = watch(root, { recursive: true }, (_event, name) => {
    if (name && !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(name)) changed.add(join(root, name));
  });

  // One run at a time: parallel tool calls wait their turn.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  let last: VitestMcpRun | undefined;

  const bus = createAsyncSchemaCommandBus(VITEST_MCP_SCHEMA);

  bus.register('runTests', (cmd) => {
    const filters = filtersOf(cmd.target);
    return serial(async () => {
      // Vitest caches which files are tests: a test file created after start
      // was not run (measured), so any change also drops that cache.
      if (changed.size > 0) vitest.clearSpecificationsCache();
      for (const file of changed) vitest.invalidateFile(file);
      changed.clear();
      const specifications = await vitest.getRelevantTestSpecifications(filters);
      const result = await vitest.runTestSpecifications(specifications, filters.length === 0);
      last = summarize(result.testModules, new Set(specifications.map((s) => s.moduleId)), result.unhandledErrors, root);
      return last;
    });
  });

  // Queued too: an MCP client sends calls concurrently, and a runTests sent just
  // before must finish before its result is "the last run" (measured over stdio:
  // unqueued, this answered VC_TEST_MCP_NO_RUN).
  bus.register('getTestResults', () =>
    serial(async () => {
      if (last === undefined) throw new VcTestError('VC_TEST_MCP_NO_RUN');
      // `changed` was emptied when that run started, so it holds what changed since.
      const stale = [...changed].map((file) => relative(root, file));
      return { ...last, stale: stale.length > 0, changedSince: stale };
    }),
  );

  bus.register('getCoverageGaps', (cmd) => {
    const filters = filtersOf(cmd.target);
    return serial(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'vc-vitest-mcp-coverage-'));
      try {
        const vitestBin = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
        const args = [
          vitestBin, 'run', '--root', root,
          '--coverage.enabled=true', '--coverage.reporter=json', `--coverage.reportsDirectory=${dir}`, '--coverage.reportOnFailure=true',
          ...(options.config === undefined ? [] : ['--config', options.config]),
          ...filters,
        ];
        // A child of this process is not a worker of a Vitest run, whatever
        // started this process.
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITEST|TEST$|NODE_ENV$)/.test(key)));
        const stderr = await new Promise<string>((done) => {
          let text = '';
          const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
          child.stderr.on('data', (chunk) => { text += chunk; });
          child.on('close', () => done(text));
        });
        const report = join(dir, 'coverage-final.json');
        if (!existsSync(report)) throw new VcTestError('VC_TEST_MCP_NO_COVERAGE', `: ${stderr.split('\n').map((line) => line.trim()).filter((line) => /error/i.test(line)).slice(0, 3).join(' | ')}`);
        return { files: coverageGaps(JSON.parse(readFileSync(report, 'utf8')), root) };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  return {
    bus,
    async close() {
      watcher.close();
      await vitest.close();
    },
  };
}

/**
 * {@link createVitestMcp}, served over stdio with every tool allowed. Resolves
 * to a `stop()` that detaches from stdin and closes Vitest.
 */
export async function serveVitestMcp(options: VitestMcpOptions = {}): Promise<() => Promise<void>> {
  const server = await createVitestMcp(options);
  const stop = serveMcpStdio(server.bus, { actions: VITEST_MCP_ACTIONS, serverName: 'vc-vitest-mcp' });
  return async () => {
    stop();
    await server.close();
  };
}
