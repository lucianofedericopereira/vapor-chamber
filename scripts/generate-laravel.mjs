/**
 * generate-laravel — Laravel backend codegen from a vapor-chamber schema.
 *
 * Third leg of the "define each command once" typed contract: the same schema
 * that types the bus (defineSchema), validates dispatches (schemaValidator),
 * and produces LLM tools (toTools) also generates the Laravel backend:
 *
 *   <out>/config/vapor-chamber.php        command → action-class registry
 *   <out>/app/Actions/<Studly>.php        one invokable action stub per command
 *
 * The stubs match examples/laravel-backend/ exactly: invokable classes with a
 * `__invoke($target, $payload, $user)` shape, resolved from the container by
 * VaporChamberController via config('vapor-chamber.handlers'). Field maps
 * become Validator::make() rules; the thrown ValidationException is mapped to
 * 422 + { ok: false, error } by the example controller.
 *
 * Action stubs contain user logic after the first run, so they are NEVER
 * overwritten unless --force. The config file is a pure registry and is
 * regenerated on every run.
 *
 * Run: node scripts/generate-laravel.mjs <schema-file> [--out <dir>] [--namespace <ns>] [--force]
 *   schema-file      .mjs/.js module (default export or named `schema`) or .json
 *   --out <dir>      output root (default ./laravel-out)
 *   --namespace <ns> PHP namespace for action classes (default App\Actions)
 *   --force          overwrite existing action stubs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'array', 'object', 'any']);

// FieldType → Laravel validation rule. 'any' means "no rule" (validated as null).
const RULES = {
  string: 'required|string',
  number: 'required|numeric',
  boolean: 'required|boolean',
  array: 'required|array',
  object: 'required|array',
  any: null,
};

// ---------------------------------------------------------------------------
// Naming — mirrors src/schema.ts normalizeSchema() so PHP names match the bus
// ---------------------------------------------------------------------------

function toCamel(s) {
  return s.replace(/[_.\-\s]+(.)/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
}

function toStudly(s) {
  const camel = toCamel(s);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`[generate-laravel] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { schemaFile: null, out: './laravel-out', namespace: 'App\\Actions', force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') args.force = true;
    else if (a === '--out') {
      if (!argv[i + 1]) fail('--out requires a directory argument');
      args.out = argv[++i];
    } else if (a === '--namespace') {
      if (!argv[i + 1]) fail('--namespace requires a namespace argument (e.g. App\\Actions)');
      args.namespace = argv[++i];
    } else if (a.startsWith('--')) fail(`Unknown option: ${a}`);
    else if (args.schemaFile) fail(`Unexpected extra argument: ${a}`);
    else args.schemaFile = a;
  }
  if (!args.schemaFile) {
    fail('Usage: node scripts/generate-laravel.mjs <schema-file> [--out <dir>] [--namespace <ns>] [--force]');
  }
  args.namespace = args.namespace.replace(/^\\+|\\+$/g, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\\[A-Za-z_][A-Za-z0-9_]*)*$/.test(args.namespace)) {
    fail(`Invalid PHP namespace: "${args.namespace}"`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Schema loading + validation
// ---------------------------------------------------------------------------

async function loadSchema(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`Schema file not found: ${abs}`);
  if (extname(abs) === '.json') {
    try {
      return JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      fail(`Could not parse JSON schema file: ${e.message}`);
    }
  }
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e) {
    fail(`Could not import schema module: ${e.message}`);
  }
  const schema = mod.default ?? mod.schema;
  if (schema === undefined) fail('Schema module must have a default export or a named export `schema`.');
  return schema;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Validate the BusSchema shape; exit(1) with a precise message on garbage. */
function validateSchema(schema) {
  if (!isPlainObject(schema)) fail(`Schema must be a plain object of { actionName: ActionSchema }, got ${schema === null ? 'null' : Array.isArray(schema) ? 'array' : typeof schema}.`);
  if (Object.keys(schema).length === 0) fail('Schema has no actions — nothing to generate.');
  for (const [action, def] of Object.entries(schema)) {
    if (!isPlainObject(def)) fail(`Action "${action}" must be an object, got ${def === null ? 'null' : typeof def}.`);
    if (def.description !== undefined && typeof def.description !== 'string') {
      fail(`Action "${action}": description must be a string.`);
    }
    if (def.authorize !== undefined && (typeof def.authorize !== 'string' || def.authorize === '')) {
      fail(`Action "${action}": authorize must be a non-empty ability name string.`);
    }
    for (const section of ['target', 'payload', 'result']) {
      const fields = def[section];
      if (fields === undefined) continue;
      if (!isPlainObject(fields)) fail(`Action "${action}": ${section} must be a field map object.`);
      for (const [field, type] of Object.entries(fields)) {
        if (!FIELD_TYPES.has(type)) {
          fail(`Action "${action}": ${section}.${field} has invalid type "${type}" (expected one of: ${[...FIELD_TYPES].join(', ')}).`);
        }
      }
    }
  }
}

