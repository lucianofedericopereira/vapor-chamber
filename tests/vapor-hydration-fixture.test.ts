// @vitest-environment happy-dom
/**
 * FIXTURE - `v-vc-command` on a HYDRATED element.
 *
 * WHOSE PATH THIS IS, stated accurately because the first version of this
 * header got it wrong. It said examples/exo-astro hydrates a Vapor app. It does
 * not: that example imports nothing from vue and runs a hand-rolled directive
 * scanner over the bus, and its `v-command` is its own directive, not
 * `v-vc-command`. Checked across all three examples - vapor-sfc mounts with
 * `createVaporApp` (client, no SSR), vapor-island-cart's `hydrate()` is a lazy
 * `customElements.define` upgrade, not Vue hydration, and none of the three
 * uses `v-vc-command` in a Vapor template at all.
 *
 * So this is a CONSUMER path, not a path this repository ships: someone doing
 * Vapor SSR registers `vcCommandVapor` on their own `createVaporSSRApp`. That
 * is supported and was untested, which is reason enough to pin it - but it is a
 * weaker reason than "our own example depends on it", and the difference
 * matters when someone later decides what this file is for.
 *
 * rc.9 changed the Vapor hydration walk in four commits - #15541 null value
 * bindings, empty text blocks in place, fragment ownership when hydrating empty
 * text, missing text among element children - so the assumption is pinned now
 * rather than assumed again next cycle.
 *
 * TWO GRAPHS, DELIBERATELY - do not "simplify" this. The server half imports
 * `vue` (the node entry) because that is the graph `@vue/server-renderer`
 * resolves; the client half imports the with-vapor browser dist. Only the
 * rendered STRING crosses between them, which is exactly how a real server
 * bundle and client bundle relate.
 *
 * The first attempt at this probe took `resolveDirective` from the browser
 * dist and handed it to a render driven by server-renderer, and died on
 * `Cannot read properties of undefined (reading 'getSSRProps')`: two
 * separately imported Vue dists are two disconnected instances, so
 * `currentRenderingInstance` was set in one and read in the other. That is
 * this repository's most-documented failure mode (chamber.ts probeVue,
 * whitepaper 11.6), and it is reachable from here.
 *
 * WHY THE TEMPLATE IS NOT JUST A BUTTON. A plain `<button>go</button>`
 * supports one claim: a directive on a plain hydrated element mounts once. The
 * rc.9 hydration commits are about how the walk crosses empty text, null-bound
 * attributes and fragment roots - so the directive's element sits BEHIND all
 * three, and the assertion that matters is that hydration adopted the server's
 * node rather than replacing it.
 *
 * THE RUN COUNT IS THE POINT. The likeliest hydration defect is a double mount
 * or a missed mount, and both are silent: 0 gives a dead control, 2 gives two
 * listeners and a doubled delegated count.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVapor } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fragment root; empty interpolation and a null-bound attribute before the button.
 *
 * NEITHER IS VISIBLE IN THE RENDERED MARKUP - an empty interpolation and a null
 * attribute both render to nothing, so
 * `<!--[--><span>a</span><button>go</button><!--]-->` looks identical with or
 * without them. The test therefore asserts them in the GENERATED CODE, below,
 * rather than leaving a reader to take the template's word for it. What the
 * compilers emit for it:
 *
 *   ssr    _push(`<!--[-->${...  _ssrInterpolate(_ctx.empty)
 *                               _ssrRenderAttr("title", _ctx.nothing)
 *   vapor  t0 = _template(" "), t1 = _template("<span>a"), t2 = _template("<button>go")
 *          _setText(n0, _toDisplayString(_ctx.empty))
 *          _setProp(n1, "title", _ctx.nothing)
 *          _withVaporDirectives(n2, ...)
 *
 * so the hydration walk crosses a text node and a null-bound attribute inside a
 * fragment before it reaches the element carrying the directive.
 */
const SOURCE =
  '{{ empty }}<span :title="nothing">a</span>' +
  '<button v-vc-command.delegate="act">go</button>';

const CTX = { act: 'cartAdd', empty: '', nothing: null };

