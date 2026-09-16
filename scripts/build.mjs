/**
 * Build orchestrator - single source of truth for the JS pipeline.
 *
 * Outputs:
 *   ESM multi-entry library (tree-shakable, sideEffects: false)
 *     dist/index.js, dist/transports.js, dist/directives.js,
 *     dist/transitions.js, dist/ssr.js, dist/vite-hmr.js, dist/iife.js
 *
 *   IIFE variants (script-tag drop-ins, three sized bundles)
 *     dist/vapor-chamber.iife.js          + .min.js   (full)
 *     dist/vapor-chamber-core.iife.js     + .min.js   (no async, no custom-element)
 *     dist/vapor-chamber-elements.iife.js + .min.js   (custom-element + core)
 *
 * Types are emitted separately by `tsc` (emitDeclarationOnly).
 *
 * Run: node scripts/build.mjs
 */

import { build } from 'vite';
import { transform } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// A pointer, not a notice block. 22 bytes. Every emitted file carries this one
// line; dist/LICENSE.txt carries the per-file notices and LICENSE the full
// LGPL-2.1 text - both outside the bundle, where no size metric counts them.
//
// `/*!` is load-bearing: it marks this a LEGAL comment, which minifiers keep. A
// plain `/* ... */` is not, and every minifier dropped it - before this, both
// .min.js IIFEs shipped with no licence reference at all.
const pointer = '/*! See LICENSE.txt */';

/** Files emitted across all builds, for the LICENSE.txt manifest. */
const emitted = new Set();

/**
 * Licence pointer + comment stripping, after the minifier has run.
 *
 * `rollupOptions.output.banner` is applied BEFORE minification, so the minifier
 * ate it. `generateBundle` runs after, so the pointer always survives.
 *
 * `strip` also drops JSDoc from the emitted ESM - ~13.6 KB of dist/index.js,
 * redundant there because the same prose is in the `.d.ts`, which is what
 * editors and TypeScript read. Source keeps every comment; only shipped JS
 * loses them. The `@__PURE__` and `@vite-ignore` annotations survive: esbuild
 * preserves them, and stripping them would break downstream tree-shaking.
 */
function licenseNotice({ strip = false } = {}) {
  return {
    name: 'vc-license-notice',
    enforce: 'post',
    async generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        emitted.add(file.fileName);
        let code = file.code;
        if (strip) {
          code = (await transform(code, { loader: 'js', target: 'esnext', legalComments: 'none' })).code;
        }
        file.code = code.startsWith('/*!') ? code : `${pointer}\n${code}`;
      }
    },
  };
}

/** Writes dist/LICENSE.txt - one notice block per emitted JavaScript file. */
function writeLicenseManifest() {
  const notice = [
    `Copyright (C) Luciano Federico Pereira`,
    ``,
    `  This file is part of vapor-chamber and is licensed under the GNU Lesser`,
    `  General Public License, version 2.1. It is distributed WITHOUT ANY`,
    `  WARRANTY; without even the implied warranty of MERCHANTABILITY or`,
    `  FITNESS FOR A PARTICULAR PURPOSE. See the GNU LGPL v2.1 for details.`,
    ``,
    `  Full licence text: LICENSE in the package root.`,
    `  Complete corresponding source: https://github.com/lucianofedericopereira/vapor-chamber`,
  ].join('\n');

  const files = [...emitted].sort().map((f) => `  ${f}`).join('\n');

  writeFileSync(
    'dist/LICENSE.txt',
    `vapor-chamber v${pkg.version} - licence information for the distributed JavaScript\n` +
    `${'='.repeat(78)}\n\n` +
    `Every JavaScript file in this directory carries the one-line reference\n` +
    `"/*! See LICENSE.txt */". This file is that reference.\n\n` +
    `These ${emitted.size} files:\n\n${files}\n\n` +
    `are each covered by the following notice.\n\n` +
    `${'='.repeat(78)}\n\n${notice}\n`,
  );
  console.log(`✓ dist/LICENSE.txt - ${emitted.size} files`);
}

