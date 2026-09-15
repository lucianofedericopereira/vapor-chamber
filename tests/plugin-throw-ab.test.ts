/**
 * Real-path A/B for the plugin-throw work on the bus, run in the house
 * three-arm shape: baselines DERIVED from the shipped source, a byte-identical
 * second copy of the reference baseline as the self-control, and the shipped
 * source - every timed arm a derived copy, loaded the same way.
 *
 * WHAT IS MEASURED, as two separate changes so each carries its own row:
 *   - conversion: a plugin's throw or rejected promise becomes a
 *     VC_PLUGIN_THREW result at EACH plugin's boundary - an inline try in each
 *     runner's `nextFrom`, and on the async runner a `.then(undefined, ...)`
 *     only when the plugin did not simply return its `next()` value (the
 *     per-run `last` slot);
 *   - settle: a throw that escapes the runner (only onMissing: 'throw' can) is
 *     settled - after-hooks and listeners see it - before it is re-thrown, so a
 *     started `isLoading` key cannot stay true.
 * Plus two DECLINED shapes, kept as arms so the reason each was declined stays
 * reproducible: `try { return await plugin(...) } catch` with `nextFrom` made
 * async - an async frame, a promise and a microtask per level - and the first
 * cut's `.then(undefined, ...)` on EVERY async level, pass-through or not.
 *
 * WHY THREE ARMS. A two-arm run on this path could not separate a 3% effect
 * from machine load: the no-plugin control rows swung 0.84x-1.20x between runs
 * of identical code while other work shared the CPU. Two byte-identical arms
 * read the band this machine produces in this run; a difference inside that
 * band is not claimed. Each arm is its own module instance, the arm order
 * rotates every round, ratios are paired per round, and `gc()` runs before
 * every timed segment when it is exposed.
 *
 * HOW THE ARMS ARE BUILT, per the house rule (tests/wildcard-prefix-ab.test.ts):
 * the shipped src/command-bus.ts with named groups of text transformed -
 * reverted, or for the declined arm rewritten - written to tests/__ref/plugin-throw/ and
 * imported as real modules. If a target stops matching, the transform throws
 * rather than measuring one arm twice.
 *
 * FIXTURE SHAPE: three DISTINCT plugin functions per level and per bus type
 * (SYNC_PLUGINS / ASYNC_PLUGINS below) - a real chain's shape. Figures from a
 * harness that installs one function at every level are not comparable with
 * these; see the note at SYNC_PLUGINS.
 *
 * READ EVERY ROW AGAINST ITS SELF-CONTROL ROW. The self-control is two
 * byte-identical arms, so its spread of per-round ratios is the noise band of
 * this machine in this run - about +/-3-5% at a load average of 6-10. A
 * shipped ratio inside that band is noise in EITHER direction: async
 * "3 plugins" read 0.977x in one run, which is not a speedup, just as 1.017x
 * in another is not a cost.
 *
 * NO TIMING THRESHOLD IS ASSERTED; the printed table is the evidence. What IS
 * asserted is equivalence wherever the arms must agree, and the two intended
 * differences. Numbers quoted anywhere in the docs come from three separate
 * runs of:
 *
 *   NODE_ENV=production NODE_OPTIONS=--expose-gc npx vitest run tests/plugin-throw-ab.test.ts --silent=false
 *
 * Ratios are TIME ratios: above 1.00 is slower than the denominator arm.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as shippedMod from '../src/command-bus';

const HERE = dirname(fileURLToPath(import.meta.url));
// Per-file subdir: the whole dir is removed in afterAll, so it must be ours alone.
const REF_DIR = resolve(HERE, '__ref', 'plugin-throw');

const SHIPPED_ASYNC_NEXT = `      if (!plugin) return (last = execute());
      let r: CommandResult | Promise<CommandResult>;
      try { r = plugin(cmd, () => nextFrom(idx + 1)); }
      catch (e) { return pluginThrew(e, cmd, plugin, idx); }
      return (last = r !== last && r != null && typeof (r as PromiseLike<CommandResult>).then === 'function'
        ? (r as Promise<CommandResult>).then(undefined, (e: unknown) => pluginThrew(e, cmd, plugin, idx))
        : r);`;

/** [shipped text, replacement], grouped by the change it undoes (or, for the declined arm, rewrites). */
const TRANSFORMS: Record<string, Array<[string, string]>> = {
  conversion: [
    [
      `      if (!plugin) return execute();
      // The boundary (see pluginThrew), inline so this runner keeps its OWN
      // plugin call site - tests/plugin-throw-ab.test.ts.
      try { return plugin(cmd, () => nextFrom(idx + 1)); }
      catch (e) { return pluginThrew(e, cmd, plugin, idx); }`,
      '      return plugin ? plugin(cmd, () => nextFrom(idx + 1)) : execute();',
    ],
    [SHIPPED_ASYNC_NEXT, '      return plugin ? plugin(cmd, () => nextFrom(idx + 1)) : execute();'],
  ],
  settle: [
    [
      "  const result = s.opts.onMissing === 'throw' ? syncRunSettling(s, cmd, execute) : s.runner(cmd, execute);",
      '  const result = s.runner(cmd, execute);',
    ],
    [
      `  let result: CommandResult;
  try { result = await s.runner(cmd, execute); }
  catch (e) { const h = asyncRunHooks(s, cmd, errResult(e as Error)); if (h) await h; throw e; }`,
      '  const result = await s.runner(cmd, execute);',
    ],
  ],
  awaitPerLevel: [
    [
      `    function nextFrom(idx: number): CommandResult | Promise<CommandResult> {
      const plugin = plugins[idx];
${SHIPPED_ASYNC_NEXT}`,
      `    async function nextFrom(idx: number): Promise<CommandResult> {
      const plugin = plugins[idx];
      if (!plugin) return execute();
      try { return await plugin(cmd, () => nextFrom(idx + 1)); }
      catch (e) { return pluginThrew(e, cmd, plugin, idx); }`,
    ],
  ],
  wrapEveryLevel: [
    ['      return (last = r !== last && r != null &&', '      return (last = r != null &&'],
  ],
};

