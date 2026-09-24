// @vitest-environment happy-dom
/**
 * FIXTURE - `v-vc-command` on a REAL Vapor app, through `vcCommandVapor`.
 *
 * WHY THIS FILE EXISTS. `tests/vapor-directives-fixture.test.ts` proved that
 * Vapor has custom directives (`withVaporDirectives`) and pinned what a port
 * has to respect: the directive is a plain function run ONCE per element, its
 * value arrives as a GETTER, there is no `updated` hook, and a returned
 * function is its cleanup. This file mounts the port itself - the same
 * `buildHandler` the vDOM directive uses - and checks what makes it the same
 * directive rather than a lookalike: a click dispatches, a modifier means what
 * it means in vDOM, a changed binding re-targets the next click, and unmount
 * takes the listener with it.
 *
 * The directive tuples are the shapes compiler-vapor emits for
 * `<button v-vc-command.stop="action">`: with `vVc` in scope,
 *   withVaporDirectives(n0, [[_ctx.vVc, () => (_ctx.action), () => ("command"), { stop: true }]])
 * and registered app-wide,
 *   const _directive_vc = _resolveDirective("vc-command") ... [[_directive_vc, ...]]
 * They were written against rc.8, which emitted the ARGUMENT as the bare string
 * `"command"`, and they kept passing after #15490 made it a getter in rc.9 -
 * while the directive itself was dead in every compiled template. They have
 * been corrected, but correcting them is not the fix: a literal records a
 * compiler release and ages into a mock. The fix is the ONE test here that
 * compiles the template on the INSTALLED Vue and never writes a tuple at all.
 * See the note at the end of this file.
 *
 * THE vDOM REGISTRATION, TOO. tests/directives.test.ts drives the plugin's
 * hooks by hand on mock elements. The second block below mounts a real vDOM
 * app from the same with-vapor build (`createApp` is in it) with
 * `createDirectivePlugin()` installed, so Vue calls mounted / updated /
 * beforeUnmount on real elements: `v-vc-payload` and `v-vc-optimistic` through
 * an update, rollback, modifiers, `data-vc-*`, an async bus in flight and
 * timing out, a bus that throws or rejects, and delegation against a real
 * document. Written for batch 3 item 4, to take src/directives.ts off the
 * coverage exclusion list - see vitest.config.ts for why it stays on it.
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

/**
 * Derived from Vue's own `VaporDirective`, not restated from it. A hand-written
 * copy of a framework contract is the same frozen-literal problem as a
 * hand-written tuple: it agrees with whatever release it was typed against.
 * Taking the tail of `Parameters<VaporDirective>` means the next change to the
 * call shape is a typecheck failure here. This is what the `@vue/runtime-vapor`
 * devDep buys - see the assignability assertion below.
 */
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

  // Pays for the with-vapor Vue build ONCE, in a hook, before any test is
  // timed. It used to be paid inside whichever test ran first, against the 5 s
  // default: on a slow machine that test timed out, and because a timeout does
  // not cancel the async body, its `button.click()` ran later and pushed a
  // stray action into the NEXT test's `seen` - failing a second test that was
  // never broken. Warming here removes the timeout, and with it the leak.
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
    // The single-ref test above proves the value is not frozen at mount. This
    // is the other way that property is reached, and the one a consumer hits:
    // an unkeyed list, where Vapor REUSES the element and moves the item under
    // it. Element 0 belonged to "a" and belongs to "b" afterwards, with no
    // re-run of the directive - so a port that stored `value()` at mount would
    // dispatch the wrong item's command, silently, for the rest of the page.
    //
    // A keyed REORDER cannot show this: it moves the node, so the binding
    // travels with its own element and a latched value looks identical. That
    // is why this case is unkeyed.
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

  // INVERTED at v1.22.0, and the inversion is the whole reshape in one case.
  // This used to pass `() => 'payload'` and assert `seen` stayed EMPTY: the
  // argument was the selector, and a non-`command` argument declined to mount.
  // The selector is the NAME now, so the argument is inert - whatever lands in
  // that slot, the directive mounts and dispatches. Asserting that is what
  // stops someone reintroducing a read of it.
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

    // Two delegated buttons, one of them behind v-if. Compiled, because a
    // hand-written tuple is what let #15490 through - and because the v-if
    // codegen is the part under test here.
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
    // One listener for both - `vcCommandVapor` returns `() => unmountCommand(el)`
    // and Vue registers it with onScopeDispose, so this is the same accounting
    // the vDOM hooks use.
    expect(clicks(add)).toBe(1);
    a.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    // THE ROUTE A LONG-LIVED APP ACTUALLY TAKES: v-if removes the element while
    // the app keeps running. The directive's scope is detached, so something in
    // the Vapor runtime has to stop it; if nothing did, a delegated count would
    // climb forever in an app that never unmounts.
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

  // The tuple comes from the COMPILER, not from a literal in this file - see the note at the end.
  it('runs the code the installed compiler emits for <button v-vc-command.stop="action">', async () => {
    const v = await vapor();
    const { render, code } = await compileVapor(v, '<button v-vc-command.stop="action">go</button>');
    // The argument shape this run is actually being held to, recorded in the
    // failure message so a future change reads as a diff and not as a puzzle.
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

  // REPLACED at v1.22.0. This case used to assert the DEV guard that rejected a
  // STRING argument and named the required Vue. That guard existed only to
  // defend the selector-in-the-argument read, and it went with it - so there is
  // nothing left to reject. What is worth pinning instead is the stronger
  // property the deletion bought: a string in that slot, the pre-#15490 shape
  // that made this directive a dead control, is now simply DATA THE DIRECTIVE
  // NEVER TOUCHES. It cannot throw, it cannot decline to mount, and it cannot
  // be the reason a control is silent, because nothing reads it.
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
    // It dispatches. On rc.9 with the old shape this was `[]` and silent.
    expect(seen).toEqual(['cartAdd']);
    // ...and says nothing, because there is no version guard left to fire.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.startsWith('[vapor-chamber]'))).toEqual([]);

    warn.mockRestore();
    app.unmount();
    host.remove();
  });

  // COVERAGE, not a fails-before (see the note at the end): on rc.9 a template
  // @click registers first, and its veto stands.
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

  // COVERAGE: the plugin on a Vapor app names the FIX, and is silent in production.
  it('createDirectivePlugin() on a Vapor app warns with our text, not just any text', async () => {
    const v = await vapor();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A COMPILED template carrying v-vc-command, so Vue's own #15489 warning
    // fires in the same run. That is the point: a test that only asserted "a
    // warning fired" would pass on Vue's, which says nothing about the fix.
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

// ---------------------------------------------------------------------------
// The vDOM registration, on a REAL vDOM app
// ---------------------------------------------------------------------------

/** `[directive name, value, argument, modifiers]` - what a template compiles to. */
type Dir = [name: string, value: unknown, arg?: string, modifiers?: Record<string, boolean>];

/**
 * `<tag v-name:arg.mods="value">go</tag>` as a render function writes it. The
 * directive is RESOLVED from the app, so it is whatever createDirectivePlugin()
 * installed - the test never calls a hook itself.
 */
function withDirs(v: VaporApi, tag: string, props: Record<string, unknown> | null, dirs: Dir[]): unknown {
  return v.withDirectives(
    v.h(tag, props, 'go'),
    dirs.map(([name, value, arg, modifiers]) => [v.resolveDirective(name), value, arg, modifiers]),
  );
}

/**
 * A vDOM app from the SAME with-vapor build (createApp is in it), with the
 * plugin installed. `render` re-runs on every reactive change it reads, so
 * Vue drives mounted / updated / beforeUnmount.
 */
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

  // ---------------------------------------------------------------------------
  // THE CASE THAT WOULD HAVE CAUGHT THE DRIFT (plan section 4b).
  //
  // Every other vDOM case in this file builds its bindings with `withDirs`,
  // which calls `resolveDirective(name)`. That takes the NAME as given, so it
  // can only ever confirm that a name we already chose is wired to the hooks we
  // already wrote. It cannot see the notation, and the notation is where the
  // defect was: `v-vc:payload` resolved to `vc` with the argument `payload`,
  // whose `mounted` returned early, so it did nothing at all - while being
  // documented in the README, the whitepaper, an example header and the
  // generated docs/api/directives.md.
  //
  // So this case types what a consumer types, hands it to the installed
  // compiler, and asserts the payload reaches the dispatch. It is the vDOM
  // counterpart of the one compiled Vapor case, and it exists for the same
  // reason: a test that cannot be fooled by its own copy of what we intended.
  // ---------------------------------------------------------------------------
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
    // The two names resolve SEPARATELY. This is the assertion that fails if the
    // colon form ever comes back: `v-vc:payload` compiles to one
    // `resolveDirective("vc")` shared by both bindings, with the selector in
    // the argument, and the payload binding is then inert.
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

    // The other half of the same gap. `v-vc:optimistic` was inert for exactly
    // the same reason `v-vc:payload` was - the colon form resolved to `vc`
    // with an argument its `mounted` rejected. Both spellings now work on both
    // renderers; the Vapor half is the block further down.
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

  // INVERTED at v1.22.0, the vDOM twin of the Vapor case above. It asserted
  // that `arg: 'other'` was ignored through mount, update AND unmount - three
  // `binding.arg` guards, one per hook, except that `beforeUnmount` never had
  // one and must never get one. Two of those guards are gone; the third never
  // existed. So the argument reaches no hook, and the directive behaves the
  // same with a stray one as without.
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

    // ...and beforeUnmount detached it, which is the half that was ALREADY
    // correct and is the one that must stay correct - teardown answers to the
    // mount, never to the binding. rc9/4 is the defect that established it.
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
    // A <span>, not a <button>: a button is disabled while in flight, and the
    // platform would swallow the second click before the directive saw it.
    const { app, host, el } = mountVdom(v, () => withDirs(v, 'span', null, [['vc-command', 'slow', undefined, { '20': true }]]));

    el('span').click();
    el('span').click();
    await settle();
    expect(calls).toBe(1);
    expect(el('span').classList.contains('vc-loading')).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
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
    // A template cannot write this - one attribute per name - but a render
    // function can list the directive twice, and each binding's mounted hook
    // runs against the same element. Before the fix the second overwrote the
    // first's state while both listeners stayed attached: a click dispatched
    // both, an update never reached the first (frozen at its mount value), and
    // unmount removed only the second, leaving the first on the element.
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

  // THE ARG FLIP IS GONE FROM THIS CASE, and the case is not. It used to drive
  // teardown through a dynamic argument moving off `command` - the only route
  // that reached rc9/4's defect, where `beforeUnmount` guarded on the CURRENT
  // binding and never detached. There is no argument to flip now, so the route
  // is unreachable and staging it would mean feeding Vue an input it cannot
  // produce. What the case was actually FOR survives untouched: that the shared
  // document listener comes off by IDENTITY, not merely goes quiet. A binding
  // update still drives `updated`, so the element is still exercised through a
  // re-render before unmount - it is the action that changes now, not the arg.
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

    // Through `updated`, which is the hook that lost its guard: the action
    // follows the binding and the same shared listener keeps serving it.
    action.value = 'cartRemove';
    await v.nextTick();
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);

    // THE ASSERTION THAT MATTERS: the shared listener actually comes off the
    // document. This is element-independent - it outlives the button either
    // way - and it is what the old `arg !== 'command'` guard skipped.
    app.unmount();
    const added = add.mock.calls.filter((c) => c[0] === 'click');
    const removed = remove.mock.calls.filter((c) => c[0] === 'click');
    expect(removed).toHaveLength(1);
    // `removeEventListener` is a silent no-op when the handler reference or the
    // options differ from the `addEventListener` call, so "called once" does
    // not mean "removed". The arguments are compared by identity, not counted.
    expect(removed[0][1]).toBe(added[0][1]);
    expect(removed[0][2]).toBe(added[0][2]);

    // Behavioural check from a legitimately ATTACHED node - not a re-attached
    // corpse, which would also pass if someone made the handler inert instead
    // of detaching it. A fresh button in the document that is not ours.
    const stray = document.createElement('button');
    document.body.appendChild(stray);
    stray.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartRemove']);
    stray.remove();

    // And the per-document count went back to zero, so the NEXT delegated
    // element re-attaches rather than riding a listener that was never removed.
    const second = mountVdom(v, () => withDirs(v, 'button', null, [['vc-command', 'cartAdd', undefined, { delegate: true }]]));
    expect(clicksOn(add)).toBe(2);
    second.app.unmount();

    add.mockRestore();
    remove.mockRestore();
    button.remove();
    host.remove();
    second.host.remove();
  });

  // The arg flip is gone here for the same reason as in the delegated twin
  // above, and the identity assertions it existed for are untouched. A binding
  // UPDATE still drives `updated`, so the element is still re-rendered between
  // mount and unmount; only the thing that changes is the action rather than
  // the argument.
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

    // THE ASSERTION THAT MATTERS: the handler is detached from the element,
    // not merely made inert. A mounted-flag or isConnected check in the handler
    // would satisfy the click assertion below and fail this one.
    app.unmount();
    const removed = remove.mock.calls.filter((c) => c[0] === 'click');
    expect(removed).toHaveLength(1);
    // Same reasoning as the delegated case: a mismatched handler or options
    // object makes removeEventListener a silent no-op, so the call is compared
    // against the add that actually bound this element.
    //
    // THE OPTIONS ASSERTION IS A STRUCTURAL PIN, stricter than the platform.
    // The platform matches on `capture` alone, so an equal-but-copied options
    // object removes the listener perfectly well and nothing observable
    // breaks. What this line pins is the CONSTRUCTION that makes the pair
    // impossible to get wrong: one object, recorded at mount, handed back at
    // teardown. That is what closes the trap - a rebuilt object is equal today
    // and silently unequal the moment someone adds `{ once: true }` to one
    // side. Unlike the handler assertion above, a failure here is not
    // evidence of a defect. If a refactor copies the options for a reason,
    // this assertion is the one to relax; check first that both calls still
    // agree on capture.
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

  // ---------------------------------------------------------------------------
  // The delegated refcount. Nothing here is a regression guard - every case
  // below already passed before rc9/4 - so each one is armed by a seeded
  // mutation, recorded at the end of this file.
  //
  // There is no double-unmount case, and that is a finding rather than an
  // omission. A test was written for it and PASSED against a source mutated to
  // remove the protection it claimed to test - decoration. The reason,
  // measured with a probe that counts hook invocations: Vue invokes a
  // directive's `beforeUnmount` exactly ONCE however many times
  // `app.unmount()` is called.
  //
  // That is the narrow claim, and it is the only one measured. Repeated
  // `app.unmount()` cannot produce a second decrement. Whether some OTHER
  // route can - KeepAlive deactivation, HMR, a parent re-render - is open, and
  // KeepAlive in particular is one of the rc.9 clusters not yet read. If one of
  // those does re-run teardown, the early return in `unmountCommand` is what
  // stands between it and a wrong count, and a case belongs here.
  //
  // What the early return demonstrably does today is the MOUNT path, where
  // `mountCommand` calls `unmountCommand` on an element that has no state yet.
  // Every mounting test in this file arms that already: removing the early
  // return crashes all of them.
  //
  // What the double-unmount case was reaching for - that teardown really does
  // forget the element - IS reachable, just not that way. It is the second
  // test below: while the shared listener is still up for another element, the
  // state map is the only thing keeping an unmounted element from dispatching.
  // ---------------------------------------------------------------------------

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
    // The shared listener is STILL installed, because B needs it. So the only
    // thing standing between a click on A's old element and a dispatch is that
    // `unmountCommand` deleted A's entry from the state map - the delegated
    // handler looks every element on the composed path up in that map. Put the
    // element back in the document, where its click really does reach the
    // document listener, and check that the lookup misses.
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

    // WHAT THE CONTROL DOES AFTER THE MOVE, recorded rather than assumed: the
    // listener is on document A and the element now lives in document B, so a
    // click in B reaches nothing. The control is dead. This is a limit of
    // `.delegate`, not of the directive - a direct listener travels with the
    // element - and it is written up in the delegation note in src/directives.ts.
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

