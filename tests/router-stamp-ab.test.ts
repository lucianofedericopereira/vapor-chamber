// @vitest-environment happy-dom
/**
 * EXPERIMENT -> SHIPPED: memoizing `routableTarget` per anchor.
 *
 * WHERE THE IDEA CAME FROM. Vue 3.6.0-rc.6's `29ed4b0` hoists a per-call
 * template-string scan into a descriptor the factory computes once. The same
 * shape was sitting in `stampActiveLinks`, which runs after EVERY navigation
 * over EVERY in-base anchor and re-derives `new URL()` + `stripBase()` per
 * anchor per commit - from an href that almost never changes. rc.6's prop fix
 * (`84833e2`) supplied the other half: validate the cache against the raw INPUT
 * you were given, not against something downstream of it, so the memo is keyed
 * on the anchor's href rather than merely on the element.
 *
 * WHY IT IS SHAPED THIS WAY. Both arms run the REAL `stampActiveLinks`, in one
 * process, interleaved AB/BA, medians - the house method
 * (`tests/clock-source-ab.test.ts`, `scripts/ab-vue.mjs`). The baseline arm is
 * DERIVED from the shipped source at run time rather than hand-written, so it is
 * the genuine pre-change function and not a transcription of it; if the revert
 * target ever stops matching, the transform throws instead of silently
 * measuring one arm twice.
 *
 * SCALE MATTERS AND IS MEASURED AT THREE SIZES. `data-active` stamping exists
 * for Blade-rendered menus ("Blade-rendered menus light up with zero Vue"), and
 * a server-rendered nav is where anchor counts get large. 50 is an ordinary
 * page, 200 a large nav, 1000 a sitemap-ish footer.
 *
 * NO TIMING THRESHOLD IS ASSERTED, per the house rule - single-host ratios are
 * unstable under parallel load. The printed table is the evidence. What IS
 * asserted is equivalence, including the two cases a naive memo would get
 * wrong: an anchor whose `href` is rewritten in place, and non-routable links
 * (whose `null` result is cached too).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stampActiveLinks } from '../src/router/dom';

const HERE = dirname(fileURLToPath(import.meta.url));
const REF_DIR = resolve(HERE, '__ref');
const BASELINE = resolve(REF_DIR, 'router-dom-baseline.ts');

/** The memo lookup this change introduced, and what it replaced. */
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
    .replace(/from '\.\/history'/g, "from '../../src/router/history'")
    .replace(/from '\.\/url'/g, "from '../../src/router/url'");
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
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('matches the baseline exactly, and measures the difference', async () => {
    buildBaseline();
    const base = (await import(/* @vite-ignore */ BASELINE)) as { stampActiveLinks: Stamp };
    const baseline = base.stampActiveLinks;

    // --- equivalence, including the cases a naive memo gets wrong ------------
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

    // An href rewritten IN PLACE must invalidate the memo. This is the case a
    // memo keyed on element identity alone would answer wrongly, and the reason
    // the cache stores the href it was derived from.
    const first = host.querySelector('a') as HTMLAnchorElement;
    first.setAttribute('href', '/app/section-9/item-999');
    expect(snapshot(stampActiveLinks, '/section-9/item-999')).toBe(
      snapshot(baseline, '/section-9/item-999'),
    );
    // And once more after moving it OUT of the base - the cached value flips
    // from a target to null.
    first.setAttribute('href', 'https://elsewhere.test/x');
    expect(snapshot(stampActiveLinks, '/section-1/item-1')).toBe(
      snapshot(baseline, '/section-1/item-1'),
    );
    host.remove();

    // --- measurement --------------------------------------------------------
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
  }, 120_000);
});
