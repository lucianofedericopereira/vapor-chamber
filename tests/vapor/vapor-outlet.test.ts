// @vitest-environment happy-dom
/**
 * FIXTURE - `vapor-chamber/router/vapor`'s outlet, mounted on a real
 * `createVaporApp` with NO `vaporInteropPlugin` installed.
 *
 * Every behaviour is asserted twice, against the SAME assertion function: once
 * in-process under vitest, and once against an esbuild bundle built with
 * production defines and executed. A dev-only pass has not tested the premise
 * - the slot-fallback path was prod-only broken upstream until `2473b78`, and
 * this repo's own bug history is dev-correct/prod-broken twice over.
 *
 * WHICH `vue` EACH ARM RESOLVES, since the answer differs per arm and the
 * feasibility claim turns on it:
 *   - in-process: `vitest.vapor.config.ts` aliases bare `vue` to
 *     `vue/dist/vue.runtime-with-vapor.esm-browser.js`, a DEV build. Asserted
 *     below rather than assumed.
 *   - the production arm: esbuild with `platform: 'browser'` resolves bare
 *     `vue` through the package exports map to `vue.runtime.esm-bundler.js`,
 *     whose `export * from "@vue/runtime-vapor"` is what makes the outlet's
 *     static helper imports resolve at all. Under raw Node ESM they would not.
 * Both are real consumer configurations; neither alone tests the premise.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVaporApp, defineVaporComponent } from 'vue';
import { type OutletObservations, runOutletObservations } from './vapor-outlet-fixture';

const fixtureEntry = resolve(process.cwd(), 'tests', 'vapor', 'vapor-outlet-fixture.ts');

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

/**
 * Production defines, as a real Vite production build sets them: NODE_ENV plus
 * Vue's three feature flags. Shared by every arm, so no arm can be measured
 * under different dead-code elimination than another.
 */
const PROD_DEFINE = {
  'process.env.NODE_ENV': '"production"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};

/**
 * The whole behavioural contract, applied identically to the dev and
 * production arms.
 */
function assertBehaviours(o: OutletObservations) {
  // (a) nested depth through the OUTLET_DEPTH_KEY ladder. A failed depth read
  // renders the layout again at depth 1, so the occurrence counts are the
  // discriminator, not the visible text.
  expect(o.depth.layoutOccurrences).toBe(1);
  expect(o.depth.userOccurrences).toBe(1);
  expect(o.depth.text).toBe('user');

  // (b) a null entry is a true empty branch: no element, no text, and the only
  // node left is the outlet's own fragment anchor. Asserted on node KIND and
  // never on markup - the anchor is a labelled comment in dev and an empty
  // text node under production defines, so any innerHTML assertion here would
  // be dev/prod divergent by construction.
  expect(o.nullBranch.elementCount).toBe(0);
  expect(o.nullBranch.text).toBe('');
  expect(o.nullBranch.residual).toHaveLength(1);
  expect(o.nullBranch.residual[0]).toMatch(/^anchor:/);

  // (c) default-slot fallback at a depth with no entry. The slot is built once
  // in setup and only when it exists; the no-slot case above must stay a
  // literal null, which is why (b) and (c) are separate scenarios.
  expect(o.fallback.text).toBe('no child route');
  expect(o.fallback.elementCount).toBe(1);

  // (d) the reuse contract, the one place a perf regression could hide from
  // every size measurement. Keyless on purpose: the branch swaps on resolved
  // COMPONENT identity, so param-only and query-only navigations keep the
  // instance and a record change replaces it.
  expect(o.reuse.setupsAfterFirstUser).toBe(1);
  expect(o.reuse.setupsAfterParamSwap).toBe(1);
  expect(o.reuse.sameElementAcrossParamSwap).toBe(true);
  expect(o.reuse.setupsAfterQuerySwap).toBe(1);
  expect(o.reuse.textAfterRecordSwap).toBe('about');
  expect(o.reuse.setupsAfterReturningToUser).toBe(2);
  // Two DIFFERENT records resolving to the SAME component reuse, by design.
  // "record identity implies reuse" is shorthand for the vDOM outlet too,
  // which reuses on vnode type; this pins that the shorthand is not the
  // mechanism, so neither outlet may quietly start keying on the record.
  expect(o.reuse.setupsAcrossTwinRecords).toBe(2);
  expect(o.reuse.sameElementAcrossTwinRecords).toBe(true);

  // (e) attrs placed on the outlet. PINNED, NOT DESIGNED, and the distinction
  // matters: neither outlet ever documented a fallthrough contract, and rc.5
  // reworked fallthrough resolution three ways in a single cycle (`293ca1c`,
  // `be7157e`, `10f666e`). Measured today, identically on both arms: an attr
  // put on the outlet is DROPPED - it does not reach the route component's
  // root - while the route component itself still renders normally. That is
  // recorded here so the next upstream rework fails loudly instead of
  // silently changing what consumers get. If this breaks, decide the contract
  // deliberately; do not just update the expectation to match.
  expect(o.attrs.markedTag).toBeNull();
  expect(o.attrs.outletChildTag).toBe('SPAN');

  // (f) the mode guard, both causes. Asserted on `code` and never on message
  // text, per the router's error convention.
  expect(o.guard.vdom.name).toBe('RouterError');
  expect(o.guard.vdom.code).toBe('mode_mismatch');
  expect(o.guard.blade.name).toBe('RouterError');
  expect(o.guard.blade.code).toBe('mode_mismatch');
}

/**
 * Bundles the scenarios under production defines and runs them, so the
 * assertions see prod dead-code elimination and the prod `vue` rather than the
 * dev dist the vitest alias supplies.
 *
 * CJS + `createRequire`, not `import()`: the bundle lands outside the project
 * root, where vitest's module runner refuses to resolve a file URL. Node's own
 * loader has no such boundary, and the bundle is self-contained (`vue` is
 * bundled into it), so nothing crosses back into the runner's graph. The DOM
 * it renders into is the happy-dom one on `globalThis`, shared with the tests.
 */
async function runUnderProductionBuild(): Promise<OutletObservations> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-outlet-prod-'));
  const out = join(dir, 'outlet.prod.cjs');
  try {
    await (esbuild as typeof import('esbuild')).build({
      entryPoints: [fixtureEntry],
      outfile: out,
      bundle: true,
      format: 'cjs',
      platform: 'browser',
      target: 'es2022',
      define: PROD_DEFINE,
      minify: false,
      logLevel: 'silent',
    });
    const mod = createRequire(import.meta.url)(out) as {
      runOutletObservations: () => Promise<OutletObservations>;
    };
    return await mod.runOutletObservations();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Vapor outlet', () => {
  it('the in-process arm runs on a with-vapor build (guards the harness itself)', () => {
    // Without the alias these would be undefined and every assertion below
    // would be measuring the harness rather than the outlet.
    expect(typeof createVaporApp).toBe('function');
    expect(typeof defineVaporComponent).toBe('function');
  });

  it('renders depth, empty branch, fallback, reuse, attrs and the mode guard', async () => {
    const o = await runOutletObservations();
    expect(o.build).toBe('dev');
    assertBehaviours(o);
  });

  it.skipIf(!esbuild)('holds identically under an executed production build', async () => {
    const o = await runUnderProductionBuild();
    expect(o.build).toBe('prod');
    assertBehaviours(o);
  });
});
