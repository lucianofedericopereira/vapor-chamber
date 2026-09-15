// @vitest-environment happy-dom
/**
 * FIXTURE - `v-vc:command` on a REAL Vapor app, through `vcCommandVapor`.
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
 * The directive tuples are the shapes compiler-vapor 3.6.0-rc.8 emits for
 * `<button v-vc:command.stop="action">`: with `vVc` in scope,
 *   withVaporDirectives(n0, [[_ctx.vVc, () => (_ctx.action), "command", { stop: true }]])
 * and registered app-wide,
 *   const _directive_vc = _resolveDirective("vc") ... [[_directive_vc, ...]]
 *
 * THE vDOM REGISTRATION, TOO. tests/directives.test.ts drives the plugin's
 * hooks by hand on mock elements. The second block below mounts a real vDOM
 * app from the same with-vapor build (`createApp` is in it) with
 * `createDirectivePlugin()` installed, so Vue calls mounted / updated /
 * beforeUnmount on real elements: `v-vc:payload` and `v-vc:optimistic` through
 * an update, rollback, modifiers, `data-vc-*`, an async bus in flight and
 * timing out, a bus that throws or rejects, and delegation against a real
 * document. Written for batch 3 item 4, to take src/directives.ts off the
 * coverage exclusion list - see vitest.config.ts for why it stays on it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

/** Raw runtime-vapor surface - deliberately untyped; this file builds a component tree by hand. */
type VaporApi = any;

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

type Tuple = [typeof vcCommandVapor, () => unknown, string?, Record<string, boolean>?];

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

describe('v-vc:command on a real Vapor app (vcCommandVapor)', () => {
  const seen: string[] = [];

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd) => {
      seen.push(cmd.action);
    });
  });

  it('dispatches the bound action on click', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd', 'command']);
    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
    host.remove();
  });

  it('re-targets when the binding changes - no updated hook, no freeze', async () => {
    const v = await vapor();
    const action = v.shallowRef('cartAdd');
    const { app, host, button, invocations } = await mount((vVc) => [vVc, () => action.value, 'command']);

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

  it('honours .stop the way the vDOM directive does', async () => {
    const { app, host, button, div } = await mount((vVc) => [vVc, () => 'cartAdd', 'command', { stop: true }]);
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

  it('ignores other arguments, like the vDOM directive', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd', 'payload']);
    button.click();
    await settle();
    expect(seen).toEqual([]);
    app.unmount();
    host.remove();
  });

  it('removes its listener on unmount', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd', 'command']);
    app.unmount();
    // The element is detached, but a reference to it can still be clicked;
    // with the listener gone, nothing dispatches.
    button.click();
    await settle();
    expect(seen).toEqual([]);
    host.remove();
  });

  it('.delegate shares the document listener and drops it on unmount', async () => {
    const { app, host, button } = await mount((vVc) => [vVc, () => 'cartAdd', 'command', { delegate: true }]);
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

  it('registers app-wide: app.directive("vc", vcCommandVapor), resolved as a compiled template does', async () => {
    const v = await vapor();
    const Comp = v.defineVaporComponent({
      setup() {
        const vc = v.resolveDirective('vc');
        const root = v.template('<div><button>go</button></div>', true)();
        v.withVaporDirectives(root.firstChild, [[vc, () => 'cartAdd', 'command']]);
        return root;
      },
    });
    const host = document.createElement('div');
    const app = v.createVaporApp(Comp);
    app.directive('vc', vcCommandVapor);
    app.mount(host);
    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(seen).toEqual(['cartAdd']);
    app.unmount();
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

describe('v-vc:command on a real vDOM app (createDirectivePlugin)', () => {
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
        ['vc', action.value, 'command'],
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
    const optimistic = v.shallowRef<(cmd: { action: string }) => (() => void) | null>((cmd) => {
      log.push(`apply ${cmd.action}`);
      return () => log.push('rollback');
    });
    const { app, host, el } = mountVdom(v, () =>
      withDirs(v, 'button', null, [
        ['vc', 'cartAdd', 'command'],
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

  it('v-vc-payload and v-vc-optimistic without v-vc:command are inert', async () => {
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

  it('other arguments are ignored through mount, update and unmount', async () => {
    const v = await vapor();
    const value = v.shallowRef('cartAdd');
    const { app, host, el } = mountVdom(v, () => withDirs(v, 'button', null, [['vc', value.value, 'other']]));
    value.value = 'cartRemove';
    await v.nextTick();
    el().click();
    await settle();
    app.unmount();
    host.remove();
    expect(seen).toEqual([]);
  });

  it('mouse-button modifiers pick the button, and a .capture listener comes off on unmount', async () => {
    const v = await vapor();
    const { app, host, el } = mountVdom(v, () =>
      v.h('div', null, [
        withDirs(v, 'button', { id: 'mid' }, [['vc', 'middleAct', 'command', { middle: true }]]),
        withDirs(v, 'button', { id: 'right' }, [['vc', 'rightAct', 'command', { right: true }]]),
        withDirs(v, 'button', { id: 'cap' }, [['vc', 'capAct', 'command', { capture: true }]]),
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
          ['vc', 'cartAdd', 'command'],
        ]),
        withDirs(v, 'button', { id: 'bad', 'data-vc-payload': '{not json' }, [['vc', 'cartAdd', 'command']]),
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
    const { app, host, el } = mountVdom(v, () => withDirs(v, 'span', null, [['vc', 'slow', 'command', { '20': true }]]));

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
    const sync = mountVdom(v, () => withDirs(v, 'button', null, [['vc', 'nobodyHome', 'command']]));
    sync.el().click();
    await settle();
    expect(sync.el().classList.contains('vc-error')).toBe(true);
    sync.app.unmount();
    sync.host.remove();

    // A naming violation throws inside the async dispatch, so the PROMISE the
    // directive races against its timeout rejects.
    setCommandBus(createAsyncCommandBus({ naming: { pattern: /^[a-z]+[A-Z]/, onViolation: 'throw' } }));
    const async = mountVdom(v, () => withDirs(v, 'button', null, [['vc', 'BADNAME', 'command']]));
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
        withDirs(v, 'button', { id: 'del' }, [['vc', 'cartAdd', 'command', { delegate: true }]]),
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

  it('two v-vc:command bindings on one element: the second replaces the first, nothing is stranded', async () => {
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
        ['vc', first.value, 'command'],
        ['vc', 'cartRemove', 'command'],
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
        () => withDirs(v, 'button', null, [['vc', 'cartAdd', 'command', { delegate: true, once: true }]]),
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
