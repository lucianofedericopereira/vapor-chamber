// @vitest-environment happy-dom
/**
 * FIXTURE - `useCommand()` after a top-level `await` in a COMPILED
 * `<script setup vapor>`, mounted under a real `<Suspense>`, vue@3.6.0-rc.8
 * (65819bf, "render async setups from a settled hydration pass", #15433;
 * commit 20 of the rc.8 range - and e9515f1, commit 11, which registers the
 * async setup with the NEAREST Suspense).
 *
 * WHY THIS FILE EXISTS. `useVaporAsyncCommand`'s docs show exactly this
 * pattern - an awaiting `<script setup vapor>` under `<Suspense>` - and no
 * test mounted it. Everything after the `await` runs in a continuation, where
 * a composable only works if Vue has restored the component instance AND its
 * scope: `tryAutoCleanup` registers on `getCurrentScope()`, and the KeepAlive
 * guard asks `hasInjectionContext()`. rc.8 compiles such a setup into an
 * `async setup()` that uses runtime-core's `withAsyncContext` and returns the
 * template as a render closure run once setup has settled; runtime-vapor's own
 * `withAsyncContext` is gone. Read at source, runtime-core's `restore()` sets
 * the instance and its scope, so the cleanup should arm after the await - and
 * if the app is unmounted DURING the await, the stopped scope is restored,
 * `onScopeDispose` appends to it without an active check, and `reset()` runs
 * the cleanups a microtask later. This file checks both instead of trusting
 * the reading.
 *
 * The component is compiled here, at test time, by the real compiler
 * (`vue/compiler-sfc`, `inlineTemplate`), so the fixture follows whatever the
 * installed compiler emits rather than a hand copy of it. The output is
 * evaluated in memory: its only module syntax is named `import { ... } from`
 * lines and one `export default`, and `evaluate()` binds each import to an
 * injected module object (the with-vapor build for `vue`, this repo's chamber
 * for the composable) and throws on anything it cannot map. No temp file: the
 * module runner will not import one from outside the project root, and a copy
 * inside it would be one more thing to clean up.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileScript, parse } from 'vue/compiler-sfc';
import * as chamber from '../src/chamber';
import { configureVue, getCommandBus, setCommandBus, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime surface - deliberately untyped. */
type VueApi = any;

/** Shared with the compiled component through its `vc:state` import. */
const state = {
  fired: [] as string[],
  gate: Promise.resolve(),
  open: () => {},
  reset() {
    this.fired.length = 0;
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

function compile() {
  const { descriptor } = parse(SFC, { filename: 'Async.vue' });
  const { content } = compileScript(descriptor, { id: 'vc-async-setup', inlineTemplate: true });
  return { descriptor, content };
}

/** Run compiled SFC output with its named imports bound to `modules`. */
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

beforeAll(async () => {
  await waitForVueDetection();
  v = await import(/* @vite-ignore */ WITH_VAPOR);
  configureVue(v);
  Async = evaluate(compile().content, { vue: v, 'vc:chamber': chamber, 'vc:state': { state } });
});

/** Let the gate's continuation, the restore microtasks and Suspense's resolve all run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

function mountUnderSuspense() {
  const Root = v.defineComponent({
    render: () =>
      v.h(v.Suspense, null, {
        default: () => v.h(Async),
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
});
