// @vitest-environment happy-dom
/**
 * FIXTURE: `useCommand()` after a top-level `await` in a compiled `<script setup vapor>`, under a real `<Suspense>`.
 * Why: `useVaporAsyncCommand`'s docs show this pattern; after the await a composable works only if Vue restored the instance and its scope.
 * Shows: it compiles to an async setup with a render closure; cleanup arms after the await, nothing is left if unmounted during it, nested-block awaits too. A handler and a `useCommandGroup` the setup makes after the await are not left either. Composables made BEFORE the await keep nothing they are asked to register after it once the app unmounted during it; mounted, those registrations work and go on unmount.
 * See: vuejs/core 65819bf (#15433), e9515f1, 54097087 (#15465), 21dd33c61 (#16108).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as chamber from '../src/chamber';
import { configureVue, getCommandBus, setCommandBus, waitForVueDetection } from '../src/chamber';
import * as chamberVapor from '../src/chamber-vapor';
import { createCommandBus } from '../src/command-bus';
import { commandState } from '../src/command-state';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime surface - deliberately untyped. */
type VueApi = any;

/** Shared with the compiled component through its `vc:state` import. */
const state = {
  fired: [] as string[],
  /** What the late setup's on(), register() and use() returned, for the test to call. */
  offs: [] as Array<() => void>,
  gate: Promise.resolve(),
  open: () => {},
  reset() {
    this.fired.length = 0;
    this.offs.length = 0;
    this.gate = new Promise<void>((r) => {
      this.open = r;
    });
  },
};

const SFC = `<script setup vapor>
import { useCommand } from 'vc:chamber';
import { state } from 'vc:state';
await state.gate;
const { on } = useCommand();
on('ping', () => { state.fired.push('async'); });
</script>
<template><span>async</span></template>`;

/** The same contract, with the awaits inside a nested block. */
const SFC_NESTED = `<script setup vapor>
import { useCommand } from 'vc:chamber';
import { state } from 'vc:state';
if (true) {
  if (false) {}
  await state.gate;
  await Promise.resolve();
}
const { on } = useCommand();
on('ping', () => { state.fired.push('nested'); });
</script>
<template><span>nested</span></template>`;

/** Handlers and a group made after the await: what a setup registers once it resumes must go with it too. */
const SFC_LATE = `<script setup vapor>
import { useCommand, useCommandGroup } from 'vc:chamber';
import { useVaporAsyncCommand } from 'vc:chamber-vapor';
import { state } from 'vc:state';
await state.gate;
const { register, pending } = useCommand();
state.offs.push(register('late', () => 'mine'));
pending('late');
const group = useCommandGroup('grp');
state.offs.push(group.register('add', () => 'added'));
state.offs.push(group.use({ started: () => { state.fired.push('plugin'); } }));
state.offs.push(group.on('*', () => { state.fired.push('group'); }));
useVaporAsyncCommand().pending('late');
</script>
<template><span>late</span></template>`;

/** The same registrations, by composables made BEFORE the await: their scope may stop while the setup waits. */
const SFC_EARLY = `<script setup vapor>
import { useCommand, useCommandGroup } from 'vc:chamber';
import { useVaporAsyncCommand } from 'vc:chamber-vapor';
import { state } from 'vc:state';
const { on, register, pending } = useCommand();
const group = useCommandGroup('grp');
const asyncCommand = useVaporAsyncCommand();
await state.gate;
state.offs.push(on('ping', () => { state.fired.push('early'); }));
state.offs.push(register('late', () => 'mine'));
pending('late');
state.offs.push(group.register('add', () => 'added'));
state.offs.push(group.use({ started: () => { state.fired.push('plugin'); } }));
state.offs.push(group.on('*', () => { state.fired.push('group'); }));
asyncCommand.pending('late');
</script>
<template><span>early</span></template>`;

/** Compiled by the real compiler at test time, so the fixture follows what the installed compiler emits. */
function compile(source = SFC, filename = 'Async.vue') {
  const { descriptor } = parse(source, { filename });
  const { content } = compileScript(descriptor, { id: 'vc-async-setup', inlineTemplate: true });
  return { descriptor, content };
}

/** Run compiled SFC output in memory, imports bound to `modules`; no temp file, the runner will not import one from outside the root. */
function evaluate(content: string, modules: Record<string, object>): unknown {
  const body = content
    .replace(/^import \{([^}]*)\} from '([^']+)';?[ \t]*$/gm, (_line, names: string, spec: string) => {
      if (!Object.hasOwn(modules, spec)) throw new Error(`[fixture] unmapped import '${spec}'`);
      const bindings = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\s+as\s+/, ': '))
        .join(', ');
      return `const { ${bindings} } = __modules[${JSON.stringify(spec)}];`;
    })
    .replace(/^export default /m, 'return ');
  if (/^\s*(import|export)\b/m.test(body)) throw new Error('[fixture] module syntax left after binding');
  return new Function('__modules', body)(modules);
}

let v: VueApi;
let Async: unknown;
let AsyncNested: unknown;
let AsyncLate: unknown;
let AsyncEarly: unknown;

beforeAll(async () => {
  await waitForVueDetection();
  v = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
  const modules = { vue: v, 'vc:chamber': chamber, 'vc:chamber-vapor': chamberVapor, 'vc:state': { state } };
  Async = evaluate(compile().content, modules);
  AsyncNested = evaluate(compile(SFC_NESTED, 'AsyncNested.vue').content, modules);
  AsyncLate = evaluate(compile(SFC_LATE, 'AsyncLate.vue').content, modules);
  AsyncEarly = evaluate(compile(SFC_EARLY, 'AsyncEarly.vue').content, modules);
});

