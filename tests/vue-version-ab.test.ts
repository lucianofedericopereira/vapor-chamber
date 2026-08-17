// @vitest-environment happy-dom
/**
 * Same-process A/B: the INSTALLED Vue vs a baseline version.
 *
 * Skipped unless driven by `scripts/ab-vue.mjs`, which packs the baseline and
 * sets `VC_AB_BASELINE`. Run it with:
 *
 *     npm run ab:vue -- 3.6.0-rc.3
 *
 * METHOD, and why it is this fussy. Both prod dists load into ONE process and
 * rounds alternate AB / BA, because the thing being measured (1-3%) is smaller
 * than the drift between two separate runs on a shared host — comparing today's
 * bench output against numbers written into a previous release is not a
 * measurement at all. Medians and IQRs are reported, never a single run, and
 * the workloads are scaled so every round takes >1ms: at ~15µs a round the
 * timer quantises and results go bimodal, which reads as a spurious 2-3x
 * "speedup" (observed while building this — the first version of this harness
 * reported 0.361x on a workload that is actually 1.013x).
 *
 * The workloads are the Vue primitives THIS library sits on, not a general Vue
 * benchmark: scope create/dispose (`tryAutoCleanup`), shallowRef writes
 * (`signal()`), watcher notify, and computed read-after-write.
 */

import { describe, expect, it } from 'vitest';

const BASELINE = process.env.VC_AB_BASELINE;
const BASELINE_VERSION = process.env.VC_AB_VERSION ?? 'baseline';
const ROUNDS = 51;

/** Raw Vue module surface — deliberately untyped; two dists loaded side by side. */
type V = any;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quant = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length * p)];
};

/** Each round must exceed ~1ms — see the note about timer quantisation above. */
const WORKLOADS: Record<string, (v: V) => void> = {
  'effectScope + onScopeDispose x20k (tryAutoCleanup path)': (v) => {
    for (let i = 0; i < 20000; i++) {
      const s = v.effectScope();
      s.run(() => { v.onScopeDispose(() => {}); });
      s.stop();
    }
  },
  'shallowRef create + 100 writes x2000 (signal() path)': (v) => {
    for (let i = 0; i < 2000; i++) {
      const r = v.shallowRef(0);
      for (let j = 0; j < 100; j++) r.value = j;
    }
  },
  'shallowRef + watchEffect notify x50k (subscriber path)': (v) => {
    const r = v.shallowRef(0);
    let seen = 0;
    const s = v.effectScope();
    s.run(() => { v.watchEffect(() => { seen += r.value === -1 ? 0 : 1; }); });
    for (let i = 0; i < 50000; i++) r.value = i;
    s.stop();
    void seen;
  },
  'computed read after write x100k': (v) => {
    const r = v.shallowRef(0);
    const c = v.computed(() => r.value * 2);
    for (let i = 0; i < 100000; i++) { r.value = i; void c.value; }
  },
};

describe.skipIf(!BASELINE)('Vue version A/B (same process, interleaved)', () => {
  it('reports medians, IQR and ratio per workload', async () => {
    const base: V = await import(/* @vite-ignore */ BASELINE!);
    // MUST be the same dist flavour as the baseline. A bare `import('vue')`
    // resolves to the DEV bundler build, whose warning paths and instrumentation
    // make it several times slower on the watcher path — comparing that against
    // a prod browser dist measures build flavour, not version. The first run of
    // this harness did exactly that and reported a 2.8x "regression" in rc.4
    // that does not exist. Both sides are now the prod with-vapor browser dist.
    const cur: V = await import(/* @vite-ignore */ 'vue/dist/vue.runtime-with-vapor.esm-browser.prod.js');

    const lines: string[] = [];
    let worst = 1;
    for (const [name, fn] of Object.entries(WORKLOADS)) {
      for (let i = 0; i < 3; i++) { fn(base); fn(cur); }

      const tb: number[] = [];
      const tc: number[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        if (r % 2 === 0) {
          let t = performance.now(); fn(base); tb.push(performance.now() - t);
          t = performance.now(); fn(cur); tc.push(performance.now() - t);
        } else {
          let t = performance.now(); fn(cur); tc.push(performance.now() - t);
          t = performance.now(); fn(base); tb.push(performance.now() - t);
        }
      }
      const mb = median(tb);
      const mc = median(tc);
      const ratio = mc / mb;
      if (ratio > worst) worst = ratio;
      lines.push(
        `${name}\n` +
        `    ${BASELINE_VERSION.padEnd(12)} median ${mb.toFixed(3)}ms  IQR [${quant(tb, 0.25).toFixed(3)}, ${quant(tb, 0.75).toFixed(3)}]\n` +
        `    ${String(cur.version).padEnd(12)} median ${mc.toFixed(3)}ms  IQR [${quant(tc, 0.25).toFixed(3)}, ${quant(tc, 0.75).toFixed(3)}]\n` +
        `    ratio ${ratio.toFixed(3)}x  ${ratio > 1.15 ? '<<< SLOWER, investigate' : ratio < 0.87 ? '<<< faster' : '(within noise band)'}`,
      );
    }

    console.log(
      `\nVue A/B — ${BASELINE_VERSION} vs installed ${cur.version} (${ROUNDS} interleaved rounds)\n` +
      lines.join('\n') +
      `\n\nworst ratio: ${worst.toFixed(3)}x`,
    );

    // Deliberately not an assertion threshold. A single host cannot distinguish
    // a 5% regression from 5% noise, so failing the build on a ratio would
    // produce flakes and train people to ignore it. The numbers are for a human
    // to read during an alignment cycle; only a ratio far outside the noise
    // band (flagged above) means anything.
    expect(lines.length).toBe(Object.keys(WORKLOADS).length);
  }, 600_000);
});