/**
 * DEV, resolved for the ESM artifact only.
 *
 * `src/dev.ts` answers DEV with a build define and a RUNTIME FALLBACK, and the
 * fallback is what the suite exercises - all six of its branches are covered by
 * tests/dev-flag.test.ts. It is also what stopped the ESM build ever folding:
 * a consumer's bundler cannot evaluate `typeof __VC_DEV__ !== 'undefined'`, so
 * the ternary survived minification and carried EVERY dev-only diagnostic
 * string into production. Measured on a real Vite APP build consuming this
 * package: 14,037 -> 12,764 raw and 4,453 -> 3,999 brotli, about 10%.
 *
 * A `define` cannot fix it. It substitutes the identifier - including the one
 * inside `typeof` - which duplicates the expression and still does not fold. So
 * the ESM artifact gets the resolved form by SOURCE SUBSTITUTION here, and
 * `src/dev.ts` keeps the shape its tests read. Nothing is deleted from the
 * measured surface: the six branches stay in src, stay covered, and this string
 * is pinned against them by tests/dev-flag.test.ts so the two cannot drift.
 *
 * THE EXPRESSION. Its first shape, `typeof process === "undefined" ? false :
 * process.env.NODE_ENV !== "production"`, read false in every browser page a
 * bundler's dev server serves: the server replaces `process.env.NODE_ENV`, but
 * a page has no `process`, so the guard answered first (verified in a real
 * browser, Vite 8, both with the package pre-bundled and served unbundled).
 * The guard now also passes on `import.meta.env?.DEV`, which Vite sets in
 * every module it serves, and the rest is unchanged:
 *
 *   - Node (vitest, SSR)     `process` exists; NODE_ENV decides, as before.
 *   - Vite dev page          no `process`, `import.meta.env.DEV` true, and
 *                            NODE_ENV already substituted, so nothing throws.
 *   - no-bundler page        neither exists: false, and `process.env` is never
 *                            touched, so no ReferenceError.
 *   - production build       NODE_ENV substituted, so BOTH arms read false and
 *                            a minifier collapses the ternary, as before.
 *
 * WHERE IT IS EMITTED. Once per importing module, never as a shared export. A
 * minifier folds DEV only inside the chunk that defines it: in a code-split
 * app, a chunk that IMPORTED the one shared constant kept every warning it
 * guards (measured on examples/vapor-island-cart, whose Cart chunk shipped
 * the whole probe-path hint, 4,718 -> 3,264 B raw). So every `./dev` import
 * from src resolves to its own module, which lands in its importer's chunk,
 * and no chunk of this build or a consumer's imports DEV from another. Both
 * examples' production chunks are now byte-identical to a build where DEV is
 * the literal `false` in every module; tests/dev-esm-consumers.test.ts pins
 * that for the one-chunk and the code-split shape.
 *
 * WHY A PLACEHOLDER. Vite's library build statically replaces `import.meta.env`
 * in the code it bundles (measured: the arm came out `|| false`, which bakes
 * OUR build's answer in and silences every dev page again), so the modules
 * carry a placeholder and the expression is written in after bundling.
 */
export const DEV_ESM_EXPR =
  'typeof process !== "undefined" || import.meta.env?.DEV ? process.env.NODE_ENV !== "production" : false';
export const DEV_ESM_SOURCE = `export const DEV = ${DEV_ESM_EXPR};\n`;

const DEV_PLACEHOLDER = '__VC_DEV_ESM__';

function resolveDevFlag() {
  return {
    name: 'vc-dev-flag',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/^\.\.?\/dev$/.test(source)) return null;
      if (!importer.replace(/\\/g, '/').includes('/src/')) return null;
      return `\0vc-dev:${importer}`;
    },
    load(id) {
      return id.startsWith('\0vc-dev:') ? `export const DEV = ${DEV_PLACEHOLDER};\n` : null;
    },
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        // An import that bypassed resolveId would bring back the shared constant.
        if (file.moduleIds.some((m) => m.replace(/\\/g, '/').endsWith('/src/dev.ts'))) {
          this.error(`${file.fileName} bundles src/dev.ts; every DEV must be derived per module`);
        }
        file.code = file.code.split(DEV_PLACEHOLDER).join(`(${DEV_ESM_EXPR})`);
      }
    },
  };
}

