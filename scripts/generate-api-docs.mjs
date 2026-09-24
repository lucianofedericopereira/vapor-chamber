/**
 * generate-api-docs - the API reference, written from the compiler rather than
 * by hand, as Markdown committed into the repo.
 *
 * WHY THIS EXISTS AT ALL, given typedoc did the job: typedoc cannot run on
 * TypeScript 7. That is not a version-range conservatism to override - the Go
 * port drops the JS compiler API entirely (`typescript`'s exports map is now
 * `lib/version.cjs` plus `unstable/*`, with no `lib/typescript.js`), and typedoc
 * crashes during module evaluation reading `SyntaxKind` off an undefined import.
 * There is no released typedoc that survives it: 0.28.20 is latest, and the
 * `1.0.0-dev.*` tags on npm are abandoned 2020 prereleases, not a port.
 *
 * WHY HAND-ROLLED rather than assembling typedoc's own pieces: `typedoc/models`
 * and `typedoc/browser` do import cleanly under TS 7 (only the converter is
 * coupled), so reusing them is technically possible. Two reasons not to. The
 * renderer is not separately importable - converter, renderer and CLI are one
 * `dist/index.js` that dies on evaluation - so their HTML could only be
 * re-implemented, not imported. And typedoc is Apache-2.0 while this package is
 * LGPL-2.1: fine as a dev tool, not fine to paste into `scripts/`, which
 * `package.json` "files" publishes in the npm tarball.
 *
 * WHY MARKDOWN, which is the reason this file has no dependencies: typedoc's
 * five runtime deps all serve HTML. markdown-it turns doc comments into HTML,
 * but JSDoc bodies are already Markdown and pass straight through. mini-shiki
 * highlights code, which a fenced block gets for free. lunr indexes a static
 * site for search. Emitting Markdown deletes the need for all of them, matches
 * how every other generated doc here works (`measure-size.mjs --md`,
 * `measure-coverage.mjs --md`), and buys one thing typedoc could not: the
 * output is committed, so an added or changed export shows up in the diff
 * instead of vanishing into a gitignored HTML build.
 *
 * THE ENTRY POINTS ARE DERIVED, NOT LISTED. typedoc.json carried a hand-kept
 * array and it had drifted: it named 18 while `exports` published 23, leaving
 * `./vue`, `./vapor`, `./store`, `./router/vapor` and `./router/remote` shipped
 * and undocumented. Reading `package.json` "exports" instead means the
 * reference covers exactly the public surface, by construction. The `iife`
 * entries are skipped on purpose - they install a global rather than export a
 * module, and their surface is the variant contract in docs/, not this.
 *
 * Aliases are resolved before anything is read off a symbol: `src/index.ts` is
 * a re-export barrel, so an unresolved alias reports an empty doc comment and a
 * bare type. That was the first thing to get wrong when writing this.
 *
 * Run: node scripts/generate-api-docs.mjs         write docs/api/
 *      node scripts/generate-api-docs.mjs --list  entry points, no write
 *
 * CI runs it and then `git diff --exit-code docs/api`, the same freshness
 * pattern as docs/BUNDLE-SIZES.md and docs/COVERAGE.md.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const OUT_DIR = 'docs/api';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

/**
 * Source links are built from `repository`, not from a hardcoded URL, and the
 * heading uses `name`. Both were literals until a fixture with a different
 * package name rendered someone else's identity into its own reference. With
 * no `repository` field the paths still print, just without links.
 */
const REPO = String(pkg.repository?.url ?? pkg.repository ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '');
const BLOB = REPO ? `${REPO}/blob/main` : '';

/** `[`path`](url)` when the package declares a repository, plain code if not. */
const sourceLink = (file, label = `\`${file}\``) => (BLOB ? `[${label}](${BLOB}/${file})` : label);

/**
 * Public subpath -> source file, from "exports". The `import` condition is the
 * dist path; the source beside it is what the compiler needs.
 */
const entryPoints = Object.entries(pkg.exports)
  .filter(([subpath]) => subpath !== './package.json' && !subpath.includes('iife'))
  .map(([subpath, conditions]) => ({
    subpath,
    specifier: subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
    file: conditions.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'),
  }));

