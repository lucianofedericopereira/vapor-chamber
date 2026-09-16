// @vitest-environment happy-dom
/**
 * SIZE GUARD - what dropping `vaporInteropPlugin` is worth, re-measured every
 * run against a baseline derived by the same harness.
 *
 * THIS TEST IS SUPPOSED TO BE ABLE TO FAIL, and it has - twice, both times on
 * an improvement, and the second firing is why it now asserts two things
 * instead of one. The two limits are stated once, at `OWN_ARM_CEILING_KB` and
 * `SAVING_FLOOR_KB` below, with the history. A failure is still the intended
 * signal that the subpath's justification needs re-examining, and still a
 * decision rather than a number to nudge.
 *
 * What the firings taught, which the original framing did not anticipate:
 * the old guard measured interop MINUS vapor, and both arms carry the router,
 * so anything that makes the LIBRARY smaller made the DIFFERENCE smaller. A
 * change that cut ~10% from every consumer's bundle registered here as a
 * REGRESSION (v1.19), and so did Vue shrinking the interop arm (rc.8). A
 * difference answers "is this subpath worth existing" only if the other arm
 * holds still, and the other arm is Vue's to change. The two assertions below
 * each measure one thing that is ours to answer for.
 *
 * The two recovery levers measured and DECLINED at acceptance are still
 * declined, and are still the first place to look if it fires again: swapping
 * routerError for a plain Error recovers ~77 B but breaks the coded-error
 * taxonomy consumers switch on, and dropping the DEV gate recovers ~35 B but
 * ships both diagnostic strings to every production consumer - which this
 * library now goes out of its way to avoid (scripts/build.mjs, resolveDevFlag).
 * (Both measured under esbuild, the bundler this guard used then.)
 *
 * WHY VITE'S BUILD API AND NOT ESBUILD (rc.8 cycle). A consumer-facing number
 * has to come from the bundler consumers ship with, and that is Vite 8 /
 * rolldown. esbuild was an internal proxy, and at rc.8 the proxy and the real
 * thing disagreed in SIGN. rc.8 removed the hydration-boundary closure from
 * client render and moved slot hydration into top-level functions (Vue commits
 * 13 and 19); esbuild keeps those functions, because they are statically
 * referenced behind an `isHydrating` check, while rolldown shakes them. On
 * clean rc.7 and rc.8 trees (every @vue package that follows vue's version, eleven, pinned per tree; the
 * whitepaper's rc.8 row), the same four arms read:
 *
 *                              esbuild           Vite 8 / rolldown
 *     saving rc.7 -> rc.8      20.06 -> 19.40    18.85 -> 20.42  (KB brotli)
 *     hydration-named code     19 -> 28 fns      5 -> 3 identifiers (Vapor arm)
 *
 * So rc.8 made the outlet's case WORSE by esbuild's count and BETTER by 1.57 KB
 * in what a consumer actually ships, and the old 19.5 KB bar was an esbuild
 * number that rolldown had already undercut on rc.7. Every arm is 25-30%
 * smaller under rolldown. A size guard must name its bundler; this one is
 * Vite's, with the same production shape a consumer's `vite build` gets.
 *
 * The interop baseline is RE-DERIVED here rather than quoted from any
 * document, so the arms cannot differ by method: same bundler, same defines,
 * same `vue`, same route table, same leaf component. The only variable between
 * the two outlet arms is which outlet renders the route.
 *
 * Not comparable to `docs/BUNDLE-SIZES.md`. Those rows measure each export
 * with `vue` EXTERNAL, because the question there is what the package ships.
 * Here `vue` is BUNDLED, because the question is what lands in the app.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const vaporEntry = resolve(process.cwd(), 'dist', 'router', 'vapor.js');
const haveDist = existsSync(routerEntry) && existsSync(vdomEntry) && existsSync(vaporEntry);

const esm = (p: string) => p.replace(/\\/g, '\\\\');

/**
 * Production defines, as a real Vite production build of a Vue app sets them.
 *
 * `process.env.NODE_ENV` is stated even though `mode: 'production'` implies it,
 * because this runs INSIDE vitest, whose process has NODE_ENV=test, and Vite
 * derives the client-side replacement from the process environment when one is
 * set. Without it Vue's dev branches would stay in every arm.
 *
 * At acceptance, under esbuild, this set was also measured as the one LEAST
 * favourable to the Vapor arm (interop-vs-Vapor delta 20.1-34.4 KB brotli
 * across four method variants, this pairing the floor). That comparison has
 * not been re-run under rolldown.
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

/**
 * One production build per arm, the way a consumer's `vite build` runs it.
 *
 * Each arm is a real entry FILE, not stdin, because Vite builds from files.
 * The temp directory sits under this repo's `node_modules/.cache` rather than
 * the OS temp dir so the entry's bare `vue` import resolves the way a
 * consumer's does - by walking up to a `node_modules` - with no alias or
 * resolver plugin standing in for Vite's own resolution.
 */
