// @vitest-environment happy-dom
/** FIXTURE - `VcTransition` on a real Vapor app, dev build and an executed production build. */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVaporApp, defineVaporComponent } from 'vue';
import { compileVaporSource } from '../compile-vapor';
import {
  VC_TRANSITION_TEMPLATES,
  type VcTransitionObservations,
  type VcTransitionTemplate,
  runVcTransitionObservations,
} from './vc-transition-fixture';

const fixtureEntry = resolve(process.cwd(), 'tests', 'vapor', 'vc-transition-fixture.ts');

let esbuild: typeof import('esbuild') | null = null;
try {
  esbuild = await import('esbuild');
} catch {
  esbuild = null;
}

const PROD_DEFINE = {
  'process.env.NODE_ENV': '"production"',
  __VUE_OPTIONS_API__: 'false',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
};

async function compileAll(isProd: boolean): Promise<Record<VcTransitionTemplate, string>> {
  const out = {} as Record<VcTransitionTemplate, string>;
  for (const [name, source] of Object.entries(VC_TRANSITION_TEMPLATES)) {
    out[name as VcTransitionTemplate] = await compileVaporSource(source, isProd);
  }
  return out;
}

const P = 'section.p';
const LEAVE = [`BeforeLeave:${P}:in`, `Leave:${P}:in`, `AfterLeave:${P}:out`];
const ENTER = [`BeforeEnter:${P}:in`, `Enter:${P}:in`, `AfterEnter:${P}:in`];

function assertBehaviours(o: VcTransitionObservations) {
  // (a) sync bus. Mounting dispatches nothing; a close runs the three leave
  // commands with the element, and AfterLeave sees it out of the document.
  expect(o.sync.mountedOpen).toEqual({ present: true, log: [] });
  expect(o.sync.closed).toEqual({ present: false, log: LEAVE });
  expect(o.sync.reopened).toEqual({ present: true, log: ENTER, newElement: true });
  expect(o.sync.mountedClosed).toEqual({ present: false, log: [] });
  expect(o.sync.openedFromClosed).toEqual({ present: true, log: ENTER });
  expect(o.sync.errors).toEqual([]);

  // (b) async bus, slow Leave: the element is in the DOM while the handler runs.
  expect(o.slowLeave.whileLeaving).toEqual({ present: true, log: LEAVE.slice(0, 2) });
  expect(o.slowLeave.afterAnswer).toEqual({ present: false, log: LEAVE.slice(2) });

  // (c) the content is live: while open, while leaving, and after a reopen.
  expect(o.live.whileOpen).toBe('changed while open');
  expect(o.live.whileLeaving).toBe('panel -> changed while leaving');
  expect(o.live.afterReopen).toBe('changed after reopen');

  // (d) reopened before the leave answered: LeaveCancelled, then the same
  // element enters again, and the older leave's answer removes nothing and
  // dispatches nothing.
  expect(o.reopenMidLeave.whileLeaving).toEqual(LEAVE.slice(0, 2));
  expect(o.reopenMidLeave.afterReopen).toEqual({
    present: true,
    log: [`LeaveCancelled:${P}:in`, ...ENTER],
    sameElement: true,
  });
  expect(o.reopenMidLeave.afterOldLeaveAnswers).toEqual({ present: true, log: [] });
  expect(o.reopenMidLeave.closedAgain).toEqual({ present: false, log: LEAVE });

  // (n) closed before the enter answered: EnterCancelled, then the leave; the
  // older enter's answer dispatches nothing (no AfterEnter).
  expect(o.closeMidEnter.whileEntering).toEqual(ENTER.slice(0, 2));
  expect(o.closeMidEnter.afterClose).toEqual({ present: false, log: [`EnterCancelled:${P}:in`, ...LEAVE] });
  expect(o.closeMidEnter.afterOldEnterAnswers).toEqual([]);

  // (e) unmounted mid-leave: no timer kept, nothing dispatched afterwards.
  expect(o.unmountMidLeave.timersWhileLeaving).toBe(1);
  expect(o.unmountMidLeave.timersAfterUnmount).toBe(0);
  expect(o.unmountMidLeave.logAfterUnmount).toEqual([]);
  expect(o.unmountMidLeave.present).toBe(false);

  // (f) a handler that never settles: the timeout finishes the transition.
  const warnings = o.build === 'dev' ? 1 : 0;
  expect(o.timeout.leave).toEqual({ presentBefore: true, present: false, log: LEAVE, warnings });
  expect(o.timeout.enter).toEqual({ log: ENTER, warnings });

  // (g) a Leave handler that rejects.
  expect(o.rejects).toEqual({ present: false, log: LEAVE });

  // (l) what is awaited is the DISPATCH. A sync bus answers at once, so the
  // element leaves at once, even though the handler's own promise never settles.
  expect(o.syncBusPromise).toEqual({ present: false, log: LEAVE });

  // (m) `appear`: content that is there at mount gets the enter commands,
  // once. Mounted closed it gets none until it opens, and then once.
  expect(o.appear.mountedOpen).toEqual({ present: true, log: ENTER });
  expect(o.appear.closed).toEqual({ present: false, log: LEAVE });
  expect(o.appear.mountedClosed).toEqual({ present: false, log: [] });
  expect(o.appear.openedFromClosed).toEqual({ present: true, log: ENTER });

  // (h) the action names are the bridge's.
  expect(o.names.namespaced.ours).toEqual(o.names.namespaced.bridge);
  expect(o.names.namespaced.ours).toEqual([
    'modalBeforeLeave',
    'modalLeave',
    'modalAfterLeave',
    'modalBeforeEnter',
    'modalEnter',
    'modalAfterEnter',
  ]);
  expect(o.names.bare.ours).toEqual(o.names.bare.bridge);
  expect(o.names.bare.ours).toEqual(['beforeLeave', 'leave', 'afterLeave', 'beforeEnter', 'enter', 'afterEnter']);
  expect(o.names.cancelled.ours).toEqual(o.names.cancelled.bridge);
  expect(o.names.cancelled.ours).toEqual(['enterCancelled', 'leaveCancelled']);

  // (i) no handler registered anywhere: it still hides and shows.
  expect(o.noHandlers).toEqual({ closed: true, reopened: true, errors: [] });

  // (j) no `:bus`: the shared bus gets the commands.
  expect(o.sharedBus).toEqual({ log: ['BeforeLeave', 'Leave', 'AfterLeave'], present: false });

  // (k) the target, per shape of slot content. Content with no element still
  // leaves; its commands carry no target.
  expect(o.targets.component).toEqual({ leave: 'Leave:article.p:in', hidden: true });
  expect(o.targets.multi).toEqual({ leave: 'Leave:i.first:in', hidden: true });
  expect(o.targets.conditionalIf).toEqual({ leave: 'Leave:section.p:in', hidden: true });
  expect(o.targets.conditionalElse).toEqual({ leave: 'Leave:aside.q:in', hidden: true });
  expect(o.targets.text).toEqual({ leave: 'Leave:none', hidden: true });
}

