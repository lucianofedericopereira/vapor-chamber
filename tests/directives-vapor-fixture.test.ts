// @vitest-environment happy-dom
/**
 * FIXTURE: `v-vc-command`, `v-vc-payload` and `v-vc-optimistic` on real Vapor and vDOM apps, from the with-vapor build.
 * Why: a port must be the same directive, not a lookalike; Vapor runs it once per element with a getter and no `updated` hook, and only a compile on the installed Vue sees what templates emit.
 * Shows: clicks dispatch; modifiers match vDOM; a changed binding re-targets; payload and optimistic work in any order; unmount and v-if take listeners off by identity; the delegated count holds.
 * See: tests/vapor-directives-fixture.test.ts, tests/directives.test.ts, tests/compile-vapor.ts, log s34.19, log s34.26, vuejs/core#15490, #14948, #15489, 80b3a046, 86d44991.
 */

import type { VaporDirective } from '@vue/runtime-vapor';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import {
  createDirectivePlugin,
  vcCommandVapor,
  vcOptimisticVapor,
  vcPayloadVapor,
} from '../src/directives';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

/** Derived from Vue's VaporDirective, not restated: the next change to the call shape is a typecheck failure here. */
type Tuple = [dir: typeof vcCommandVapor, ...rest: Parameters<VaporDirective> extends [unknown, ...infer R] ? R : never];

