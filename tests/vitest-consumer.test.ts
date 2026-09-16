/**
 * `vapor-chamber/vitest` on a packed and installed consumer.
 *
 * Every probe in the study imported `src/` by relative path, which cannot see
 * the failures that matter here: two module instances, a setup file resolved
 * the wrong way, a declaration file that breaks a consumer without vitest.
 * These run a real Vitest, in a subprocess, on a project outside this repo that
 * has the built package installed the way npm leaves it.
 *
 * Acceptance assertions from vitest5-plugin-study.md Rev 3 section 6.
 * A7 (our own suite on Node 22 and 24) and A9 (suite wall time, interleaved)
 * are measurements of this repository, recorded with the batch, not tests.
 *
 * THE PACKAGE IS COPIED, NOT LINKED, into each project's node_modules. Vite
 * follows a symlink to its real path, and a package whose real path is outside
 * node_modules is treated as source rather than a dependency - which is exactly
 * the difference module identity depends on (tests/vite-wire-plugin.test.ts
 * makes the same choice for the same reason). Vitest, happy-dom and TypeScript
 * are linked: their real paths are inside this repository's node_modules.
 *
 * The projects live in the OS temp dir, never under this repository, so
 * nothing resolves through the workspace self-link to the working tree.
 */
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = process.cwd();
const dist = (f: string) => resolve(REPO, 'dist', f);
const haveDist = existsSync(dist('vitest.js')) && existsSync(dist('vitest-pure.js')) && existsSync(dist('index.d.ts'));

// ---------------------------------------------------------------------------
// Consumer projects
// ---------------------------------------------------------------------------

const roots: string[] = [];

/** The built package as npm installs it: package.json and dist/, source maps left behind. */
function installCopy(at: string): void {
  mkdirSync(at, { recursive: true });
  cpSync(join(REPO, 'package.json'), join(at, 'package.json'));
  cpSync(join(REPO, 'dist'), join(at, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
  cpSync(join(REPO, 'bin'), join(at, 'bin'), { recursive: true });
}

/**
 * `vc-vitest-mcp` started as an MCP client starts it, in `root`: each message
 * written to stdin as a line, every stdout line kept, then stdin closed once
 * every request (a message with an id) has its reply.
 */
function mcpOverStdio(root: string, messages: object[]): Promise<{ replies: Map<unknown, any>; stdout: string[]; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, 'node_modules/vapor-chamber/bin/vc-vitest-mcp.mjs')], { cwd: root, env: childEnv });
    const expected = messages.filter((m) => 'id' in m).length;
    const replies = new Map<unknown, any>();
    const stdout: string[] = [];
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`vc-vitest-mcp answered ${replies.size} of ${expected} requests:\n${stderr}`));
    }, 110_000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        stdout.push(line);
        try {
          const reply = JSON.parse(line);
          if (reply.id !== undefined) replies.set(reply.id, reply);
        } catch {}
        newline = buffer.indexOf('\n');
      }
      if (replies.size === expected) child.stdin.end();
    });
    child.on('close', () => {
      clearTimeout(timer);
      done({ replies, stdout, stderr });
    });
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

/**
 * A project in the OS temp dir: `files` written, the package installed as a
 * copy at node_modules/vapor-chamber (and at every path in `copies`), and each
 * of `links` linked from this repository's node_modules.
 */
function consumer(files: Record<string, string>, { links = ['vitest'], copies = [] as string[] } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vc-consumer-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"vc-consumer","private":true,"type":"module"}\n');
  installCopy(join(root, 'node_modules', 'vapor-chamber'));
  for (const at of copies) installCopy(join(root, at));
  for (const dep of links) {
    mkdirSync(dirname(join(root, 'node_modules', dep)), { recursive: true });
    symlinkSync(join(REPO, 'node_modules', dep), join(root, 'node_modules', dep));
  }
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

/** The child must not believe it is a worker of this run. */
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITEST|TEST$|NODE_ENV$)/.test(key)));

function exec(root: string, args: string[]): Promise<{ status: number; output: string; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, args, { cwd: root, env: childEnv, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ status: typeof error?.code === 'number' ? error.code : 0, output: `${stdout}\n${stderr}`, stdout, stderr });
    });
  });
}

