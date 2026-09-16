/**
 * measure-size - honest shipped-size table for every published entry.
 *
 * The size that matters is brotli of the CODE a consumer ships. Since v1.20.0
 * every ESM row is a VITE PRODUCTION BUILD of the built export in `dist/` -
 * `process.env.NODE_ENV` defined, minified, `vue` external - which is what a
 * consumer's bundler emits: comments gone, and the dev-only diagnostics folded
 * away. Until then the rows were esbuild bundles of the source with no define,
 * and that build keeps every DEV-only branch a production build drops, so
 * every row read about 10% high (the consumer row: 6,971 esbuild against
 * 6,230 Vite, measured 2026-09-15). tests/esm-treeshake.test.ts and
 * tests/vapor/vapor-outlet-size.test.ts had already moved their ceilings to
 * the Vite number; this table now measures the same artifact they gate.
 * IIFE variants ship minified, so we read the built .min.js directly.
 *
 * Run: node scripts/measure-size.mjs            human table (default)
 *      node scripts/measure-size.mjs --json      machine-readable
 *      node scripts/measure-size.mjs --md         full generated doc (docs/BUNDLE-SIZES.md)
 *
 * `npm run size:doc` writes --md to docs/BUNDLE-SIZES.md; CI regenerates and
 * `git diff --exit-code`s it, so the published numbers can never drift from reality.
 * Needs `npm run build` first: every row reads `dist/`.
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import zlib from 'node:zlib';
import { build as viteBuild } from 'vite';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
const brot = (buf) => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
const gzip = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (n) => (n / 1024).toFixed(1);
const dist = (f) => resolve(process.cwd(), 'dist', f);

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
 * Each row is the built file `exports` points at, so a stale exports entry
 * degrades to a missing row rather than a crash.
 *
 * (`./router` is deliberately renderer-free - the outlets and blade components
 * live behind `./router/vdom` and `./router/vapor` so a consumer pays only for
 * the renderer it renders through. See tests/router/vdom-boundary.test.ts and
 * tests/router/vapor-boundary.test.ts.)
 */
const esm = Object.entries(pkg.exports ?? {}).flatMap(([subpath, value]) => {
  const file = typeof value === 'string' ? value : (value?.import ?? value?.default);
  if (typeof file !== 'string' || !file.endsWith('.js')) return [];
  return [[subpath, resolve(process.cwd(), file)]];
});
const iife = [
  ['vapor-chamber (full)', 'dist/vapor-chamber.iife.min.js'],
  ['vapor-chamber-core', 'dist/vapor-chamber-core.iife.min.js'],
  ['vapor-chamber-elements', 'dist/vapor-chamber-elements.iife.min.js'],
];

// `vitest` is the test entry's peer, external like Vue: the `./vitest` row is
// what the entry adds to a test run, not Vitest itself.
// The `./vitest/mcp` row runs in Node: its Vitest API and Node's built-ins are not what it adds.
const EXTERNAL = ['vue', '@vue/devtools-api', '@vue/reactivity', 'vitest', 'vitest/node', /^node:/];
let entrySeq = 0;

/**
 * One Vite production build, in memory. `input` is either a file (an export's
 * built entry, which keeps every export of that module - the import-everything
 * measurement) or a virtual module carrying `code` (the consumer-shaped rows
 * below; a virtual entry resolves its bare imports from the repo root, so
 * `vue` and `mitt` are found without a file on disk).
 *
 * ONE build answers both questions the table asks. Rollup splits every
 * `import()` into its own chunk, so `first` is the chunks reachable from the
 * entry through STATIC imports - what a consumer downloads to start - and
 * `lazy` is the rest, fetched only if the feature is used. `min` / `gz` / `br`
 * join every chunk, the historical single-file measurement. Reachability, not
 * the entry flag: a chunk split out for a dynamic import is not startup cost,
 * and a chunk without the flag can be shared code the entry imports statically,
 * which is how `./router-fetch` reaches the http client.
 */
async function bundle(input, code, { bundleVue = false } = {}) {
  const id = code === undefined ? input : `\0vc-size-entry-${++entrySeq}`;
  const res = await viteBuild({
    configFile: false, root: process.cwd(), logLevel: 'silent', mode: 'production',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: code === undefined ? [] : [{
      name: 'vc-size-entry',
      resolveId: (source) => (source === input ? id : null),
      load: (source) => (source === id ? code : null),
    }],
    build: {
      write: false, minify: true, target: 'es2022', modulePreload: false,
      rollupOptions: {
        input,
        external: bundleVue ? EXTERNAL.filter((e) => e === '@vue/devtools-api') : EXTERNAL,
        output: { format: 'es' },
        // An app build drops an entry's unused exports; a library row IS its
        // exports (measured: every ESM row read 0.0 without this).
        preserveEntrySignatures: 'strict',
      },
    },
  });
  const chunks = (Array.isArray(res) ? res : [res]).flatMap((r) => ('output' in r ? r.output : [])).filter((o) => o.type === 'chunk');
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const eager = new Set();
  for (const queue = chunks.filter((c) => c.isEntry).map((c) => c.fileName); queue.length; ) {
    const name = queue.pop();
    if (eager.has(name) || !byName.has(name)) continue;
    eager.add(name);
    queue.push(...byName.get(name).imports);
  }
  const join = (list) => Buffer.from(list.map((c) => c.code).join('\n'));
  const all = join(chunks);
  const lazyChunks = chunks.filter((c) => !eager.has(c.fileName));
  return {
    min: all.length, gz: gzip(all), br: brot(all),
    first: brot(join(chunks.filter((c) => eager.has(c.fileName)))),
    lazy: lazyChunks.length ? brot(join(lazyChunks)) : 0,
  };
}

