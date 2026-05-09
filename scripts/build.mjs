/**
 * Build orchestrator — single source of truth for the JS pipeline.
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
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const banner = `/* vapor-chamber v${pkg.version} | LGPL-2.1 | github.com/lucianofedericopereira/vapor-chamber */`;

// 1. ESM multi-entry library — preserves sub-path exports defined in package.json
await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    lib: {
      entry: {
        'index':      'src/index.ts',
        'transports': 'src/transports.ts',
        'directives': 'src/directives.ts',
        'transitions':'src/transitions.ts',
        'ssr':        'src/ssr.ts',
        'vite-hmr':   'src/vite-hmr.ts',
        'fast-lane':  'src/fast-lane.ts',
        'observable': 'src/observable.ts',
        'plugins-schema': 'src/plugins-schema.ts',
        'alien-signals': 'src/alien-signals.ts',
        'iife':       'src/iife.ts',
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['vue', '@vue/devtools-api'],
      output: { banner, preserveModules: false },
    },
    emptyOutDir: false,
    minify: false,
    sourcemap: true,
    target: 'es2022',
  },
});

// 2. IIFE variants — sized for <script> tag use cases
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
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        lib: {
          entry: v.entry,
          name: 'VaporChamber',
          formats: ['iife'],
          fileName: () => `${v.name}.iife${min ? '.min' : ''}.js`,
        },
        rollupOptions: { output: { banner, exports: 'named' } },
        emptyOutDir: false,
        minify: min,
        sourcemap: !min,
        target: ['es2020', 'chrome80', 'firefox75', 'safari13'],
      },
    });
  }
}

console.log('✓ Built ESM library + 3 IIFE variants (full / core / elements)');

// Print bundle-size table — keeps the README narrative honest each build.
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