/** `vitest run` with one CLI reporter writing to the terminal streams: what a user sees, colors stripped. */
async function runWithReporter(root: string, reporter: string) {
  const { stdout, stderr } = await exec(root, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', `--reporter=${reporter}`]);
  const plain = (s: string) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  return { stdout: plain(stdout), stderr: plain(stderr) };
}

type Outcome = { file: string; title: string; status: string; failure: string };

/** `vitest run` in the project, every test's outcome read from the JSON reporter. */
async function runVitest(root: string): Promise<Outcome[]> {
  const out = join(root, 'results.json');
  const { output } = await exec(root, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', `--outputFile=${out}`]);
  if (!existsSync(out)) throw new Error(`vitest wrote no results in ${root}:\n${output}`);
  const report = JSON.parse(readFileSync(out, 'utf8')) as {
    testResults: { name: string; message: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
  };
  return report.testResults.flatMap((file) =>
    file.assertionResults.length === 0
      ? [{ file: relative(root, file.name), title: '(file)', status: 'failed', failure: file.message }]
      : file.assertionResults.map((t) => ({ file: relative(root, file.name), title: t.title, status: t.status, failure: t.failureMessages.join('\n') })),
  );
}

/** `tsc -p` on a tsconfig written for `file`: strict, and NEVER skipLibCheck. */
async function typecheck(root: string, file: string, types: string[]): Promise<{ status: number; output: string }> {
  cpSync(join(REPO, 'tests/types/vitest', file), join(root, file));
  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', skipLibCheck: false, types },
      files: [file],
    }),
  );
  return exec(root, [join(REPO, 'node_modules/typescript/bin/tsc'), '-p', root]);
}

/** `vitest bench --run` in the project: how many times each file ran, and in which projects. */
async function runBench(root: string): Promise<{ file: string; project: string }[]> {
  const out = join(root, 'bench.json');
  const { output } = await exec(root, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'bench', '--run', '--reporter=json', `--outputFile=${out}`]);
  if (!existsSync(out)) throw new Error(`vitest bench wrote no results in ${root}:\n${output}`);
  const report = JSON.parse(readFileSync(out, 'utf8')) as { testResults: { name: string; projectName?: string }[] };
  return report.testResults.map((r) => ({ file: relative(root, r.name), project: r.projectName ?? '' }));
}

const passed = (outcomes: Outcome[], file: string) => outcomes.filter((o) => o.file === file && o.status === 'passed');
const failedIn = (outcomes: Outcome[], file: string) => outcomes.filter((o) => o.file === file && o.status !== 'passed');

// ---------------------------------------------------------------------------
// Test files the consumers run. Plain JS, globals off (Vitest's default).
// ---------------------------------------------------------------------------

/** The adoption test, identical in every A1 arm, so only the config differs. */
const ADOPTION = `import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';
it('a matcher on getCommandBus() sees the dispatch', () => {
  const bus = getCommandBus();
  bus.register('cartAdd', () => 1);
  bus.dispatch('cartAdd', null, { qty: 1 });
  expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
});
`;

const PURE = `import { expect, it } from 'vitest';
import { getCommandBus, inspectBus } from 'vapor-chamber';
import { tap } from 'vapor-chamber/vitest/pure';
it('importing /pure registers no matcher and no hook', () => {
  expect(typeof tap).toBe('function');
  // Vitest's expect() is a Chai proxy: an unregistered matcher throws on access.
  expect(() => expect(0).toHaveBeenDispatched('a')).toThrow(/Invalid Chai property: toHaveBeenDispatched/);
  expect(inspectBus(getCommandBus()).afterHookCount).toBe(0);
});
`;

const USER_SETUP = `import { expect } from 'vitest';
let registered = true;
try { expect(0).toHaveBeenDispatched; } catch { registered = false; }
globalThis.__userSetupSawMatchers = registered;
`;

const ORDER = `import { expect, it } from 'vitest';
it('the user setup file ran, after ours', () => {
  expect(globalThis.__userSetupSawMatchers).toBe(true);
  expect(typeof document).toBe('undefined');
});
`;

const EXCLUDED = `import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';
it('an excluded file gets no tapped shared bus', () => {
  let code;
  try { expect(getCommandBus()).toHaveBeenDispatched('a'); } catch (e) { code = e.code; }
  expect(code).toBe('VC_TEST_UNTAPPED');
});
`;

const ISLAND = `import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';
import aliased from '@aliased';
it('runs in the island project, with the user setup file and alias', () => {
  expect(typeof document).toBe('object');
  expect(globalThis.__userSetupSawMatchers).toBe(true);
  expect(aliased).toBe('from-the-alias');
  const bus = getCommandBus();
  bus.register('open', () => 1);
  bus.dispatch('open', null);
  expect(bus).toHaveBeenDispatched('open');
});
`;

const IDENTITY = `import { expect, it } from 'vitest';
import * as vc from 'vapor-chamber';
it('the bus getCommandBus() returns here is the one the setup file tapped', () => {
  const bus = vc.getCommandBus();
  bus.register('ping', () => 'pong');
  expect(bus.dispatch('ping', null)).toSucceedWith('pong');
  expect(bus).toHaveBeenDispatched('ping');
});
`;