// ---------------------------------------------------------------------------
// v-vc-payload and v-vc-optimistic on a real VAPOR app (v1.22.0, plan 4a)
// ---------------------------------------------------------------------------

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

  // THE ORDER THAT THE NAIVE PORT LOSES, first because a regression should read
  // as this case. A compiled template applies directives in SOURCE order and
  // mountCommand() clears the element first, so a payload written before the
  // command lands in state the command then throws away - a button that
  // dispatches with no payload, silently. Armed by reducing `vaporSlot` to the
  // ordered shape, which fails exactly here; see the note at the end.
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

  // THE CASE THAT DECIDED 4a AGAINST DROPPING THESE TWO. `data-vc-payload` is
  // JSON in an attribute, and JSON is lossy: measured through the attribute the
  // same payload arrives with its Date as a string, its Map as `{}`, its class
  // instance as a plain object and its function gone. The binding hands the
  // handler the real values, which is a capability the attribute cannot have.
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

  // The capability gap s34.23 recorded, closed. Before v1.22.0 this template
  // produced Vue's "Failed to resolve directive: vc-optimistic" and no
  // optimistic update at all.
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

  // THE BINDING NAME, pinned at the compiler rather than described in prose.
  // Vue camelCases the WHOLE directive name, so `v-vc-payload` looks for
  // `vVcPayload`. An import aliased to anything else compiles and type-checks
  // and falls back to `resolveDirective("vc-payload")`, which finds nothing
  // unless the consumer also registered it app-wide - and Vue's "failed to
  // resolve" warning is stripped from a production build, which is exactly how
  // the same mistake reached a built example in rc9/57 unnoticed.
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

  it('both new exports are assignable to Vue VaporDirective', () => {
    const asPayload: VaporDirective = vcPayloadVapor;
    const asOptimistic: VaporDirective = vcOptimisticVapor;
    expect(typeof asPayload).toBe('function');
    expect(typeof asOptimistic).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// HOW THE VAPOR PAYLOAD / OPTIMISTIC BLOCK WAS ARMED, AND THE TWO CASES THAT
// ARE PINS RATHER THAN GUARDS
// ---------------------------------------------------------------------------
//
// Five injections into src/directives.ts, each restored by in-memory file copy
// in a finally (never `git checkout` - the implementation was uncommitted).
// Every one went red and named its case:
//
//   reduce vaporSlot to the ordered shape    -> "payload written BEFORE the
//     (no pending slot at all)                  command still reaches the
//                                               dispatch"
//   drop the pending PICKUP in mountCommand  -> the same case, from the other
//                                               end
//   drop the dispatch-time payload read      -> "payload written AFTER the
//                                               command reaches the dispatch"
//   drop the dispatch-time optimistic read   -> "optimistic applies immediately
//                                               and rolls back"
//   read the payload at MOUNT, not dispatch  -> "the binding is read at
//                                               DISPATCH time"
//
// THE FIRST TWO ARE THE 4a DECISION, staged rather than argued. The naive port
// (set the getter if the element already has command state, warn otherwise)
// loses a payload written before the command, because a compiled template
// applies directives in SOURCE order and `mountCommand()` opens by deleting the
// element's state. A warning is not enough for that: attribute order is not
// something a consumer has any reason to think matters, and the failure is a
// button that dispatches with no payload. The pending slot makes it impossible
// instead of merely noisy, for four brotli bytes.
//
// TWO CASES IN THIS BLOCK ARE NOT FAILS-BEFORE, and are labelled here rather
// than left to look like guards:
//
//   "an SFC binding must be named vVcPayload" PINS UPSTREAM BEHAVIOUR. Nothing
//     in src can break it - it asserts what Vue's own SFC compiler emits for a
//     right and a wrong local alias. It earns its place because the wrong alias
//     is silent in the only place it matters: the fallback to
//     `resolveDirective("vc-payload")` makes Vue warn, and that warning is
//     stripped from a production build. That is exactly how the same mistake
//     reached a built example unnoticed in rc9/57, on the command directive,
//     with vue-tsc and vite build both green.
//
//   "both new exports are assignable to Vue VaporDirective" is a TYPE
//     assertion. It fails at `tsc`, not at runtime, which is the point: the
//     same assertion for `vcCommandVapor` sat in this file unchecked until
//     tests/ was typechecked in rc9/55, and it was false at the time.
//
// ---------------------------------------------------------------------------
// WHY ONE TEST COMPILES THE TEMPLATE INSTEAD OF WRITING THE TUPLE OUT
// ---------------------------------------------------------------------------
//
// Every other tuple in this file is a literal, copied from what compiler-vapor
// emitted at the time it was written. That is fast to read and it is how the
// directive contract was pinned - but a literal records a COMPILER RELEASE, and
// the suite then keeps agreeing with that release forever.
//
// Vue 3.6.0-rc.9 is the proof. #15490 made the directive argument a getter, so
// the compiler went from
//   [_directive_vc, () => (_ctx.action), "command", { stop: true }]
// to
//   [_directive_vc, () => (_ctx.action), () => ("command"), { stop: true }]
// and `vcCommandVapor`, which compared `argument !== 'command'`, stopped
// mounting. v-vc-command was a dead control in every compiled Vapor template on
// rc.9: the button renders, the click does nothing, nothing is logged. The full
// suite - 2,431 tests, both Vapor fixtures included - stayed green through all
// of it, because no test asked the compiler what it emits.
//
// So one test does. It takes the template a consumer writes, runs it through
// `vue/compiler-sfc` (a `vue` export - no extra dependency, and the same path an
// SFC takes), evaluates the generated render function against the real runtime,
// and clicks the real button. The tuple it feeds the directive is whatever the
// INSTALLED Vue produces, so the next shape change fails here on the RC bump
// rather than in a consumer app after release.
//
// The literals stay. They are precise about the individual rules - a modifier,
// a re-target, a cleanup - and they run without a compiler. This test is the
// one that cannot be fooled by its own copy of the past.

// ---------------------------------------------------------------------------
// WHY THE @CLICK ORDER CASE IS COVERAGE AND NOT A FAILS-BEFORE
// ---------------------------------------------------------------------------
//
// Vue 3.6.0-rc.9 `80b3a046` moved compiled custom directives to the end of a
// block, after the element's props, children and v-model. On rc.8 the compiler
// emitted `_withVaporDirectives` and then `_on`; on rc.9 it emits `_on` and then
// `_withVaporDirectives`. So this directive's click listener ran FIRST on rc.8
// and runs SECOND on rc.9, and a template `@click` on the same element can now
// veto the dispatch through `buildHandler`'s disabled / aria-disabled /
// in-flight guard.
//
// The guard is not incidental: it has been deliberate since v1.6.0, mirroring
// Vue's #14948 for the DIRECT listener this directive attaches, and the owner
// ruled it stays. What changed is who runs first, not what the guard does, so
// this case pins the rc.9 behaviour rather than repairing anything.
//
// It cannot be a fails-before. rc.8 is not installed, and rc.8's compiler emits
// the ARGUMENT as a bare string, which `vcCommandVapor` rejects by design since
// #15490 - so compiling the same template with it would fail for the other
// reason and prove nothing about order. The order was isolated separately, on
// one runtime with only the registration order swapped: directive-first
// dispatches, template-first does not. That measurement is in the cycle record
// (docs/rc-alignment-log.md s34.19), not here, because it needs two compilers.
//
// Not pinned here, measured and written up in the same place: the vDOM
// registration already behaved this way (Vue patches props before `mounted`),
// and `.delegate` is unaffected because its listener is on the document - which
// is also why plain `stopPropagation()` vetoes `.delegate` alone.