/** Derived arms: the shipped source with these groups applied. The FIRST is the reference. */
const ARMS: Record<string, string[]> = {
  bare: ['conversion', 'settle'],
  preSettle: ['settle'],
  declinedAwait: ['awaitPerLevel'],
  declinedWrapEvery: ['wrapEveryLevel'],
};

/** Printed rows: [label, numerator arm, denominator arm]. */
const PAIRS: Array<[string, string, string]> = [
  ['self-control', 'self', 'bare'],
  ['conversion (VC_PLUGIN_THREW)', 'preSettle', 'bare'],
  ['settle (onMissing: throw)', 'shipped', 'preSettle'],
  ['total shipped', 'shipped', 'bare'],
  ['DECLINED try/await per level', 'declinedAwait', 'bare'],
  ['DECLINED .then on every level', 'declinedWrapEvery', 'bare'],
];

function derive(groups: string[]): string {
  let src = readFileSync(resolve(HERE, '../src/command-bus.ts'), 'utf8');
  for (const g of groups) {
    for (const [shipped, replacement] of TRANSFORMS[g]) {
      if (!src.includes(shipped)) {
        throw new Error(
          `plugin-throw-ab: a shipped line of group "${g}" was not found - update TRANSFORMS, ` +
            'otherwise this A/B silently measures the same code twice.\n' + shipped,
        );
      }
      src = src.replace(shipped, replacement);
    }
  }
  return src.replace(/from '\.\/dev'/g, "from '../../../src/dev'").replace(/from '\.\/dict'/g, "from '../../../src/dict'");
}

afterAll(() => {
  if (existsSync(REF_DIR)) rmSync(REF_DIR, { recursive: true, force: true });
});

type Mod = typeof shippedMod;
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const gc = (globalThis as { gc?: () => void }).gc;
const noop = () => {};

// DISTINCT functions per level and per bus type, as in a real app (logger,
// auth, transport...). One shared pass-through at every level keeps the
// plugin call site monomorphic - friendlier to V8 than any real install - and
// read ~1.00x on a version of the runners that distinct plugins measured at
// 0.886-0.909x (sync) and 0.910-0.924x (async).
const SYNC_PLUGINS = [
  (_c: unknown, next: () => any) => next(),
  (_c: unknown, next: () => any) => next(),
  (_c: unknown, next: () => any) => next(),
];
const ASYNC_PLUGINS = [
  (_c: unknown, next: () => any) => next(),
  (_c: unknown, next: () => any) => next(),
  (_c: unknown, next: () => any) => next(),
];