const DUPLICATE = `import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';
import { getCommandBus as nestedCommandBus } from 'some-lib';
it('a bus from a second installed copy is named as a duplicate', () => {
  const bus = nestedCommandBus();
  bus.register('a', () => 1);
  bus.dispatch('a', null);
  let error;
  try { expect(bus).toHaveBeenDispatched('a'); } catch (e) { error = e; }
  expect(error?.code).toBe('VC_TEST_DUPLICATE_INSTANCE');
  expect(error?.fix).toContain('npm ls vapor-chamber');
});
it('control: the copy the setup file loaded is tapped', () => {
  const bus = getCommandBus();
  bus.register('a', () => 1);
  bus.dispatch('a', null);
  expect(bus).toHaveBeenDispatched('a');
});
`;

/** The fixtures, from `it` imported off the entry, beside the test's own import of the library. */
const FIXTURE = `import { expect, it } from 'vapor-chamber/vitest';
import * as vc from 'vapor-chamber';
it('bus and asyncBus come from the module instance this file imports', ({ bus, asyncBus }) => {
  // inspectBus reads its own instance's symbol: a bus from another copy reports 0 hooks.
  expect(vc.inspectBus(bus).afterHookCount).toBe(1);
  expect(vc.inspectBus(asyncBus).afterHookCount).toBe(1);
  expect(bus).not.toBe(vc.getCommandBus());
  bus.register('ping', () => 'pong');
  expect(bus.dispatch('ping', null)).toSucceedWith('pong');
  expect(bus).toHaveBeenDispatched('ping');
});
const shopTest = it.extend('shop', ({ bus }) => {
  bus.register('cartAdd', () => 1);
  return bus;
});
shopTest('a snippet built on bus with .extend', ({ shop }) => {
  expect(shop.dispatch('cartAdd', null)).toSucceedWith(1);
  expect(shop).toHaveBeenDispatched('cartAdd');
});
`;

/** The control for FIXTURE's identity check: a second installed copy's inspectBus does not see the tap. */
const FIXTURE_DUPLICATE = `import { expect, it } from 'vapor-chamber/vitest';
import { inspectBus } from 'vapor-chamber';
import { inspectBus as nestedInspectBus } from 'some-lib';
it('a second installed copy reads no hook on the fixture bus', ({ bus }) => {
  expect(nestedInspectBus(bus).afterHookCount).toBe(0);
  expect(inspectBus(bus).afterHookCount).toBe(1);
});
`;

/** Fails on purpose, on an assertion that is not ours, after a dispatch. */
const EXPLAIN = `import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';
it('fails on an unrelated toBe', () => {
  getCommandBus().dispatch('cartAdd', { id: 1 }, { qty: 2 });
  expect(1).toBe(2);
});
`;

/** One cheap benchmark: the file is the unit under test, not the number. */
const BENCH = `import { it } from 'vitest';
it('noop', async ({ bench }) => {
  await bench('noop', () => {}).run({ time: 1, iterations: 3 });
});
`;