/** Mount `<div><button>go</button></div>` with the directive on the button. */
async function mount(tuple: (vVc: typeof vcCommandVapor) => Tuple) {
  const v = await vapor();
  let invocations = 0;
  // Counts how many times Vue calls the directive FUNCTION - once, by design.
  const vVc: typeof vcCommandVapor = (...args) => {
    invocations++;
    return vcCommandVapor(...args);
  };
  const Comp = v.defineVaporComponent({
    setup() {
      const root = v.template('<div><button>go</button></div>', true)();
      v.withVaporDirectives(root.firstChild, [tuple(vVc)]);
      return root;
    },
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(Comp);
  app.mount(host);
  const button = host.querySelector('button') as HTMLButtonElement;
  const div = host.querySelector('div') as HTMLDivElement;
  return { app, host, button, div, invocations: () => invocations };
}

/** Let an async dispatch settle (the handler is async even on a sync bus). */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('v-vc-command on a real Vapor app (vcCommandVapor)', () => {
  const seen: string[] = [];

  // Loads the with-vapor build in a hook: inside a test it could time out, and its late click would land in the next test.
  beforeAll(async () => {
    await vapor();
  });

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd) => {
      seen.push(cmd.action);
    });
  });

  it('dispatches the bound action on click', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd']);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
    host.remove();
  });

  it('re-targets when the binding changes - no updated hook, no freeze', async () => {
    const v = await vapor();
    const action = v.shallowRef('cartAdd');
    const { app, host, button, invocations } = await mount((vVc) => [vVc, () => action.value]);

    button.click();
    await settle();
    action.value = 'cartRemove';
    await v.nextTick();
    button.click();
    await settle();

    // The directive function ran once; the second click still reached the new
    // action. A port that stored `value()` at mount would dispatch cartAdd twice.
    expect(invocations()).toBe(1);
    expect(seen).toEqual(['cartAdd', 'cartRemove']);
    app.unmount();
    host.remove();
  });

  it('an UNKEYED v-for shifts items under a reused element, and the click follows the item', async () => {
    const v = await vapor();
    // Unkeyed: Vapor reuses the element and moves the item under it, with no directive re-run. A keyed reorder moves the node, so it cannot show this.
    const { render } = await compileVapor(
      v,
      '<ul><li v-for="it in items"><button v-vc-command="it.act">{{ it.id }}</button></li></ul>',
    );
    const st = v.reactive({
      items: [
        { id: 'a', act: 'cartAdd' },
        { id: 'b', act: 'cartRemove' },
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => render(st) }));
    app.directive('vc-command', vcCommandVapor);
    app.mount(host);

    const first = host.querySelector('button') as HTMLButtonElement;
    first.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    // Drop the head. Unkeyed, so the ELEMENT stays and "b" moves into it.
    st.items = [st.items[1]];
    await v.nextTick();
    const after = host.querySelector('button') as HTMLButtonElement;
    expect(after).toBe(first);

    after.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    app.unmount();
    host.remove();
  });

  it('honours .stop the way the vDOM directive does', async () => {
    const { app, host, button, div } = await mount((vVc) => [vVc, () => 'cartAdd', undefined, { stop: true }]);
    let bubbled = 0;
    div.addEventListener('click', () => {
      bubbled++;
    });
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    expect(bubbled).toBe(0);
    app.unmount();
    host.remove();
  });

  // The argument is inert: the selector is the directive's name.
  it('ignores whatever is in the argument slot - the selector is the name now', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd', () => 'payload']);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
    host.remove();
  });

  it('removes its listener on unmount', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd']);
    app.unmount();
    // The element is detached, but a reference to it can still be clicked;
    // with the listener gone, nothing dispatches.
    button.click();
    await settle();
    expect(seen).toEqual([]);
    host.remove();
  });

  it('.delegate shares the document listener and drops it on unmount', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd', undefined, { delegate: true }]);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    app.unmount();
    // Same element, re-attached so a click would bubble to the document: the
    // delegated listener must be gone with the last delegated element.
    document.body.appendChild(button);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    button.remove();
    host.remove();
  });

  it('.delegate: v-if removal and unmount both run the Vapor teardown - refcount and state map', async () => {
    const v = await vapor();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const clicks = (s: typeof add) => s.mock.calls.filter((c) => c[0] === 'click').length;

    // Compiled, because the v-if codegen is the part under test.
    const { render } = await compileVapor(
      v,
      '<div><button v-if="show" v-vc-command.delegate="a">A</button>' +
        '<button v-vc-command.delegate="b">B</button></div>',
    );
    const state = v.reactive({ show: true, a: 'cartAdd', b: 'cartRemove' });
    const Comp = v.defineVaporComponent({ setup: () => render(state) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Comp);
    app.directive('vc-command', vcCommandVapor);
    app.mount(host);

    const [a, b] = Array.from(host.querySelectorAll('button')) as HTMLButtonElement[];
    // One listener for both: Vue registers the directive's returned cleanup with onScopeDispose.
    expect(clicks(add)).toBe(1);
    a.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    // v-if removes the element while the app runs; the runtime must stop the directive's scope, or the count climbs forever.
    state.show = false;
    await v.nextTick();
    expect(host.querySelectorAll('button')).toHaveLength(1);
    // B still needs the shared listener, so it must still be installed.
    expect(clicks(remove)).toBe(0);

    // ...and A must be gone from the state map. Put it back where its click
    // really does reach the document listener, and check the lookup misses.
    document.body.appendChild(a);
    a.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    b.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    // The other route, for the last element.
    app.unmount();
    const added = add.mock.calls.filter((c) => c[0] === 'click');
    const removed = remove.mock.calls.filter((c) => c[0] === 'click');
    expect(removed).toHaveLength(1);
    expect(removed[0][1]).toBe(added[0][1]);
    expect(removed[0][2]).toBe(added[0][2]);

    add.mockRestore();
    remove.mockRestore();
    a.remove();
    host.remove();
  });

  it('registers app-wide: app.directive("vc-command", vcCommandVapor), resolved as a compiled template does', async () => {
    const v = await vapor();
    const Comp = v.defineVaporComponent({
      setup() {
        const vc = v.resolveDirective('vc-command');
        const root = v.template('<div><button>go</button></div>', true)();
        v.withVaporDirectives(root.firstChild, [[vc, () => 'cartAdd']]);
        return root;
      },
    });
    const host = document.createElement('div');
    const app = v.createVaporApp(Comp);
    app.directive('vc-command', vcCommandVapor);
    app.mount(host);
    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
  });

  // The tuple comes from the installed compiler, not a literal, so the next shape change fails here on the Vue bump.
  it('runs the code the installed compiler emits for <button v-vc-command.stop="action">', async () => {
    const v = await vapor();
    const { render, code } = await compileVapor(v, '<button v-vc-command.stop="action">go</button>');
    // The directive really goes through the compiled call.
    expect(code).toContain('_withVaporDirectives(');

    const Comp = v.defineVaporComponent({ setup: () => render({ action: 'cartAdd' }) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Comp);
    app.directive('vc-command', vcCommandVapor);
    app.mount(host);

    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
    host.remove();
  });

  // A string in the argument slot is data the directive never touches: it cannot throw, skip mounting or silence a control.
  it('a STRING in the argument slot - the pre-#15490 shape - cannot break the directive', async () => {
    const v = await vapor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Comp = v.defineVaporComponent({
      setup() {
        const root = v.template('<div><button>go</button></div>', true)();
        v.withVaporDirectives(root.firstChild, [[vcCommandVapor, () => 'cartAdd', 'command' as never]]);
        return root;
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(Comp);
    app.mount(host);

    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    // ...and says nothing.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[vapor-chamber]'))).toEqual([]);

    warn.mockRestore();
    app.unmount();
    host.remove();
  });

  // Pins the order: Vue compiles directives after props, so a template @click registers first and its veto stands.
  it('a template @click on the same element runs first, and its veto stands', async () => {
    const v = await vapor();
    const arms: Array<[string, string[]]> = [];
    for (const arm of ['plain', 'disable', 'stopImmediate'] as const) {
      seen.length = 0;
      const { render } = await compileVapor(
        v,
        `<div><button v-vc-command="'cartAdd'" @click="mine">go</button></div>`,
      );
      const host = document.createElement('div');
      document.body.appendChild(host);
      const app = v.createVaporApp(
        v.defineVaporComponent({
          setup: () =>
            render({
              mine: (e: Event) => {
                if (arm === 'disable') (e.currentTarget as HTMLButtonElement).disabled = true;
                if (arm === 'stopImmediate') e.stopImmediatePropagation();
              },
            }),
        }),
      );
      app.directive('vc-command', vcCommandVapor);
      app.mount(host);
      (host.querySelector('button') as HTMLButtonElement).click();
      await settle();
      arms.push([arm, [...seen]]);
      app.unmount();
      host.remove();
    }
    expect(arms).toEqual([
      ['plain', ['cartAdd']],
      ['disable', []],
      ['stopImmediate', []],
    ]);
  });

  // A bound :onClick on a native element is a listener too, registered first.
  it('a bound :onClick on the same element runs first too, and its veto stands', async () => {
    const v = await vapor();
    const arms: Array<[string, number, string[]]> = [];
    for (const arm of ['plain', 'disable', 'stopImmediate'] as const) {
      seen.length = 0;
      let ran = 0;
      const { render } = await compileVapor(
        v,
        `<div><button v-vc-command="'cartAdd'" :onClick="mine">go</button></div>`,
      );
      const host = document.createElement('div');
      document.body.appendChild(host);
      const app = v.createVaporApp(
        v.defineVaporComponent({
          setup: () =>
            render({
              mine: (e: Event) => {
                ran++;
                if (arm === 'disable') (e.currentTarget as HTMLButtonElement).disabled = true;
                if (arm === 'stopImmediate') e.stopImmediatePropagation();
              },
            }),
        }),
      );
      app.directive('vc-command', vcCommandVapor);
      app.mount(host);
      (host.querySelector('button') as HTMLButtonElement).click();
      await settle();
      arms.push([arm, ran, [...seen]]);
      app.unmount();
      host.remove();
    }
    expect(arms).toEqual([
      ['plain', 1, ['cartAdd']],
      ['disable', 1, []],
      ['stopImmediate', 1, []],
    ]);
  });

  // The plugin on a Vapor app names the fix, and is silent in production.
  it('createDirectivePlugin() on a Vapor app warns with our text, not just any text', async () => {
    const v = await vapor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Compiled, so Vue's own warning fires too: asserting "a warning fired" would pass on Vue's, which names no fix.
    const { render } = await compileVapor(v, `<div><button v-vc-command="'cartAdd'">go</button></div>`);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => render({}) }));
    expect(app.vapor).toBeTruthy(); // the own-property the guard reads
    app.use(createDirectivePlugin());
    app.mount(host);

    const said = warn.mock.calls.map((c) => String(c[0]));
    const ours = said.filter((m) => m.startsWith('[vapor-chamber]'));
    const vues = said.filter((m) => m.includes('VDOM object directive'));

    // Both fire, and they are different messages: the discrimination is real.
    expect(vues.length).toBeGreaterThan(0);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toContain('On a Vapor app use vcCommandVapor');

    // ...and the control stays inert, which is why the warning exists.
    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(seen).toEqual([]);

    warn.mockRestore();
    app.unmount();
    host.remove();
  });

  it('...and says nothing in production', async () => {
    const v = await vapor(); // before the reset, so the app keeps this Vue instance
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const directives = await import('../src/directives');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const host = document.createElement('div');
      document.body.appendChild(host);
      const app = v.createVaporApp(
        v.defineVaporComponent({ setup: () => v.template('<div><button>go</button></div>', true)() }),
      );
      app.use(directives.createDirectivePlugin());
      app.mount(host);

      const ours = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[vapor-chamber]'));
      expect(ours).toEqual([]);

      warn.mockRestore();
      app.unmount();
      host.remove();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });

  // Type-only: our exported directive still satisfies Vue's VaporDirective.
  it('vcCommandVapor is assignable to Vue VaporDirective', () => {
    const asVueDirective: VaporDirective = vcCommandVapor;
    expect(typeof asVueDirective).toBe('function');
  });
});

