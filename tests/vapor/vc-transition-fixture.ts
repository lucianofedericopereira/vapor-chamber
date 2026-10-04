/**
 * Scenarios for `VcTransition`, on a real `createVaporApp`. No assertions here.
 */

import * as vue from 'vue';
import { getCommandBus } from '../../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../../src/command-bus';
import { createTransitionBridge } from '../../src/transitions';
import { VcTransition } from '../../src/transitions/vapor';
import { bindVapor } from '../bind-vapor';

const v = vue as any;

const tag = (attrs: string, body: string) => `<div class="host"><VcTransition ${attrs}>${body}</VcTransition></div>`;
const MODAL = ':show="s.open" namespace="modal" :bus="bus"';

/** The templates the test file compiles on the installed Vue and hands back as source. */
export const VC_TRANSITION_TEMPLATES = {
  panel: tag(`${MODAL} :timeout="s.timeout"`, '<section class="p">{{ s.label }}</section>'),
  bare: tag(':show="s.open" :bus="bus"', '<section class="p">x</section>'),
  shared: tag(':show="s.open" namespace="vcShared"', '<section class="p">x</section>'),
  component: tag(MODAL, '<Panel />'),
  multi: tag(MODAL, 'text<i class="first"></i><b class="second"></b>'),
  conditional: tag(MODAL, '<section class="p" v-if="s.inner">in</section><aside class="q" v-else>else</aside>'),
  text: tag(MODAL, 'just text'),
  appear: tag(`${MODAL} appear`, '<section class="p">{{ s.label }}</section>'),
} as const;

export type VcTransitionTemplate = keyof typeof VC_TRANSITION_TEMPLATES;

export type VcTransitionObservations = {
  build: 'dev' | 'prod';
  sync: {
    mountedOpen: { present: boolean; log: string[] };
    closed: { present: boolean; log: string[] };
    reopened: { present: boolean; log: string[]; newElement: boolean };
    mountedClosed: { present: boolean; log: string[] };
    openedFromClosed: { present: boolean; log: string[] };
    errors: string[];
  };
  slowLeave: {
    whileLeaving: { present: boolean; log: string[] };
    afterAnswer: { present: boolean; log: string[] };
  };
  live: {
    whileOpen: string;
    whileLeaving: string;
    afterReopen: string;
  };
  reopenMidLeave: {
    whileLeaving: string[];
    afterReopen: { present: boolean; log: string[]; sameElement: boolean };
    afterOldLeaveAnswers: { present: boolean; log: string[] };
    closedAgain: { present: boolean; log: string[] };
  };
  closeMidEnter: {
    whileEntering: string[];
    afterClose: { present: boolean; log: string[] };
    afterOldEnterAnswers: string[];
  };
  unmountMidLeave: {
    timersWhileLeaving: number;
    timersAfterUnmount: number;
    logAfterUnmount: string[];
    present: boolean;
  };
  timeout: {
    leave: { presentBefore: boolean; present: boolean; log: string[]; warnings: number };
    enter: { log: string[]; warnings: number };
  };
  rejects: { present: boolean; log: string[] };
  syncBusPromise: { present: boolean; log: string[] };
  appear: {
    mountedOpen: { present: boolean; log: string[] };
    mountedClosed: { present: boolean; log: string[] };
    openedFromClosed: { present: boolean; log: string[] };
    closed: { present: boolean; log: string[] };
  };
  names: {
    namespaced: { ours: string[]; bridge: string[] };
    bare: { ours: string[]; bridge: string[] };
    cancelled: { ours: string[]; bridge: string[] };
  };
  noHandlers: { closed: boolean; reopened: boolean; errors: string[] };
  sharedBus: { log: string[]; present: boolean };
  targets: Record<'component' | 'multi' | 'conditionalIf' | 'conditionalElse' | 'text', { leave: string; hidden: boolean }>;
};

const HOOKS = [
  'BeforeEnter',
  'Enter',
  'AfterEnter',
  'EnterCancelled',
  'BeforeLeave',
  'Leave',
  'AfterLeave',
  'LeaveCancelled',
] as const;
type Hook = (typeof HOOKS)[number];

