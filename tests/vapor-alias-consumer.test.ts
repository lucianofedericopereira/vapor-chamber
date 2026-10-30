/**
 * The Vapor alias rule of docs/manual/10-testing.md, its config block run as written in a packed, installed consumer project under a real Vitest.
 * Why: a bare `vue` under Vitest has no Vapor, and the library in node_modules loads its own `vue` unless it is inlined, so an app's Vapor test fails with "no router provided" for a reason that is not in the app.
 * Shows: with the block, bare `vue` carries Vapor, a deep import is the same module, the library's router injects inside a mounted Vapor component, and `vapor-chamber/vitest` still works beside it; a control for each half (no alias, no inline), and the bundler entry the rule warns against.
 * See: docs/manual/10-testing.md, vitest.vapor.config.ts, tests/vitest-consumer.test.ts
 */
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDist } from './require-dist';

const REPO = process.cwd();
requireDist(existsSync(join(REPO, 'dist/router.js')));

const CHAPTER = readFileSync(join(REPO, 'docs/manual/10-testing.md'), 'utf8');
const BLOCK = [...CHAPTER.matchAll(/^```typescript vapor-alias\n([\s\S]*?)^```$/gm)].map((m) => m[1] as string);

const SPEC = `import { expect, it } from 'vitest';
import * as Vue from 'vue';
import { createMemoryHistory, createRouter, useRouter } from 'vapor-chamber/router';
it('bare vue carries Vapor', () => {
  expect(typeof Vue.createVaporApp).toBe('function');
});
it('a deep import of the file is the same module', async () => {
  const deep = await import('vue/dist/vue.runtime-with-vapor.esm-browser.js');
  expect(deep.createVaporApp).toBe(Vue.createVaporApp);
});
it('the router injects inside a mounted Vapor component', () => {
  const router = createRouter({
    base: '/',
    history: createMemoryHistory('/'),
    routes: [{ name: 'home', path: '/', parent: null, component: 'Home' }],
    components: { Home: { name: 'Home' } },
  });
  let seen;
  const App = Vue.defineVaporComponent({ setup() { seen = useRouter(); return Vue.template('<p>ok</p>')(); } });
  const host = document.createElement('div');
  const app = Vue.createVaporApp(App);
  app.use(router);
  app.mount(host);
  expect(seen).toBe(router);
  expect(host.textContent).toBe('ok');
  app.unmount();
});
`;

const MATCHERS = `import { expect, it } from 'vitest';
import { getCommandBus } from 'vapor-chamber';
it('a matcher sees a dispatch', () => {
  const bus = getCommandBus();
  bus.register('cartAdd', () => 1);
  bus.dispatch('cartAdd', null, { qty: 1 });
  expect(bus).toHaveBeenDispatchedWith('cartAdd', { qty: 1 });
});
`;

// The child must not believe it is a worker of this run.
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VITEST|TEST$|NODE_ENV$)/.test(key)));
const roots: string[] = [];

type Outcome = { title: string; status: string; failure: string };

// The package is copied, not linked: a real path outside node_modules is treated as source, and the rule is about a package inside it.
async function run(config: string, files: Record<string, string> = { 'a.test.js': SPEC }): Promise<Outcome[]> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vc-vapor-alias-')));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"vc-consumer","private":true,"type":"module"}\n');
  const pkg = join(root, 'node_modules', 'vapor-chamber');
  mkdirSync(pkg, { recursive: true });
  cpSync(join(REPO, 'package.json'), join(pkg, 'package.json'));
  cpSync(join(REPO, 'dist'), join(pkg, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });
  for (const dep of ['vitest', 'happy-dom', 'vue']) {
    mkdirSync(dirname(join(root, 'node_modules', dep)), { recursive: true });
    symlinkSync(join(REPO, 'node_modules', dep), join(root, 'node_modules', dep));
  }
  writeFileSync(join(root, 'vitest.config.ts'), config);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const out = join(root, 'results.json');
  const output = await new Promise<string>((done) => {
    execFile(process.execPath, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', `--outputFile=${out}`], { cwd: root, env: childEnv, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout, stderr) => done(`${stdout}\n${stderr}`));
  });
  if (!existsSync(out)) throw new Error(`vitest wrote no results in ${root}:\n${output}`);
  const report = JSON.parse(readFileSync(out, 'utf8')) as {
    testResults: { message: string; assertionResults: { title: string; status: string; failureMessages: string[] }[] }[];
  };
  return report.testResults.flatMap((file) =>
    file.assertionResults.length === 0
      ? [{ title: '(file)', status: 'failed', failure: file.message }]
      : file.assertionResults.map((t) => ({ title: t.title, status: t.status, failure: t.failureMessages.join('\n') })),
  );
}

// The block with one part changed, which fails loudly if the block stops holding that part.
function without(find: string | RegExp, replacement: string): string {
  const code = BLOCK[0] as string;
  const next = code.replace(find, replacement);
  if (next === code) throw new Error(`the manual's block no longer holds ${find}`);
  return next;
}

const statusOf = (outcomes: Outcome[], title: string) => outcomes.find((o) => o.title === title)?.status;
const failureOf = (outcomes: Outcome[], title: string) => outcomes.find((o) => o.title === title)?.failure;

let asWritten: Outcome[];
let withMatchers: Outcome[];
let noAlias: Outcome[];
let noInline: Outcome[];
let bundlerEntry: Outcome[];

beforeAll(async () => {
  const code = BLOCK[0] as string;
  [asWritten, withMatchers, noAlias, noInline, bundlerEntry] = await Promise.all([
    run(code),
    run(without('environment:', "setupFiles: ['vapor-chamber/vitest'],\n    environment:"), { 'a.test.js': SPEC, 'b.test.js': MATCHERS }),
    run(without(/ *alias: .*\n/, '')),
    run(without(/ *server: .*\n/, '')),
    run(without('vue.runtime-with-vapor.esm-browser.js', 'vue.runtime.esm-bundler.js')),
  ]);
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("the manual's Vapor alias block", () => {
  it('the chapter holds the block once', () => {
    expect(BLOCK).toHaveLength(1);
  });

  it('as written: Vapor is there, one module, and the router injects in a mounted Vapor component', () => {
    expect(asWritten.map((o) => [o.title, o.status, o.failure])).toEqual([
      ['bare vue carries Vapor', 'passed', ''],
      ['a deep import of the file is the same module', 'passed', ''],
      ['the router injects inside a mounted Vapor component', 'passed', ''],
    ]);
  });

  it('beside vapor-chamber/vitest: the same tests pass and a matcher still works', () => {
    expect(withMatchers).toHaveLength(4);
    expect(withMatchers.filter((o) => o.status !== 'passed')).toEqual([]);
    expect(statusOf(withMatchers, 'a matcher sees a dispatch')).toBe('passed');
  });
});

describe('each part of the rule is needed', () => {
  it('no alias: bare vue has no Vapor', () => {
    expect(statusOf(noAlias, 'bare vue carries Vapor')).toBe('failed');
  });

  it('no inline: Vapor is there, and the library misses the app on its own vue', () => {
    expect(statusOf(noInline, 'bare vue carries Vapor')).toBe('passed');
    expect(failureOf(noInline, 'the router injects inside a mounted Vapor component')).toContain('no router provided');
  });

  // On a Vue that loads this entry under Vitest this goes red: the manual's warning can then go.
  it('the bundler entry as the target: the file throws at load', () => {
    expect(bundlerEntry).toHaveLength(1);
    expect(bundlerEntry[0]?.failure).toContain('createInternalObject is not a function');
  });
});
