/**
 * Real-path A/B for history()'s async-redo fix, in the house three-arm shape
 * (tests/plugin-throw-ab.test.ts): a baseline DERIVED from the shipped
 * src/plugins-core.ts with the fix reverted, a byte-identical second copy of
 * that baseline as the self-control, and the shipped source - every timed arm
 * a derived copy, loaded the same way.
 *
 * WHAT IS MEASURED: the recorder's `cmd.meta?.origin !== 'redo'` test, read on
 * every dispatch the plugin sees, and redo()'s dispatch through
 * `_withOrigin('redo', ...)`. The buses are the shipped src/command-bus.ts in
 * every arm; only the plugin differs.
 *
 * READ EVERY ROW AGAINST ITS SELF-CONTROL ROW: two byte-identical arms give
 * this machine's noise band in this run, and a shipped ratio inside it is not
 * claimed in either direction.
 *
 * NO TIMING THRESHOLD IS ASSERTED; the printed table is the evidence. What IS
 * asserted is equivalence where the arms must agree (the sync bus, the island
 * cart's wiring) and the one intended difference (a redo on an async bus is
 * recorded once, not twice). Numbers quoted anywhere come from three runs of:
 *
 *   NODE_ENV=production NODE_OPTIONS=--expose-gc npx vitest run tests/history-redo-ab.test.ts --silent=false
 *
 * Ratios are TIME ratios: above 1.00 is slower than the denominator arm.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import type * as ShippedMod from '../src/plugins-core';
import { runTiming } from './under-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'history-redo');

/**
 * [shipped text, replacement]: the fix, reverted - the recorder back on a
 * `_replaying` flag alone, no origin check, the undo handler and the redo
 * dispatch bracketed by the flag. Since undo/1 the shipped code has no flag
 * at all (a scoped origin covers both windows on both buses), so the baseline
 * re-creates it: the pre-q4 code, text for text.
 *
 * The recording rule and undo/redo live in src/ledger.ts, shared by the
 * history() plugin and useCommandHistory, so the transforms apply to the
 * ledger, and each arm
 * gets its OWN derived ledger that its plugins-core copy imports. Loading the
 * shipped ledger from a reverted arm would time the same code twice.
 */
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: source text matched against src/ledger.ts byte for byte, not templates
const REVERT_FIX: Array<[string, string]> = [
  [
    "      if (origin === 'redo' || origin === 'undo' || origin === 'sync' || !result.ok || skip?.(cmd) || (filter && !filter(cmd))) {",
    '      if (_replaying || !result.ok || skip?.(cmd) || (filter && !filter(cmd))) {',
  ],
  ['  let inFlight = false;\n', '  let inFlight = false;\n  let _replaying = false;\n'],
  [
    "        () => (handler ? onSettledValue(_undo(bus as LedgerBus, cmd)) : undefined));",
    '        () => { _replaying = true; try { return handler ? handler(cmd) : undefined; } finally { _replaying = false; } });',
  ],
  [
    "        () => (bus ? _withOriginScope('redo', () => bus.dispatch(cmd.action, cmd.target, cmd.payload)) : undefined));",
    '        () => { _replaying = true; try { return bus ? bus.dispatch(cmd.action, cmd.target, cmd.payload) : undefined; } finally { _replaying = false; } });',
  ],
];
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the verbatim-source block

const toSrc = (src: string): string => src.replace(/from '\.\/([\w-]+)'/g, "from '../../../src/$1'");

/** The arm's ledger: shipped, or with the fix reverted. */
function deriveLedger(revert: boolean): string {
  let src = readFileSync(resolve(HERE, '../src/ledger.ts'), 'utf8');
  if (revert) {
    for (const [shipped, replacement] of REVERT_FIX) {
      if (!src.includes(shipped)) {
        throw new Error(
          'history-redo-ab: a shipped line was not found - update REVERT_FIX, ' +
            'otherwise this A/B silently measures the same code twice.\n' + shipped,
        );
      }
      src = src.replace(shipped, replacement);
    }
  }
  return toSrc(src);
}

/** The arm's plugins-core: shipped text, importing the arm's own ledger. */
function derivePlugins(ledgerModule: string): string {
  const src = readFileSync(resolve(HERE, '../src/plugins-core.ts'), 'utf8');
  if (!src.includes("from './ledger'")) {
    throw new Error("history-redo-ab: plugins-core no longer imports './ledger' - the arms would not reach the derived ledger.");
  }
  return toSrc(src).replace("from '../../../src/ledger'", `from './${ledgerModule}'`);
}

afterAll(() => {
  if (existsSync(REF_DIR)) rmSync(REF_DIR, { recursive: true, force: true });
});

type Mod = typeof ShippedMod;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const gc = (globalThis as { gc?: () => void }).gc;

