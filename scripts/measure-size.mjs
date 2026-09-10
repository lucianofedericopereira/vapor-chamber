/**
 * measure-size - honest shipped-size table for every published entry.
 *
 * The size that matters is brotli of the CODE - comment-free. ESM subpath exports
 * ship unminified (comments included), but the consumer's bundler strips comments
 * and minifies, so measuring the raw dist file would count comment bytes that never
 * reach production. So we esbuild-bundle each export from source, MINIFY (drops
 * comments), externalize vue, then gzip/brotli that - the real over-the-wire cost.
 * IIFE variants already ship minified, so we read the built .min.js directly.
 *
 * Run: node scripts/measure-size.mjs            human table (default)
 *      node scripts/measure-size.mjs --json      machine-readable
 *      node scripts/measure-size.mjs --md         full generated doc (docs/BUNDLE-SIZES.md)
 *
 * `npm run size:doc` writes --md to docs/BUNDLE-SIZES.md; CI regenerates and
 * `git diff --exit-code`s it, so the published numbers can never drift from reality.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { relative, sep } from 'node:path';
import zlib from 'node:zlib';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const brot = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1);

/**
 * ESM subpath exports, DERIVED FROM `package.json` "exports" - not listed.
 *
 * This was a hand-kept list of 24, and by the time anyone diffed it the exports
 * map had 26: `./devtools` and `./stream-parser` were published subpaths that a
 * consumer could import and that `build.mjs` built, with NO size row anywhere.
 * Never measured, never in docs/BUNDLE-SIZES.md, never tracked when they grew -
 * and nothing could notice, because the list looked complete.
 *
 * Deriving it makes the table exactly as complete as the package's own
 * promises. A subpath added to `exports` gets a row on the next run; a subpath
 * removed loses one. `generate-api-docs.mjs` already reads the same source for
 * the same reason (its predecessor's hand-kept list had drifted by five).
 *
 * The mapping is mechanical: `./dist/x/y.js` is built from `src/x/y.ts`, which
 * is what `build.mjs`'s entry map says. Entries whose source is missing are
 * dropped below, so a stale exports entry degrades to a missing row rather than
 * an esbuild crash.
 *
 * (`./router` is deliberately renderer-free - the outlets and blade components
 * live behind `./router/vdom` and `./router/vapor` so a consumer pays only for
 * the renderer it renders through. See tests/router/vdom-boundary.test.ts and
 * tests/router/vapor-boundary.test.ts.)
 */
