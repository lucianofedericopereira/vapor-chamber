// @vitest-environment happy-dom
/**
 * stampActiveLinks with the per-anchor routableTarget memo, A/B against a baseline derived from the shipped source.
 * Why: the memo must be keyed on the anchor's href, not the element alone; otherwise an href rewritten in place would keep stamping data-active from a stale target.
 * Shows: the memoized function stamps data-active and data-exact-active exactly as the baseline for three paths, after an href is rewritten in place, and after it moves out of the base (a cached target becomes null); the timing table prints only under the timing run and asserts finite, positive figures, never a ratio threshold.
 * See: tests/clock-source-ab.test.ts, scripts/ab-vue.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stampActiveLinks } from '@router/dom';
import { runTiming } from './under-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'router-stamp');
const BASELINE = resolve(REF_DIR, 'router-dom-baseline.ts');

/** The memo block in src/router/dom.ts, and the one line the baseline arm puts in its place. */
const SHIPPED = `  const memo = routableMemo.get(anchor);
  // \`base\` is fixed per router instance, so href alone settles validity.
  if (memo !== undefined && memo.href === href) return memo.target;

  const target = parseRoutable(href, base);
  routableMemo.set(anchor, { href, target });
  return target;`;
const BASELINE_BODY = '  return parseRoutable(href, base);';

function buildBaseline(): void {
  const src = readFileSync(resolve(HERE, '../src/router/dom.ts'), 'utf8');
  if (!src.includes(SHIPPED)) {
    throw new Error(
      'router-stamp-ab: could not find the memo block to revert. If routableTarget ' +
        'was refactored, update SHIPPED/BASELINE_BODY here - otherwise this A/B ' +
        'silently measures the same code twice.',
    );
  }
  const reverted = src
    .replace(SHIPPED, BASELINE_BODY)
    // Rewrite every relative specifier to its real location, not a fixed list of imports.
    .replace(/from '\.\.\/([^']+)'/g, "from '../../../src/$1'")
    .replace(/from '\.\/([^']+)'/g, "from '@router/$1'");
  mkdirSync(REF_DIR, { recursive: true });
  writeFileSync(BASELINE, reverted);
}

afterAll(() => {
  if (existsSync(REF_DIR)) rmSync(REF_DIR, { recursive: true, force: true });
});

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

type Stamp = typeof stampActiveLinks;

/** A menu: mostly in-base links, plus the minority of external ones real pages carry. */
function buildMenu(n: number): HTMLElement {
  const host = document.createElement('div');
  let html = '';
  for (let i = 0; i < n; i++) html += `<a href="/app/section-${i % 20}/item-${i}">i${i}</a>`;
  for (let i = 0; i < Math.ceil(n / 10); i++) html += `<a href="https://example.com/x${i}">e${i}</a>`;
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

const BASE = '/app';
const PATHS = ['/section-1/item-1', '/section-2/item-42', '/section-3/item-7'];

function secondsFor(fn: Stamp, host: HTMLElement, iters: number): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(BASE, PATHS[i % PATHS.length], host);
  return Number(process.hrtime.bigint() - t0) / 1e9;
}

describe('stampActiveLinks - per-anchor memo, real function A/B', () => {
  it('matches the baseline exactly, and measures the difference', async () => {
    buildBaseline();
    const base = (await import(/* @vite-ignore */ BASELINE)) as { stampActiveLinks: Stamp };
    const baseline = base.stampActiveLinks;

    const host = buildMenu(12);
    const snapshot = (fn: Stamp, path: string): string => {
      for (const a of host.querySelectorAll('a')) {
        a.removeAttribute('data-active');
        a.removeAttribute('data-exact-active');
      }
      fn(BASE, path, host);
      return [...host.querySelectorAll('a')]
        .map((a) => `${a.getAttribute('href')}|${a.hasAttribute('data-active')}|${a.hasAttribute('data-exact-active')}`)
        .join(',');
    };
    for (const path of PATHS) {
      expect(snapshot(stampActiveLinks, path)).toBe(snapshot(baseline, path));
    }

    // An href rewritten in place must invalidate the memo.
    const first = host.querySelector('a') as HTMLAnchorElement;
    first.setAttribute('href', '/app/section-9/item-999');
    expect(snapshot(stampActiveLinks, '/section-9/item-999')).toBe(
      snapshot(baseline, '/section-9/item-999'),
    );
    // Moving it out of the base flips the cached value from a target to null.
    first.setAttribute('href', 'https://elsewhere.test/x');
    expect(snapshot(stampActiveLinks, '/section-1/item-1')).toBe(
      snapshot(baseline, '/section-1/item-1'),
    );
    host.remove();

    // Timing runs on `npm run test:timing` only, never instrumented (tests/under-coverage.ts).
    if (!runTiming) return;

    const rows: Array<{ n: number; oldUs: number; newUs: number; ratio: number }> = [];
    for (const n of [50, 200, 1000]) {
      const menu = buildMenu(n);
      const iters = 300;
      secondsFor(baseline, menu, 20);
      secondsFor(stampActiveLinks, menu, 20);

      const A: number[] = [];
      const B: number[] = [];
      for (let rep = 0; rep < 7; rep++) {
        if (rep % 2 === 0) {
          A.push(secondsFor(baseline, menu, iters));
          B.push(secondsFor(stampActiveLinks, menu, iters));
        } else {
          B.push(secondsFor(stampActiveLinks, menu, iters));
          A.push(secondsFor(baseline, menu, iters));
        }
      }
      const oldS = median(A);
      const newS = median(B);
      rows.push({
        n,
        oldUs: (oldS / iters) * 1e6,
        newUs: (newS / iters) * 1e6,
        ratio: oldS / newS,
      });
      menu.remove();
    }

    console.log('\n  stampActiveLinks - per commit, median of 7 interleaved reps');
    for (const r of rows) {
      console.log(
        `   ${String(r.n).padStart(5)} anchors`,
        `current=${r.oldUs.toFixed(1)}us`.padStart(18),
        `memo=${r.newUs.toFixed(1)}us`.padStart(15),
        `ratio=${r.ratio.toFixed(2)}x`,
        `saved=${(r.oldUs - r.newUs).toFixed(1)}us/commit`,
      );
    }
    console.log(
      '   NOTE: happy-dom. `querySelectorAll` is JS here and native in a browser,\n' +
        '         and it is a shared constant in BOTH arms - so it inflates the\n' +
        '         denominator and this ratio is, if anything, conservative.\n',
    );

    for (const r of rows) {
      expect(Number.isFinite(r.ratio)).toBe(true);
      expect(r.oldUs).toBeGreaterThan(0);
      expect(r.newUs).toBeGreaterThan(0);
    }
  });
});
