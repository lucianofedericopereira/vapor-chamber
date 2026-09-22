// @vitest-environment happy-dom
/**
 * FIXTURE - what KeepAlive does to a custom directive's scope, on both renderers.
 *
 * MOSTLY UPSTREAM CONTRACT, and the file is precise about which parts. The
 * property being asserted is Vue's, not this library's: that deactivating a
 * kept-alive component does NOT dispose a custom directive's scope, and that
 * reactivating it reuses the same element with the same directive state. What
 * it guards is an ASSUMPTION this library rests on, which can change under us
 * without anyone changing a line here.
 *
 * MEASURED against the mutation matrix in .probes/mutate.sh, which is the only
 * way to know rather than assert:
 *
 *   - the vDOM test is a PURE upstream contract: no mutation of
 *     src/directives.ts makes it fail.
 *   - every other test here DOES exercise our cleanup, so M5 (the directive
 *     returns no cleanup function at all) turns them red. The Vapor
 *     round-trip test is in that group, through its balanced-at-unmount
 *     assertion - which an earlier version of this header denied, on the
 *     strength of having run only M1-M4. That was a claim about a mutation
 *     set stated as a claim about the test.
 *
 * So M1-M4 leaving the file green means those mutations do not change WHETHER
 * cleanup is invoked, only what it does - not that the file is untouchable.
 *
 * WHY IT IS WORTH A TEST. `vcCommandVapor` returns `() => unmountCommand(el)`
 * and Vue registers it with `onScopeDispose`. On the scope this file exercises:
 * the target here is a compiled `<button v-vc-command.delegate>`, an ELEMENT,
 * so `withVaporDirectives` takes its `node instanceof Element` path and applies
 * synchronously in the CURRENT scope - the component's setup scope. (A
 * non-element target - a component root or fragment - gets the detached
 * `EffectScope` instead; this header said "a detached scope" flatly until
 * v1.22.0, which was the other path's answer.) If a future RC started
 * disposing that scope on deactivation, one of two things would follow, and
 * both are silent:
 *
 *   - disposed and NOT re-run on reactivation -> the control comes back dead,
 *   - re-run with no disposal in between      -> the delegated refcount drifts
 *     upward, held honest only by `mountCommand` calling `unmountCommand`
 *     first.
 *
 * Neither prints anything. rc.9 reworked KeepAlive substantially (#15525,
 * #15526, #15560), which is precisely why the assumption is pinned now rather
 * than assumed again next cycle.
 *
 * MEASURED on 3.6.0-rc.9: Vapor matches vDOM exactly - scope kept, element
 * reused, directive run once, counts balanced at unmount.
 *
 * THESE ASSERTIONS CAN FAIL, which is the answer to the obvious charge against
 * a test that no mutation of our source can break. They have already been seen
 * red: the first draft of this measurement put a `v-if` INSIDE the KeepAlive
 * instead of swapping a cached component, and a v-if disposes its branch
 * outright - one remove, the directive re-run, a new element. That result
 * fails all three assertions here. So they do tell scope RETENTION apart from
 * scope DISPOSAL, and if a future RC made deactivation behave like removal,
 * this file goes red rather than quiet.
 *
 * `.delegate` is used because it makes the accounting observable: the shared
 * document listener is added once and removed once, so a spy on
 * add/removeEventListener reports what deactivation did.
 *
 * Deactivation here is a CACHED COMPONENT swapped out of the KeepAlive slot,
 * not a `v-if` inside it. Those are different mechanisms and only the first is
 * deactivation - a v-if inside a KeepAlive disposes the branch outright, which
 * tests/directives-vapor-fixture.test.ts already covers. Measuring one against
 * the other produces a comparison that looks meaningful and is not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

async function vapor(): Promise<VaporApi> {
  return (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('KeepAlive keeps a custom directive scope (upstream contract)', () => {
  const seen: string[] = [];

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd) => {
      seen.push(cmd.action);
    });
  });

  /** Count click add/remove on the document, which is where `.delegate` registers. */
  function listenerSpies() {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const clicks = (s: typeof add) => s.mock.calls.filter((c) => c[0] === 'click').length;
    return { add, remove, adds: () => clicks(add), removes: () => clicks(remove) };
  }

  it('vDOM: deactivate and reactivate keep the element, the state and the count', async () => {
    const v = await vapor();
    const { add, remove, adds, removes } = listenerSpies();

    const show = v.ref(true);
    const Inner = {
      render: () =>
        v.withDirectives(v.h('button', null, 'go'), [
          [v.resolveDirective('vc-command'), 'cartAdd', undefined, { delegate: true }],
        ]),
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v
      .createApp({ render: () => v.h(v.KeepAlive, null, { default: () => (show.value ? v.h(Inner) : null) }) })
      .use(createDirectivePlugin());
    app.mount(host);

    const first = host.querySelector('button') as HTMLButtonElement;
    expect(adds()).toBe(1);

    show.value = false;
    await v.nextTick();
    // Deactivated: out of the DOM, but beforeUnmount did NOT run, so the
    // delegated count is untouched and the listener stays.
    expect(host.querySelector('button')).toBeNull();
    expect(removes()).toBe(0);

    show.value = true;
    await v.nextTick();
    const second = host.querySelector('button') as HTMLButtonElement;
    expect(second).toBe(first);
    expect(adds()).toBe(1);

    second.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    // Balanced at teardown, which is the only place the count should move.
    app.unmount();
    expect(removes()).toBe(1);

    add.mockRestore();
    remove.mockRestore();
    host.remove();
  });

  it('Vapor: the same, from a compiled template - scope kept, directive run once', async () => {
    const v = await vapor();
    const { add, remove, adds, removes } = listenerSpies();

    let runs = 0;
    const counting: typeof vcCommandVapor = (...args) => {
      runs++;
      return vcCommandVapor(...args);
    };

    const inner = await compileVapor(v, '<button v-vc-command.delegate="a">A</button>');
    const other = await compileVapor(v, '<span>other</span>');
    const shell = await compileVapor(v, '<KeepAlive><component :is="cur" /></KeepAlive>');
    const state = v.reactive({ a: 'cartAdd' });
    const Inner = v.defineVaporComponent({ setup: () => inner.render(state) });
    const Other = v.defineVaporComponent({ setup: () => other.render(state) });
    const outer = v.reactive({ cur: Inner });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => shell.render(outer) }));
    app.directive('vc-command', counting);
    app.mount(host);

    const first = host.querySelector('button') as HTMLButtonElement;
    expect(runs).toBe(1);
    expect(adds()).toBe(1);
    first.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    outer.cur = Other;
    await v.nextTick();
    expect(host.querySelector('button')).toBeNull();
    // THE ASSERTION THIS FILE EXISTS FOR: the owning scope (the component's
    // setup scope - see the header) is PAUSED and not stopped on deactivation,
    // so the cleanup did not run and the count did not move.
    expect(removes()).toBe(0);

    outer.cur = Inner;
    await v.nextTick();
    const second = host.querySelector('button') as HTMLButtonElement;
    expect(second).toBe(first);
    // Not re-run: the directive function ran once, for one mount.
    expect(runs).toBe(1);
    expect(adds()).toBe(1);

    second.click();
    await settle();
    expect(seen).toEqual(['cartAdd', 'cartAdd']);

    app.unmount();
    expect(adds()).toBe(1);
    expect(removes()).toBe(1);

    add.mockRestore();
    remove.mockRestore();
    host.remove();
  });

  // ---------------------------------------------------------------------------
  // TEARDOWN ROUTES. The two tests above cover ONE route - a cached component
  // swapped out of the slot and back. KeepAlive has others, and unlike
  // deactivation they are real unmounts where our cleanup MUST run:
  // include/exclude dropping a cached instance, `max` evicting one, and a
  // nested branch being torn down while a cached component is live in it.
  // rc.9 changed the machinery behind all three (#15525, #15526), so they are
  // pinned rather than assumed.
  //
  // Each counts CLEANUP INVOCATIONS directly instead of watching the document
  // listener. With a single delegated element the two are indistinguishable: a
  // second teardown hits `unmountCommand`'s early return and leaves no trace,
  // so "the listener came off" reads the same whether cleanup ran once or
  // twice. #15526 re-registers a cached component's unmount against whichever
  // scope re-enters it, which is exactly the shape that could run teardown
  // twice - and upstream's own test for it asserts `unmounted` exactly once.
  // A second delegated element OUTSIDE the KeepAlive holds the shared count
  // above zero, so the listener transitions stay honest too.
  // ---------------------------------------------------------------------------

  /** Wraps the directive so both it and its cleanup are counted. */
  function counted() {
    const n = { runs: 0, cleanups: 0 };
    const dir: typeof vcCommandVapor = (...args) => {
      n.runs++;
      const cleanup = vcCommandVapor(...args);
      return cleanup
        ? () => {
            n.cleanups++;
            cleanup();
          }
        : cleanup;
    };
    return { n, dir };
  }

  async function mountShell(v: VaporApi, shellSrc: string, extra: Record<string, unknown> = {}) {
    const { n, dir } = counted();
    const child = await compileVapor(v, '<button v-vc-command.delegate="x">child</button>');
    const Child = v.defineVaporComponent({ name: 'Child', setup: () => child.render({ x: 'cartAdd' }) });
    const shell = await compileVapor(v, shellSrc);
    const st = v.reactive({ show: true, view: 'child', y: 'outside', Child, ...extra });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => shell.render(st) }));
    app.directive('vc-command', dir);
    app.mount(host);
    return { n, st, host, app };
  }

  /** The outside button keeps the shared document listener installed throughout. */
  const OUTSIDE = '<button v-vc-command.delegate="y">outside</button>';

  it('include/exclude dropping a cached instance runs the cleanup exactly once', async () => {
    const v = await vapor();
    const { n, st, host, app } = await mountShell(
      v,
      `<div>${OUTSIDE}<KeepAlive :include="inc"><component :is="Child" v-if="view === 'child'" /></KeepAlive></div>`,
      { inc: ['Child'] },
    );
    expect(n.cleanups).toBe(0);

    st.view = 'other';
    st.inc = [];
    await v.nextTick();
    await settle();
    expect(n.cleanups).toBe(1);

    app.unmount();
    host.remove();
  });

  it('max eviction runs the cleanup exactly once', async () => {
    const v = await vapor();
    const other = await compileVapor(v, '<span>other</span>');
    const { n, st, host, app } = await mountShell(
      v,
      `<div>${OUTSIDE}<KeepAlive :max="1"><component :is="cur" /></KeepAlive></div>`,
      { cur: null },
    );
    st.cur = st.Child;
    await v.nextTick();
    expect(n.cleanups).toBe(0);

    // A second component becomes current; with max=1 the cached one is pruned,
    // which is a real unmount rather than a deactivation.
    st.cur = v.defineVaporComponent({ name: 'Other', setup: () => other.render({}) });
    await v.nextTick();
    await settle();
    expect(n.cleanups).toBe(1);

    app.unmount();
    host.remove();
  });

  it('a nested branch torn down after reactivation runs the cleanup exactly once', async () => {
    const v = await vapor();
    const { n, st, host, app } = await mountShell(
      v,
      `<div>${OUTSIDE}<div v-if="show"><KeepAlive>` +
        `<span v-if="view === 'a'">a</span>` +
        `<component v-else-if="view === 'child'" :is="Child" />` +
        `<span v-else>b</span>` +
        `</KeepAlive></div></div>`,
    );
    const mountRuns = n.runs;

    // Deactivated, not unmounted.
    st.view = 'b';
    await v.nextTick();
    expect(n.cleanups).toBe(0);

    // Reactivated from cache: same element, directive NOT run again.
    st.view = 'child';
    await v.nextTick();
    expect(n.runs).toBe(mountRuns);
    expect(n.cleanups).toBe(0);
    const child = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'child');
    expect(child).toBeDefined();
    (child as HTMLButtonElement).click();
    await settle();
    expect(seen).toContain('cartAdd');

    // The branch goes: a real unmount of the reactivated component. #15526
    // hands unmount ownership to the scope that re-entered the cache, so this
    // is the route where a surviving old registration would tear down twice.
    st.show = false;
    await v.nextTick();
    await settle();
    expect(n.cleanups).toBe(1);

    app.unmount();
    host.remove();
  });
});