/** Let the gate's continuation, the restore microtasks and Suspense's resolve all run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function mountUnderSuspense(component: unknown = Async) {
  const Root = v.defineComponent({
    render: () =>
      v.h(v.Suspense, null, {
        default: () => v.h(component),
        fallback: () => v.h('i', 'fallback'),
      }),
  });
  const host = document.createElement('div');
  const app = v.createApp(Root);
  app.use(v.vaporInteropPlugin);
  app.mount(host);
  return { app, host };
}

describe('useCommand() after await in a compiled <script setup vapor> under Suspense (rc.8)', () => {
  beforeEach(() => {
    setCommandBus(createCommandBus());
    getCommandBus().register('ping', () => 'pong');
    state.reset();
  });

  it('compiles to an async setup with a render closure (the rc.8 shape)', () => {
    const { descriptor, content } = compile();
    expect(descriptor.vapor).toBe(true);
    expect(content).toMatch('async setup(');
    expect(content).toMatch('_withAsyncContext(');
    expect(content).toMatch('return () => {');
  });

  it('arms cleanup after the await, and the listener goes on unmount', async () => {
    const { app, host } = mountUnderSuspense();
    expect(host.textContent).toBe('fallback');

    state.open();
    await settle();
    await v.nextTick();
    expect(host.textContent).toBe('async');

    getCommandBus().dispatch('ping', null);
    expect(state.fired).toEqual(['async']);

    app.unmount();
    state.fired.length = 0;
    getCommandBus().dispatch('ping', null);
    expect(state.fired).toEqual([]);
  });

  it('leaves no listener behind when the app unmounts DURING the await', async () => {
    const { app, host } = mountUnderSuspense();
    expect(host.textContent).toBe('fallback');

    // Torn down while setup is suspended; the continuation still runs later.
    app.unmount();
    state.open();
    await settle();
    await settle();

    getCommandBus().dispatch('ping', null);
    expect(state.fired).toEqual([]);
  });

  // Vue rc.15 (#16108) runs a cleanup armed in a stopped scope at once, so the
  // composable is disposed before the setup's next line registers anything.
  it('leaves no handler, group or command state behind that the setup made after the await, when unmounted during it', async () => {
    const bus = getCommandBus();
    // A probe holder: when it leaves and no other holder is left, the next holder gets a fresh entry.
    const probe = commandState(bus);
    const errors = probe.errors;
    const { app } = mountUnderSuspense(AsyncLate);
    app.unmount();
    state.open();
    await settle();
    await settle();

    expect(bus.hasHandler('late')).toBe(false);
    expect(bus.hasHandler('grpAdd')).toBe(false);
    bus.emit('grpPing', null);
    bus.dispatch('ping', null);
    expect(state.fired).toEqual([]);
    // What they returned can still be called, as any off() can.
    expect(state.offs).toHaveLength(4);
    for (const off of state.offs) expect(() => off()).not.toThrow();
    probe.dispose();
    const next = commandState(bus);
    expect(next.errors).not.toBe(errors);
    next.dispose();
  });

  // Made before the await, the composables armed their cleanup on a live scope; the unmount ran it over an
  // empty list, so what the setup registers after the await must not stay (on rc.14 and rc.15 alike).
  it('leaves nothing behind that composables made BEFORE the await register after it, when unmounted during it', async () => {
    const bus = getCommandBus();
    const probe = commandState(bus);
    const errors = probe.errors;
    const { app } = mountUnderSuspense(AsyncEarly);
    app.unmount();
    state.open();
    await settle();
    await settle();

    expect(bus.hasHandler('late')).toBe(false);
    expect(bus.hasHandler('grpAdd')).toBe(false);
    bus.emit('grpPing', null);
    bus.dispatch('ping', null);
    expect(state.fired).toEqual([]);
    expect(state.offs).toHaveLength(5);
    for (const off of state.offs) expect(() => off()).not.toThrow();
    probe.dispose();
    const next = commandState(bus);
    expect(next.errors).not.toBe(errors);
    next.dispose();
  });

  it('control: mounted, what composables made before the await register after it works, and goes on unmount', async () => {
    const bus = getCommandBus();
    const { app, host } = mountUnderSuspense(AsyncEarly);
    state.open();
    await settle();
    await v.nextTick();
    expect(host.textContent).toBe('early');
    expect(bus.hasHandler('late')).toBe(true);
    bus.dispatch('ping', null);
    expect(state.fired).toContain('early');

    app.unmount();
    state.fired.length = 0;
    expect(bus.hasHandler('late')).toBe(false);
    bus.dispatch('ping', null);
    expect(state.fired).toEqual([]);
  });

  // Coverage of an ordinary shape the top-level case does not exercise, not a fails-before.
  it('arms cleanup after an await inside a nested block', async () => {
    const { content } = compile(SFC_NESTED, 'AsyncNested.vue');
    expect(content).toMatch('async setup(');
    expect(content).toMatch('_withAsyncContext(');

    const { app, host } = mountUnderSuspense(AsyncNested);
    expect(host.textContent).toBe('fallback');

    state.open();
    await settle();
    await v.nextTick();
    expect(host.textContent).toBe('nested');

    getCommandBus().dispatch('ping', null);
    expect(state.fired).toEqual(['nested']);

    app.unmount();
    state.fired.length = 0;
    getCommandBus().dispatch('ping', null);
    expect(state.fired).toEqual([]);
  });
});
