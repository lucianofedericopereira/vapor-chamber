// @vitest-environment happy-dom
/**
 * The Vapor RouterOutlet (`vapor-chamber/router/vapor`) on a real `createVaporApp` with no `vaporInteropPlugin`, in dev and in a production build.
 * Why: the outlet must behave the same in a production build as in dev, or consumers see output that only breaks after `vite build`.
 * Shows: one assertion function (depth, empty branch, slot fallback, instance reuse, dropped attrs, mode guard, live and late default slots) passes in-process against the with-vapor dev dist and against an executed esbuild production bundle.
 * See: tests/vapor/vapor-outlet-fixture.ts
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

// Production defines as a Vite production build sets them: NODE_ENV plus Vue's three feature flags.
const PROD_DEFINE = {
  'process.env.NODE_ENV': '"production"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};

// The whole behavioural contract, applied identically to the dev and production arms.
function assertBehaviours(o: OutletObservations) {
  // Nested depth: a failed depth read renders the layout again at depth 1, so occurrence counts discriminate, not the text.
  expect(o.depth.layoutOccurrences).toBe(1);
  expect(o.depth.userOccurrences).toBe(1);
  expect(o.depth.text).toBe('user');

  // A null entry is a true empty branch. Asserted on node kind, not markup: the anchor is a comment in dev and an empty text node in production.
  expect(o.nullBranch.elementCount).toBe(0);
  expect(o.nullBranch.text).toBe('');
  expect(o.nullBranch.residual).toHaveLength(1);
  expect(o.nullBranch.residual[0]).toMatch(/^anchor:/);

  // Default-slot fallback at a depth with no entry; the no-slot case above must stay a literal null.
  expect(o.fallback.text).toBe('no child route');
  expect(o.fallback.elementCount).toBe(1);

  // Reuse is keyless: the branch swaps on resolved component identity, so param-only and query-only navigations keep the instance and a record change replaces it.
  expect(o.reuse.setupsAfterFirstUser).toBe(1);
  expect(o.reuse.setupsAfterParamSwap).toBe(1);
  expect(o.reuse.sameElementAcrossParamSwap).toBe(true);
  expect(o.reuse.setupsAfterQuerySwap).toBe(1);
  expect(o.reuse.textAfterRecordSwap).toBe('about');
  expect(o.reuse.setupsAfterReturningToUser).toBe(2);
  // Two different records resolving to the same component reuse the instance: the outlet must not key on the record.
  expect(o.reuse.setupsAcrossTwinRecords).toBe(2);
  expect(o.reuse.sameElementAcrossTwinRecords).toBe(true);

  // Pinned, not designed: no fallthrough contract is documented. An attr put on the outlet is dropped on both arms while the route component renders normally.
  // If this breaks, decide the contract deliberately instead of updating the expectation.
  expect(o.attrs.markedTag).toBeNull();
  expect(o.attrs.outletChildTag).toBe('SPAN');

  // The mode guard, both causes; asserted on `code`, never on message text.
  expect(o.guard.vdom.name).toBe('BusError');
  expect(o.guard.vdom.code).toBe('router:invalid:component');
  expect(o.guard.blade.name).toBe('BusError');
  expect(o.guard.blade.code).toBe('router:invalid:component');

  // A reactive default slot stays reactive across a child route: removing a fragment stops its scope, so the slot must be rebuilt on return.
  expect(o.liveSlot.beforeChild).toBe('on');
  expect(o.liveSlot.flippedBeforeChild).toBe('off');
  expect(o.liveSlot.whileChild).toBe('about');
  expect(o.liveSlot.afterRoundTrip).toBe('off');
  expect(o.liveSlot.flippedAfterRoundTrip).toBe('on');
  expect(o.liveSlot.afterSecondRoundTrip).toBe('on');
  expect(o.liveSlot.slotElements).toBe(1);

  // A conditional default slot that is off at creation is a dynamic source (`slots.default` undefined); it must show once its condition turns on.
  expect(o.lateSlot.offAtMount).toEqual({ text: '', elements: 0 });
  expect(o.lateSlot.turnedOn).toBe('late fallback');
  expect(o.lateSlot.whileChild).toBe('about');
  expect(o.lateSlot.backWithSlotOff).toBe('');
  expect(o.lateSlot.turnedOnAgain).toBe('late fallback');
}

// Bundles the scenarios under production defines, so the assertions see the production `vue`, not the dev dist the vitest alias supplies.
// CJS + `createRequire`, not `import()`: the bundle lands outside the project root, where vitest's module runner refuses a file URL.
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