// docs/integrations/vitest.md: every fenced block carries a tag after its
// language, and each tag says how this file checks it.
const DOC = readFileSync(join(REPO, 'docs/integrations/vitest.md'), 'utf8');
const docBlocks = [...DOC.matchAll(/^```(\S*)(?: (\S+))?\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1], tag: m[2] ?? '', code: m[3] }));
const docBlock = (tag: string) => docBlocks.filter((b) => b.tag === tag);
const docTests = Object.fromEntries(docBlock('test').map((b, i) => [`tests/doc-sample-${i + 1}.test.ts`, b.code]));

const config = (body: string, imports = '') => `import { defineConfig } from 'vitest/config';\n${imports}export default defineConfig(${body});\n`;

const SETUP_LINE = ["setupFiles: ['vapor-chamber/vitest']"];

// ---------------------------------------------------------------------------
// Runs, all started together
// ---------------------------------------------------------------------------

let setupPath: Promise<Outcome[]>;
let noIntegration: Promise<Outcome[]>;
let pluginPath: Promise<Outcome[]>;
let matrix: Promise<Outcome[]>;
let duplicate: Promise<Outcome[]>;
let benchRuns: Promise<{ file: string; project: string }[]>;
let mcpStdio: Promise<Awaited<ReturnType<typeof mcpOverStdio>>>;
let docSetup: Promise<Outcome[]>;
let docPlugin: Promise<Outcome[]>;
type Streams = Awaited<ReturnType<typeof runWithReporter>>;
let brand: Promise<{ root: string; dot: Streams; json: Streams; list: { stdout: string; stderr: string }; setupOnly: Streams }>;
let typed: Promise<{ status: number; output: string }>;
let pureOnly: Promise<{ status: number; output: string }>;
let withoutVitest: Promise<{ status: number; output: string }>;
let hazardControl: Promise<{ status: number; output: string }>;

beforeAll(() => {
  if (!haveDist) return;
  // Every promise gets a handler now, so a rejection surfaces in its own test
  // rather than as an unhandled rejection while the others still run.
  const settle = <T>(p: Promise<T>) => {
    p.catch(() => {});
    return p;
  };

  setupPath = settle(runVitest(consumer({
    'vitest.config.js': config(`{ test: { ${SETUP_LINE} } }`),
    'tests/adoption.test.js': ADOPTION,
    'tests/explain.test.js': EXPLAIN,
  })));

  // A1's control for BOTH paths: removing the setupFiles line and removing the
  // plugin leave the same config. A12 rides along: it needs no integration.
  noIntegration = settle(runVitest(consumer({
    'vitest.config.js': config('{ test: {} }'),
    'tests/adoption.test.js': ADOPTION,
    'tests/pure.test.js': PURE,
    'tests/explain.test.js': EXPLAIN,
    // No setup file: importing `it` from the entry is enough on its own.
    'tests/fixture.test.js': FIXTURE,
  })));

  pluginPath = settle(runVitest(consumer({
    'vitest.config.js': config(
      `{
  resolve: { alias: { '@aliased': new URL('./aliased.js', import.meta.url).pathname } },
  plugins: [vaporChamberTest({ sharedBus: { exclude: ['tests/excluded.test.js'] } })],
  // An explicit include, as most suites have: Vitest 5 extends it into the
  // island project unless the plugin replaces it there.
  test: { setupFiles: './user-setup.js', include: ['tests/**/*.test.js'] },
}`,
      "import { vaporChamberTest } from 'vapor-chamber/vite';\n",
    ),
    'aliased.js': "export default 'from-the-alias';\n",
    'user-setup.js': USER_SETUP,
    'tests/adoption.test.js': ADOPTION,
    'tests/order.test.js': ORDER,
    'tests/excluded.test.js': EXCLUDED,
    'tests/cart.island.test.js': ISLAND,
    'tests/islands/panel.test.js': ISLAND,
  }, { links: ['vitest', 'happy-dom'] })));

  const inline = "server: { deps: { inline: ['vapor-chamber'] } }";
  matrix = settle(runVitest(consumer({
    'vitest.config.js': config(`{ test: { projects: [
  { test: { name: 'node', ${SETUP_LINE} } },
  { test: { name: 'happy-dom', environment: 'happy-dom', ${SETUP_LINE} } },
  { test: { name: 'inline', ${inline}, ${SETUP_LINE} } },
  { test: { name: 'vmThreads', pool: 'vmThreads', ${SETUP_LINE} } },
  { test: { name: 'happy-dom-inline', environment: 'happy-dom', ${inline}, ${SETUP_LINE} } },
] } }`),
    'tests/identity.test.js': IDENTITY,
    'tests/fixture.test.js': FIXTURE,
  }, { links: ['vitest', 'happy-dom'] })));

  // The island project inherits the declaring config, benchmark.include
  // included: without the plugin replacing it there, every bench file ran once
  // per project (measured on this repository: tests/perf.bench.ts twice, the CI
  // bench job 89s -> 179s).
  benchRuns = settle(runBench(consumer({
    'vitest.config.js': config(`{ plugins: [vaporChamberTest()] }`, "import { vaporChamberTest } from 'vapor-chamber/vite';\n"),
    'tests/speed.bench.js': BENCH,
  }, { links: ['vitest', 'happy-dom'] })));

  duplicate = settle(runVitest(consumer({
    'vitest.config.js': config(`{ test: { ${SETUP_LINE} } }`),
    'node_modules/some-lib/package.json': '{"name":"some-lib","type":"module","exports":"./index.js"}\n',
    'node_modules/some-lib/index.js': "export { getCommandBus, inspectBus } from 'vapor-chamber';\n",
    'tests/duplicate.test.js': DUPLICATE,
    'tests/fixture-duplicate.test.js': FIXTURE_DUPLICATE,
  }, { copies: ['node_modules/some-lib/node_modules/vapor-chamber'] })));

  // The vc-vitest-plugin line: the plugin with a terminal reporter, the same
  // project with the JSON report on stdout, and the setup-file line alone.
  const branded = consumer({
    'vitest.config.js': config('{ plugins: [vaporChamberTest({ islands: false })] }', "import { vaporChamberTest } from 'vapor-chamber/vite';\n"),
    'tests/adoption.test.js': ADOPTION,
  });
  const setupOnly = consumer({ 'vitest.config.js': config(`{ test: { ${SETUP_LINE} } }`), 'tests/adoption.test.js': ADOPTION });
  brand = settle((async () => ({
    root: branded,
    dot: await runWithReporter(branded, 'dot'),
    json: await runWithReporter(branded, 'json'),
    list: await exec(branded, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'list', '--json']),
    setupOnly: await runWithReporter(setupOnly, 'dot'),
  }))());

  // The docs page's samples, under each of its two documented configs.
  const docProject = (configTag: string) => consumer({
    'vitest.config.ts': docBlock(configTag)[0]?.code ?? '',
    ...docTests,
    'tests/doc-sample-fails.test.ts': docBlock('fails')[0]?.code ?? '',
  }, { links: ['vitest', 'happy-dom'] });
  // One after the other: started together with every run above, the extra
  // Vitest process pushed this suite's router-stamp-ab shared-bus hook past its
  // 10 s timeout (1 of 3 full runs).
  const docs = settle((async () => ({ setup: await runVitest(docProject('config:setup')), plugin: await runVitest(docProject('config:plugin')) }))());
  docSetup = docs.then((d) => d.setup);
  docPlugin = docs.then((d) => d.plugin);

  // vc-vitest-mcp over stdio, in a project whose own config prints (the
  // default reporter), whose test logs, and whose failing test dispatched.
  const mcpProject = consumer({
    'vitest.config.js': config(`{ test: { ${SETUP_LINE}, reporters: ['default'] } }`),
    'src/cart.js': 'export function add(qty) {\n  return qty > 0 ? qty + 1 : 0;\n}\n',
    'tests/cart.test.js': "import { expect, it } from 'vitest';\nimport { add } from '../src/cart.js';\nit('adds one', () => { console.log('a log line from a test'); expect(add(1)).toBe(2); });\n",
    'tests/checkout.test.js': EXPLAIN,
  }, { links: ['vitest', '@vitest/coverage-v8'] });
  const call = (id: number, name: string, target?: object) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: target === undefined ? {} : { target } } });
  mcpStdio = settle(mcpOverStdio(mcpProject, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    call(3, 'runTests', {}),
    call(4, 'getTestResults'),
    call(5, 'getCoverageGaps', {}),
    call(6, 'runTests', { files: ['--config=/tmp/elsewhere.js'] }),
  ]));

  typed = settle(typecheck(consumer({}), 'typed.ts', ['vapor-chamber/vitest']));
  pureOnly = settle(typecheck(consumer({}), 'pure-only.ts', []));
  withoutVitest = settle(typecheck(consumer({}, { links: [] }), 'no-vitest.ts', []));

  // The hazard A.14 measured, injected: a root declaration file that imports vitest.
  const hazard = consumer({}, { links: [] });
  const rootTypes = join(hazard, 'node_modules/vapor-chamber/dist/index.d.ts');
  writeFileSync(rootTypes, `import 'vitest';\n${readFileSync(rootTypes, 'utf8')}`);
  hazardControl = settle(typecheck(hazard, 'no-vitest.ts', []));
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe.skipIf(!haveDist)('A1 adoption', () => {
  it('setupFiles: [vapor-chamber/vitest], globals false: a matcher on getCommandBus() passes', async () => {
    const outcomes = await setupPath;
    expect(failedIn(outcomes, 'tests/adoption.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/adoption.test.js')).toHaveLength(1);
  });

  it('control: the same test with that line removed fails', async () => {
    const [outcome] = failedIn(await noIntegration, 'tests/adoption.test.js');
    expect(outcome?.failure).toMatch(/toHaveBeenDispatchedWith/);
  });

  it('plugins: [vaporChamberTest()], globals false: the same test passes', async () => {
    const outcomes = await pluginPath;
    expect(failedIn(outcomes, 'tests/adoption.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/adoption.test.js')).toHaveLength(1);
  });

  it('control: the same test with the plugin removed fails (the same config as the line removed)', async () => {
    expect(failedIn(await noIntegration, 'tests/adoption.test.js')).toHaveLength(1);
  });

  it('sharedBus.exclude reaches the setup file: the excluded file gets no tapped bus', async () => {
    const outcomes = await pluginPath;
    expect(failedIn(outcomes, 'tests/excluded.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/excluded.test.js')).toHaveLength(1);
  });
});

describe.skipIf(!haveDist)('C3 a failed test shows what it dispatched', () => {
  it('a test failing on an unrelated toBe lists its dispatches, as Vitest lists spy calls', async () => {
    const [outcome] = failedIn(await setupPath, 'tests/explain.test.js');
    expect(outcome?.failure).toContain('expected 1 to be 2');
    expect(outcome?.failure).toContain('Dispatched during this test:');
    expect(outcome?.failure).toContain('1st dispatch on getCommandBus():');
    expect(outcome?.failure).toContain('Number of dispatches: 1');
  });

  it('control: without the setup file the same failure lists nothing', async () => {
    const [outcome] = failedIn(await noIntegration, 'tests/explain.test.js');
    expect(outcome?.failure).toContain('expected 1 to be 2');
    expect(outcome?.failure).not.toContain('Dispatched during this test:');
  });
});

describe.skipIf(!haveDist)('the vc-vitest-plugin line, in a real run', () => {
  const LINE = ' \\\\//  powered by vc-vitest-plugin';

  it('the plugin with a terminal reporter: the line once, on stderr, before the run', async () => {
    const { dot } = await brand;
    expect(dot.stderr.split('\n').filter((l) => l.includes('vc-vitest-plugin'))).toEqual([LINE]);
    expect(dot.stdout).not.toContain('vc-vitest-plugin');
    // The run itself went on as usual.
    expect(dot.stdout).toMatch(/Tests\s+1 passed/);
  });

  it('control: only a machine reporter (json) prints no line, and its report is intact', async () => {
    const { json, root } = await brand;
    expect(`${json.stdout}${json.stderr}`).not.toContain('vc-vitest-plugin');
    // Vitest 5 writes the json report to .vitest/json/output.json when no outputFile is set.
    expect(JSON.parse(readFileSync(join(root, '.vitest/json/output.json'), 'utf8')).numPassedTests).toBe(1);
  });

  it('vitest list --json: stdout stays parseable JSON, the line goes to stderr', async () => {
    const { list } = await brand;
    expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ name: 'a matcher on getCommandBus() sees the dispatch' })]);
    expect(list.stderr).toContain('vc-vitest-plugin');
  });

  it('control: the setup-file line alone prints no line (the plugin is what brands a run)', async () => {
    const { setupOnly } = await brand;
    expect(`${setupOnly.stdout}${setupOnly.stderr}`).not.toContain('vc-vitest-plugin');
    expect(setupOnly.stdout).toMatch(/Tests\s+1 passed/);
  });
});

describe.skipIf(!haveDist)('vc-vitest-mcp, started as an MCP client starts it', () => {
  const text = (reply: any) => reply.result.content[0].text as string;

  it('every stdout line is a JSON-RPC message, although the project config prints and a test logs', async () => {
    const { stdout, replies } = await mcpStdio;
    expect(replies.size).toBe(6);
    for (const line of stdout) expect(JSON.parse(line).jsonrpc, line.slice(0, 80)).toBe('2.0');
  });

  it('initialize names the server, and tools/list lists the three tools', async () => {
    const { replies } = await mcpStdio;
    expect(replies.get(1).result.serverInfo.name).toBe('vc-vitest-mcp');
    expect(replies.get(2).result.tools.map((t: { name: string }) => t.name)).toEqual(['runTests', 'getTestResults', 'getCoverageGaps']);
  });

  it('runTests reports the failure with the dispatches the failed test made, and getTestResults returns it again', async () => {
    const { replies } = await mcpStdio;
    const run = JSON.parse(text(replies.get(3)));
    expect(run).toMatchObject({ files: 2, passed: 1, failed: 1, skipped: 0, errors: [] });
    expect(run.failures[0].file).toBe('tests/checkout.test.js');
    expect(run.failures[0].message).toContain('1st dispatch on getCommandBus():');
    expect(JSON.parse(text(replies.get(4)))).toMatchObject({ failed: 1, stale: false });
  });

  it('getCoverageGaps lists the branch arm no test took', async () => {
    const { replies } = await mcpStdio;
    expect(JSON.parse(text(replies.get(5)))).toEqual({
      files: [{ file: 'src/cart.js', uncoveredLines: '', uncoveredFunctions: [], uncoveredBranches: [{ line: 2, type: 'cond-expr', uncoveredArms: [1], arms: 2 }] }],
    });
  });

  it('a filter that reads as a command-line option is refused with its code', async () => {
    const { replies } = await mcpStdio;
    expect(replies.get(6).result.isError).toBe(true);
    expect(text(replies.get(6))).toContain('VC_TEST_MCP_INVALID_FILES');
  });
});

describe('docs/integrations/vitest.md: every block is checked', () => {
  it('each fenced block carries a known tag, and each single-use tag appears once', () => {
    const known = ['config:setup', 'config:plugin', 'test', 'fails', 'failure', 'brand', 'tsconfig', 'mcp-client'];
    expect(docBlocks.filter((b) => !known.includes(b.tag)).map((b) => `${b.lang} ${b.tag}`)).toEqual([]);
    for (const tag of known.filter((t) => t !== 'test')) expect(docBlock(tag), tag).toHaveLength(1);
    expect(docBlock('test').length).toBeGreaterThan(0);
  });

  it('the tsconfig block names the types entry the A4 fixtures compile with', () => {
    expect(JSON.parse(docBlock('tsconfig')[0].code).compilerOptions.types).toEqual(['vapor-chamber/vitest']);
  });

  it('the mcp-client block starts the command package.json ships, with no argument an agent could change', () => {
    const entry = JSON.parse(docBlock('mcp-client')[0].code).mcpServers.vitest;
    expect(entry).toEqual({ command: 'npx', args: ['vc-vitest-mcp'] });
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    expect(existsSync(join(REPO, pkg.bin[entry.args[0]]))).toBe(true);
  });
});

describe.skipIf(!haveDist)('docs/integrations/vitest.md: the samples run', () => {
  for (const [name, run] of [['config:setup', () => docSetup], ['config:plugin', () => docPlugin]] as const) {
    it(`under the ${name} block as vitest.config.ts, every test block passes`, async () => {
      const outcomes = await run();
      for (const file of Object.keys(docTests)) {
        expect(failedIn(outcomes, file), file).toEqual([]);
        expect(passed(outcomes, file).length, file).toBeGreaterThan(0);
      }
    });

    it(`under the ${name} block, the fails block fails with the failure block's text`, async () => {
      const [outcome] = failedIn(await run(), 'tests/doc-sample-fails.test.ts');
      for (const line of docBlock('failure')[0].code.split('\n').map((l) => l.trim()).filter(Boolean)) {
        expect(outcome?.failure, line).toContain(line);
      }
    });
  }

  it('the brand block is the line a real run prints', async () => {
    const { dot } = await brand;
    expect(dot.stderr.split('\n')).toContain(docBlock('brand')[0].code.trimEnd());
  });
});

