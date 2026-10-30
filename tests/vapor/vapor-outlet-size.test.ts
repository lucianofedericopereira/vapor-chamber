// @vitest-environment happy-dom
/**
 * Size guard: what the Vapor RouterOutlet costs a consumer's bundle, and what it saves against the vDOM outlet plus `vaporInteropPlugin`.
 * Why: if the outlet's own machinery grows past its ceiling, or the saving over the interop arm falls below its floor, the `router/vapor` subpath no longer justifies itself.
 * Shows: four Vite production builds (Vue bundled, same defines, route table and leaf) give brotli sizes where vapor minus router-only stays within OWN_ARM_CEILING_KB and interop minus vapor is at least SAVING_FLOOR_KB; the interop baseline is rebuilt here, not quoted.
 * See: log s35.24, docs/BUNDLE-SIZES.md
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import zlib from 'node:zlib';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';
import { requireDist } from '../require-dist';

const routerEntry = resolve(process.cwd(), 'dist', 'router', 'index.js');
const vdomEntry = resolve(process.cwd(), 'dist', 'router', 'vdom.js');
const vaporEntry = resolve(process.cwd(), 'dist', 'router', 'vapor.js');
requireDist(existsSync(routerEntry) && existsSync(vdomEntry) && existsSync(vaporEntry));

const esm = (p: string) => p.replace(/\\/g, '\\\\');

// NODE_ENV is set explicitly: vitest's process has NODE_ENV=test, which Vite would otherwise use, leaving Vue's dev branches in every arm.
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

// Merges one key into docs/metrics.json, as scripts/test-counts-reporter.mjs does; never throws, so a failed publish cannot fail the guard.
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

// The entry chunk with each lazy chunk's hash zeroed, same length: the hash follows the entry's file name (the arm's label) and would shift the brotli size.
// Throws when a lazy chunk name is not hashed or is absent from the entry, so a no-op normalization cannot pass unseen.
function withFixedLazyNames(arm: string, entryCode: string, lazyChunks: Array<{ fileName: string }>): string {
  let code = entryCode;
  for (const chunk of lazyChunks) {
    const base = chunk.fileName.slice(chunk.fileName.lastIndexOf('/') + 1);
    const fixed = base.replace(/-[\w-]{8}\.js$/, '-00000000.js');
    if (fixed === base || !code.includes(base)) {
      throw new Error(`[outlet size] ${arm}: cannot normalize the lazy chunk name "${base}" in the entry`);
    }
    code = code.split(base).join(fixed);
  }
  return code;
}

// One production build per arm. Each arm is an entry file under node_modules/.cache, so bare `vue` resolves by walking up to node_modules, with no alias.
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
  // The entry chunk is the startup cost. The router arms also emit one lazy chunk (makeBladeComponent, loaded on the first blade row; none here).
  // Any other chunk means the entry no longer holds the whole startup cost, so it throws rather than under-count.
  const entry = chunks.filter((c) => c.isEntry);
  const stray = chunks.filter((c) => !c.isEntry && !c.isDynamicEntry);
  if (entry.length !== 1 || stray.length !== 0) {
    throw new Error(
      `[outlet size] ${name}: expected 1 entry chunk and only lazy chunks besides, got ${chunks.map((c) => c.fileName).join(', ')}`,
    );
  }
  const lazy = chunks.filter((c) => !c.isEntry).reduce((n, c) => n + brotli(Buffer.from(c.code)), 0);
  const buf = Buffer.from(withFixedLazyNames(name, entry[0].code, chunks.filter((c) => !c.isEntry)));
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

// The router is in the graph but no outlet renders it: the floor both outlet arms are measured against.
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

// OWN_ARM_CEILING_KB: the Vapor arm over the router-only floor. Both sides share the router and Vue app, so it moves only when our outlet or the Vapor helpers it calls grow, never because interop got cheaper.
// SAVING_FLOOR_KB: interop minus vapor, a coarse floor; below it the subpath's reason to exist has eroded whichever arm moved.
// Both are published to docs/metrics.json (vc:outletOwnArmCeiling, vc:outletFloor, vc:outletOwnArm, vc:outletSaving) so documents do not retype them.
const OWN_ARM_CEILING_KB = 5.0;
const SAVING_FLOOR_KB = 15;

describe('Vapor outlet - size', () => {
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

    // Published so the docs stamp the figures instead of quoting them; docs/metrics.json is gitignored, so a fresh checkout leaves committed values alone.
    writeMetrics('outlet', {
      savedBr: saved.toFixed(2),
      savedRaw: (interop.raw - vapor.raw).toFixed(1),
      floor: SAVING_FLOOR_KB.toFixed(1),
      ownArm: ownArm.toFixed(2),
      ownArmCeiling: OWN_ARM_CEILING_KB.toFixed(1),
      machineryVapor: ownArm.toFixed(1),
      machineryInterop: (interop.br - routerOnly.br).toFixed(1),
    });

    // Raw comparisons, no rounding and no slack.
    expect(ownArm).toBeLessThanOrEqual(OWN_ARM_CEILING_KB);
    expect(saved).toBeGreaterThanOrEqual(SAVING_FLOOR_KB);
  });
});