const realSetTimeout = globalThis.setTimeout;
const wait = (ms: number) => new Promise<void>((r) => realSetTimeout(r, ms));
/** Past every microtask and every scheduler flush a toggle can start. */
async function settle() {
  await v.nextTick();
  await wait(0);
  await v.nextTick();
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function describeTarget(target: unknown): string {
  const el = target as Element | null | undefined;
  if (el?.nodeType !== 1) return 'none';
  return `${el.tagName.toLowerCase()}.${el.className}:${el.isConnected ? 'in' : 'out'}`;
}

/**
 * A real bus with a handler per hook. Each handler logs at CALL time, so an
 * entry means "dispatched", whether or not the handler has answered yet.
 */
function recorder(kind: 'sync' | 'async', namespace: string, slow: Partial<Record<Hook, () => Promise<void>>> = {}) {
  const log: string[] = [];
  const bus: any = kind === 'sync' ? createCommandBus() : createAsyncCommandBus();
  for (const hook of HOOKS) {
    bus.register(`${namespace}${hook}`, (cmd: { target: unknown }) => {
      log.push(`${hook}:${describeTarget(cmd.target)}`);
      return slow[hook]?.();
    });
  }
  const take = () => log.splice(0, log.length);
  return { bus, log, take };
}

function mount(code: string, ctx: Record<string, unknown>, components: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const render = bindVapor(v, code);
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => render(ctx) }));
  app.component('VcTransition', VcTransition);
  for (const [name, component] of Object.entries(components)) app.component(name, component);
  const errors: string[] = [];
  app.config.errorHandler = (e: unknown) => {
    errors.push(String(e).slice(0, 120));
  };
  app.mount(host);
  let mounted = true;
  return {
    host,
    errors,
    el: (selector = '.p') => host.querySelector(selector),
    present: (selector = '.p') => host.querySelector(selector) !== null,
    unmount: () => {
      if (mounted) app.unmount();
      mounted = false;
    },
    done() {
      this.unmount();
      host.remove();
    },
  };
}

/** Counts the timers the component holds, by the delay it asked for. */
function trackTimers(delay: number) {
  const realClear = globalThis.clearTimeout;
  const live = new Set<unknown>();
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = realSetTimeout(() => {
      live.delete(id);
      fn(...args);
    }, ms);
    if (ms === delay) live.add(id);
    return id;
  }) as never;
  globalThis.clearTimeout = ((id: unknown) => {
    live.delete(id);
    realClear(id as never);
  }) as never;
  return {
    count: () => live.size,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClear;
    },
  };
}

function captureWarnings() {
  const real = console.warn;
  const seen: string[] = [];
  console.warn = (...args: unknown[]) => {
    const text = args.map(String).join(' ');
    if (text.includes('[vapor-chamber]')) seen.push(text);
    else real(...args);
  };
  return {
    count: () => seen.length,
    restore() {
      console.warn = real;
    },
  };
}

/** One close and one reopen on an `onMissing: 'ignore'` bus, as the action names dispatched. */
async function actionsOfOneCycle(code: string, namespace: string | undefined) {
  const ours: string[] = [];
  const bus: any = createCommandBus({ onMissing: 'ignore' });
  bus.onAfter((cmd: { action: string }) => {
    ours.push(cmd.action);
  });
  const s = v.reactive({ open: true });
  const m = mount(code, { s, bus });
  s.open = false;
  await settle();
  s.open = true;
  await settle();
  m.done();

  const bridge: string[] = [];
  const bridgeBus: any = createCommandBus({ onMissing: 'ignore' });
  bridgeBus.onAfter((cmd: { action: string }) => {
    bridge.push(cmd.action);
  });
  const t = createTransitionBridge({ bus: bridgeBus, namespace });
  const el = document.createElement('div');
  t.onBeforeLeave(el);
  t.onLeave(el, () => {});
  t.onAfterLeave(el);
  t.onBeforeEnter(el);
  t.onEnter(el, () => {});
  t.onAfterEnter(el);
  return { ours, bridge };
}

