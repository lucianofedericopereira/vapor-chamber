// @vitest-environment happy-dom
/**
 * FIXTURE: `v-vc-command` with no action: a press dispatches nothing, on both renderers.
 * Why: Vue calls a directive whatever its value; a press dispatching `undefined` fails, shows vc-error and is announced. Like `@click=""`, it does nothing.
 * Shows: empty, bare and null actions dispatch nothing, show no error, warn once in DEV; an action set after mount dispatches from then on; a literal action dispatches; an action that cannot be read at mount does not stop the mount.
 * See: docs/rc-alignment-log.md 36.6, tests/compile-vapor.ts.
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

  // Checked at press time, when both renderers decide the action; Vapor has no `updated` hook for a mount-time check.
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

  it('an action that cannot be read yet does not stop the mount, and one set later works', async () => {
    const s = v.reactive({ a: null as { name: string } | null });
    const errors: unknown[] = [];
    const tpl = await compileVapor(v, '<button v-vc-command="s.a.name">x</button>');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => tpl.render({ s }) }));
    app.config.errorHandler = (e: unknown) => { errors.push(e); };
    app.directive('vc-command', vcCommandVapor);
    app.mount(host);
    expect(errors).toEqual([]);
    s.a = { name: 'late' };
    (host.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(seen).toEqual(['late']);
    app.unmount();
    host.remove();
  });
});