describe.skipIf(!haveDist)('A4 types, without skipLibCheck', () => {
  it('typed bus: valid matcher calls compile; a typo, a wrong payload and a wrong value do not', async () => {
    // Exit 0 is only possible if every expected-error directive met its error.
    const { status, output } = await typed;
    expect(output.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('importing only /pure leaves toHaveBeenDispatched a type error, and its stub declarations compile without a disposable lib', async () => {
    const { status, output } = await pureOnly;
    expect(output.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('a consumer without vitest that imports the root and vapor-chamber/vite typechecks clean', async () => {
    const { status, output } = await withoutVitest;
    expect(output.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('control: the same consumer fails once a root declaration file imports vitest (TS2882, A.14)', async () => {
    const { status, output } = await hazardControl;
    expect(status).not.toBe(0);
    expect(output).toContain('TS2882');
  });
});

/** Static `import ... from "x"` and dynamic `import("x")` specifiers of an emitted file. */
function emittedImports(file: string) {
  const code = readFileSync(dist(file), 'utf8');
  return {
    statics: [...code.matchAll(/^import\s[^;]*?from\s*"([^"]+)";?$|^import\s*"([^"]+)";?$/gm)].map((m) => m[1] ?? m[2]),
    dynamics: [...code.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]),
  };
}

/**
 * Module names a declaration file declares or augments with `declare module
 * 'x'`. From the AST: preProcessFile's `ambientExternalModules` lists only a
 * script file's declarations, never an augmentation inside a module.
 */
function augmentedModules(text: string): string[] {
  const source = ts.createSourceFile('x.d.ts', text, ts.ScriptTarget.ES2022, true);
  return source.statements.filter(ts.isModuleDeclaration).map((m) => m.name.text);
}

describe.skipIf(!haveDist)('A5 packaging', () => {
  it('dist/vitest.js keeps import("vapor-chamber") external, never bundled', () => {
    // beforeEach's, then the bus and asyncBus fixtures'.
    expect(emittedImports('vitest.js').dynamics).toEqual(['vapor-chamber', 'vapor-chamber', 'vapor-chamber']);
    // Bundled, the library would sit in the file or in a chunk it imports.
    expect(readFileSync(dist('vitest.js'), 'utf8')).not.toContain('function createCommandBus');
  });

  it('dist/vitest.js imports only vitest and ./vitest-pure.js statically; the pure entry imports nothing', () => {
    expect(emittedImports('vitest.js').statics.sort()).toEqual(['./vitest-pure.js', 'vitest']);
    expect(emittedImports('vitest-pure.js')).toEqual({ statics: [], dynamics: [] });
  });

  it('dist/index.d.ts does not reach the vitest augmentation', () => {
    // Every declaration file the root's types reach, by relative import.
    const seen = new Set<string>();
    const queue = ['index.d.ts'];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = readFileSync(dist(file), 'utf8');
      for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
        if (fileName.startsWith('.')) {
          const base = join(dirname(file), fileName).replace(/\.js$/, '');
          queue.push(existsSync(dist(`${base}.d.ts`)) ? `${base}.d.ts` : join(base, 'index.d.ts'));
        }
        // A bare 'vitest' anywhere in the root's types is the TS2882 hazard (A.14).
        expect(fileName, `${file} imports ${fileName}`).not.toMatch(/^vitest/);
      }
      expect(augmentedModules(text), file).not.toContain('vitest');
    }
    expect(seen.has('command-bus.d.ts')).toBe(true);
    expect(seen.has('vitest.d.ts')).toBe(false);
    // Control: the augmentation is in the entry that owns it.
    const declared = (file: string) => {
      const info = ts.preProcessFile(readFileSync(dist(file), 'utf8'), true, true);
      return { imports: info.importedFiles.map((f) => f.fileName), ambient: augmentedModules(readFileSync(dist(file), 'utf8')) };
    };
    expect(declared('vitest.d.ts').ambient).toEqual(['vitest']);
    expect(declared('vitest-pure.d.ts')).toEqual({ imports: ['./command-bus', './mcp'], ambient: [] });
  });
});

describe.skipIf(!haveDist)('A10 identity', () => {
  it('one module instance in node, happy-dom, server.deps.inline, vmThreads, happy-dom plus inline', async () => {
    const outcomes = await matrix;
    expect(failedIn(outcomes, 'tests/identity.test.js')).toEqual([]);
    // The one file, once per project.
    expect(passed(outcomes, 'tests/identity.test.js')).toHaveLength(5);
  });

  it('fixtures: bus and asyncBus share the test file\'s module instance in all five configurations, and without a setup file', async () => {
    const outcomes = await matrix;
    expect(failedIn(outcomes, 'tests/fixture.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/fixture.test.js')).toHaveLength(10);
    const alone = await noIntegration;
    expect(failedIn(alone, 'tests/fixture.test.js')).toEqual([]);
    expect(passed(alone, 'tests/fixture.test.js')).toHaveLength(2);
  });

  it('fixtures, control: a second installed copy does not recognise the fixture bus', async () => {
    const outcomes = await duplicate;
    expect(failedIn(outcomes, 'tests/fixture-duplicate.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/fixture-duplicate.test.js')).toHaveLength(1);
  });

  it('a duplicated install produces VC_TEST_DUPLICATE_INSTANCE', async () => {
    const outcomes = await duplicate;
    expect(failedIn(outcomes, 'tests/duplicate.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/duplicate.test.js').map((o) => o.title)).toEqual([
      'a bus from a second installed copy is named as a duplicate',
      'control: the copy the setup file loaded is tapped',
    ]);
  });
});

describe.skipIf(!haveDist)('A11 setup-file merge, in a real Vitest', () => {
  it('a string setupFiles runs after ours, and both run', async () => {
    const outcomes = await pluginPath;
    expect(failedIn(outcomes, 'tests/order.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/order.test.js')).toHaveLength(1);
  });
});

describe.skipIf(!haveDist)('A12 pure is pure (runtime)', () => {
  it('importing /pure alone registers no matcher and no hook', async () => {
    const outcomes = await noIntegration;
    expect(failedIn(outcomes, 'tests/pure.test.js')).toEqual([]);
    expect(passed(outcomes, 'tests/pure.test.js')).toHaveLength(1);
  });
});

describe.skipIf(!haveDist)('A13 island project', () => {
  it('only *.island.test.* and tests/islands/** run in the island project', async () => {
    const outcomes = await pluginPath;
    // Each file exactly once: a file in both projects would appear twice, and
    // an island file in the root project would find no document.
    expect(outcomes.map((o) => o.file).sort()).toEqual([
      'tests/adoption.test.js',
      'tests/cart.island.test.js',
      'tests/excluded.test.js',
      'tests/islands/panel.test.js',
      'tests/order.test.js',
    ]);
    expect(outcomes.filter((o) => o.status !== 'passed')).toEqual([]);
  });

  it('a benchmark file runs once, in the root project, never again in the island project', async () => {
    const runs = await benchRuns;
    expect(runs.filter((r) => r.file === 'tests/speed.bench.js')).toHaveLength(1);
    expect(runs.map((r) => r.project)).not.toContain('vapor-chamber-islands');
  });

  it('the island project picks up the user setup files and aliases', async () => {
    const outcomes = await pluginPath;
    for (const file of ['tests/cart.island.test.js', 'tests/islands/panel.test.js']) {
      expect(passed(outcomes, file), file).toHaveLength(1);
    }
  });
});
