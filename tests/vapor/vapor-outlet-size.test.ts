// @vitest-environment happy-dom
/**
 * SIZE GUARD - what dropping `vaporInteropPlugin` is worth, re-measured every
 * run against a baseline derived by the same harness.
 *
 * THIS TEST IS SUPPOSED TO BE ABLE TO FAIL. It is not a smoke test with a
 * comfortable margin: the Vapor outlet was accepted on a measured
 * -20.13 KB brotli against a >= 20 KB bar, i.e. **0.13 KB of headroom**, and
 * the accepting decision recorded that growth in `DynamicFragment` /
 * `SlotFragment` in a later RC can flip it. So a failure here is the intended
 * signal that the margin has eroded and the subpath's justification needs
 * re-examining - not a threshold to nudge. Record the new number and take it
 * to the decision owner, along with the two recovery levers that were measured
 * and DECLINED at acceptance, so the re-decision starts from the known
 * options: swapping routerError for a plain Error recovers ~77 B but breaks
 * the coded-error taxonomy consumers switch on, and dropping the DEV gate
 * recovers ~35 B but ships both diagnostic strings to every production
 * consumer to win bytes in this synthetic row. Either alone more than restores
 * the margin; both were declined for cause, and firing this guard does not
 * change the cause - it changes who decides.
 *
 * The interop baseline is RE-DERIVED here rather than quoted from any
 * document, so the two arms cannot differ by method: same bundler, same
 * defines, same `vue`, same route table, same leaf component. The only
 * variable between them is which outlet renders the route.
 *
 * Not comparable to `docs/BUNDLE-SIZES.md`. Those rows measure each export
 * with `vue` EXTERNAL, because the question there is what the package ships.
 * Here `vue` is BUNDLED, because the question is what lands in the app.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const vaporEntry = resolve(process.cwd(), 'dist', 'router', 'vapor.js');
const haveDist = existsSync(routerEntry) && existsSync(vdomEntry) && existsSync(vaporEntry);

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

const esm = (p: string) => p.replace(/\\/g, '\\\\');

/**
 * Production defines, as a real Vite production build sets them.
 *
 * This set is also the one LEAST favourable to the Vapor arm. Measured across
 * four method variants (these defines vs NODE_ENV alone, each minified and
 * not), the interop-vs-Vapor brotli delta ranged 20.1-34.4 KB; the pairing
 * below is its floor. Output is byte-deterministic across runs, so the margin
 * is not sampling noise.
 */
const PROD_DEFINE = {
  'process.env.NODE_ENV': '"production"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};

const brotli = (buf: Buffer) =>
  zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const gzip = (buf: Buffer) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n: number) => n / 1024;

/**
 * Merge one key into docs/metrics.json - the same channel and merge semantics
 * scripts/test-counts-reporter.mjs uses, so both vitest projects and this test
 * can publish into one file without clobbering each other. Never throws: a
 * measurement that cannot be published must not fail the guard it belongs to.
 */
function writeMetrics(key: string, value: Record<string, string>): void {
  const OUT = 'docs/metrics.json';
  try {
    mkdirSync('docs', { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(OUT)) {
      try {
        existing = JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    const next = { ...existing, [key]: value };
    const ordered = Object.fromEntries(Object.keys(next).sort().map((k) => [k, next[k]]));
    writeFileSync(OUT, `${JSON.stringify(ordered, null, 2)}\n`);
  } catch {
    /* publishing is best-effort - the assertion below is the contract */
  }
}

async function measure(name: string, contents: string) {
  const r = await (esbuild as typeof import('esbuild')).build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'js' },
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    define: PROD_DEFINE,
    write: false,
    logLevel: 'silent',
    legalComments: 'none',
  });
  const buf = Buffer.from(r.outputFiles[0]?.contents as Uint8Array);
  return { name, raw: kb(buf.length), br: kb(brotli(buf)), gz: kb(gzip(buf)) };
}

/** Route table + leaf, identical in every arm so the outlet is the only variable. */
const APP_PRELUDE = `
  import { createComponent, createVaporApp, defineVaporComponent, setInsertionState, template } from 'vue';
  const Page = defineVaporComponent({ setup: () => template('<span>page</span>', 1)() });
  const ROUTES = [{ name: 'home', path: '/', component: 'Page' }];
`;

const CONTROL = `${APP_PRELUDE}
  const Root = defineVaporComponent({
    setup() { const el = template('<div></div>', 1)(); setInsertionState(el); createComponent(Page); return el; },
  });
  createVaporApp(Root).mount(document.getElementById('app'));
`;