const esm = Object.entries(pkg.exports ?? {}).flatMap(([subpath, value]) => {
  const dist = typeof value === 'string' ? value : (value?.import ?? value?.default);
  if (typeof dist !== 'string' || !dist.endsWith('.js')) return [];
  return [[subpath, dist.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts')]];
});
const iife = [
  ['vapor-chamber (full)', 'dist/vapor-chamber.iife.min.js'],
  ['vapor-chamber-core', 'dist/vapor-chamber-core.iife.min.js'],
  ['vapor-chamber-elements', 'dist/vapor-chamber-elements.iife.min.js'],
];

/**
 * TWO passes, because one number cannot answer both questions.
 *
 * Pass 1 (`min`/`gz`/`br`) bundles with NO code splitting, which is the
 * original measurement and stays untouched so every published figure remains
 * comparable to its history.
 *
 * Pass 2 exists because pass 1 has a blind spot that was actively misleading.
 * Without `splitting`, esbuild cannot emit a second chunk, so it INLINES every
 * internal `import()` and adds a `Promise.resolve().then()` wrapper on top - a
 * module deferred off the startup path is counted in full, plus overhead. The
 * metric therefore charged a penalty for the one technique that removes bytes
 * from a real consumer: measured on `./router`, moving the http client behind
 * an on-demand import read as +0.5 KB here while cutting 3.2 KB from an app's
 * first load. Two sites are affected today - the http client and `./blade`,
 * both in the router. (The `import()` calls in `chamber.ts` and `devtools.ts`
 * hold their specifier in a variable behind `@vite-ignore`, so esbuild leaves
 * them external and neither pass sees them.)
 *
 * So pass 2 rebuilds with `splitting: true` and reports what an app's bundler
 * actually produces: `first` is the entry chunk, `lazy` is everything deferred
 * into sibling chunks, fetched only if the feature is used. A row where the
 * two agree has nothing deferred, which is most of them.
 */
async function esmRow(name, entry) {
  const shared = {
    entryPoints: [entry], bundle: true, minify: true, format: 'esm', target: 'es2022',
    external: ['vue', '@vue/devtools-api'], write: false, logLevel: 'silent', legalComments: 'none',
  };
  const r = await build(shared);
  const buf = Buffer.from(r.outputFiles[0].contents);

  // `outdir` is required by esbuild whenever splitting is on; nothing is
  // written, since `write: false` keeps the result in memory.
  const split = await build({ ...shared, splitting: true, outdir: 'size-probe', metafile: true });
  const outputs = split.metafile.outputs;
  const keyOf = (file) => relative(process.cwd(), file.path).split(sep).join('/');

  // Reachability, NOT the `entryPoint` field. esbuild stamps an `entryPoint` on
  // the chunk it splits out for a dynamic import too, so testing that flag
  // counts a deferred module as part of the startup cost - the exact inversion
  // of what this pass is for. And a chunk WITHOUT one is not necessarily lazy:
  // it can be shared code the entry imports statically, which is how
  // `./router-fetch` reaches the http client. So walk `import-statement` edges
  // from the entry chunk; whatever that closure reaches is downloaded to
  // start, and whatever it does not is fetched only on demand.
  const entryKey = Object.keys(outputs).find((k) => outputs[k].entryPoint === entry);
  const eager = new Set();
  for (const queue = entryKey ? [entryKey] : []; queue.length; ) {
    const key = queue.pop();
    if (!key || eager.has(key) || !outputs[key]) continue;
    eager.add(key);
    for (const imp of outputs[key].imports ?? []) {
      if (imp.kind === 'import-statement' && outputs[imp.path]) queue.push(imp.path);
    }
  }

  let first = 0;
  let lazy = 0;
  for (const file of split.outputFiles) {
    const size = brot(Buffer.from(file.contents));
    if (eager.has(keyOf(file))) first += size;
    else lazy += size;
  }
  return { name, min: buf.length, gz: gzip(buf), br: brot(buf), first, lazy };
}

/**
 * The "typical Blade consumer" bundle - the shape docs/performance.md quotes.
 *
 * Measured from `dist/`, not `src/`, deliberately: that is what a consumer
 * actually installs, and it makes this row describe the SAME artifact
 * `tests/esm-treeshake.test.ts` builds and gates. The doc used to carry a
 * hand-typed "5.5 KB brotli" here, which had drifted ~18% low by the time
 * anyone re-measured. A number that appears in prose comes from this script.
 */
async function consumerRow() {
  const entry = 'dist/index.js';
  if (!existsSync(entry) || !existsSync('dist/transports.js')) return null;
  const r = await build({
    stdin: {
      contents: [
        `import { createCommandBus, logger } from './dist/index.js';`,
        `import { createHttpBridge } from './dist/transports.js';`,
        `const bus = createCommandBus();`,
        `bus.use(logger());`,
        `bus.use(createHttpBridge({ endpoint: '/api' }));`,
        `globalThis.__vc_size_probe = bus;`,
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true, minify: true, format: 'esm', target: 'es2022', platform: 'browser',
    external: ['vue', '@vue/devtools-api'], write: false, logLevel: 'silent', legalComments: 'none',
  });
  const buf = Buffer.from(r.outputFiles[0].contents);
  return { name: 'consumer: createCommandBus + logger + createHttpBridge', min: buf.length, gz: gzip(buf), br: brot(buf) };
}

/**
 * The dispatch core ALONE - `createCommandBus` and nothing else.
 *
 * This is the "~3.6 KB brotli core" the README leads with, and until v1.17.0 it
 * was hand-typed in three separate places with no generator behind it. Same
 * rule as `consumerRow` above, and the same reason: a number that appears in
 * prose comes from this script, or it drifts. Measured from `dist/` because
 * that is what a consumer installs and tree-shakes.
 */
async function coreRow() {
  const entry = 'dist/index.js';
  if (!existsSync(entry)) return null;
  const r = await build({
    stdin: {
      contents: [
        `import { createCommandBus } from './dist/index.js';`,
        `globalThis.__vc_size_probe = createCommandBus();`,
      ].join('\n'),
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true, minify: true, format: 'esm', target: 'es2022', platform: 'browser',
    external: ['vue', '@vue/devtools-api'], write: false, logLevel: 'silent', legalComments: 'none',
  });
  const buf = Buffer.from(r.outputFiles[0].contents);
  return { name: 'core: createCommandBus alone', min: buf.length, gz: gzip(buf), br: brot(buf) };
}

const esmRows = await Promise.all(esm.filter(([, e]) => existsSync(e)).map(([n, e]) => esmRow(n, e)));
const core = await coreRow();
if (core) esmRows.push(core);
const consumer = await consumerRow();
if (consumer) esmRows.push(consumer);
const iifeRows = iife.filter(([, f]) => existsSync(f)).map(([name, f]) => {
  const buf = readFileSync(f);
  return { name, min: statSync(f).size, gz: gzip(buf), br: brot(buf) };
});

/**
 * Which exports actually defer something, READ OFF THE ROWS.
 *
 * The first version of this note hard-coded "true of every export but
 * `./router`" and was false the moment it was generated, because
 * `./router-fetch` reaches `./blade` through the router and defers it too. A
 * sentence in generated prose that describes the table has to be derived from
 * the table, or it is one more hand-typed number waiting to drift - which is
 * the entire failure this script exists to prevent, reintroduced inside the
 * script itself. `--check` cannot catch it: it verifies marker bodies, and
 * this is free text.
 */
function deferredNote(rs) {
  const names = rs.filter((r) => r.lazy > 0).map((r) => `\`${r.name}\``);
  if (!names.length) return 'A `-` means nothing is deferred, currently true of every export.';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `A \`-\` means nothing is deferred, which is every export except ${list}.`;
}

/**
 * The first three columns are the historical measurement and keep their order:
 * `stamp-docs` reads rows by position, so anything new goes on the END.
 */
function mdTable(label, rs, split = false) {
  const head = split
    ? `| ${label} | min KB | gzip KB | brotli KB | first load KB | on demand KB |`
    : `| ${label} | min KB | gzip KB | brotli KB |`;
  const rule = split ? `|---|--:|--:|--:|--:|--:|` : `|---|--:|--:|--:|`;
  const out = [head, rule];
  for (const r of rs) {
    const base = `| \`${r.name}\` | ${kb(r.min)} | ${kb(r.gz)} | ${kb(r.br)} |`;
    // A dash, not 0.0: nothing is deferred, which is different from deferring
    // something that happens to be tiny.
    out.push(split ? `${base} ${kb(r.first ?? r.br)} | ${r.lazy ? kb(r.lazy) : '-'} |` : base);
  }
  return out.join('\n');
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ esm: esmRows, iife: iifeRows }, null, 2));
} else if (process.argv.includes('--md')) {
  console.log(`<!-- GENERATED by \`npm run size:doc\` (scripts/measure-size.mjs) - do not edit by hand. -->
# Bundle sizes: vapor-chamber v${pkg.version}

All numbers are **minified, comment-free brotli/gzip** - esbuild \`--minify\` for the ESM
exports (so comments never count), the pre-minified \`.min.js\` for IIFE, then brotli q=11 /
gzip level 9. This is the real over-the-wire cost of the *code*, not the commented source.
Regenerated by \`npm run size:doc\`, verified fresh in CI. **Hard ceilings apply to the IIFE
variants only** (\`scripts/check-size.mjs\` budgets those three files); the ESM rows below are
measured and published every run, but nothing fails a build when one grows. This line used to
promise ceilings over the whole document.

## ESM subpath exports

Each row is the cost of importing **only that export**, bundled self-contained with \`vue\`
external. **Read this carefully:** the shared command-bus core (~3.6 KB brotli on its own) is
included in *every* row, so the rows are **not additive** - importing two exports does not cost
their sum (the core is shared once). \`.\` is the full main barrel measured *import-everything*;
your app's tree-shaking drops whatever you don't use (e.g. importing just \`createCommandBus\`
from it is ~3.6 KB brotli, not ${kb(esmRows[0]?.br ?? 0)} KB).

**brotli vs first load.** \`brotli\` bundles each export into ONE file, which is the
historical measurement and the one to compare against older releases. \`first load\` and
\`on demand\` come from a second pass with code splitting enabled - what an app's bundler
actually emits. Where a module is deferred behind an \`import()\`, the single-file pass has
to inline it *and* add the async wrapper, so it reports a feature nobody uses as slightly
*more* expensive than shipping it eagerly. **\`first load\` is what a consumer downloads to
start; \`on demand\` is fetched only if that feature is used.** ${deferredNote(esmRows)} No row here is budgeted - see the note above.

${mdTable('export', esmRows, true)}

## IIFE variants (\`<script>\` drop-ins)

${mdTable('variant', iifeRows)}`);
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const padl = (s, n) => String(s).padStart(n);
  const line = (a, b, c, d, e) => `${pad(a, 26)}${padl(b, 9)}${padl(c, 9)}${padl(d, 10)}${padl(e, 11)}`;
  console.log(line('entry (minified)', 'min KB', 'gzip KB', 'brotli KB', 'first load'));
  console.log('-'.repeat(65));
  for (const r of [...esmRows, ...iifeRows]) {
    console.log(line(r.name, kb(r.min), kb(r.gz), kb(r.br), r.lazy ? `${kb(r.first)} +${kb(r.lazy)}` : '-'));
  }
}