/**
 * Render SOURCE to a string the way a server bundle would.
 *
 * The generated SSR module's imports are PARSED, not listed: which helpers it
 * needs depends on the template - adding the interpolation pulled in
 * `_ssrInterpolate`, and a hard-coded parameter list died on it. Same lesson,
 * same fix, as tests/compile-vapor.ts.
 */
async function renderOnTheServer(): Promise<string> {
  const vnode: Record<string, unknown> = await import('vue');
  const sr: Record<string, unknown> = await import('@vue/server-renderer');
  const { compileTemplate } = await import('vue/compiler-sfc');

  const { code, errors } = compileTemplate({ source: SOURCE, filename: 'T.vue', id: 'h', ssr: true });
  expect(errors).toEqual([]);

  let body = code.replace('export function ssrRender', 'return function ssrRender');
  const names: string[] = [];
  const values: unknown[] = [];
  for (const m of code.matchAll(/^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)"$/gm)) {
    const mod = m[2] === 'vue' ? vnode : m[2] === 'vue/server-renderer' ? sr : null;
    if (!mod) throw new Error(`ssr code imports from an unexpected module: ${m[2]}`);
    for (const part of m[1].split(',')) {
      const [orig, local] = part.trim().split(/\s+as\s+/);
      if (!orig) continue;
      if (!(orig in mod)) throw new Error(`${m[2]} has no "${orig}"`);
      names.push(local ?? orig);
      values.push(mod[orig]);
    }
    body = body.replace(`${m[0]}\n`, '');
  }
  const ssrRender = new Function(...names, body)(...values);

  const app = (vnode.createSSRApp as (o: unknown) => { use: (p: unknown) => void })({
    ssrRender,
    data: () => ({ ...CTX }),
  });
  app.use(createDirectivePlugin());
  return (sr.renderToString as (a: unknown) => Promise<string>)(app);
}

describe('v-vc-command on hydrated markup', () => {
  const seen: string[] = [];

  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
    seen.length = 0;
    getCommandBus().onAfter((cmd) => {
      seen.push(cmd.action);
    });
  });

  it('adopts the server element, mounts exactly once, dispatches, and tears down clean', async () => {
    const html = await renderOnTheServer();
    // A real fragment root, so the walk to the button crosses the constructs
    // the rc.9 hydration commits changed.
    expect(html).toContain('<!--[-->');
    expect(html).toContain('<button>go</button>');

    const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const clicks = (s: typeof add) => s.mock.calls.filter((c) => c[0] === 'click').length;
    const warned: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warned.push(String(a[0]));
    });
    const error = vi.spyOn(console, 'error').mockImplementation((...a) => {
      warned.push(String(a[0]));
    });

    let runs = 0;
    let cleanups = 0;
    const counting: typeof vcCommandVapor = (...args) => {
      runs++;
      const cleanup = vcCommandVapor(...args);
      return cleanup
        ? () => {
            cleanups++;
            cleanup();
          }
        : cleanup;
    };

    const { render, code } = await compileVapor(v, SOURCE);
    // The constructs are asserted in the generated code, not assumed from the
    // template: editing SOURCE into something that no longer exercises them
    // must fail here rather than quietly weaken the test.
    expect(code).toContain('_setText(');
    expect(code).toContain('_setProp(');
    expect(code.match(/_template\(/g) ?? []).toHaveLength(3);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const serverButton = host.querySelector('button');

    const app = v.createVaporSSRApp(v.defineVaporComponent({ setup: () => render({ ...CTX }) }));
    app.directive('vc-command', counting);
    app.mount(host);

    const button = host.querySelector('button') as HTMLButtonElement;
    // ADOPTED, not replaced - the identity check is what says hydration walked
    // the server markup correctly rather than rebuilding it.
    expect(button).toBe(serverButton);
    expect(runs).toBe(1);
    expect(clicks(add)).toBe(1);
    expect(warned.filter((w) => /hydrat|mismatch/i.test(w))).toEqual([]);

    button.click();
    await settle();
    expect(seen).toEqual(['cartAdd']);

    app.unmount();
    expect(cleanups).toBe(1);
    expect(clicks(remove)).toBe(1);

    warn.mockRestore();
    error.mockRestore();
    add.mockRestore();
    remove.mockRestore();
    host.remove();
  });
});