async function measure(dir: string, name: string, contents: string) {
  const input = join(dir, `${name.replace(/[^a-z]+/gi, '-')}.js`);
  writeFileSync(input, contents);
  const result = await build({
    configFile: false,
    root: dir,
    logLevel: 'silent',
    mode: 'production',
    define: PROD_DEFINE,
    build: {
      minify: true,
      target: 'es2022',
      write: false,
      modulePreload: false,
      rollupOptions: { input, output: { format: 'es' } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
  const chunks = outputs.filter((o) => o.type === 'chunk') as Array<{
    code: string; fileName: string; isEntry: boolean; isDynamicEntry: boolean;
  }>;
  // The ENTRY chunk is what the app loads at startup, which is the cost this
  // guard is about. The router arms also emit one lazy chunk: the router
  // imports `makeBladeComponent` on demand, the first time a blade row renders
  // (README, router section), and no row here is a blade row. esbuild without
  // code splitting inlined that chunk into the one file, so the esbuild-era
  // numbers carried it; the rolldown numbers the limits are set from do not.
  // Anything else - a second entry, or a chunk split off the STATIC graph -
  // would mean the entry no longer holds the whole startup cost, so it throws
  // rather than under-count.
  const entry = chunks.filter((c) => c.isEntry);
  const stray = chunks.filter((c) => !c.isEntry && !c.isDynamicEntry);
  if (entry.length !== 1 || stray.length !== 0) {
    throw new Error(
      `[outlet size] ${name}: expected 1 entry chunk and only lazy chunks besides, got ${chunks.map((c) => c.fileName).join(', ')}`,
    );
  }
  const lazy = chunks.filter((c) => !c.isEntry).reduce((n, c) => n + brotli(Buffer.from(c.code)), 0);
  const buf = Buffer.from(entry[0].code);
  return { name, raw: kb(buf.length), br: kb(brotli(buf)), gz: kb(gzip(buf)), lazyBr: kb(lazy) };
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

/**
 * THE TWO LIMITS, each stated once and published so no document retypes them
 * (`vc:outletOwnArmCeiling`, `vc:outletFloor`, with the measured values as
 * `vc:outletOwnArm` and `vc:outletSaving`).
 *
 * OWN_ARM_CEILING_KB - the Vapor outlet's own machinery: the Vapor arm over
 * the router-without-outlet floor. Both sides of that subtraction hold the
 * same router and the same Vue app, so it moves when OUR outlet grows, or when
 * the Vapor helpers it calls (`createDynamicComponent`, `createSlot`) grow. It
 * cannot fire because interop got cheaper, which is the failure the old metric
 * had. 4.21 KB on rc.8 under rolldown; 5.0 leaves ~0.8 KB, the same order of
 * headroom the old bar kept (0.41 KB on a 19.5 KB number), so ordinary growth
 * does not fire it and losing most of a KB does.
 *
 * SAVING_FLOOR_KB - interop minus vapor, the old question, asked at the
 * resolution it can answer: a coarse floor rather than a bar within half a KB
 * of the measurement. 20.42 KB on rc.8. Below 15 the subpath's reason to exist
 * has genuinely eroded, whichever arm moved.
 *
 * History of the single bar this replaces (all esbuild):
 *
 *   20.13   acceptance spike (2026-08-28), against a 20 bar: 0.13 headroom
 *   20.04   after the router fixes of that cycle
 *   19.98   after the numeric-option sweep added ~150 B of SHARED code
 *   19.91   after DEV stopped shipping diagnostic strings to production;
 *           bar re-baselined 20 -> 19.5, because folding DEV shed 97 B from
 *           the interop arm against 23 B from the Vapor one, and a 10% win
 *           for every consumer read as a 0.07 KB regression
 *   19.43   rc.8 (mixed tree; 19.40 clean) - FAILED the 19.5 bar, on an rc.8
 *           that rolldown measures as a 1.57 KB IMPROVEMENT. Second firing on
 *           an improvement; the metric was retired rather than re-baselined.
 */
const OWN_ARM_CEILING_KB = 5.0;
const SAVING_FLOOR_KB = 15;

describe.skipIf(!haveDist)('Vapor outlet - size', () => {
  it(`own machinery stays under ${OWN_ARM_CEILING_KB} KB and saves at least ${SAVING_FLOOR_KB} KB brotli against a re-derived interop baseline`, async () => {
    const cache = resolve(process.cwd(), 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const dir = mkdtempSync(join(cache, 'vc-outlet-size-'));
    let control: Awaited<ReturnType<typeof measure>>;
    let routerOnly: Awaited<ReturnType<typeof measure>>;
    let interop: Awaited<ReturnType<typeof measure>>;
    let vapor: Awaited<ReturnType<typeof measure>>;
    try {
      control = await measure(dir, 'Vapor app only (control)', CONTROL);
      routerOnly = await measure(dir, '+ router, app renders the route itself', ROUTER_NO_OUTLET);
      interop = await measure(dir, '+ vDOM RouterOutlet rendered (interop baseline)', INTEROP_ARM);
      vapor = await measure(dir, '+ Vapor RouterOutlet rendered (no interop)', VAPOR_ARM);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const ownArm = vapor.br - routerOnly.br;
    const saved = interop.br - vapor.br;

    console.log(
      '\n  | bundle (Vite 8 production build, entry chunk) | raw KB | brotli KB | gzip KB | lazy chunks, brotli KB |\n' +
        '  | --- | ---: | ---: | ---: | ---: |\n' +
        [control, routerOnly, interop, vapor]
          .map(
            (r) =>
              `  | ${r.name} | ${r.raw.toFixed(1)} | ${r.br.toFixed(1)} | ${r.gz.toFixed(1)} | ${r.lazyBr.toFixed(1)} |`,
          )
          .join('\n') +
        `\n\n  vapor vs interop: ${(interop.raw - vapor.raw).toFixed(1)} KB raw / ` +
        `${saved.toFixed(2)} KB brotli / ${(interop.gz - vapor.gz).toFixed(1)} KB gzip saved` +
        ` (floor ${SAVING_FLOOR_KB} KB)` +
        `\n  outlet machinery over the no-outlet floor - vapor: ${ownArm.toFixed(2)} KB brotli` +
        ` (ceiling ${OWN_ARM_CEILING_KB} KB), interop: ${(interop.br - routerOnly.br).toFixed(1)} KB brotli\n`,
    );

    // Publish the measurement so the DOCS can stamp it instead of quoting it.
    // The saving appears in the ROADMAP, README, router.md and the whitepaper,
    // and it moves whenever anything on either side of the A/B changes - which
    // is how five copies of "20.03" came to be wrong at once. Same channel and
    // merge semantics as scripts/test-counts-reporter.mjs: docs/metrics.json is
    // gitignored, so a fresh checkout simply leaves the committed values alone
    // rather than stamping a placeholder over them.
    writeMetrics('outlet', {
      savedBr: saved.toFixed(2),
      savedRaw: (interop.raw - vapor.raw).toFixed(1),
      floor: SAVING_FLOOR_KB.toFixed(1),
      ownArm: ownArm.toFixed(2),
      ownArmCeiling: OWN_ARM_CEILING_KB.toFixed(1),
      machineryVapor: ownArm.toFixed(1),
      machineryInterop: (interop.br - routerOnly.br).toFixed(1),
    });

    // Raw comparisons, no rounding and no slack. Why each limit is where it
    // is: OWN_ARM_CEILING_KB and SAVING_FLOOR_KB above.
    expect(ownArm).toBeLessThanOrEqual(OWN_ARM_CEILING_KB);
    expect(saved).toBeGreaterThanOrEqual(SAVING_FLOOR_KB);
  });
});