if (process.argv.includes('--list')) {
  for (const entry of entryPoints) console.log(`${entry.specifier.padEnd(34)} ${entry.file}`);
  process.exit(0);
}

const { options } = ts.parseJsonConfigFileContent(
  JSON.parse(readFileSync('tsconfig.json', 'utf8')),
  ts.sys,
  '.',
);
const program = ts.createProgram(
  entryPoints.map((entry) => entry.file),
  options,
);
const checker = program.getTypeChecker();

const isAlias = (symbol) => (symbol.flags & ts.SymbolFlags.Alias) !== 0;
const resolve = (symbol) => (isAlias(symbol) ? checker.getAliasedSymbol(symbol) : symbol);

/**
 * Resolved symbol -> the name it is EXPORTED under, when the two differ.
 *
 * Resolving an alias is required for `@internal` and for the type, but it also
 * renames the symbol, and the declaration's name is not always the public one.
 * `src/vitest.ts` does `export { expect }` on a binding Vitest declares as
 * `globalExpect`, so the reference published `globalExpect` - a name that is
 * not importable from this package - and omitted `expect`, which is. The same
 * shape as the `v-vc:payload` drift: a documented spelling nothing compiles.
 *
 * Rebuilt per entry point, because one declaration can be exported under
 * different names by different entries and the program is shared across them.
 */
const publicNames = new Map();
const nameOf = (symbol) => publicNames.get(symbol) ?? symbol.name;

/**
 * Ordered because the first match wins and the flags overlap: a class carries
 * the Value flag too, an enum member carries Property. Interface before Type
 * for the same reason.
 *
 * Plurals are spelled out rather than suffixed with "s" - the first draft did
 * that and published a heading reading "Type aliass".
 */
const KINDS = [
  ['Function', 'Functions', ts.SymbolFlags.Function],
  ['Class', 'Classes', ts.SymbolFlags.Class],
  ['Interface', 'Interfaces', ts.SymbolFlags.Interface],
  ['Type alias', 'Type aliases', ts.SymbolFlags.TypeAlias],
  ['Enum', 'Enums', ts.SymbolFlags.Enum],
  ['Variable', 'Variables', ts.SymbolFlags.Variable],
  ['Namespace', 'Namespaces', ts.SymbolFlags.Module],
];

function kindOf(symbol) {
  for (const [label, , flag] of KINDS) if (symbol.flags & flag) return label;
  return 'Value';
}

const pluralOf = (kind) => KINDS.find(([label]) => label === kind)?.[1] ?? kind;

const tagsOf = (symbol) => symbol.getJsDocTags(checker);
const docOf = (symbol) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
const tagText = (tag) => ts.displayPartsToString(tag.text).trim();

/**
 * A `const` arrow function is a Variable whose type happens to have call
 * signatures, so the type drives this rather than the symbol flags. Signatures
 * are rendered one per line; NoTruncation because the default elides at 160
 * characters, which silently amputates the generic-heavy signatures here.
 *
 * Type aliases and interfaces are printed from their DECLARATION TEXT, not
 * through the checker. Asking the checker to stringify a generic alias yields
 * the bare word "any" - `ChamberStore<S, A>` rendered exactly that way in the
 * first output - because there is no instantiation to describe. The source
 * line is both correct and what a reader wants to see.
 */
function signatureOf(symbol) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];

  if (declaration && (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration))) {
    return declaration.getText().split('\n');
  }

  const type = declaration
    ? checker.getTypeOfSymbolAtLocation(symbol, declaration)
    : checker.getDeclaredTypeOfSymbol(symbol);
  const calls = type.getCallSignatures();
  const format = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrowStyleSignature;
  if (calls.length) {
    return calls.map((call) => `${nameOf(symbol)}${checker.signatureToString(call, declaration, format)}`);
  }
  return [`${nameOf(symbol)}: ${checker.typeToString(type, declaration, format)}`];
}

