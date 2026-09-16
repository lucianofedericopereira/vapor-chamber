// vapor-chamber/vitest/mcp: the three tools, on a real Vitest and a real project. More at the end of the file.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpHandler } from '../src/mcp';
import { coverageGaps, createVitestMcp, serveVitestMcp, VITEST_MCP_ACTIONS, type VitestMcpServer } from '../src/vitest-mcp';
import { mcpClient } from '../src/vitest-pure';

const CART = 'export function add(qty) {\n  if (qty < 0) {\n    throw new Error("negative");\n  }\n  return qty + 1;\n}\nexport function unused(x) {\n  return x ? 1 : 2;\n}\n';
const CART_TEST = "import { expect, it } from 'vitest';\nimport { add } from '../src/cart.js';\nit('adds one', () => expect(add(1)).toBe(2));\n";
const FAIL_TEST = "import { expect, it } from 'vitest';\nit('is wrong on purpose', () => expect(1).toBe(2));\nit.skip('is not written yet', () => {});\n";

const roots: string[] = [];

/** A project in the OS temp dir, vitest and the coverage provider linked from this repository. */
function project(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vc-vitest-mcp-')));
  roots.push(root);
  const all = { 'package.json': '{"name":"fixture","private":true,"type":"module"}\n', ...files };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  for (const dep of ['vitest', '@vitest/coverage-v8']) {
    mkdirSync(dirname(join(root, 'node_modules', dep)), { recursive: true });
    symlinkSync(join(process.cwd(), 'node_modules', dep), join(root, 'node_modules', dep));
  }
  return root;
}

let root: string;
let server: VitestMcpServer;
let mcp: ReturnType<typeof mcpClient>;
const json = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

beforeAll(async () => {
  root = project({ 'src/cart.js': CART, 'tests/cart.test.js': CART_TEST, 'tests/fail.test.js': FAIL_TEST });
  server = await createVitestMcp({ root });
  mcp = mcpClient(createMcpHandler(server.bus, { actions: VITEST_MCP_ACTIONS }));
});

