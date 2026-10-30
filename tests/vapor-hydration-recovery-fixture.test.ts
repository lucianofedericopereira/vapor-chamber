// @vitest-environment happy-dom
/**
 * `v-vc-command` on server markup the client disagrees with, hydrated by `createVaporSSRApp`.
 * Why: the app the server rendered and the app that hydrates can differ, and a control that shows one label and dispatches another, or a second button left behind by recovery, is silent; the user presses what they read.
 * Shows: a `v-if` chain whose branches look alike renders the client's branch in the server's range, with one mismatch warning, the client's label and the client's action; the same branch is adopted with no warning; a first root that differs is replaced, also over a whole server range, with one button left and the directive run once.
 * See: vuejs/core#16044, vuejs/core#16049, vuejs/core#16052, vuejs/core#16067, tests/vapor-hydration-fixture.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVaporComponent } from './compile-vapor';
import { renderOnTheServer } from './render-on-server';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

const CHAIN =
  '<button v-if="a" v-vc-command="\'one\'">one</button>' +
  '<button v-else v-vc-command="\'two\'">two</button>';

const CHAIN_OF_THREE =
  '<span v-if="n === 1">s</span>' +
  '<button v-else-if="n === 2" v-vc-command="\'two\'">two</button>' +
  '<button v-else v-vc-command="\'three\'">three</button>';

/** Hydrate `client` over `html` and press every button; what a user of `v-vc-command` sees. */
async function hydrate(html: string, client: string, ctx: Record<string, unknown>) {
  const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
  const dispatched: string[] = [];
  getCommandBus().onAfter((cmd) => {
    dispatched.push(cmd.action);
  });
  const warned: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a) => {
    warned.push(String(a[0]));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...a) => {
    warned.push(String(a[0]));
  });

  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  const serverButton = host.querySelector('button');

  let runs = 0;
  const counting: typeof vcCommandVapor = (...args) => {
    runs++;
    return vcCommandVapor(...args);
  };
  const app = v.createVaporSSRApp(await compileVaporComponent(v, client, ctx));
  app.directive('vc-command', counting);
  app.mount(host);

  const buttons = [...host.querySelectorAll('button')];
  const seen = {
    labels: buttons.map((b) => b.textContent),
    adopted: buttons[0] === serverButton,
    text: host.textContent,
    runs,
    // Vue's one summary line, "contains mismatches", is logged once per dist: only the per-node warning counts.
    mismatches: warned.filter((w) => /mismatch:/.test(w)).length,
  };
  for (const button of buttons) button.click();
  await settle();

  app.unmount();
  host.remove();
  warn.mockRestore();
  error.mockRestore();
  return { ...seen, dispatched };
}

describe('v-vc-command when the server and the client disagree', () => {
  beforeEach(() => {
    resetCommandBus();
    setCommandBus(createCommandBus({ onMissing: 'ignore' }));
  });

  it('the server marks the branch of a chain whose branches look alike', async () => {
    expect(await renderOnTheServer(CHAIN, { a: true }, true)).toBe('<!--[0--><button>one</button><!--]-->');
    expect(await renderOnTheServer(CHAIN, { a: false }, true)).toBe('<!--[1--><button>two</button><!--]-->');
  });

  it('a chain the client takes the other way: the client branch, its label and its action', async () => {
    const html = await renderOnTheServer(CHAIN, { a: true }, true);
    expect(await hydrate(html, CHAIN, { a: false })).toMatchObject({
      labels: ['two'],
      adopted: false,
      runs: 1,
      mismatches: 1,
      dispatched: ['two'],
    });
  });

  it('a chain the client takes the same way: adopted, with no warning', async () => {
    const html = await renderOnTheServer(CHAIN, { a: true }, true);
    expect(await hydrate(html, CHAIN, { a: true })).toEqual({
      labels: ['one'],
      adopted: true,
      text: 'one',
      runs: 1,
      mismatches: 0,
      dispatched: ['one'],
    });
  });

  it('a nested chain of three: the branch is found by its position', async () => {
    const html = await renderOnTheServer(CHAIN_OF_THREE, { n: 2 }, true);
    expect(html).toContain('<!--[1-->');
    expect(await hydrate(html, CHAIN_OF_THREE, { n: 3 })).toMatchObject({
      labels: ['three'],
      adopted: false,
      runs: 1,
      dispatched: ['three'],
    });
  });

  it('a first root that differs is replaced, and the block behind it is the client one', async () => {
    const html = await renderOnTheServer('<p>a</p><button>go</button>', {});
    expect(await hydrate(html, '<div>a</div><button v-vc-command="act">go</button>', { act: 'one' })).toMatchObject({
      labels: ['go'],
      adopted: false,
      runs: 1,
      mismatches: 1,
      dispatched: ['one'],
    });
  });

  it('a server range under the cursor goes as one unit: one button left', async () => {
    const html = await renderOnTheServer('<template v-if="on"><i>1</i><i>2</i></template><button>go</button>', { on: true });
    expect(html).toContain('<i>1</i><i>2</i>');
    expect(await hydrate(html, '<b>1</b><button v-vc-command="act">go</button>', { act: 'one' })).toMatchObject({
      labels: ['go'],
      text: '1go',
      runs: 1,
      dispatched: ['one'],
    });
  });
});