/** `src/router/engine.ts:120`, linked to the repo, or null for a synthesized symbol. */
function sourceOf(symbol) {
  const declaration = symbol.declarations?.[0];
  if (!declaration) return null;
  const sourceFile = declaration.getSourceFile();
  if (sourceFile.fileName.includes('node_modules')) return null;
  const file = sourceFile.fileName.replace(`${process.cwd()}/`, '');
  const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1;
  return { file, line };
}

/** True when signatureOf printed the declaration verbatim. */
function printsSource(symbol) {
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  return Boolean(
    declaration && (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)),
  );
}

/**
 * Members of an interface or type alias, one row each. Only the shape's own
 * properties: inherited members belong to the type they came from, and listing
 * them again is how a reference stops being readable.
 *
 * Skipped entirely when the declaration was printed verbatim above, which is
 * every alias and interface: the source block already lists these members WITH
 * their comments, so the table was restating it at roughly a third of the total
 * output size.
 */
function membersOf(symbol) {
  if (printsSource(symbol)) return [];
  if (!(symbol.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) return [];
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  const own = new Set(symbol.members ? [...symbol.members.keys()] : []);
  return type
    .getProperties()
    .filter((member) => own.size === 0 || own.has(member.escapedName))
    .map((member) => ({
      name: member.name,
      optional: (member.flags & ts.SymbolFlags.Optional) !== 0,
      type: checker.typeToString(
        checker.getTypeOfSymbolAtLocation(member, member.declarations?.[0] ?? symbol.declarations[0]),
        undefined,
        ts.TypeFormatFlags.NoTruncation,
      ),
      // Whole comment, newlines folded by escapeCell. Taking the first LINE
      // instead cut mid-sentence at whatever column the source happened to wrap.
      doc: docOf(member),
    }));
}

// Underscores SURVIVE. GitHub's slugger strips punctuation but keeps `_` and
// `-`, so `ERROR_CODE_REGISTRY` anchors as `error_code_registry`. Folding `_`
// into `-` here made every SCREAMING_SNAKE entry in a Contents list a dead
// link - seven of them, across index, mcp, router and vitest-mcp - while the
// sections they pointed at were correct and present.
const anchor = (name) => name.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-|-$/g, '');
const escapeCell = (text) => text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

function renderSymbol(symbol) {
  const out = [];
  const source = sourceOf(symbol);
  const tags = tagsOf(symbol);

  out.push(`### ${nameOf(symbol)}`, '');
  const meta = [`**${kindOf(symbol)}**`];
  if (source) {
    meta.push(
      BLOB
        ? `[${source.file}:${source.line}](${BLOB}/${source.file}#L${source.line})`
        : `${source.file}:${source.line}`,
    );
  }
  out.push(meta.join(' - '), '');

  const deprecated = tags.find((tag) => tag.name === 'deprecated');
  if (deprecated) out.push(`> **Deprecated.** ${tagText(deprecated) || 'See below.'}`, '');

  out.push('```ts', ...signatureOf(symbol), '```', '');

  const doc = docOf(symbol);
  if (doc) out.push(doc, '');

  const params = tags.filter((tag) => tag.name === 'param');
  if (params.length) {
    out.push('| parameter | description |', '|---|---|');
    for (const tag of params) {
      const text = tagText(tag);
      const space = text.indexOf(' ');
      const name = space === -1 ? text : text.slice(0, space);
      out.push(`| \`${name}\` | ${escapeCell(space === -1 ? '' : text.slice(space + 1))} |`);
    }
    out.push('');
  }

  const returns = tags.find((tag) => tag.name === 'returns');
  if (returns) out.push(`**Returns:** ${tagText(returns)}`, '');

  const members = membersOf(symbol);
  if (members.length) {
    out.push('| member | type | description |', '|---|---|---|');
    for (const member of members) {
      const name = `\`${member.name}${member.optional ? '?' : ''}\``;
      out.push(`| ${name} | \`${escapeCell(member.type)}\` | ${escapeCell(member.doc)} |`);
    }
    out.push('');
  }

  for (const tag of tags.filter((tag) => tag.name === 'example')) {
    const text = tagText(tag);
    out.push(text.includes('```') ? text : ['```ts', text, '```'].join('\n'), '');
  }

  const see = tags.filter((tag) => tag.name === 'see');
  if (see.length) out.push(`**See also:** ${see.map(tagText).join(', ')}`, '');

  return out.join('\n');
}