async function esmRow(name, entry) {
  return { name, ...(await bundle(entry)) };
}

/**
 * The "typical Blade consumer" bundle - the shape docs/performance.md quotes.
 *
 * The same entry text as tests/esm-treeshake.test.ts builds and gates, kept
 * global name included, so this row IS that test's number. The doc used to
 * carry a hand-typed "5.5 KB brotli" here, which had drifted ~18% low by the
 * time anyone re-measured. A number that appears in prose comes from this
 * script.
 */
async function consumerRow() {
  if (!existsSync(dist('index.js')) || !existsSync(dist('transports.js'))) return null;
  const code = [
    `import { createCommandBus, logger } from '${dist('index.js')}';`,
    `import { createHttpBridge } from '${dist('transports.js')}';`,
    `const bus = createCommandBus();`,
    `bus.use(logger());`,
    `bus.use(createHttpBridge({ endpoint: '/api' }));`,
    `globalThis.__vc_test = bus;`,
  ].join('\n');
  return { name: 'consumer: createCommandBus + logger + createHttpBridge', ...(await bundle('vc:consumer', code)) };
}

/**
 * The dispatch core ALONE - `createCommandBus` and nothing else.
 *
 * This is the "KB brotli core" the README leads with, and until v1.17.0 it was
 * hand-typed in three separate places with no generator behind it. Same rule
 * as `consumerRow` above, and the same reason: a number that appears in prose
 * comes from this script, or it drifts.
 */
async function coreRow() {
  if (!existsSync(dist('index.js'))) return null;
  const code = [
    `import { createCommandBus } from '${dist('index.js')}';`,
    `globalThis.__vc_size_probe = createCommandBus();`,
  ].join('\n');
  return { name: 'core: createCommandBus alone', ...(await bundle('vc:core', code)) };
}

/**
 * Vapor wiring, Vue BUNDLED (the only rows where it is), so the cost of a
 * static Vue import shows. `vapor-chamber/vapor` wires three of the five
 * Vapor names `configureVue` reads and leaves two out; src/vapor.ts carries
 * the measurement that decided the split, taken on the vapor-sfc example at
 * rc.6, and the README quotes the deltas. These rows re-take them on every
 * run, from `dist/`: the first row is a hand-wired minimum (`createVaporApp`
 * alone, the composables from `vapor-chamber/vue`), each row after it is the
 * DIFFERENCE from the row above - the columns are deltas, not sizes.
 */
async function vaporWiringRows() {
  if (!existsSync(dist('vapor.js')) || !existsSync(dist('vue.js'))) return [];
  const opts = { bundleVue: true };
  const steps = [
    ['Vapor wiring: hand-wired createVaporApp', [
      `import '${dist('vue.js')}';`,
      `import { createVaporApp } from 'vue';`,
      `import { configureVue } from '${dist('index.js')}';`,
      `configureVue({ createVaporApp });`,
      `globalThis.__vc_wiring = createVaporApp;`,
    ]],
    ['vapor-chamber/vapor over that', [
      `import '${dist('vapor.js')}';`,
      `globalThis.__vc_wiring = 1;`,
    ]],
    ['+ defineVaporCustomElement', [
      `import { configureVue } from '${dist('vapor.js')}';`,
      `import { defineVaporCustomElement } from 'vue';`,
      `configureVue({ defineVaporCustomElement });`,
      `globalThis.__vc_wiring = 1;`,
    ]],
    ['+ vaporInteropPlugin', [
      `import { configureVue } from '${dist('vapor.js')}';`,
      `import { defineVaporCustomElement, vaporInteropPlugin } from 'vue';`,
      `configureVue({ defineVaporCustomElement, vaporInteropPlugin });`,
      `globalThis.__vc_wiring = 1;`,
    ]],
  ];
  const rows = [];
  let prev = null;
  for (const [name, lines] of steps) {
    const r = await bundle(`vc:wiring-${rows.length}`, lines.join('\n'), opts);
    rows.push(prev ? { name, min: r.min - prev.min, gz: r.gz - prev.gz, br: r.br - prev.br } : { name, min: r.min, gz: r.gz, br: r.br });
    prev = r;
  }
  return rows;
}

