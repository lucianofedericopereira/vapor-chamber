// CI's speed check decides from the A/B summaries: each failure it must catch, seeded.
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKLOADS, decide } from '../scripts/ab/ci.mjs';

const row = (verdict: string, controls = [true], ratios = [1]) => ({ verdict, controls, ratios, fit: null });
const clean = () => ({
  'track-parts': { p0_bare: row('no result'), p4_tracked: row('faster', [true], [0.86]) },
  composable: { composable_dispatch: row('no result') },
});

describe('ab:ci decide', () => {
  it('passes a run with no slower row and a passing control', () => {
    const d = decide(clean());
    expect(d.ok).toBe(true);
    expect(d.why).toEqual([]);
    expect(d.controlsPassed).toBe(3);
  });

  it('fails a seeded regression, naming the workload, the row and its ratio', () => {
    const r = clean();
    r.composable.composable_dispatch = row('slower', [true], [1.084]);
    const d = decide(r);
    expect(d.ok).toBe(false);
    expect(d.why.join()).toMatch(/slower than base: composable: composable_dispatch \(B\/A 1\.084\)/);
  });

  it('fails when no control passed anywhere: a noisy VM is not a pass', () => {
    const r = clean();
    for (const s of Object.values(r)) for (const k of Object.keys(s)) (s as any)[k] = row('no result', [false]);
    const d = decide(r);
    expect(d.ok).toBe(false);
    expect(d.why.join()).toMatch(/instrument failed/);
  });

  it('fails loudly when a workload measured nothing', () => {
    const d = decide({ ...clean(), plugins: {} });
    expect(d.ok).toBe(false);
    expect(d.why.join()).toMatch(/no function measured: plugins/);
  });

  it('runs the five committed workloads by default, and each exists', async () => {
    const { existsSync } = await import('node:fs');
    expect(DEFAULT_WORKLOADS.map((w: string) => w.split('/').pop())).toEqual(['track-parts.mjs', 'composable.mjs', 'create.mjs', 'filter-mixed.mjs', 'plugins.mjs']);
    for (const w of DEFAULT_WORKLOADS) expect(existsSync(w)).toBe(true);
  });
});

describe('ab:ci base check (scripts/ab/base-ok.sh)', () => {
  const run = async (args: string[]) => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('bash', ['scripts/ab/base-ok.sh', ...args], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout.trim() };
  };

  it('accepts a commit this checkout has', async () => {
    const { execSync } = await import('node:child_process');
    const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    expect(await run([head])).toEqual({ status: 0, out: '' });
  });

  it('refuses, with a reason, an all-zero base, an absent one and none', async () => {
    const zero = await run(['0'.repeat(40)]);
    expect([zero.status, zero.out]).toEqual([1, expect.stringMatching(/all zeros/)]);
    const absent = await run(['deadbeef'.repeat(5)]);
    expect([absent.status, absent.out]).toEqual([1, expect.stringMatching(/not in this checkout/)]);
    const none = await run([]);
    expect([none.status, none.out]).toEqual([1, expect.stringMatching(/no base commit/)]);
  });

  it('build-dists names the commit it cannot check out instead of exiting silently', async () => {
    const { spawnSync } = await import('node:child_process');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const out = mkdtempSync(join(tmpdir(), 'vc-bd-'));
    const r = spawnSync('bash', ['scripts/ab/build-dists.sh', out, 'deadbeef'.repeat(5)], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/cannot check out deadbeef/);
  });

  it('the workflow skips perf-ab through base-ok.sh before it builds anything', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync('.github/workflows/ci.yml', 'utf8');
    const check = yml.indexOf('bash scripts/ab/base-ok.sh "$BASE"');
    expect(check).toBeGreaterThan(0);
    expect(yml.slice(check, yml.indexOf('build-dists.sh', check))).toMatch(/exit 0/);
  });
});

// Why each case: the job's value is the failure it reports, so each failure is
// seeded and must turn the decision red. "no result" rows do not fail (the gate
// saying it cannot tell); but a run in which NO control passed measured nothing,
// and passing it would be the silent-pass shape this repo has hit before (a
// guard that never fires). The real run, base against head on built dists, is
// verified locally (log s35.59); GitHub runs it on every push and PR.