/** `[directive name, value, argument, modifiers]` - what a template compiles to. */
type Dir = [name: string, value: unknown, arg?: string, modifiers?: Record<string, boolean>];

/** A directive on `tag` as a render function writes it, resolved from the app, so the test never calls a hook itself. */
function withDirs(v: VaporApi, tag: string, props: Record<string, unknown> | null, dirs: Dir[]): unknown {
  return v.withDirectives(
    v.h(tag, props, 'go'),
    dirs.map(([name, value, arg, modifiers]) => [v.resolveDirective(name), value, arg, modifiers]),
  );
}

/** A vDOM app from the same with-vapor build, plugin installed; Vue drives mounted, updated and beforeUnmount. */
function mountVdom(v: VaporApi, render: () => unknown, plugin = createDirectivePlugin()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createApp({ render }).use(plugin);
  app.mount(host);
  return { app, host, el: (sel = 'button') => host.querySelector(sel) as HTMLElement };
}

describe('v-vc-command on a real vDOM app (createDirectivePlugin)', () => {
  const seen: string[] = [];

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd) => {
      seen.push(cmd.action);
    });
  });

  it('dispatches with v-vc-payload, and follows action and payload through an update', async () => {
    const v = await vapor();
    const payloads: unknown[] = [];
    getCommandBus().onAfter((cmd) => {
      payloads.push(cmd.payload);
    });
    const action = v.shallowRef('cartAdd');
    const payload = v.shallowRef({ id: 1 });
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [
        ['vc-command', action.value],
        ['vc-payload', payload.value],
      ]),
    );

    el().click();
    await settle();
    action.value = 'cartRemove';
    payload.value = { id: 2 };
    await v.nextTick();
    el().click();
    await settle();

    expect(seen).toEqual(['cartAdd', 'cartRemove']);
    expect(payloads).toEqual([{ id: 1 }, { id: 2 }]);
    app.unmount();
    host.remove();
  });

  it('v-vc-optimistic: applied first, rolled back on failure, a throwing rollback contained', async () => {
    const v = await vapor();
    getCommandBus().register('cartAdd', () => {
      throw new Error('out of stock');
    });
    const log: string[] = [];
    const optimistic = v.shallowRef((cmd: { action: string }): (() => void) | null => {
      log.push(`apply ${cmd.action}`);
      return () => log.push('rollback');
    });
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [
        ['vc-command', 'cartAdd'],
        ['vc-optimistic', optimistic.value],
      ]),
    );

    el().click();
    await settle();
    expect(log).toEqual(['apply cartAdd', 'rollback']);
    expect(el().classList.contains('vc-error')).toBe(true);

    // Through `updated`: a rollback that throws stays inside the directive -
    // an escape would surface as an unhandled rejection and fail this run.
    optimistic.value = () => () => {
      throw new Error('rollback failed');
    };
    await v.nextTick();
    el().click();
    await settle();

    // And one that offers no rollback at all.
    optimistic.value = () => null;
    await v.nextTick();
    el().click();
    await settle();
    expect(el().classList.contains('vc-error')).toBe(true);
    app.unmount();
    host.remove();
  });

  // Compiled from what a consumer types: `withDirs` takes the name as given, so only this can see the notation.
  it('COMPILED notation: v-vc-command + v-vc-payload reach the dispatch together', async () => {
    const v = await vapor();
    const got: unknown[] = [];
    getCommandBus().onAfter((cmd) => {
      got.push(cmd.payload);
    });

    const { render, code } = await compileVdom(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-payload="{ id: 7 }">go</button>`,
    );
    // The names resolve separately; a colon form would share one `vc` and leave the payload inert.
    expect(code).toContain('resolveDirective("vc-command")');
    expect(code).toContain('resolveDirective("vc-payload")');
    expect(code).not.toContain('resolveDirective("vc")');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createApp({ render }).use(createDirectivePlugin());
    app.mount(host);

    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();

    expect(seen).toEqual(['cartAdd']);
    expect(got).toEqual([{ id: 7 }]);

    app.unmount();
    host.remove();
  });

  it('COMPILED notation: v-vc-optimistic applies and rolls back from a template', async () => {
    const v = await vapor();
    getCommandBus().register('cartAdd', () => {
      throw new Error('out of stock');
    });
    const log: string[] = [];

    // The same notation check for v-vc-optimistic; the Vapor half is further down.
    const { render, code } = await compileVdom(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-optimistic="fn">go</button>`,
    );
    expect(code).toContain('resolveDirective("vc-optimistic")');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v
      .createApp({
        render,
        data: () => ({
          fn: () => {
            log.push('apply');
            return () => log.push('rollback');
          },
        }),
      })
      .use(createDirectivePlugin());
    app.mount(host);

    const button = host.querySelector('button') as HTMLButtonElement;
    button.click();
    await settle();

    expect(log).toEqual(['apply', 'rollback']);
    expect(button.classList.contains('vc-error')).toBe(true);

    app.unmount();
    host.remove();
  });

  it('v-vc-payload and v-vc-optimistic without v-vc-command are inert', async () => {
    const v = await vapor();
    const p = v.shallowRef(1);
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [
        ['vc-payload', p.value],
        ['vc-optimistic', () => null],
      ]),
    );
    p.value = 2;
    await v.nextTick();
    el().click();
    await settle();
    expect(seen).toEqual([]);
    app.unmount();
    host.remove();
  });

  // The argument reaches no hook, and teardown answers to the mount, never to the binding.
  it('a stray argument reaches no hook - mount, update and unmount all ignore it', async () => {
    const v = await vapor();
    const value = v.shallowRef('cartAdd');
    const { app, host, el } = mountVdom(v, () => withDirs(v, 'button', null, [['vc-command', value.value, 'other']]));
    el().click();
    await settle();
    // mounted ran despite the argument.
    expect(seen).toEqual(['cartAdd']);

    // updated ran too: the action follows the binding.
    value.value = 'cartRemove';
    await v.nextTick();
    el().click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    // beforeUnmount detached it.
    const button = el();
    app.unmount();
    document.body.appendChild(button);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);
    button.remove();
    host.remove();
  });

  it('mouse-button modifiers pick the button, and a .capture listener comes off on unmount', async () => {
    const v = await vapor();
    const { app, host, el } = mountVdom(v, () =>
      v.h('div', null, [
        withDirs(v, 'button', { id: 'mid' }, [['vc-command', 'middleAct', undefined, { middle: true }]]),
        withDirs(v, 'button', { id: 'right' }, [['vc-command', 'rightAct', undefined, { right: true }]]),
        withDirs(v, 'button', { id: 'cap' }, [['vc-command', 'capAct', undefined, { capture: true }]]),
      ]),
    );
    const press = (id: string, button: number) =>
      el(`#${id}`).dispatchEvent(new MouseEvent('click', { button, bubbles: true }));

    press('mid', 0);
    press('right', 0);
    await settle();
    expect(seen).toEqual([]);
    press('mid', 1);
    press('right', 2);
    press('cap', 0);
    await settle();
    expect(seen).toEqual(['middleAct', 'rightAct', 'capAct']);

    const cap = el('#cap');
    app.unmount();
    cap.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(seen).toEqual(['middleAct', 'rightAct', 'capAct']);
    host.remove();
  });

  it('reads data-vc-payload / data-vc-target from the element, and ignores malformed JSON', async () => {
    const v = await vapor();
    const got: unknown[] = [];
    getCommandBus().onAfter((cmd) => {
      got.push([cmd.target, cmd.payload]);
    });
    const { app, host, el } = mountVdom(v, () =>
      v.h('div', null, [
        withDirs(v, 'button', { id: 'good', 'data-vc-payload': '{"id":7}', 'data-vc-target': '{"sku":"a"}' }, [
          ['vc-command', 'cartAdd'],
        ]),
        withDirs(v, 'button', { id: 'bad', 'data-vc-payload': '{not json' }, [['vc-command', 'cartAdd']]),
      ]),
    );
    el('#good').click();
    el('#bad').click();
    await settle();
    expect(got).toEqual([
      [{ sku: 'a' }, { id: 7 }],
      [{}, undefined],
    ]);
    app.unmount();
    host.remove();
  });

  it('async bus: a click while in flight is dropped, and the .<ms> timeout settles a hung dispatch', async () => {
    const v = await vapor();
    const bus = createAsyncCommandBus();
    setCommandBus(bus);
    let calls = 0;
    bus.register('slow', () => {
      calls++;
      return new Promise(() => {}); // never settles
    });
    // A <span>: the second click is dropped by the directive's in-flight guard, whatever the element.
    const { app, host, el } = mountVdom(v, () => withDirs(v, 'span', null, [['vc-command', 'slow', undefined, { '200': true }]]));

    el('span').click();
    el('span').click();
    await settle();
    expect(calls).toBe(1);
    // 200ms: wide enough that a loaded run (coverage) still checks in flight.
    expect(el('span').classList.contains('vc-loading')).toBe(true);

    await new Promise((r) => setTimeout(r, 260));
    expect(el('span').classList.contains('vc-loading')).toBe(false);
    expect(el('span').classList.contains('vc-error')).toBe(true);
    app.unmount();
    host.remove();
  });

  it('a bus that throws (onMissing: throw) or rejects (naming: throw, async) marks the element failed', async () => {
    const v = await vapor();
    setCommandBus(createCommandBus({ onMissing: 'throw' }));
    const sync = mountVdom(v, () => withDirs(v, 'button', null, [['vc-command', 'nobodyHome']]));
    sync.el().click();
    await settle();
    expect(sync.el().classList.contains('vc-error')).toBe(true);
    sync.app.unmount();
    sync.host.remove();

    // A naming violation throws inside the async dispatch, so the PROMISE the
    // directive races against its timeout rejects.
    setCommandBus(createAsyncCommandBus({ naming: { pattern: /^[a-z]+[A-Z]/, onViolation: 'throw' } }));
    const async = mountVdom(v, () => withDirs(v, 'button', null, [['vc-command', 'BADNAME']]));
    async.el().click();
    await settle();
    expect(async.el().classList.contains('vc-error')).toBe(true);
    async.app.unmount();
    async.host.remove();
  });

  it('.delegate: a click outside every delegated element stops at the document', async () => {
    const v = await vapor();
    const { app, host, el } = mountVdom(v, () =>
      v.h('div', null, [
        withDirs(v, 'button', { id: 'del' }, [['vc-command', 'cartAdd', undefined, { delegate: true }]]),
        v.h('p', { id: 'elsewhere' }, 'text'),
      ]),
    );
    el('#elsewhere').click();
    await settle();
    expect(seen).toEqual([]);
    el('#del').click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
    host.remove();
  });

  it('two v-vc-command bindings on one element: the second replaces the first, nothing is stranded', async () => {
    // A template cannot write this, but a render function can: both mounted hooks run on one element.
    const v = await vapor();
    const first = v.shallowRef('cartAdd');
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [
        ['vc-command', first.value],
        ['vc-command', 'cartRemove'],
      ]),
    );
    const button = el();

    button.click();
    await settle();
    expect(seen).toEqual(['cartRemove']);

    // Both updated hooks write the one state, in binding order: last wins again.
    first.value = 'cartClear';
    await v.nextTick();
    button.click();
    await settle();
    expect(seen).toEqual(['cartRemove', 'cartRemove']);

    // A retained reference to the detached element: nothing may still listen.
    app.unmount();
    button.click();
    await settle();
    expect(seen).toEqual(['cartRemove', 'cartRemove']);
    host.remove();
  });

  // The shared document listener comes off by identity, not merely goes quiet, also after an update.
  it('.delegate: the document listener comes off by identity after an update and unmount', async () => {
    const v = await vapor();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const action = v.shallowRef('cartAdd');
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [['vc-command', action.value, undefined, { delegate: true }]]),
    );
    const button = el();
    const clicksOn = (spy: typeof add) => spy.mock.calls.filter((c) => c[0] === 'click').length;
    expect(clicksOn(add)).toBe(1);

    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    // Through `updated`: the action follows the binding on the same shared listener.
    action.value = 'cartRemove';
    await v.nextTick();
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    // The shared listener really comes off the document.
    app.unmount();
    const added = add.mock.calls.filter((c) => c[0] === 'click');
    const removed = remove.mock.calls.filter((c) => c[0] === 'click');
    expect(removed).toHaveLength(1);
    // removeEventListener is a silent no-op on a different handler or options, so compare by identity, not count.
    expect(removed[0][1]).toBe(added[0][1]);
    expect(removed[0][2]).toBe(added[0][2]);

    // From a fresh attached node: a re-attached one would also pass if the handler were merely inert.
    const stray = document.createElement('button');
    document.body.appendChild(stray);
    stray.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);
    stray.remove();

    // The count went back to zero, so the next delegated element re-attaches.
    const second = mountVdom(v, () => withDirs(v, 'button', null, [['vc-command', 'cartAdd', undefined, { delegate: true }]]));
    expect(clicksOn(add)).toBe(2);
    second.app.unmount();

    add.mockRestore();
    remove.mockRestore();
    button.remove();
    host.remove();
    second.host.remove();
  });

  it('direct: the listener comes off the element by identity after an update and unmount', async () => {
    const v = await vapor();
    const action = v.shallowRef('cartAdd');
    // The button does not exist until mountVdom has already bound the listener
    // to it, so the ADD is captured from the prototype, with its receiver.
    const bound: Array<[unknown, unknown, unknown]> = [];
    // happy-dom's EventTarget is not the global one - the element's chain owns
    // addEventListener on its own. Find the real owner from a throwaway node.
    let proto: any = Object.getPrototypeOf(document.createElement('button'));
    while (proto && !Object.hasOwn(proto, 'addEventListener')) {
      proto = Object.getPrototypeOf(proto);
    }
    const realAdd = proto.addEventListener;
    const addSpy = vi
      .spyOn(proto, 'addEventListener')
      // `as never` because addEventListener is overloaded in lib.dom and a
      // spy cannot be given both signatures; this mock covers what the test
      // drives.
      .mockImplementation(function (this: EventTarget, type: string, fn: never, opts: never) {
        if (type === 'click') bound.push([this, fn, opts]);
        return realAdd.call(this, type, fn, opts);
      } as never);
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [['vc-command', action.value, undefined, {}]]),
    );
    addSpy.mockRestore();
    const button = el();
    const ours = bound.find(([target]) => target === button);
    expect(ours).toBeDefined();
    const remove = vi.spyOn(button, 'removeEventListener');

    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    action.value = 'cartRemove';
    await v.nextTick();
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    // Detached, not merely inert: a mounted-flag check in the handler would pass the click below and fail this.
    app.unmount();
    const clicks = remove.mock.calls.filter((c) => c[0] === 'click');
    // `click` removals here: the in-flight capture guard, once per dispatch (two), and the handler once at unmount.
    const guards = clicks.filter((c) => c[1] !== ours![1]);
    expect(guards).toHaveLength(2);
    expect(guards.every((c) => c[2] === true)).toBe(true);
    const removed = clicks.filter((c) => c[1] === ours![1]);
    expect(removed).toHaveLength(1);
    // The one options object recorded at mount comes back at teardown: stricter than the platform, which matches on capture alone. Relax if a copy is needed.
    expect(removed[0][1]).toBe(ours![1]);
    expect(removed[0][2]).toBe(ours![2]);

    // Behavioural check alongside it: re-attached and clicked, nothing fires.
    document.body.appendChild(button);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    remove.mockRestore();
    button.remove();
    host.remove();
  });

  // The delegated refcount. No double-unmount case: Vue runs beforeUnmount once however often app.unmount() is called, so it could not fail.
  // Open: whether KeepAlive or HMR can re-run teardown; if so, a case belongs here.

  /** Mount one delegated v-vc-command button in its own app. */
  function delegated(v: VaporApi) {
    return mountVdom(v, () => withDirs(v, 'button', null, [['vc-command', 'cartAdd', undefined, { delegate: true }]]));
  }

  it('refcount: one element unmounted of two leaves the shared listener in place', async () => {
    const v = await vapor();
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const clicks = (s: typeof add) => s.mock.calls.filter((c) => c[0] === 'click').length;

    const a = delegated(v);
    const b = delegated(v);
    // One listener for both - that is the whole point of delegation.
    expect(clicks(add)).toBe(1);

    a.app.unmount();
    expect(clicks(remove)).toBe(0);
    // B is still live and still reaches the shared listener.
    b.el().click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    b.app.unmount();
    expect(clicks(remove)).toBe(1);

    add.mockRestore();
    remove.mockRestore();
    a.host.remove();
    b.host.remove();
  });

  it('refcount: an unmounted element stops dispatching while the listener is still up for another', async () => {
    const v = await vapor();
    const a = delegated(v);
    const b = delegated(v);
    const aButton = a.el();

    a.app.unmount();
    // The listener is still up for B, so only A's removal from the state map stops this click dispatching.
    document.body.appendChild(aButton);
    aButton.click();
    await settle();
    expect(seen).toEqual([]);

    // ...while B, which is still mounted, still works through that same listener.
    b.el().click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    b.app.unmount();
    aButton.remove();
    a.host.remove();
    b.host.remove();
  });

  it('refcount: teardown decrements the document the element MOUNTED in, not the one it ended up in', async () => {
    const v = await vapor();
    const second = document.implementation.createHTMLDocument('second');
    const addA = vi.spyOn(document, 'addEventListener');
    const removeA = vi.spyOn(document, 'removeEventListener');
    const addB = vi.spyOn(second, 'addEventListener');
    const removeB = vi.spyOn(second, 'removeEventListener');
    const clicksOn = (s: typeof addA) => s.mock.calls.filter((c) => c[0] === 'click').length;

    const { app, host, el } = delegated(v);
    const button = el();
    expect(clicksOn(addA)).toBe(1);
    expect(clicksOn(addB)).toBe(0);

    // Move the element into the other document. happy-dom implements this
    // faithfully: ownerDocument changes and the node leaves the old body.
    second.adoptNode(button);
    second.body.appendChild(button);
    expect(button.ownerDocument).toBe(second);

    // A limit of `.delegate`, noted in src/directives.ts: the listener stays on document A, so a click in B reaches nothing.
    button.click();
    await settle();
    expect(seen).toEqual([]);

    // The point of the test: teardown decrements A, where the listener was
    // counted at mount, and never touches B.
    app.unmount();
    expect(clicksOn(removeA)).toBe(1);
    expect(clicksOn(removeB)).toBe(0);

    addA.mockRestore();
    removeA.mockRestore();
    addB.mockRestore();
    removeB.mockRestore();
    button.remove();
    host.remove();
  });

  it('production: .delegate with .once falls back to a direct listener without the dev warning', async () => {
    const v = await vapor(); // before the reset, so the app keeps this Vue instance
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    try {
      const directives = await import('../src/directives');
      const chamber = await import('../src/chamber');
      const { createCommandBus: freshBus } = await import('../src/command-bus');
      chamber.setCommandBus(freshBus({ onMissing: 'ignore' }));
      const got: string[] = [];
      chamber.getCommandBus().onAfter((cmd) => {
        got.push(cmd.action);
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { app, host, el } = mountVdom(
        v,
        () => withDirs(v, 'button', null, [['vc-command', 'cartAdd', undefined, { delegate: true, once: true }]]),
        directives.createDirectivePlugin(),
      );
      el().click();
      await settle();
      expect(got).toEqual(['cartAdd']);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('.delegate is incompatible'))).toEqual([]);
      app.unmount();
      host.remove();
    } finally {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      vi.resetModules();
    }
  });
});

