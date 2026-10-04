// The bench ratios: rows exist where the reporter reads them, and bands are published by kind.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RATIOS, ratiosOf } from '../scripts/bench-ratios-reporter.mjs';
import { MIN_RUNS, PEERS, bands, groupPattern, provenance } from '../scripts/bench-bands.mjs';

type Ratio = { group: string; fast: string; slow: string; kind: string };
type Ratios = Record<string, Ratio>;

const SRC = readFileSync(resolve(__dirname, 'perf.bench.ts'), 'utf8');

/** Each ratio whose group, or a row inside that group, is not in the bench source. */
function missingRows(src: string, ratios: Ratios): string[] {
  const missing: string[] = [];
  for (const [name, { group, fast, slow }] of Object.entries(ratios)) {
    const start = src.indexOf(`describe('${group}'`);
    if (start < 0) { missing.push(`${name}: group`); continue; }
    const next = src.indexOf('\ndescribe(', start + 1);
    const body = src.slice(start, next < 0 ? undefined : next);
    for (const row of [fast, slow]) {
      if (!body.includes(`bench('${row}'`) && !body.includes(`bench("${row}"`)) missing.push(`${name}: ${row}`);
    }
  }
  return missing;
}

describe('bench ratios: the reporter reads rows that exist', () => {
  it('every group and row in RATIOS is in tests/perf.bench.ts', () => {
    expect(missingRows(SRC, RATIOS as Ratios)).toEqual([]);
  });

  it('positive control: a renamed row, or a row read from the wrong group, is caught', () => {
    const renamed = { x: { ...RATIOS.benchFastLaneVsMitt, slow: 'mitt - 3 listener (peer)' } };
    const wrongGroup = { y: { ...RATIOS.benchFastLaneVsMitt, group: 'comparative emit fan-out (10k events x 3 listeners)' } };
    expect(missingRows(SRC, renamed)).toEqual(['x: mitt - 3 listener (peer)']);
    expect(missingRows(SRC, wrongGroup)).toEqual(['y: vapor-chamber fast-lane emit (live, default)', 'y: mitt - 3 listeners (peer)']);
  });

  it('a ratio is peer exactly when one of its rows is a peer library', () => {
    const mentionsPeer = (r: Ratio) => [r.fast, r.slow].some((row) => PEERS.some((p) => row.includes(p)));
    for (const [name, r] of Object.entries(RATIOS as Ratios)) {
      expect([name, r.kind]).toEqual([name, mentionsPeer(r) ? 'peer' : 'own']);
    }
  });

  it('ratiosOf divides fast by slow and leaves out a ratio with a row missing', () => {
    const { fast, slow } = RATIOS.benchPersistCoalesce;
    const got = ratiosOf(new Map([[fast, 300], [slow, 20]]));
    expect(got).toEqual({ benchPersistCoalesce: '15.00' });
  });
});

describe('bench bands: published by kind', () => {
  const two: Ratios = {
    own1: { group: 'g', fast: 'a', slow: 'b', kind: 'own' },
    peer1: { group: 'g', fast: 'a', slow: 'mitt', kind: 'peer' },
  };
  const runs = [
    { own1: '10.00', peer1: '1.90' },
    { own1: '11.00', peer1: '1.79' },
    { own1: '30.00', peer1: '1.83' },
  ];

  it('an own ratio is the median, a peer ratio the min-max band', () => {
    expect(bands(runs, two)).toEqual({ own1: '11.00', peer1: '1.79-1.90' });
  });

  it('negative control: an own ratio is never a band, a peer ratio never one value', () => {
    const out = bands(runs, two);
    expect(out.own1).toMatch(/^\d+\.\d\d$/);
    expect(out.peer1).toMatch(/^\d+\.\d\d-\d+\.\d\d$/);
  });

  it(`refuses fewer than ${MIN_RUNS} runs, and a ratio missing from any run`, () => {
    expect(() => bands(runs.slice(0, MIN_RUNS - 1), two)).toThrow(/at least 3/);
    expect(() => bands([...runs.slice(1), { own1: '9.00' }], two)).toThrow(/peer1 missing from 1 of 3/);
  });

  it('provenance names Node, vitest, each peer and the run count', () => {
    expect(provenance({ node: '24.21.0', vitest: '5.0.1', peers: { mitt: '3.0.1', eventemitter3: '5.0.4' }, runs: 5 }))
      .toBe('Node 24.21.0, vitest 5.0.1, mitt 3.0.1, eventemitter3 5.0.4, 5 runs');
  });

  it('the -t pattern selects every ratio group and no other group', () => {
    const re = new RegExp(groupPattern());
    const groups = [...SRC.matchAll(/^describe\('([^']+)'/gm)].map((m) => m[1]);
    const wanted = new Set(Object.values(RATIOS as Ratios).map((r) => r.group));
    expect(wanted.size).toBeGreaterThan(0);
    for (const g of groups) expect([g, re.test(`${g} compare`)]).toEqual([g, wanted.has(g)]);
  });
});

// The test file the reporter matches against is the bench source itself, read
// as text: a bench run takes minutes and is not part of `test:run`, so a row
// renamed in `tests/perf.bench.ts` used to surface only as a marker that
// silently kept its old value. `missingRows` reads each group's span from its
// `describe(` to the next top-level one, which is how the file is laid out.
