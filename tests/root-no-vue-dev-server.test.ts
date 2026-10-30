/**
 * The packed package root under a real Vite dev server, in an app with no Vue installed.
 * Why: the root must work with no Vue in the tree. If the build folded chamber.ts's specifier into a literal `import("vue")` in dist/chamber.js, the dev server's pre-bundling would resolve it and answer 500 for the package: a blank page, even for an app importing only createCommandBus. The package is packed and extracted, not aliased to src or dist, because what ships is what is tested; the app sits in the OS temp directory so no node_modules above it holds a `vue`.
 * Shows: the pre-bundled dep is served with 200 with no vue installed and with vue linked in; in Node the packed root still finds the installed Vue. Vue apps wire through `vapor-chamber/vue` or `/vapor`, not the root, since the specifier is a runtime value.
 * See: log s36.F26
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireDist } from './require-dist';

const repo = resolve(__dirname, '..');
requireDist(existsSync(join(repo, 'dist', 'index.js')));

let work: string;

/** fetch(), retrying only a failure to connect (see tests/vite-hmr-pipeline.test.ts). */
async function fetchWhenReady(url: URL, attempts = 5): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

/** An app in `work/<name>` with the packed package installed, and `vue` linked in when asked. */
function app(name: string, tgz: string, withVue: boolean): string {
  const dir = join(work, name);
  const pkg = join(dir, 'node_modules', 'vapor-chamber');
  mkdirSync(pkg, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', pkg, '--strip-components=1']);
  if (withVue) symlinkSync(join(repo, 'node_modules', 'vue'), join(dir, 'node_modules', 'vue'), 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><script type="module" src="/main.js"></script></body></html>');
  writeFileSync(join(dir, 'main.js'), "import { createCommandBus } from 'vapor-chamber';\nexport const bus = createCommandBus();\n");
  return dir;
}

/** Status of the root's pre-bundled dep, as a browser requests it. */
async function depStatus(root: string): Promise<number> {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { port: 0, hmr: false, watch: null },
    optimizeDeps: { force: true },
  });
  try {
    await server.listen();
    const base = server.resolvedUrls?.local[0];
    expect(base).toBeTruthy();
    const main = await (await fetchWhenReady(new URL('/main.js', base))).text();
    const dep = main.match(/\/node_modules\/\.vite\/deps\/vapor-chamber\.js[^"']*/)?.[0];
    expect(dep).toBeTruthy();
    return (await fetchWhenReady(new URL(dep!, base))).status;
  } finally {
    await server.close();
  }
}

let noVue: string;
let withVue: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'vc-no-vue-'));
  execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: repo, stdio: 'ignore' });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  noVue = app('no-vue', join(work, tgz), false);
  withVue = app('with-vue', join(work, tgz), true);
});

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

describe('the package root under a Vite dev server', () => {
  it('an app with no vue installed gets its dep: 200', async () => {
    expect(existsSync(join(noVue, 'node_modules', 'vue'))).toBe(false);
    expect(await depStatus(noVue)).toBe(200);
  });

  it('control: the same app with vue installed gets its dep: 200', async () => {
    expect(await depStatus(withVue)).toBe(200);
  });

  it('control: in Node the packed root still finds the installed Vue', () => {
    const probe = "import { signal, waitForVueDetection } from 'vapor-chamber'; import { isRef } from 'vue';" +
      ' await waitForVueDetection(); console.log(isRef(signal(0)));';
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: withVue, encoding: 'utf8' });
    expect(out.trim()).toBe('true');
  });
});