/** The router is in the graph but no outlet component renders it. The floor
 *  both outlet arms are measured against, and the only row that says how much
 *  of each arm is outlet machinery rather than router. */
const ROUTER_NO_OUTLET = `${APP_PRELUDE}
  import { createMemoryHistory, createRouter } from '${esm(routerEntry)}';
  const Root = defineVaporComponent({
    setup() { const el = template('<div></div>', 1)(); setInsertionState(el); createComponent(Page); return el; },
  });
  const router = createRouter({ base: '', history: createMemoryHistory(''), routes: ROUTES, components: { Page } });
  const app = createVaporApp(Root);
  app.use(router);
  app.mount(document.getElementById('app'));
`;

const VAPOR_ARM = `${APP_PRELUDE}
  import { createMemoryHistory, createRouter } from '${esm(routerEntry)}';
  import { RouterOutlet } from '${esm(vaporEntry)}';
  const Root = defineVaporComponent({
    setup() { const el = template('<div></div>', 1)(); setInsertionState(el); createComponent(RouterOutlet); return el; },
  });
  const router = createRouter({ base: '', history: createMemoryHistory(''), routes: ROUTES, components: { Page } });
  const app = createVaporApp(Root);
  app.use(router);
  app.mount(document.getElementById('app'));
`;

const INTEROP_ARM = `${APP_PRELUDE}
  import { vaporInteropPlugin } from 'vue';
  import { createMemoryHistory, createRouter } from '${esm(routerEntry)}';
  import { RouterOutlet } from '${esm(vdomEntry)}';
  const Root = defineVaporComponent({
    setup() { const el = template('<div></div>', 1)(); setInsertionState(el); createComponent(RouterOutlet); return el; },
  });
  const router = createRouter({ base: '', history: createMemoryHistory(''), routes: ROUTES, components: { Page } });
  const app = createVaporApp(Root);
  app.use(vaporInteropPlugin);
  app.use(router);
  app.mount(document.getElementById('app'));
`;

describe.skipIf(!haveDist || !esbuild)('Vapor outlet - size', () => {
  it('drops at least 20 KB brotli against a re-derived interop baseline', async () => {
    const control = await measure('Vapor app only (control)', CONTROL);
    const routerOnly = await measure('+ router, app renders the route itself', ROUTER_NO_OUTLET);
    const interop = await measure('+ vDOM RouterOutlet rendered (interop baseline)', INTEROP_ARM);
    const vapor = await measure('+ Vapor RouterOutlet rendered (no interop)', VAPOR_ARM);

    console.log(
      '\n  | bundle | raw KB | brotli KB | gzip KB |\n  | --- | ---: | ---: | ---: |\n' +
        [control, routerOnly, interop, vapor]
          .map((r) => `  | ${r.name} | ${r.raw.toFixed(1)} | ${r.br.toFixed(1)} | ${r.gz.toFixed(1)} |`)
          .join('\n') +
        `\n\n  vapor vs interop: ${(interop.raw - vapor.raw).toFixed(1)} KB raw / ` +
        `${(interop.br - vapor.br).toFixed(2)} KB brotli / ${(interop.gz - vapor.gz).toFixed(1)} KB gzip saved` +
        `\n  margin over the 20 KB bar: ${(interop.br - vapor.br - 20).toFixed(2)} KB brotli` +
        `\n  outlet machinery over the no-outlet floor - vapor: ${(vapor.br - routerOnly.br).toFixed(1)} KB brotli,` +
        ` interop: ${(interop.br - routerOnly.br).toFixed(1)} KB brotli\n`,
    );

    // Publish the measurement so the DOCS can stamp it instead of quoting it.
    // This number appears in the CHANGELOG, ROADMAP, README, router.md and the
    // whitepaper, and it moves whenever anything on the shared side of the A/B
    // changes - which is how five copies of "20.03" came to be wrong at once.
    // Same channel and merge semantics as scripts/test-counts-reporter.mjs:
    // docs/metrics.json is gitignored, so a fresh checkout simply leaves the
    // committed values alone rather than stamping a placeholder over them.
    writeMetrics('outlet', {
      savedBr: (interop.br - vapor.br).toFixed(2),
      savedRaw: (interop.raw - vapor.raw).toFixed(1),
      margin: (interop.br - vapor.br - 20).toFixed(2),
      machineryVapor: (vapor.br - routerOnly.br).toFixed(1),
      machineryInterop: (interop.br - routerOnly.br).toFixed(1),
    });

    // The accepting bar, stated as the raw comparison it is: no rounding, no
    // slack. See this file's header before touching this number.
    expect(interop.br - vapor.br).toBeGreaterThanOrEqual(20);
  });
});