/** Open, close before the Enter answers, reopen before the Leave answers: the two cancelled names, no namespace. */
async function cancelledNames(code: string) {
  const dispatched: string[] = [];
  const bus: any = createAsyncCommandBus();
  const pending = new Promise<void>(() => {});
  const BARE = ['beforeEnter', 'enter', 'afterEnter', 'enterCancelled', 'beforeLeave', 'leave', 'afterLeave', 'leaveCancelled'];
  for (const action of BARE) {
    bus.register(action, () => {
      dispatched.push(action);
      return action === 'enter' || action === 'leave' ? pending : undefined;
    });
  }
  const s = v.reactive({ open: false });
  const m = mount(code, { s, bus });
  s.open = true;
  await settle();
  s.open = false;
  await settle();
  s.open = true;
  await settle();
  m.done();

  const bridge: string[] = [];
  const bridgeBus: any = createCommandBus({ onMissing: 'ignore' });
  bridgeBus.onAfter((cmd: { action: string }) => {
    bridge.push(cmd.action);
  });
  const t = createTransitionBridge({ bus: bridgeBus });
  const el = document.createElement('div');
  t.onEnterCancelled(el);
  t.onLeaveCancelled(el);
  return { ours: dispatched.filter((action) => action.endsWith('Cancelled')), bridge };
}

