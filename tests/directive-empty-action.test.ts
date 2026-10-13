// @vitest-environment happy-dom
/**
 * FIXTURE - `v-vc-command` with no action: a press dispatches nothing, on
 * both renderers. The long note is at the end of this file.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { createDirectivePlugin, vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVapor, compileVdom } from './compile-vapor';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));
let v: VaporApi;

beforeAll(async () => {
  v = await import(/* @vite-ignore */ WITH_VAPOR);
});

const seen: unknown[] = [];
beforeEach(() => {
  resetCommandBus();
  // The default bus: a missing handler is an error result, which the
  // directive would show as vc-error and announce.
  setCommandBus(createCommandBus());
  seen.length = 0;
  getCommandBus().onAfter((cmd: { action: unknown }) => {
    seen.push(cmd.action);
  });
});

async function mount(renderer: 'vapor' | 'vdom', source: string, ctx: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let app: VaporApi;
  if (renderer === 'vapor') {
    const tpl = await compileVapor(v, source);
    app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render(ctx) }));
    app.directive('vc-command', vcCommandVapor);
  } else {
    const tpl = await compileVdom(v, source);
    app = v.createApp({ render: () => tpl.render(ctx, []) });
    app.use(createDirectivePlugin());
  }
  app.mount(host);
  const button = host.querySelector('button') as HTMLButtonElement;
  const click = async () => {
    seen.length = 0;
    button.click();
    await settle();
    return [...seen];
  };
  return { app, host, button, click };
}

const noActionWarnings = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls.filter((c) => String(c[0]).includes('has no action')).length;

describe('v-vc-command with no action', () => {
  const cases: Array<[string, 'vapor' | 'vdom', string]> = [
    ['Vapor, v-vc-command=""', 'vapor', '<button v-vc-command="">go</button>'],
    ['vDOM, v-vc-command=""', 'vdom', '<button v-vc-command="">go</button>'],
    ['vDOM, bare v-vc-command', 'vdom', '<button v-vc-command>go</button>'],
  ];
  for (const [name, renderer, source] of cases) {
    it(`${name}: a press dispatches nothing, shows no error, and DEV warns once`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { app, host, button, click } = await mount(renderer, source);
      expect(await click()).toEqual([]);
      expect(await click()).toEqual([]);
      expect(button.className).toBe('');
      expect(button.hasAttribute('aria-disabled')).toBe(false);
      expect(noActionWarnings(warn)).toBe(1);
      warn.mockRestore();
      app.unmount();
      host.remove();
    });
  }

  it('Vapor, an action that is null: nothing is dispatched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, host, click } = await mount('vapor', '<button v-vc-command="act">go</button>', { act: null });
    expect(await click()).toEqual([]);
    warn.mockRestore();
    app.unmount();
    host.remove();
  });

  for (const renderer of ['vapor', 'vdom'] as const) {
    it(`${renderer}: an action set after mount dispatches from then on`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const s = v.reactive({ act: undefined as string | undefined });
      const { app, host, click } = await mount(renderer, '<button v-vc-command="s.act">go</button>', { s });
      expect(await click()).toEqual([]);
      s.act = 'cartAdd';
      await v.nextTick();
      getCommandBus().register('cartAdd', () => 'ok');
      expect(await click()).toEqual(['cartAdd']);
      warn.mockRestore();
      app.unmount();
      host.remove();
    });

    it(`${renderer}: a literal action dispatches (control)`, async () => {
      getCommandBus().register('cartAdd', () => 'ok');
      const { app, host, click } = await mount(renderer, `<button v-vc-command="'cartAdd'">go</button>`);
      expect(await click()).toEqual(['cartAdd']);
      app.unmount();
      host.remove();
    });
  }
});

/*
 * WHY THIS FILE EXISTS. Vue calls a directive whatever its value is. Before
 * this fix one notation behaved three ways (docs/rc-alignment-log.md, 36.6
 * R1, measured on rc.10 and rc.11):
 *
 *   Vapor `v-vc-command=""`   rc.10: compile output threw a SyntaxError.
 *                             rc.11: a press dispatched the string "undefined".
 *   vDOM, bare or `=""`       a press dispatched `undefined`.
 *
 * On a default bus that press failed with `No handler registered for
 * "undefined".`, so the control showed vc-error and the message was announced
 * to screen readers.
 *
 * The rule now, the shape Vue's own `@click=""` has (a listener that does
 * nothing): the directive stays bound, and a press with no action (undefined,
 * null or '') does nothing, with one DEV warning per element. It is checked at
 * press time because that is when the action is decided on both renderers, so
 * an action set after mount works, which is the case a mount-time refusal
 * would lose on Vapor (no `updated` hook there).
 *
 * Every template goes through tests/compile-vapor.ts on the installed Vue. The
 * literal-action cases are the control: they show the harness dispatches.
 */