/** ns per command: sync dispatch with a recording history() installed. */
function syncRecordNs(m: Mod, n: number): number {
  const bus = createCommandBus();
  bus.use(m.history({ bus }));
  bus.register('t', (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

/** ns per command: async dispatch with a recording history() installed. */
async function asyncRecordNs(m: Mod, n: number): Promise<number> {
  const bus = createAsyncCommandBus();
  bus.use(m.history({ bus: bus as any }));
  bus.register('t', async (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

/** ns per undo+redo pair on the sync bus - redo() is the `_withOrigin` path. */
function syncCycleNs(m: Mod, n: number): number {
  const bus = createCommandBus();
  const h = m.history({ bus });
  bus.use(h);
  bus.register('t', (c) => c.target, { undo: () => {} });
  bus.dispatch('t', 1);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) { h.undo(); h.redo(); }
  return Number(process.hrtime.bigint() - t0) / n;
}

const ROWS: Array<[string, (m: Mod) => number | Promise<number>]> = [
  ['sync dispatch, history recording', (m) => syncRecordNs(m, 200_000)],
  ['async dispatch, history recording', (m) => asyncRecordNs(m, 40_000)],
  ['sync undo+redo cycle', (m) => syncCycleNs(m, 100_000)],
];
const ROUNDS = 11;

describe('history() async-redo fix - real path A/B', () => {
  it('agrees on the sync bus, records an async redo once, and measures the cost', async () => {
    mkdirSync(REF_DIR, { recursive: true });
    const arms: Record<string, Mod> = {};
    const load = async (name: string, revert: boolean) => {
      writeFileSync(resolve(REF_DIR, `ledger-${name}.ts`), deriveLedger(revert));
      const file = resolve(REF_DIR, `history-redo-${name}.ts`);
      writeFileSync(file, derivePlugins(`ledger-${name}`));
      arms[name] = await import(/* @vite-ignore */ file);
    };
    await load('pre', true);
    await load('self', true);
    await load('shipped', false);

    // --- equivalence: the island cart's wiring, sync bus ---------------------
    const cartRun = (m: Mod) => {
      const bus = createCommandBus();
      const cart = { count: 0 };
      const h = m.history({ maxSize: 50, bus, filter: (cmd) => cmd.action === 'cartAdd', undoAction: 'cartUndo', redoAction: 'cartRedo' });
      bus.use(h);
      bus.register('cartAdd', () => { cart.count += 1; }, { undo: () => { cart.count -= 1; } });
      const seen: unknown[] = [];
      // `$undo` commands (s35.114) are not this A/B's subject; the arms differ there on purpose.
      bus.on('cart*', (cmd) => { if (cmd.action.endsWith('$undo')) return; const s = h.getState(); seen.push([cmd.action, cart.count, s.canUndo, s.canRedo]); });
      for (const a of ['cartAdd', 'cartAdd', 'cartUndo', 'cartRedo', 'cartUndo', 'cartUndo', 'cartRedo']) bus.dispatch(a, {});
      return seen;
    };
    expect(cartRun(arms.shipped)).toEqual(cartRun(arms.pre));

    // --- intended difference: an async redo is recorded once -----------------
    for (const [m, expected] of [[arms.pre, 2], [arms.shipped, 1]] as const) {
      const bus = createAsyncCommandBus();
      bus.register('add', async () => 'ok');
      const h = m.history({ bus: bus as any });
      bus.use(h);
      await bus.dispatch('add', 1);
      h.undo();
      h.redo();
      await new Promise((r) => setTimeout(r, 0));
      expect(h.getState().past).toHaveLength(expected);
    }

    // Timing runs on `npm run test:timing` only, never instrumented (tests/under-coverage.ts).
    if (!runTiming) return;

    // --- measurement --------------------------------------------------------
    const order = Object.keys(arms);
    const lines: string[] = [];
    for (const [label, row] of ROWS) {
      for (const k of order) { await row(arms[k]); await row(arms[k]); } // warm every arm
      const ns: Record<string, number[]> = {};
      for (const k of order) ns[k] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const rot = order.slice(r % order.length).concat(order.slice(0, r % order.length));
        for (const k of rot) { gc?.(); ns[k].push(await row(arms[k])); }
      }
      lines.push(`   ${label}  (pre ${median(ns.pre).toFixed(1)} ns/cmd)`);
      for (const [pl, num] of [['self-control', 'self'], ['shipped (the fix)', 'shipped']] as const) {
        const ratios = ns[num].map((v, i) => v / ns.pre[i]);
        lines.push(`      ${pl.padEnd(20)} ${median(ratios).toFixed(3)}x [${Math.min(...ratios).toFixed(3)}, ${Math.max(...ratios).toFixed(3)}]`);
        expect(Number.isFinite(median(ratios))).toBe(true);
      }
    }
    console.log(`\n  history() async-redo fix - real path, ${ROUNDS} rotated rounds, gc=${!!gc}, NODE_ENV=${process.env.NODE_ENV}; time ratios, >1 slower\n${lines.join('\n')}\n`);
  });
});