export async function runVcTransitionObservations(
  code: Record<VcTransitionTemplate, string>,
): Promise<VcTransitionObservations> {
  const build: 'dev' | 'prod' = process.env.NODE_ENV === 'production' ? 'prod' : 'dev';

  // (a) sync bus: close, reopen; then the same from a component mounted closed.
  const a = recorder('sync', 'modal');
  const sa = v.reactive({ open: true, label: 'panel' });
  const ma = mount(code.panel, { s: sa, bus: a.bus });
  const mountedOpen = { present: ma.present(), log: a.take() };
  const firstEl = ma.el();
  sa.open = false;
  await settle();
  const closed = { present: ma.present(), log: a.take() };
  sa.open = true;
  await settle();
  const reopened = { present: ma.present(), log: a.take(), newElement: ma.el() !== null && ma.el() !== firstEl };
  const syncErrors = [...ma.errors];
  ma.done();

  const a2 = recorder('sync', 'modal');
  const sa2 = v.reactive({ open: false, label: 'panel' });
  const ma2 = mount(code.panel, { s: sa2, bus: a2.bus });
  const mountedClosed = { present: ma2.present(), log: a2.take() };
  sa2.open = true;
  await settle();
  const openedFromClosed = { present: ma2.present(), log: a2.take() };
  ma2.done();

  // (b) async bus, a Leave handler that takes time: the element stays until it answers.
  const gateB = deferred();
  const b = recorder('async', 'modal', { Leave: () => gateB.promise });
  const sb = v.reactive({ open: true, label: 'panel' });
  const mb = mount(code.panel, { s: sb, bus: b.bus });
  sb.open = false;
  await settle();
  const slowWhile = { present: mb.present(), log: b.take() };
  // (c) reactive content keeps updating: open, while leaving, and after a reopen.
  const whileLeavingBefore = mb.host.textContent ?? '';
  sb.label = 'changed while leaving';
  await settle();
  const liveWhileLeaving = mb.host.textContent ?? '';
  gateB.resolve();
  await settle();
  const slowAfter = { present: mb.present(), log: b.take() };
  mb.done();

  const c = recorder('sync', 'modal');
  const sc = v.reactive({ open: true, label: 'panel' });
  const mc = mount(code.panel, { s: sc, bus: c.bus });
  sc.label = 'changed while open';
  await settle();
  const liveWhileOpen = mc.host.textContent ?? '';
  sc.open = false;
  await settle();
  sc.open = true;
  await settle();
  sc.label = 'changed after reopen';
  await settle();
  const liveAfterReopen = mc.host.textContent ?? '';
  mc.done();

  // (d) close, then reopen before the leave has answered.
  const gateD = deferred();
  let leaveGate: Promise<void> = gateD.promise;
  const d = recorder('async', 'modal', { Leave: () => leaveGate });
  const sd = v.reactive({ open: true, label: 'panel' });
  const md = mount(code.panel, { s: sd, bus: d.bus });
  const elD = md.el();
  sd.open = false;
  await settle();
  const dWhile = d.take();
  sd.open = true;
  await settle();
  const dReopen = { present: md.present(), log: d.take(), sameElement: elD !== null && md.el() === elD };
  gateD.resolve();
  await settle();
  const dAfterOld = { present: md.present(), log: d.take() };
  // The component still leaves properly afterwards.
  leaveGate = Promise.resolve();
  sd.open = false;
  await settle();
  const dClosedAgain = { present: md.present(), log: d.take() };
  md.done();

  // (n) opened, then closed before the Enter has answered.
  const gateN = deferred();
  const n = recorder('async', 'modal', { Enter: () => gateN.promise });
  const sn = v.reactive({ open: false, label: 'panel' });
  const mn = mount(code.panel, { s: sn, bus: n.bus });
  sn.open = true;
  await settle();
  const nWhile = n.take();
  sn.open = false;
  await settle();
  const nClosed = { present: mn.present(), log: n.take() };
  gateN.resolve();
  await settle();
  const closeMidEnter = { whileEntering: nWhile, afterClose: nClosed, afterOldEnterAnswers: n.take() };
  mn.done();

  // (e) unmount in the middle of a leave.
  const timersE = trackTimers(30_000);
  const gateE = deferred();
  const e = recorder('async', 'modal', { Leave: () => gateE.promise });
  const se = v.reactive({ open: true, label: 'panel' });
  const me = mount(code.panel, { s: se, bus: e.bus });
  se.open = false;
  await settle();
  const timersWhileLeaving = timersE.count();
  e.take();
  me.unmount();
  const timersAfterUnmount = timersE.count();
  gateE.resolve();
  await settle();
  const unmountMidLeave = {
    timersWhileLeaving,
    timersAfterUnmount,
    logAfterUnmount: e.take(),
    present: me.present(),
  };
  timersE.restore();
  me.done();

  // (f) a handler that never settles must not strand the element.
  const never = new Promise<void>(() => {});
  const warnF = captureWarnings();
  const f = recorder('async', 'modal', { Leave: () => never });
  const sf = v.reactive({ open: true, label: 'panel', timeout: 25 });
  const mf = mount(code.panel, { s: sf, bus: f.bus });
  sf.open = false;
  await settle();
  const presentBefore = mf.present();
  await wait(80);
  await settle();
  const timeoutLeave = { presentBefore, present: mf.present(), log: f.take(), warnings: warnF.count() };
  mf.done();
  warnF.restore();

  const warnF2 = captureWarnings();
  const f2 = recorder('async', 'modal', { Enter: () => never });
  const sf2 = v.reactive({ open: false, label: 'panel', timeout: 25 });
  const mf2 = mount(code.panel, { s: sf2, bus: f2.bus });
  sf2.open = true;
  await wait(80);
  await settle();
  const timeoutEnter = { log: f2.take(), warnings: warnF2.count() };
  mf2.done();
  warnF2.restore();

  // (g) a Leave handler that rejects still lets the element go.
  const g = recorder('async', 'modal', { Leave: () => Promise.reject(new Error('leave failed')) });
  const sg = v.reactive({ open: true, label: 'panel' });
  const mg = mount(code.panel, { s: sg, bus: g.bus });
  sg.open = false;
  await settle();
  const rejects = { present: mg.present(), log: g.take() };
  mg.done();

  // (l) a SYNC bus whose Leave handler returns a promise that never settles.
  const l = recorder('sync', 'modal', { Leave: () => never });
  const sl = v.reactive({ open: true, label: 'panel' });
  const ml = mount(code.panel, { s: sl, bus: l.bus });
  sl.open = false;
  await settle();
  const syncBusPromise = { present: ml.present(), log: l.take() };
  ml.done();

  // (m) `appear`: the enter commands run for content that is there at mount.
  const m1 = recorder('sync', 'modal');
  const sm1 = v.reactive({ open: true, label: 'panel' });
  const mm1 = mount(code.appear, { s: sm1, bus: m1.bus });
  await settle();
  const appearOpen = { present: mm1.present(), log: m1.take() };
  sm1.open = false;
  await settle();
  const appearClosed = { present: mm1.present(), log: m1.take() };
  mm1.done();
  const m2 = recorder('sync', 'modal');
  const sm2 = v.reactive({ open: false, label: 'panel' });
  const mm2 = mount(code.appear, { s: sm2, bus: m2.bus });
  await settle();
  const appearMountedClosed = { present: mm2.present(), log: m2.take() };
  sm2.open = true;
  await settle();
  const appearOpenedFromClosed = { present: mm2.present(), log: m2.take() };
  mm2.done();
  const appear = {
    mountedOpen: appearOpen,
    mountedClosed: appearMountedClosed,
    openedFromClosed: appearOpenedFromClosed,
    closed: appearClosed,
  };

  // (h) the action names, against the bridge's, with and without a namespace.
  const names = {
    namespaced: await actionsOfOneCycle(code.panel, 'modal'),
    bare: await actionsOfOneCycle(code.bare, undefined),
    cancelled: await cancelledNames(code.bare),
  };

  // (i) a bus with no handler registered at all, and its default `onMissing`.
  const si = v.reactive({ open: true, label: 'panel' });
  const mi = mount(code.panel, { s: si, bus: createCommandBus() });
  si.open = false;
  await settle();
  const iClosed = !mi.present();
  si.open = true;
  await settle();
  const noHandlers = { closed: iClosed, reopened: mi.present(), errors: [...mi.errors] };
  mi.done();

  // (j) no `:bus`: the shared bus.
  const sharedLog: string[] = [];
  const shared: any = getCommandBus();
  const off = HOOKS.map((hook) =>
    shared.register(`vcShared${hook}`, () => {
      sharedLog.push(hook);
    }),
  );
  const sj = v.reactive({ open: true });
  const mj = mount(code.shared, { s: sj });
  sj.open = false;
  await settle();
  const sharedBus = { log: [...sharedLog], present: mj.present() };
  mj.done();
  for (const unregister of off) if (typeof unregister === 'function') unregister();

  // (k) which element the handlers get, per shape of slot content.
  const Panel = v.defineVaporComponent({ setup: () => v.template('<article class="p">panel</article>', 1)() });
  async function leaveTarget(template: string, selector: string, state: Record<string, unknown> = {}) {
    const r = recorder('sync', 'modal');
    const s = v.reactive({ open: true, ...state });
    const m = mount(template, { s, bus: r.bus }, { Panel });
    s.open = false;
    await settle();
    const leave = r.log.find((entry) => entry.startsWith('Leave:')) ?? 'not dispatched';
    const out = { leave, hidden: selector ? !m.present(selector) : (m.host.textContent ?? '') === '' };
    m.done();
    return out;
  }
  const targets = {
    component: await leaveTarget(code.component, '.p'),
    multi: await leaveTarget(code.multi, '.first'),
    conditionalIf: await leaveTarget(code.conditional, '.p', { inner: true }),
    conditionalElse: await leaveTarget(code.conditional, '.q', { inner: false }),
    text: await leaveTarget(code.text, ''),
  };

  return {
    build,
    sync: { mountedOpen, closed, reopened, mountedClosed, openedFromClosed, errors: syncErrors },
    slowLeave: { whileLeaving: slowWhile, afterAnswer: slowAfter },
    live: { whileOpen: liveWhileOpen, whileLeaving: `${whileLeavingBefore} -> ${liveWhileLeaving}`, afterReopen: liveAfterReopen },
    reopenMidLeave: { whileLeaving: dWhile, afterReopen: dReopen, afterOldLeaveAnswers: dAfterOld, closedAgain: dClosedAgain },
    closeMidEnter,
    unmountMidLeave,
    timeout: { leave: timeoutLeave, enter: timeoutEnter },
    rejects,
    syncBusPromise,
    appear,
    names,
    noHandlers,
    sharedBus,
    targets,
  };
}