/** Mount a COMPILED Vapor template with all three directives registered app-wide. */
async function mountVaporAll(v: VaporApi, source: string, ctx: Record<string, unknown>) {
  const { render } = await compileVapor(v, source);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = v.createVaporApp(v.defineVaporComponent({ setup: () => render(ctx) }));
  app.directive('vc-command', vcCommandVapor);
  app.directive('vc-payload', vcPayloadVapor);
  app.directive('vc-optimistic', vcOptimisticVapor);
  app.mount(host);
  return { app, host, button: host.querySelector('button') as HTMLButtonElement };
}

describe('v-vc-payload / v-vc-optimistic on a real Vapor app', () => {
  const payloads: unknown[] = [];

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    payloads.length = 0;
    getCommandBus().onAfter((cmd) => {
      payloads.push(cmd.payload);
    });
  });

  // A compiled template applies directives in source order and mountCommand() clears the element, so this needs the pending slot.
  it('payload written BEFORE the command still reaches the dispatch', async () => {
    const v = await vapor();
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-payload="p" v-vc-command="'cartAdd'">go</button>`,
      { p: { id: 7 } },
    );
    button.click();
    await settle();
    expect(payloads).toEqual([{ id: 7 }]);
    app.unmount();
    host.remove();
  });

  it('payload written AFTER the command reaches the dispatch', async () => {
    const v = await vapor();
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-payload="p">go</button>`,
      { p: { id: 7 } },
    );
    button.click();
    await settle();
    expect(payloads).toEqual([{ id: 7 }]);
    app.unmount();
    host.remove();
  });

  it('the binding is read at DISPATCH time, so a changed payload re-targets the next click', async () => {
    const v = await vapor();
    const state = v.reactive({ p: { id: 1 } });
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-payload="p">go</button>`,
      state,
    );
    button.click();
    await settle();
    state.p = { id: 2 };
    await v.nextTick();
    button.click();
    await settle();
    // Vapor has no `updated` hook, so this is the same rule the ACTION follows.
    expect(payloads).toEqual([{ id: 1 }, { id: 2 }]);
    app.unmount();
    host.remove();
  });

  it('a binding beats data-vc-payload, the same precedence as on vDOM', async () => {
    const v = await vapor();
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-payload="p" data-vc-payload='{"from":"attr"}'>go</button>`,
      { p: { from: 'binding' } },
    );
    button.click();
    await settle();
    expect(payloads).toEqual([{ from: 'binding' }]);
    app.unmount();
    host.remove();
  });

  // Why these two exist beside data-vc-payload: JSON in an attribute loses a Date, Map, class instance or function.
  it('carries what JSON cannot - Date, Map, a class instance, a function', async () => {
    const v = await vapor();
    class Sku {
      constructor(readonly id: string) {}
    }
    const rich = { when: new Date(0), set: new Map([['a', 1]]), sku: new Sku('x'), fn: () => 1 };
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-payload="rich">go</button>`,
      { rich },
    );
    button.click();
    await settle();
    const got = payloads[0] as Record<string, unknown>;
    expect(got.when).toBeInstanceOf(Date);
    expect(got.set).toBeInstanceOf(Map);
    expect(got.sku).toBeInstanceOf(Sku);
    expect(typeof got.fn).toBe('function');
    app.unmount();
    host.remove();
  });

  // Without a Vapor registration this template would produce Vue's "Failed to
  // resolve directive: vc-optimistic" and no optimistic update at all.
  it('optimistic applies immediately and rolls back when the dispatch fails', async () => {
    const v = await vapor();
    getCommandBus().register('cartAdd', () => {
      throw new Error('out of stock');
    });
    const log: string[] = [];
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-command="'cartAdd'" v-vc-optimistic="fn">go</button>`,
      {
        fn: () => {
          log.push('apply');
          return () => log.push('rollback');
        },
      },
    );
    button.click();
    await settle();
    expect(log).toEqual(['apply', 'rollback']);
    expect(button.classList.contains('vc-error')).toBe(true);
    app.unmount();
    host.remove();
  });

  it('optimistic written BEFORE the command works too', async () => {
    const v = await vapor();
    getCommandBus().register('cartAdd', () => {
      throw new Error('nope');
    });
    const log: string[] = [];
    const { app, host, button } = await mountVaporAll(
      v,
      `<button v-vc-optimistic="fn" v-vc-command="'cartAdd'">go</button>`,
      {
        fn: () => {
          log.push('apply');
          return () => log.push('rollback');
        },
      },
    );
    button.click();
    await settle();
    expect(log).toEqual(['apply', 'rollback']);
    app.unmount();
    host.remove();
  });

  it('inert on an element with no v-vc-command, matching the vDOM half', async () => {
    const v = await vapor();
    const { app, host, button } = await mountVaporAll(v, `<button v-vc-payload="p">go</button>`, {
      p: { id: 1 },
    });
    button.click();
    await settle();
    expect(payloads).toEqual([]);
    app.unmount();
    host.remove();
  });

  // Pins upstream, nothing in src can break it: Vue camelCases the whole name, and a wrong alias falls back to a resolve that warns only in development.
  it('an SFC binding must be named vVcPayload - a shorter alias silently stops being used', async () => {
    const { compileScript, parse } = await import('vue/compiler-sfc');
    const sfc = (alias: string) => `<script setup vapor lang="ts">
import { vcPayloadVapor as ${alias} } from 'vapor-chamber/directives';
const p = { id: 1 };
</script>
<template>
  <button v-vc-command="'cartAdd'" v-vc-payload="p">go</button>
</template>
`;
    const emit = (alias: string) =>
      compileScript(parse(sfc(alias), { filename: 'T.vue' }).descriptor, {
        id: 'alias',
        inlineTemplate: true,
      }).content;

    const right = emit('vVcPayload');
    expect(right).toContain('_unref(vVcPayload)');
    expect(right).not.toContain('resolveDirective("vc-payload")');

    const wrong = emit('vVcPay');
    expect(wrong).toContain('resolveDirective("vc-payload")');
    expect(wrong).not.toContain('_unref(vVcPay)');
  });

  // Fails at tsc, not at runtime.
  it('both new exports are assignable to Vue VaporDirective', () => {
    const asPayload: VaporDirective = vcPayloadVapor;
    const asOptimistic: VaporDirective = vcOptimisticVapor;
    expect(typeof asPayload).toBe('function');
    expect(typeof asOptimistic).toBe('function');
  });
});
