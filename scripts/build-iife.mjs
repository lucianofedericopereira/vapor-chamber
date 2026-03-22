/**
 * Build script for the IIFE / CDN bundle.
 *
 * Output: dist/vapor-chamber.iife.js  (unminified, ~12KB)
 *         dist/vapor-chamber.iife.min.js (minified, ~6KB)
 *
 * Run: node scripts/build-iife.mjs
 */

import esbuild from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

const shared = {
  entryPoints: ['src/iife.ts'],
  bundle: true,
  platform: 'browser',
  target: ['es2020', 'chrome80', 'firefox75', 'safari13'],
  // Vue is an optional peer — don't bundle it; detect at runtime via dynamic import
  external: [],
  globalName: 'VaporChamber',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: `/* vapor-chamber v${pkg.version} | LGPL-2.1 | github.com/lucianofedericopereira/vapor-chamber */`,
  },
};

// Unminified
await esbuild.build({
  ...shared,
  outfile: 'dist/vapor-chamber.iife.js',
  minify: false,
  sourcemap: true,
});

// Minified
await esbuild.build({
  ...shared,
  outfile: 'dist/vapor-chamber.iife.min.js',
  minify: true,
  sourcemap: false,
});

console.log('✓ IIFE bundles written to dist/');