/*
 * WHY THIS IS A SEPARATE MODULE FROM THE TEST FILE. The same reason
 * tests/vapor/vapor-outlet-fixture.ts gives: two arms run these scenarios, one
 * in-process under vitest and one that esbuild bundles under production
 * defines and executes outside the runner. The second cannot import vitest,
 * so this file returns observations and `vc-transition.test.ts` applies the
 * SAME assertions to both.
 *
 * WHY IT TAKES SOURCE AND NOT TEMPLATES. The production bundle has no compiler
 * in it. The test file compiles `VC_TRANSITION_TEMPLATES` on the installed
 * Vue and passes the generated module source in; `bindVapor` binds it to the
 * `vue` this build resolved. So both arms run what the installed compiler
 * emits for the text a consumer writes, and nothing here is a hand-written
 * copy of compiler output.
 *
 * EVERYTHING IS REAL: a real `createVaporApp`, the real buses from
 * `src/command-bus`, the real `createTransitionBridge` for the names arm. No
 * Vue transition is imported anywhere in this file, which is the premise.
 *
 * TIMERS. Arm (e) counts the timers the component holds by wrapping the
 * global `setTimeout` / `clearTimeout` and keeping the ones asked for with the
 * component's default delay; `timersWhileLeaving` is the positive control
 * that the wrapper sees them at all. The fixture's own waits go through the
 * unwrapped `setTimeout` captured at module load.
 */