function renderEntry(entry) {
  const sourceFile = program.getSourceFile(entry.file);
  if (!sourceFile) throw new Error(`[generate-api-docs] no source file for ${entry.file}`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) throw new Error(`[generate-api-docs] ${entry.file} exports nothing`);

  // `@internal` is honoured on the RESOLVED symbol: the barrel re-export never
  // carries the tag, only the declaration does.
  publicNames.clear();
  const symbols = checker
    .getExportsOfModule(moduleSymbol)
    .map((exported) => {
      const resolved = resolve(exported);
      if (resolved.name !== exported.name) publicNames.set(resolved, exported.name);
      return resolved;
    })
    .filter((symbol) => !tagsOf(symbol).some((tag) => tag.name === 'internal'))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  const grouped = new Map();
  for (const symbol of symbols) {
    const kind = kindOf(symbol);
    if (!grouped.has(kind)) grouped.set(kind, []);
    grouped.get(kind).push(symbol);
  }
  const order = KINDS.map(([label]) => label).filter((label) => grouped.has(label));

  const body = [
    `<!-- GENERATED by \`npm run docs\` (scripts/generate-api-docs.mjs) - do not edit by hand. -->`,
    `# \`${entry.specifier}\``,
    '',
    `Source: ${sourceLink(entry.file)}. ` +
      `${symbols.length} public export${symbols.length === 1 ? '' : 's'}.`,
    '',
    '```ts',
    `import { ... } from '${entry.specifier}';`,
    '```',
    '',
  ];

  // One "Contents" heading rather than a per-kind list mirroring the body
  // headings: repeating `## Functions` twice in a file gives the two sections
  // colliding anchors, so every table-of-contents link landed on the wrong one.
  body.push('## Contents', '');
  for (const kind of order) {
    const links = grouped
      .get(kind)
      .map((symbol) => `[\`${nameOf(symbol)}\`](#${anchor(nameOf(symbol))})`);
    // Space-separated, not comma-separated. Each entry is a backticked name,
    // and on the site each also carries a kind icon, so the entries are
    // already delimited; the commas were punctuation doing no work.
    body.push(`**${pluralOf(kind)}:** ${links.join(' ')}`, '');
  }

  for (const kind of order) {
    body.push(`## ${pluralOf(kind)}`, '');
    for (const symbol of grouped.get(kind)) body.push(renderSymbol(symbol));
  }

  return { markdown: `${body.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, count: symbols.length };
}

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const index = [];
let total = 0;
for (const entry of entryPoints) {
  const { markdown, count } = renderEntry(entry);
  const name = `${entry.subpath === '.' ? 'index' : entry.subpath.slice(2).replace(/\//g, '-')}.md`;
  const path = join(OUT_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown);
  index.push({ name, entry, count });
  total += count;
}

writeFileSync(
  join(OUT_DIR, 'README.md'),
  `<!-- GENERATED by \`npm run docs\` (scripts/generate-api-docs.mjs) - do not edit by hand. -->
# ${pkg.name} v${pkg.version} API reference

Generated from the TypeScript compiler, so it cannot drift from the source. The
entry points below are derived from \`package.json\` "exports": every published
subpath is here, and nothing that is not published is.

The \`iife\` builds are deliberately absent. They install a \`VaporChamber\`
global instead of exporting a module, and their surface is a variant contract -
see [\`docs/BUNDLE-SIZES.md\`](../BUNDLE-SIZES.md).

**${total} public exports across ${index.length} entry points.**

| entry point | source | exports |
|---|---|--:|
${index
  .map(
    ({ name, entry, count }) =>
      `| [\`${entry.specifier}\`](${name}) | ${sourceLink(entry.file)} | ${count} |`,
  )
  .join('\n')}
`,
);

console.log(`api-docs: ${index.length} entry points, ${total} exports -> ${OUT_DIR}/`);