afterAll(async () => {
  await server?.close();
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('the tools an agent sees', () => {
  it('lists the three tools, by their camelCase action names', async () => {
    expect(await mcp.toolNames()).toEqual(['runTests', 'getTestResults', 'getCoverageGaps']);
  });

  it('getTestResults before any run is a coded tool error', async () => {
    const fresh = await createVitestMcp({ root });
    try {
      const client = mcpClient(createMcpHandler(fresh.bus, { actions: VITEST_MCP_ACTIONS }));
      expect(await client.call('getTestResults')).toBeToolError(/VC_TEST_MCP_NO_RUN/);
    } finally {
      await fresh.close();
    }
  });
});

describe('runTests and getTestResults, on a warm Vitest', () => {
  it('runs every test file and reports counts and each failure with its message', async () => {
    const run = json(await mcp.call('runTests', { target: {} }));
    expect(run).toMatchObject({ files: 2, passed: 1, failed: 1, skipped: 1, errors: [] });
    expect(run.failures).toEqual([{ file: 'tests/fail.test.js', test: 'is wrong on purpose', message: 'expected 1 to be 2 // Object.is equality' }]);
  });

  it('runs only the files the filters select', async () => {
    expect(json(await mcp.call('runTests', { target: { files: ['tests/cart.test.js'] } }))).toMatchObject({ files: 1, passed: 1, failed: 0 });
  });

  it('a re-run sees an edited test file and an edited source file, and getTestResults says when it is stale', async () => {
    writeFileSync(join(root, 'tests/cart.test.js'), CART_TEST.replace('toBe(2)', 'toBe(3)'));
    await sleep(300);
    expect(json(await mcp.call('runTests', { target: { files: ['tests/cart.test.js'] } }))).toMatchObject({ passed: 0, failed: 1 });
    expect(json(await mcp.call('getTestResults'))).toMatchObject({ failed: 1, stale: false, changedSince: [] });

    writeFileSync(join(root, 'src/cart.js'), CART.replace('return qty + 1;', 'return qty + 2;'));
    await sleep(300);
    expect(json(await mcp.call('getTestResults'))).toMatchObject({ stale: true, changedSince: ['src/cart.js'] });
    expect(json(await mcp.call('runTests', { target: { files: ['tests/cart.test.js'] } }))).toMatchObject({ passed: 1, failed: 0 });

    writeFileSync(join(root, 'tests/cart.test.js'), CART_TEST);
    writeFileSync(join(root, 'src/cart.js'), CART);
    await sleep(300);
  });

  it('parallel calls run one at a time and each gets its own result', async () => {
    const [all, one] = await Promise.all([
      mcp.call('runTests', { target: {} }),
      mcp.call('runTests', { target: { files: ['tests/fail.test.js'] } }),
    ]);
    expect(json(all)).toMatchObject({ files: 2, passed: 1, failed: 1 });
    expect(json(one)).toMatchObject({ files: 1, passed: 0, failed: 1 });
  });

  it('getTestResults sent right after a runTests waits for that run', async () => {
    const [run, results] = await Promise.all([mcp.call('runTests', { target: { files: ['tests/cart.test.js'] } }), mcp.call('getTestResults')]);
    expect(json(results)).toMatchObject({ ...json(run), stale: false });
  });

  it('a rejection nobody handled is an error of the run, with its message', async () => {
    writeFileSync(join(root, 'tests/late.test.js'), "import { it } from 'vitest';\nit('leaves a rejection behind', () => { Promise.reject(new Error('rejected with no handler')); });\n");
    await sleep(300);
    try {
      const run = json(await mcp.call('runTests', { target: { files: ['tests/late.test.js'] } }));
      expect(run.errors).toEqual(['rejected with no handler']);
    } finally {
      rmSync(join(root, 'tests/late.test.js'));
      await sleep(300);
    }
  });

  it('a file that fails to load is an error of the run, not a crash', async () => {
    writeFileSync(join(root, 'tests/broken.test.js'), "import { nope } from './missing.js';\n");
    await sleep(300);
    try {
      const run = json(await mcp.call('runTests', { target: { files: ['tests/broken.test.js'] } }));
      expect(run.files).toBe(1);
      expect(run.errors).toEqual([expect.stringContaining('tests/broken.test.js:')]);
    } finally {
      rmSync(join(root, 'tests/broken.test.js'));
      await sleep(300);
    }
  });
});

describe('what an agent cannot pass', () => {
  it('target.files that is not a short list of filters, or a filter that reads as an option, is refused before anything runs', async () => {
    for (const files of ['tests', [1], [''], ['--config=/tmp/elsewhere.js'], ['-t'], Array.from({ length: 101 }, (_, i) => `f${i}`), ['x'.repeat(1001)]]) {
      for (const tool of ['runTests', 'getCoverageGaps']) {
        expect(await mcp.call(tool, { target: { files } }), `${tool} ${JSON.stringify(files).slice(0, 40)}`).toBeToolError(/VC_TEST_MCP_INVALID_FILES/);
      }
    }
  });
});

describe('getCoverageGaps', () => {
  it('lists uncovered lines, functions and branch arms per source file, from a real coverage run', async () => {
    const { files } = json(await mcp.call('getCoverageGaps', { target: {} }));
    expect(files).toEqual([
      {
        file: 'src/cart.js',
        uncoveredLines: '3, 8',
        uncoveredFunctions: ['unused (line 7)'],
        uncoveredBranches: [
          { line: 2, type: 'if', uncoveredArms: [0], arms: 2 },
          { line: 8, type: 'cond-expr', uncoveredArms: [0, 1], arms: 2 },
        ],
      },
    ]);
  });

  it('filters select the tests that produce the coverage, and a source file no selected test imports is not listed', async () => {
    // v8 coverage reports the files a run loaded; a config's coverage.include lists the others.
    expect(json(await mcp.call('getCoverageGaps', { target: { files: ['tests/fail.test.js'] } }))).toEqual({ files: [] });
  });

  it('a run that writes no report is a coded tool error carrying the error lines of the run', async () => {
    const noProvider = project({ 'vitest.config.js': "export default { test: { coverage: { provider: 'custom', customProviderModule: './nowhere.js' } } };\n", 'tests/a.test.js': FAIL_TEST });
    const other = await createVitestMcp({ root: noProvider, config: join(noProvider, 'vitest.config.js') });
    try {
      const client = mcpClient(createMcpHandler(other.bus, { actions: VITEST_MCP_ACTIONS }));
      const result = await client.call('getCoverageGaps');
      expect(result).toBeToolError(/VC_TEST_MCP_NO_COVERAGE/);
      expect(result.content[0].text).toContain('nowhere.js');
    } finally {
      await other.close();
    }
  });

  it('files with nothing uncovered are left out, and a statement spanning lines lists each line', () => {
    const loc = (start: number, end = start) => ({ start: { line: start }, end: { line: end } });
    expect(
      coverageGaps(
        {
          '/app/src/full.js': { s: { 0: 1 }, statementMap: { 0: loc(1) }, f: {}, fnMap: {}, b: { 0: [2, 1] }, branchMap: { 0: { type: 'if', loc: loc(1) } } },
          '/app/src/part.js': {
            s: { 0: 0, 1: 0, 2: 1 },
            statementMap: { 0: loc(4, 6), 1: loc(9), 2: loc(10) },
            f: {},
            fnMap: {},
            // A branch whose arms all ran is not a gap.
            b: { 0: [1, 1] },
            branchMap: { 0: { type: 'if', loc: loc(10) } },
          },
        },
        '/app',
      ),
    ).toEqual([{ file: 'src/part.js', uncoveredLines: '4-6, 9', uncoveredFunctions: [], uncoveredBranches: [] }]);
  });
});

describe('serveVitestMcp', () => {
  it('starts a server on stdio for the working directory, and stop() detaches it and closes Vitest', async () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const stop = await serveVitestMcp();
      await stop();
    } finally {
      process.chdir(cwd);
    }
  });
});

/**
 * `vapor-chamber/vitest/mcp`, in-repo: `createVitestMcp` on a real Vitest
 * created in this test worker, driving a project written to the OS temp dir.
 * The tools are called the way an agent calls them, through the real
 * `createMcpHandler` and `mcpClient`.
 *
 * The coverage tool runs `vitest run --coverage` in a child process, as it does
 * for a user, so its report is real too. The stdio server from a packed
 * install, started as an MCP client starts it, is tests/vitest-consumer.test.ts.
 *
 * The waits after writing a file give `fs.watch` time to report it; a warm
 * Vitest only sees an edit the server invalidated (see src/vitest-mcp.ts).
 */