async function runUnderProductionBuild(): Promise<VcTransitionObservations> {
  const dir = mkdtempSync(join(tmpdir(), 'vc-transition-prod-'));
  const out = join(dir, 'vc-transition.prod.cjs');
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
      runVcTransitionObservations: typeof runVcTransitionObservations;
    };
    return await mod.runVcTransitionObservations(await compileAll(true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('VcTransition (vapor-chamber/transitions/vapor)', () => {
  it('the in-process arm runs on a with-vapor build (guards the harness itself)', () => {
    expect(typeof createVaporApp).toBe('function');
    expect(typeof defineVaporComponent).toBe('function');
  });

  it('shows, hides, waits for the leave, cancels, cleans up and times out', async () => {
    const o = await runVcTransitionObservations(await compileAll(false));
    expect(o.build).toBe('dev');
    assertBehaviours(o);
  });

  it.skipIf(!esbuild)('holds identically under an executed production build', async () => {
    const o = await runUnderProductionBuild();
    expect(o.build).toBe('prod');
    assertBehaviours(o);
  });
});

/*
 * Modelled on tests/vapor/vapor-outlet.test.ts, and for its reason: every
 * behaviour is asserted twice against the SAME function, in-process on the
 * dev build the vitest alias supplies and against an esbuild bundle built with
 * production defines and executed. This repo has been dev-correct and
 * prod-broken before.
 *
 * The templates are compiled HERE, on the installed Vue, and handed to the
 * fixture as generated source (the production bundle carries no compiler).
 * The production arm compiles with the compiler's own `isProd`, as a
 * production SFC build does.
 *
 * The only assertion that differs by build is the timeout warning: it is
 * DEV-gated, so one warning on the dev arm and none on the production arm.
 *
 * (d) is where this component differs from a `v-if` under Vue's transition on
 * purpose: the component owns the condition, so a reopen during a leave keeps
 * the SAME element instead of creating a second one beside a leaving one.
 * That is what a `v-show` under Vue's transition does, and the commands match
 * that case as the bridge dispatches it on Vue 3.6.0-rc.10 (measured, log
 * s35.38 b): LeaveCancelled, then the enter commands. (n) is the same on both
 * of Vue's forms: EnterCancelled, then the leave commands. A cancelled command
 * is dispatched only while an Enter or a Leave is still waiting for its
 * answer, so a sync bus never produces one: arm (a) lists its commands in
 * full.
 *
 * (l) is the bridge's rule, kept: `createTransitionBridge` calls `done()` at
 * once when the dispatch result is not a promise, and a sync bus returns
 * `{ ok, value, error }` with the handler's promise inside `value`. The shared
 * bus is a sync bus, so a leave that must be waited for needs an async bus
 * passed as `:bus`.
 *
 * (k) pins the element lookup through behaviour. The read itself, which is
 * not public API, is pinned shape by shape in
 * tests/vapor/vc-transition-helpers.test.ts.
 */
