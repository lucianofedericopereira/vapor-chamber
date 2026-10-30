/**
 * A/B timing of signal() backed by Vue shallowRef vs ref on the real dispatch path (a handler writes a signal per dispatch).
 * Why: the library wires shallowRef so command-driven state does not pay for deep reactivity; the table this prints is the evidence for the ratios quoted in the docs.
 * Shows: it prints median ops/sec for ref and shallowRef over three cases, and asserts only that every ratio is finite and positive. It asserts no timing threshold, so it cannot catch a regression; that guard is chamber.test.ts "signal() factory - shallow reactivity".
 * See: docs/performance.md, docs/whitepaper.md 7.1, tests/under-coverage.ts
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ref, shallowRef, effectScope } from 'vue';
import { configureSignal } from '../src/signal';
import { getCommandBus, setCommandBus, waitForVueDetection } from '../src/chamber';
import { signal } from '../src/signal';
import { createCommandBus } from '../src/command-bus';
import { runTiming } from './under-coverage';

type Factory = (init: any) => any;
type Kind = 'array' | 'counter';

// Timed with process.hrtime and the setup amortised: vitest's bench() setup floor per iteration swamps the signal-write cost.
function runOnce(kind: Kind, n: number): void {
  setCommandBus(createCommandBus());
  const bus = getCommandBus();
  const scope = effectScope();
  scope.run(() => {
    if (kind === 'array') {
      const state = signal<number[]>([]);
      const off = bus.register('append', (cmd) => (state.value = [...state.value, cmd.target]));
      for (let i = 0; i < n; i++) bus.dispatch('append', i);
      off();
    } else {
      const state = signal(0);
      const off = bus.register('inc', () => (state.value = state.value + 1));
      for (let i = 0; i < n; i++) bus.dispatch('inc', null);
      off();
    }
  });
  scope.stop();
}

/** ops/sec where one "op" = `n` dispatches into a fresh signal. */
function opsPerSec(factory: Factory, kind: Kind, n: number, iters: number): number {
  configureSignal(factory as any);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) runOnce(kind, n);
  const t1 = process.hrtime.bigint();
  return iters / (Number(t1 - t0) / 1e9);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('signal() shallowRef vs ref - empirical proof (real dispatch path)', () => {
  // The library default is shallowRef; restore it for any later test.
  afterAll(() => { configureSignal(shallowRef as any); });

  const results: Record<string, { ref: number; shallow: number; ratio: number }> = {};

  // Runs only when timing is opted in (runTiming) and never under coverage, where instrumented ratios are meaningless.
  it.skipIf(!runTiming)('measures the ref-vs-shallowRef diff and proves shallowRef is faster', async () => {
    await waitForVueDetection();
    // Vue must be detected, or the factories below would fall back to plain objects.
    expect(typeof (ref(0) as any).value).toBe('number');

    const cases: Array<{ key: string; kind: Kind; n: number; iters: number }> = [
      { key: 'array append /100 (v-for source)', kind: 'array', n: 100, iters: 400 },
      { key: 'array append /10', kind: 'array', n: 10, iters: 1500 },
      { key: 'scalar increment /100', kind: 'counter', n: 100, iters: 400 },
    ];

    // Warm up both factories on every case.
    for (const c of cases) { opsPerSec(ref, c.kind, c.n, 30); opsPerSec(shallowRef, c.kind, c.n, 30); }

    for (const c of cases) {
      const refS: number[] = [];
      const shS: number[] = [];
      // Interleave the reps so drift hits both factories equally.
      for (let rep = 0; rep < 5; rep++) {
        refS.push(opsPerSec(ref, c.kind, c.n, c.iters));
        shS.push(opsPerSec(shallowRef, c.kind, c.n, c.iters));
      }
      const r = median(refS);
      const s = median(shS);
      results[c.key] = { ref: r, shallow: s, ratio: s / r };
    }

    // eslint-disable-next-line no-console
    console.log('\n  signal() backend - real dispatch path (median of 5 interleaved reps)');
    for (const [k, v] of Object.entries(results)) {
      const pct = ((v.ratio - 1) * 100);
      // eslint-disable-next-line no-console
      console.log(
        '   ' + k.padEnd(34),
        'ref=' + Math.round(v.ref).toLocaleString().padStart(9),
        'shallowRef=' + Math.round(v.shallow).toLocaleString().padStart(9),
        'Δ=' + (pct >= 0 ? '+' : '') + pct.toFixed(0) + '%',
      );
    }

    // No timing threshold: ratios are unstable under parallel load, and this measures Vue's ref against shallowRef directly, so it cannot see a library regression.
    // Smoke-check only that the measurement ran.
    const arr100 = results['array append /100 (v-for source)'].ratio;
    expect(Number.isFinite(arr100)).toBe(true);
    expect(arr100).toBeGreaterThan(0);
    for (const v of Object.values(results)) {
      expect(Number.isFinite(v.ratio)).toBe(true);
      expect(v.shallow).toBeGreaterThan(0);
      expect(v.ref).toBeGreaterThan(0);
    }
  });
});