/** Normalize action names to camelCase — same behavior as the bus at runtime. */
function normalizeSchema(schema) {
  const out = {};
  for (const [key, def] of Object.entries(schema)) {
    const normalized = toCamel(key);
    if (normalized !== key) console.warn(`[generate-laravel] Schema key "${key}" normalized to "${normalized}"`);
    out[normalized] = def;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PHP emitters
// ---------------------------------------------------------------------------

const phpString = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Docblock body lines from a description (a comment-terminator inside it is defused). */
const docLines = (text) =>
  text
    .replace(/\*\//g, '* /')
    .split('\n')
    .map((l) => ` * ${l}`.trimEnd());

function validationRules(def) {
  const rules = [];
  for (const section of ['target', 'payload']) {
    for (const [field, type] of Object.entries(def[section] ?? {})) {
      if (RULES[type]) rules.push([`${section}.${field}`, RULES[type]]);
    }
  }
  return rules;
}

function renderActionClass(action, def, namespace) {
  const className = toStudly(action);
  const rules = validationRules(def);
  const resultKeys = Object.keys(def.result ?? {});
  const ability = def.authorize;

  const doc = [
    '/**',
    ...(def.description ? [...docLines(def.description), ' *'] : []),
    ` * Handles the \`${action}\` command dispatched from the vapor-chamber bus.`,
    ...(ability ? [' *', ` * Requires the "${ability}" ability (Gate::authorize, enforced below).`] : []),
    ' *',
    ' * @generated by scripts/generate-laravel.mjs — edit freely, regeneration will not overwrite without --force',
    ' */',
  ];

  const body = [];
  if (ability) {
    // Authorization runs before validation — an unauthorized caller
    // shouldn't learn anything about the shape of the data it can't touch.
    body.push(`        Gate::forUser($user)->authorize(${phpString(ability)}, [$target, $payload]);`, '');
  }
  if (rules.length) {
    body.push(
      '        Validator::make(',
      "            ['target' => $target, 'payload' => $payload],",
      '            [',
      ...rules.map(([key, rule]) => `                ${phpString(key)} => ${phpString(rule)},`),
      '            ],',
      '        )->validate();',
      '',
    );
  }
  body.push('        // TODO: implement');
  if (resultKeys.length) {
    body.push('        return [', ...resultKeys.map((k) => `            ${phpString(k)} => null,`), '        ];');
  } else {
    body.push('        return [];');
  }

  const imports = [];
  if (ability) imports.push('use Illuminate\\Support\\Facades\\Gate;');
  if (rules.length) imports.push('use Illuminate\\Support\\Facades\\Validator;');

  return [
    '<?php',
    '',
    `namespace ${namespace};`,
    '',
    ...(imports.length ? [...imports, ''] : []),
    ...doc,
    `class ${className}`,
    '{',
    '    public function __invoke(mixed $target, mixed $payload, ?\\Illuminate\\Contracts\\Auth\\Authenticatable $user): mixed',
    '    {',
    ...body,
    '    }',
    '}',
    '',
  ].join('\n');
}

function renderConfig(schema, namespace) {
  const entries = Object.keys(schema).map((action) => [phpString(action), `\\${namespace}\\${toStudly(action)}::class`]);
  const width = Math.max(...entries.map(([key]) => key.length));
  return [
    '<?php',
    '/**',
    ' * vapor-chamber — command handler registry.',
    ' *',
    ' * Save as config/vapor-chamber.php in your Laravel project.',
    ' *',
    ' * Maps every command name (the first arg of `bus.dispatch(...)` on the',
    ' * client) to the action class that handles it. The controller resolves the',
    ' * class from the container, so constructor-injected dependencies work as',
    ' * normal.',
    ' *',
    ' * @generated by scripts/generate-laravel.mjs — regenerated on every run, do not edit by hand.',
    ' */',
    '',
    'return [',
    '    /*',
    '    |--------------------------------------------------------------------------',
    '    | Command handler registry',
    '    |--------------------------------------------------------------------------',
    '    |',
    '    | Each entry maps a command name to a fully-qualified action class.',
    '    | Action classes implement a single __invoke($target, $payload, $user)',
    '    | method and return any JSON-serializable shape (the client receives it',
    '    | as `result.value`).',
    '    |',
    '    */',
    "    'handlers' => [",
    ...entries.map(([key, cls]) => `        ${key.padEnd(width)} => ${cls},`),
    '    ],',
    '];',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const rawSchema = await loadSchema(args.schemaFile);
validateSchema(rawSchema);
const schema = normalizeSchema(rawSchema);

const outDir = resolve(args.out);
const actionsDir = join(outDir, 'app', 'Actions');
const configFile = join(outDir, 'config', 'vapor-chamber.php');
mkdirSync(actionsDir, { recursive: true });
mkdirSync(dirname(configFile), { recursive: true });

const report = (status, file) => console.log(`  ${status.padEnd(11)} ${relative(process.cwd(), file)}`);

// Action stubs — never clobber user logic without --force.
for (const [action, def] of Object.entries(schema)) {
  const file = join(actionsDir, `${toStudly(action)}.php`);
  const exists = existsSync(file);
  if (exists && !args.force) {
    report('skipped', file);
    continue;
  }
  writeFileSync(file, renderActionClass(action, def, args.namespace));
  report(exists ? 'overwritten' : 'created', file);
}

// Config — pure registry, always regenerated.
const configExisted = existsSync(configFile);
writeFileSync(configFile, renderConfig(schema, args.namespace));
report(configExisted ? 'overwritten' : 'created', configFile);

console.log(`✓ Generated Laravel backend for ${Object.keys(schema).length} command(s) in ${relative(process.cwd(), outDir) || '.'}`);