// 1. ESM multi-entry library - preserves sub-path exports defined in package.json
await build({
  configFile: false,
  logLevel: 'warn',
  // TOP-LEVEL, because that is the only place Vite reads `define`.
  //
  // A `define` block used to sit inside `build:` here, carrying
  // `__VC_IIFE__: 'false'` and `__VC_DEV__: 'process.env.NODE_ENV !== "production"'`.
  // Vite ignores that position, so it had never applied to the ESM output -
  // verified in `dist/dev.js`, where even the bare `__VC_DEV__` sat
  // unsubstituted. It was DELETED rather than hoisted, because hoisting it
  // would change behaviour and that is a call to make deliberately: rolldown
  // does substitute inside `typeof`, so a correctly-placed `__VC_DEV__` would
  // fold `src/dev.ts` to a constant and discard its `typeof process` fallback -
  // and that fallback is exactly what the ESM build wants to keep, since only
  // the CONSUMER's bundler knows whether their build is a dev build. Deleting
  // the dead block preserves today's behaviour and stops the config from
  // describing something that never happened.
  define: { __VC_IIFE__: 'false' },
  build: {
    lib: {
      entry: {
        'index':      'src/index.ts',
        'transports': 'src/transports.ts',
        'directives': 'src/directives.ts',
        'transitions':'src/transitions.ts',
        'ssr':        'src/ssr.ts',
        'vite-hmr':   'src/vite-hmr.ts',
        'vitest':     'src/vitest.ts',
        'vitest-pure': 'src/vitest-pure.ts',
        'vitest-mcp': 'src/vitest-mcp.ts',
        'fast-lane':  'src/fast-lane.ts',
        'observable': 'src/observable.ts',
        'plugins-schema': 'src/plugins-schema.ts',
        'alien-signals': 'src/alien-signals.ts',
        'reactive':   'src/reactive.ts',
        'vue':        'src/vue.ts',
        'vapor':      'src/vapor.ts',
        'outbox':     'src/outbox.ts',
        'mcp':        'src/mcp.ts',
        'stream-parser': 'src/stream-parser.ts',
        'devtools':   'src/devtools.ts',
        'store':      'src/store.ts',
        'router/index':       'src/router/index.ts',
        'router/vdom':        'src/router/vdom.ts',
        'router/vapor':       'src/router/vapor.ts',
        'router/remote':      'src/router/remote.ts',
        'router-fetch/index': 'src/router-fetch/index.ts',
        'iife':       'src/iife.ts',
        'iife-core':  'src/iife-core.ts',
        'iife-elements': 'src/iife-elements.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      // `vitest` is the test entry's peer. `vapor-chamber` is that entry's lazy
      // import of this package by name: bundled, it would resolve through the
      // self-link to a second copy of the library or a chunk shared with the
      // root, where the setup file and the tests must share one instance.
      // The MCP server entry runs in Node: `vitest/node` is the peer, `vapor-chamber/mcp`
      // the package itself, as above, and Node's built-ins are never bundled.
      external: ['vue', '@vue/devtools-api', '@vue/reactivity', 'vitest', 'vapor-chamber', 'vitest/node', 'vapor-chamber/mcp', /^node:/],
      output: {
        preserveModules: false,
        // Stable shared-chunk names, not `chamber-T4ImeORN.js`. Content hashes
        // exist for HTTP cache-busting, and nothing serves these to a browser -
        // consumers bundle them, and the entry names `exports` points at were
        // already stable. So the hash bought nothing and cost: builds were not
        // reproducible, `dist/` diffs churned on every rebuild, and stack traces
        // named a different file each time.
        chunkFileNames: '[name].js',
      },
    },
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    target: 'es2022',
  },
  plugins: [resolveDevFlag(), licenseNotice({ strip: true })],
});

// 2. IIFE variants - sized for <script> tag use cases
const iifeVariants = [
  { name: 'vapor-chamber',          entry: 'src/iife.ts' },
  { name: 'vapor-chamber-core',     entry: 'src/iife-core.ts' },
  { name: 'vapor-chamber-elements', entry: 'src/iife-elements.ts' },
];

for (const v of iifeVariants) {
  for (const min of [false, true]) {
    await build({
      configFile: false,
      logLevel: 'warn',
      // __VC_IIFE__ lets source branch on "this is a <script>-tag bundle",
      // which is a BUILD-time fact - no reason to answer it at runtime. It
      // const-folds, so the dead branch is dropped by the minifier rather than
      // shipped. Used by chamber.ts to omit the `@vue/reactivity` probe, whose
      // dynamic import can never resolve without a bundler anyway.
      define: {
        'process.env.NODE_ENV': '"production"',
        __VC_IIFE__: 'true',
        // A <script>-tag page has no bundler to set this, so the choice is
        // settled here: the cached clock folds in, the exact one folds out.
        // ESM deliberately omits it (see the ESM define block) so the consumer's
        // bundler can opt out instead.
        // These are production artifacts, so dev diagnostics fold away
        // entirely - branch AND message strings.
        __VC_DEV__: 'false',
      },
      build: {
        lib: {
          entry: v.entry,
          name: 'VaporChamber',
          formats: ['iife'],
          fileName: () => `${v.name}.iife${min ? '.min' : ''}.js`,
        },
        // exports: 'default' - the IIFE global must BE the API object, so a
        // plain <script> user can call VaporChamber.connect(). With 'named',
        // rollup wraps the module's exports and assigns
        // { VaporChamber, default } to the global instead, so every documented
        // call site (VaporChamber.connect, .createCommandBus, ...) is undefined
        // and the API only reachable as VaporChamber.VaporChamber.
        rollupOptions: { output: { exports: 'default' } },
        emptyOutDir: false,
        minify: min,
        sourcemap: !min,
        target: ['es2020', 'chrome80', 'firefox75', 'safari13'],
      },
      plugins: [licenseNotice()],
    });
  }
}

writeLicenseManifest();
console.log('✓ Built ESM library + 3 IIFE variants (full / core / elements)');

// Print bundle-size table - keeps the README narrative honest each build.
import { statSync } from 'node:fs';
import zlib from 'node:zlib';
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const rows = iifeVariants.map(v => {
  const file = `dist/${v.name}.iife.min.js`;
  const buf = readFileSync(file);
  return {
    name: v.name,
    min:  statSync(file).size,
    br:   zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
    gz:   zlib.gzipSync(buf, { level: 9 }).length,
  };
});
const pad = (s, n) => s.padEnd(n);
console.log(`\n  ${pad('variant', 22)} ${pad('min', 10)} ${pad('brotli', 10)} ${pad('gzip', 10)}`);
for (const r of rows) {
  console.log(`  ${pad(r.name, 22)} ${pad(kb(r.min), 10)} ${pad(kb(r.br), 10)} ${pad(kb(r.gz), 10)}`);
}

