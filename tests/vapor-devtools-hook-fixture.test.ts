// @vitest-environment happy-dom
/**
 * The Vue devtools hook on a Vapor app: `component:added` and `component:removed` reach it for each Vapor component.
 * Why: `src/devtools.ts` builds its panel from the bus and asks nothing of Vue's tree, so a Vapor app in the devtools sits beside this library's own timeline; a Vapor instance must carry what the hook reads.
 * Shows: mounting a root and a child emits one added event each with the app, the uid and the parent's uid; unmounting emits one removed event each; the bus still dispatches from inside the mounted tree.
 * See: vuejs/core#16027, ROADMAP.md
 */

import { afterEach, describe, expect, it } from 'vitest';
import { configureVue, getCommandBus, resetCommandBus, setCommandBus, useCommand, waitForVueDetection } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const HOOK = '__VUE_DEVTOOLS_GLOBAL_HOOK__';

type Emitted = { name: string; args: unknown[] };

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[HOOK];
});

describe('the devtools hook on a Vapor app', () => {
  it('sees each component added and removed, with the bus untouched', async () => {
    await waitForVueDetection();
    const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
    configureVue(v);
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));

    const emitted: Emitted[] = [];
    // `createVaporApp` reads the hook off the global, where the extension puts it. `cleanupBuffer` answering false is the extension's "not buffered".
    (globalThis as Record<string, unknown>)[HOOK] = {
      enabled: true,
      cleanupBuffer: () => false,
      emit: (name: string, ...args: unknown[]) => emitted.push({ name, args }),
      on() {},
      once() {},
      off() {},
    };
    const of = (name: string) => emitted.filter((e) => e.name === name);

    const child = await compileVapor(v, '<p>x</p>');
    let dispatch: ReturnType<typeof useCommand>['dispatch'] | undefined;
    const Child = v.defineVaporComponent({
      setup() {
        dispatch = useCommand().dispatch;
        return child.render({});
      },
    });
    const root = await compileVapor(v, '<Child />');
    const host = document.createElement('div');
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => root.render({}) }));
    app.component('Child', Child);
    app.mount(host);

    const added = of('component:added');
    expect(added).toHaveLength(2);
    // Children mount first: the child names the root as its parent, the root names none.
    const [childAdded, rootAdded] = added;
    expect(childAdded.args[0]).toBe(app);
    expect(rootAdded.args[0]).toBe(app);
    expect(childAdded.args[2]).toBe(rootAdded.args[1]);
    expect(rootAdded.args[2]).toBeUndefined();
    expect(of('component:removed')).toHaveLength(0);

    const actions: string[] = [];
    getCommandBus().onAfter((cmd) => {
      actions.push(cmd.action);
    });
    dispatch?.('ping', {});
    expect(actions).toEqual(['ping']);

    app.unmount();
    expect(of('component:removed')).toHaveLength(2);
  });
});
