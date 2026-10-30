/**
 * `scripts/verify-contract.mjs --against <ref>`, run against a stand-in verifier script and a local monitor server.
 * Why: the release cut must replay the previous release's pact files exactly, or a breaking change to the wire contract would pass unnoticed.
 * Shows: the ref's own pact files reach the verifier byte for byte with the session cookie and Sec-Fetch-Site arguments; a ref with no contract exits 0 with a notice; an unresolvable ref exits 2; without --against the checkout's contract/ is replayed.
 * See: tests/require-git.ts
 */
// Refs are HEAD and git's empty tree, which a shallow CI checkout resolves; an unpacked archive has no history, so those three cases skip there.
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitHistory } from './require-git';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
let server: Server;
let base = '';
let scratch = '';
let verifier = '';

beforeAll(async () => {
  server = createServer((_req, res) => { res.writeHead(202, { 'Set-Cookie': 'laravel-session=abc; path=/' }); res.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  scratch = mkdtempSync(join(tmpdir(), 'vc-verify-test-'));
  verifier = join(scratch, 'fake-verifier.sh');
  // Records its arguments, and copies each -f file it was handed (they are gone after the run).
  writeFileSync(verifier, `#!/bin/sh\nprintf '%s\\n' "$@" > "${scratch}/args.txt"\nmkdir -p "${scratch}/seen"\nwhile [ $# -gt 0 ]; do if [ "$1" = -f ]; then cp "$2" "${scratch}/seen/"; shift; fi; shift; done\nexit 0\n`);
  chmodSync(verifier, 0o755);
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// Async: the monitor server answers from this process, which a spawnSync would block.
const verify = (...extra: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  execFile('node', ['scripts/verify-contract.mjs', '--base', base, '--verifier', verifier, ...extra], { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => {
    resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr });
  });
});

describe('verify-contract --against <ref>', () => {
  it.skipIf(!gitHistory)("replays the ref's own pact files, byte for byte", async () => {
    const run = await verify('--against', 'HEAD');
    expect(run.status, run.stderr).toBe(0);
    const seen = readdirSync(join(scratch, 'seen')).sort();
    const headFiles = spawnSync('git', ['ls-tree', '--name-only', 'HEAD:contract'], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f.endsWith('.pact.json')).sort();
    expect(seen).toEqual(headFiles);
    for (const file of seen) {
      expect(readFileSync(join(scratch, 'seen', file), 'utf8')).toBe(spawnSync('git', ['show', `HEAD:contract/${file}`], { encoding: 'utf8' }).stdout);
    }
    const args = readFileSync(join(scratch, 'args.txt'), 'utf8');
    expect(args).toContain('Cookie=laravel-session=abc');
    expect(args).toContain('Sec-Fetch-Site=same-origin');
  });

  it.skipIf(!gitHistory)('says a ref with no contract has nothing to check, and exits 0', async () => {
    const run = await verify('--against', EMPTY_TREE);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('holds no contract/*.pact.json: nothing to check against');
  });

  // Without a repository every ref is unresolvable, so this would pass for the wrong reason.
  it.skipIf(!gitHistory)('exits 2 on a ref git cannot resolve', async () => {
    const run = await verify('--against', 'no-such-ref-vc');
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('git cannot resolve no-such-ref-vc');
  });

  it('control: without --against it replays the checkout contract/', async () => {
    const run = await verify();
    expect(run.status, run.stderr).toBe(0);
    const args = readFileSync(join(scratch, 'args.txt'), 'utf8');
    expect(args).toMatch(/contract\/core\.pact\.json/);
  });
});