/** ns per command through the real sync dispatch. */
function syncNs(m: Mod, plugins: number, n: number): number {
  const bus = m.createCommandBus();
  for (let p = 0; p < plugins; p++) bus.use(SYNC_PLUGINS[p]);
  bus.on('*', noop);
  bus.register('t', (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

/** ns per command through the real async dispatch. */
async function asyncNs(m: Mod, plugins: number, n: number): Promise<number> {
  const bus = m.createAsyncCommandBus();
  for (let p = 0; p < plugins; p++) bus.use(ASYNC_PLUGINS[p]);
  bus.on('*', noop);
  bus.register('t', async (c) => c.target);
  const t0 = process.hrtime.bigint();
  for (let j = 0; j < n; j++) await bus.dispatch('t', j);
  return Number(process.hrtime.bigint() - t0) / n;
}

const ROWS: Array<[string, (m: Mod) => number | Promise<number>]> = [
  ['CONTROL sync 0 plugins + 1 listener', (m) => syncNs(m, 0, 200_000)],
  ['sync 3 plugins + 1 listener', (m) => syncNs(m, 3, 200_000)],
  ['async 0 plugins + 1 listener', (m) => asyncNs(m, 0, 40_000)],
  ['async 3 plugins + 1 listener', (m) => asyncNs(m, 3, 40_000)],
];
const ROUNDS = 11;

describe('plugin-throw work on the bus - real path A/B', () => {
  const underCoverage = process.env.npm_lifecycle_event === 'test:coverage';

  it.skipIf(underCoverage)('agrees where it must, differs where intended, and measures the cost', async () => {
    mkdirSync(REF_DIR, { recursive: true });
    // EVERY timed arm is a derived copy written and loaded the same way -
    // `shipped` too, with nothing transformed. The src module itself is used
    // only for the equivalence checks: timing it against copies loaded by a
    // different path compares two loading paths as well as two sources - a
    // first cut did, and read the settle at 1.04-1.17x on every row, a cost
    // that vanished once the arms were loaded alike.
    const arms: Record<string, Mod> = {};
    const names = Object.keys(ARMS);
    const load = async (name: string, groups: string[]) => {
      const file = resolve(REF_DIR, `plugin-throw-${name}.ts`);
      writeFileSync(file, derive(groups));
      arms[name] = await import(/* @vite-ignore */ file);
    };
    for (const [name, groups] of Object.entries(ARMS)) await load(name, groups);
    await load('self', ARMS[names[0]]);
    await load('shipped', []);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // --- equivalence: neither change touches a path that does not throw -------
    const shape = (r: any) => ({ ok: r.ok, value: r.value, msg: r.error?.message });
    for (const other of [arms.bare, arms.preSettle]) {
      for (const onMissing of ['error', 'ignore'] as const) {
        for (const plugins of [0, 3]) {
          const a = shippedMod.createCommandBus({ onMissing });
          const b = other.createCommandBus({ onMissing });
          const aa = shippedMod.createAsyncCommandBus({ onMissing });
          const ab = other.createAsyncCommandBus({ onMissing });
          for (const bus of [a, b, aa, ab] as any[]) {
            for (let p = 0; p < plugins; p++) bus.use(SYNC_PLUGINS[p]);
            bus.on('*', noop);
            bus.register('t', (c: any) => c.target);
            bus.register('bad', () => { throw new Error('boom'); });
          }
          for (const action of ['t', 'bad', 'missing']) {
            expect(shape(a.dispatch(action, 1))).toEqual(shape(b.dispatch(action, 1)));
            expect(shape(await aa.dispatch(action, 1))).toEqual(shape(await ab.dispatch(action, 1)));
          }
        }
      }
    }
    // --- intended difference 1: a throwing plugin is a result, not an escape ---
    const thrower = () => { throw new Error('plugin bug'); };
    const s0 = arms.bare.createCommandBus(); s0.use(thrower); s0.register('t', () => 1);
    const s1 = shippedMod.createCommandBus(); s1.use(thrower); s1.register('t', () => 1);
    expect(() => s0.dispatch('t', 1)).toThrow('plugin bug');
    expect((s1.dispatch('t', 1).error as any).code).toBe('VC_PLUGIN_THREW');
    // --- intended difference 2: onMissing 'throw' settles before it throws ----
    for (const [m, expected] of [[arms.preSettle, 0], [shippedMod, 1]] as const) {
      const bus = m.createCommandBus({ onMissing: 'throw' });
      let settled = 0;
      bus.on('*', () => { settled++; });
      expect(() => bus.dispatch('nobody', 1)).toThrow('No handler');
      expect(settled).toBe(expected);
    }
    errSpy.mockRestore();

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
      lines.push(`   ${label}  (${names[0]} ${median(ns[names[0]]).toFixed(1)} ns/cmd)`);
      for (const [pl, num, den] of PAIRS) {
        const ratios = ns[num].map((v, i) => v / ns[den][i]);
        lines.push(`      ${pl.padEnd(30)} ${median(ratios).toFixed(3)}x [${Math.min(...ratios).toFixed(3)}, ${Math.max(...ratios).toFixed(3)}]`);
        expect(Number.isFinite(median(ratios))).toBe(true);
      }
    }
    console.log(`\n  plugin-throw work - real path, ${ROUNDS} rotated rounds, gc=${!!gc}, NODE_ENV=${process.env.NODE_ENV}; time ratios, >1 slower\n${lines.join('\n')}\n`);
  }, 600_000);
});
