/**
 * generate-contract - the wire contract as Pact V4 files, one per group.
 *
 * Reads the case table (scripts/contract-cases.mjs) and writes
 * contract/<group>.pact.json, and the fixture action's PHP class into
 * php/src/Contract/Fixture/. `npm run docs` runs it and the gate diffs both
 * folders, so a case edited without regenerating fails the gate. The same
 * files serve both sides: `pact-verifier` replays them against a backend
 * (scripts/verify-contract.mjs), and tests/wire-contract.test.ts replays them
 * against the client.
 *
 * What a file asserts follows docs/contract.md section 4: the request the
 * client sends (method, path, `Content-Type` and `Accept`, the idempotency key
 * header or a batch item's `headers` member, the body) and the response
 * members the client reads. A problem's `detail`
 * matches any string. No response Content-Type: the client does not read it.
 *
 * Run: node scripts/generate-contract.mjs
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, fixtureSchema } from './contract-cases.mjs';

const OUT = fileURLToPath(new URL('../contract/', import.meta.url));
const JSON_TYPE = 'application/json';
const ANY_TEXT = 'Any text.';
const BY_TYPE = { combine: 'AND', matchers: [{ match: 'type' }] };

const body = (content) => ({ content, contentType: JSON_TYPE, encoded: false });

/** A key as the `Idempotency-Key` value: a Structured Field String, percent-encoded (src/transports.ts). */
const keyHeader = (key) => `"${encodeURIComponent(key)}"`;

/** The request the client sends for a row, as the transports build it (src/transports.ts). */
function request(r) {
  if (r.get) return { method: 'GET', path: r.get };
  const headers = { 'Content-Type': [JSON_TYPE], Accept: ['application/json, application/problem+json'] };
  if (r.batch) {
    const commands = r.batch.map(({ key, ...command }) => (key === undefined ? command : { ...command, headers: { 'Idempotency-Key': keyHeader(key) } }));
    return { method: 'POST', path: '/api/vc/batch', headers, body: body({ commands }) };
  }
  const content = { command: r.command, target: r.target ?? {} };
  if (r.payload !== undefined) content.payload = r.payload;
  if (r.key !== undefined) headers['Idempotency-Key'] = [keyHeader(r.key)];
  return { method: 'POST', path: '/api/vc', headers, body: body(content) };
}

/** The response members the client reads, with a type matcher on each `detail`. */
function response(r) {
  const out = { status: r.status };
  if (r.headers) out.headers = Object.fromEntries(Object.entries(r.headers).map(([name, value]) => [name, [value]]));
  const rules = {};
  if (r.problem) {
    const { code, type, title } = r.problem;
    const content = { status: r.status, code, detail: ANY_TEXT, ...(type === undefined ? {} : { type }), ...(title === undefined ? {} : { title }) };
    rules['$.detail'] = BY_TYPE;
    if (r.problem.errors) {
      content.errors = r.problem.errors.map((pointer) => ({ pointer, detail: ANY_TEXT }));
      rules['$.errors[*].detail'] = BY_TYPE;
    }
    out.body = body(content);
  } else if (r.body !== undefined) {
    const content = structuredClone(r.body);
    content.results?.forEach((result, i) => {
      if (!result.problem) return;
      result.problem.detail = ANY_TEXT;
      rules[`$.results[${i}].problem.detail`] = BY_TYPE;
    });
    out.body = body(content);
  }
  if (Object.keys(rules).length) out.matchingRules = { body: rules };
  return out;
}

const groups = new Map();
for (const c of cases) {
  const interaction = {
    type: 'Synchronous/HTTP',
    description: c.id,
    ...(c.state ? { providerStates: [c.state] } : {}),
    request: request(c.request),
    response: response(c.response),
  };
  if (!groups.has(c.group)) groups.set(c.group, []);
  groups.get(c.group).push(interaction);
}

mkdirSync(OUT, { recursive: true });
const written = new Set();
for (const [group, interactions] of groups) {
  const pact = {
    consumer: { name: 'vapor-chamber' },
    provider: { name: 'vapor-chamber-backend' },
    interactions,
    metadata: { pactSpecification: { version: '4.0' } },
  };
  const file = `${group}.pact.json`;
  writeFileSync(OUT + file, `${JSON.stringify(pact, null, 2)}\n`);
  written.add(file);
}
// A group the table no longer has leaves no stale file behind.
for (const file of readdirSync(OUT)) {
  if (file.endsWith('.pact.json') && !written.has(file)) unlinkSync(OUT + file);
}
console.log(`[generate-contract] ${cases.length} cases in ${written.size} files: contract/{${[...written].map((f) => f.replace('.pact.json', '')).join(',')}}.pact.json`);

// The fixture action's class, written by the repo's own Laravel generator, so
// the gen cases check its output. The package ships it.
const tmp = mkdtempSync(join(tmpdir(), 'vc-contract-'));
try {
  writeFileSync(join(tmp, 'schema.json'), JSON.stringify(fixtureSchema));
  execFileSync(process.execPath, [fileURLToPath(new URL('./generate-laravel.mjs', import.meta.url)), join(tmp, 'schema.json'),
    '--out', tmp, '--namespace', 'VaporChamber\\Contract\\Fixture', '--force'], { stdio: 'ignore' });
  const fixtureDir = fileURLToPath(new URL('../php/src/Contract/Fixture/', import.meta.url));
  mkdirSync(fixtureDir, { recursive: true });
  for (const name of Object.keys(fixtureSchema)) {
    const file = `${name[0].toUpperCase()}${name.slice(1)}.php`;
    copyFileSync(join(tmp, 'app/Actions', file), fixtureDir + file);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`[generate-contract] fixture: php/src/Contract/Fixture/{${Object.keys(fixtureSchema).map((n) => `${n[0].toUpperCase()}${n.slice(1)}`).join(',')}}.php`);