/**
 * mitt, for the migration guide's comparison - bundled the same way, from the
 * devDependency, so "~200 bytes" is a measurement rather than a memory.
 */
async function mittRow() {
  try {
    return { name: 'mitt', ...(await bundle('vc:mitt', `import mitt from 'mitt';\nglobalThis.__vc_mitt = mitt();`)) };
  } catch {
    return null;
  }
}

const esmRows = [];
for (const [n, e] of esm.filter(([, e]) => existsSync(e))) esmRows.push(await esmRow(n, e));
const core = await coreRow();
if (core) esmRows.push(core);
const consumer = await consumerRow();
if (consumer) esmRows.push(consumer);
const wiringRows = await vaporWiringRows();
const mitt = await mittRow();
const iifeRows = iife.filter(([, f]) => existsSync(f)).map((name_f) => {
  const [name, f] = name_f;
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
  console.log(JSON.stringify({ esm: esmRows, wiring: wiringRows, mitt, iife: iifeRows }, null, 2));
} else if (process.argv.includes('--md')) {
  const coreKb = kb(core?.br ?? 0);
  console.log(`<!-- GENERATED by \`npm run size:doc\` (scripts/measure-size.mjs) - do not edit by hand. -->
# Bundle sizes: vapor-chamber v${pkg.version}

All numbers are **minified, comment-free brotli/gzip** of what a consumer ships: a Vite production
build of each built export (\`process.env.NODE_ENV\` defined, minified, \`vue\` external - so dev-only
diagnostics fold away as they do in an app build), the pre-minified \`.min.js\` for IIFE, then
brotli q=11 / gzip level 9. Until v1.20.0 the ESM rows were esbuild bundles of the source with no
define, which kept the DEV-only branches a production build drops: about 10% high. Regenerated by
\`npm run size:doc\`, verified fresh in CI. **Hard ceilings apply to the IIFE variants only**
(\`scripts/check-size.mjs\` budgets those three files); the ESM rows below are measured and published
every run, but nothing fails a build when one grows. This line used to promise ceilings over the
whole document.

## ESM subpath exports

Each row is the cost of importing **only that export**, bundled self-contained with \`vue\`
external. **Read this carefully:** the shared command-bus core (${coreKb} KB brotli on its own) is
included in *every* row, so the rows are **not additive** - importing two exports does not cost
their sum (the core is shared once). \`.\` is the full main barrel measured *import-everything*;
your app's tree-shaking drops whatever you don't use (e.g. importing just \`createCommandBus\`
from it is ${coreKb} KB brotli, not ${kb(esmRows[0]?.br ?? 0)} KB).

**brotli vs first load.** \`brotli\` joins every chunk of the build into one measurement, the
historical figure and the one to compare against older releases. \`first load\` and \`on demand\`
split the same chunks by reachability: a module behind an \`import()\` is its own chunk, and only
the chunks the entry reaches through static imports count as startup cost. **\`first load\` is
what a consumer downloads to start; \`on demand\` is fetched only if that feature is used.**
${deferredNote(esmRows)} No row here is budgeted - see the note above.

${mdTable('export', esmRows, true)}

## Vapor wiring, Vue bundled

The only rows with \`vue\` **bundled**, so a static Vue import shows its cost. The first row is a
hand-wired minimum: \`createVaporApp\` from \`vue\`, handed to \`configureVue\`, with the composables
from \`vapor-chamber/vue\`. Each row after it is the **difference from the row above** - what
\`vapor-chamber/vapor\` adds over hand-wiring (it wires \`defineVaporComponent\` and
\`defineVaporAsyncComponent\` as well), then each of the two names it leaves out, wired by hand.
The split was decided on the same measurement taken on the vapor-sfc example at rc.6
(src/vapor.ts); these rows re-take it from \`dist/\` on every run.

${mdTable('step (rows after the first are deltas)', wiringRows)}

## For comparison

${mitt ? mdTable('library', [mitt]) : '(mitt not installed)'}

## IIFE variants (\`<script>\` drop-ins)

${mdTable('variant', iifeRows)}`);
} else {
  const pad = (s, n) => String(s).padEnd(n);
  const padl = (s, n) => String(s).padStart(n);
  const line = (a, b, c, d, e) => `${pad(a, 44)}${padl(b, 9)}${padl(c, 9)}${padl(d, 10)}${padl(e, 11)}`;
  console.log(line('entry (minified)', 'min KB', 'gzip KB', 'brotli KB', 'first load'));
  console.log('-'.repeat(83));
  for (const r of [...esmRows, ...wiringRows, ...(mitt ? [mitt] : []), ...iifeRows]) {
    console.log(line(r.name, kb(r.min), kb(r.gz), kb(r.br), r.lazy ? `${kb(r.first)} +${kb(r.lazy)}` : '-'));
  }
}
