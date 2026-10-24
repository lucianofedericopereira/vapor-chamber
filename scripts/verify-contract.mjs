/**
 * verify-contract - check a backend against the wire contract's Pact files.
 *
 * Runs `pact-verifier` on every contract/*.pact.json against a running
 * backend, on its own command routes. One GET to the backend's monitor
 * (`/api/vc/contract/jobs/running`) mints the session the whole run shares,
 * when the answer sets cookies. Every request then carries those cookies and
 * `Sec-Fetch-Site: same-origin`, which passes Laravel's CSRF check over plain
 * HTTP. Provider states go to `/api/vc/contract/state`.
 *
 * `--against <git ref>` replays that ref's contract instead of the checkout's:
 * the last release's, at the release cut, so a backend that still answers
 * last release's cases has changed nothing an app sees (plan-compat rule 5,
 * log 36.27). A ref with no contract/ (every release before 1.32) has nothing
 * to check: it says so and exits 0. A ref git cannot resolve exits 2.
 *
 * Exits with the verifier's status: 0 when every case passes.
 *
 * Run: node scripts/verify-contract.mjs [--base http://127.0.0.1:8000] [--verifier pact-verifier] [--against <git ref>]
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'Usage: node scripts/verify-contract.mjs [--base <url>] [--verifier <path>] [--against <git ref>]';
const args = { base: 'http://127.0.0.1:8000', verifier: 'pact-verifier', against: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i]?.replace(/^--/, '');
  if (!(name in args) || argv[i + 1] === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  args[name] = argv[i + 1];
}

const repo = fileURLToPath(new URL('..', import.meta.url));
const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: repo, encoding: 'utf8' });

/** The ref's contract/*.pact.json, copied out to a scratch directory. */
function contractAt(ref) {
  if (git('rev-parse', '--verify', '--quiet', `${ref}^{tree}`).status !== 0) {
    console.error(`[verify-contract] git cannot resolve ${ref}. ${USAGE}`);
    process.exit(2);
  }
  const listed = git('ls-tree', '--name-only', `${ref}:contract`);
  const files = listed.status === 0 ? listed.stdout.split('\n').filter((file) => file.endsWith('.pact.json')) : [];
  if (files.length === 0) {
    console.log(`[verify-contract] ${ref} holds no contract/*.pact.json: nothing to check against.`);
    process.exit(0);
  }
  const out = mkdtempSync(join(tmpdir(), 'vc-contract-'));
  for (const file of files) writeFileSync(join(out, file), git('show', `${ref}:contract/${file}`).stdout);
  return out;
}

const base = new URL(args.base);
const root = base.href.replace(/\/$/, '');
const dir = args.against ? contractAt(args.against) : fileURLToPath(new URL('../contract/', import.meta.url));
const pacts = readdirSync(dir).filter((file) => file.endsWith('.pact.json')).sort();

const minted = await fetch(`${root}/api/vc/contract/jobs/running`).catch((error) => {
  console.error(`[verify-contract] ${root} did not answer: ${error.cause?.message ?? error.message}`);
  process.exit(1);
});
const cookies = minted.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

if (args.against) console.log(`[verify-contract] the contract of ${args.against}: ${pacts.join(', ')}`);
const run = spawnSync(args.verifier, [
  ...pacts.flatMap((file) => ['-f', join(dir, file)]),
  '--scheme', base.protocol.replace(':', ''),
  '--hostname', base.hostname,
  '--port', base.port || (base.protocol === 'https:' ? '443' : '80'),
  ...(base.pathname === '/' ? [] : ['--base-path', base.pathname.replace(/\/$/, '')]),
  '--state-change-url', `${root}/api/vc/contract/state`,
  '--state-change-teardown',
  '-H', 'Sec-Fetch-Site=same-origin',
  ...(cookies ? ['-H', `Cookie=${cookies}`] : []),
], { stdio: 'inherit' });
if (args.against) rmSync(dir, { recursive: true, force: true });
if (run.error) {
  console.error(`[verify-contract] cannot run ${args.verifier}: ${run.error.message}. Install it from https://github.com/pact-foundation/pact-reference/releases`);
  process.exit(1);
}
process.exit(run.status ?? 1);
