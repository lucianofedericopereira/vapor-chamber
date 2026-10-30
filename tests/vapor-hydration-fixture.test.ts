// @vitest-environment happy-dom
/**
 * `v-vc-command` (`vcCommandVapor`) on server-rendered markup hydrated by `createVaporSSRApp`.
 * Why: a hydrated element whose directive mounts zero times is a dead control and one that mounts twice has two listeners and a doubled delegated count; both are silent. The directive's element sits behind an empty text node, a null-bound attribute and a fragment root, so hydration must adopt the server's node rather than replace it.
 * Shows: the server button is adopted (same node), the directive runs once with one document click listener, a click dispatches, unmount runs one cleanup and removes the listener, and no hydration or mismatch warning is logged; a bound `:data-vc-payload` is kept when equal, the client value wins when it differs, and a later write reaches the next click; the same warning spy does count a text mismatch.
 * See: vuejs/core#15541
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { vcCommandVapor } from '../src/directives';
import { type VaporApi, compileVapor, compileVaporComponent } from './compile-vapor';
import { renderOnTheServer } from './render-on-server';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Fragment root; empty interpolation and a null-bound attribute before the button.
 * Neither shows in the rendered markup, so the test asserts them in the generated Vapor code (`_setText`, `_setProp`, three `_template` calls).
 */
const SOURCE =
  '{{ empty }}<span :title="nothing">a</span>' +
  '<button v-vc-command.delegate="act">go</button>';

const CTX = { act: 'cartAdd', empty: '', nothing: null };

/** A BOUND `data-vc-payload`: the attribute `buildHandler` parses when no `v-vc-payload` binding is present. */
const PAYLOAD_SOURCE = '<button v-vc-command.delegate="act" :data-vc-payload="pay">{{ label }}</button>';

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
    const html = await renderOnTheServer(SOURCE, CTX);
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

    const { code } = await compileVapor(v, SOURCE);
    // Editing SOURCE into a template that no longer exercises these constructs must fail here.
    expect(code).toContain('_setText(');
    expect(code).toContain('_setProp(');
    expect(code.match(/_template\(/g) ?? []).toHaveLength(3);
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const serverButton = host.querySelector('button');

    const app = v.createVaporSSRApp(await compileVaporComponent(v, SOURCE, { ...CTX }));
    app.directive('vc-command', counting);
    app.mount(host);

    const button = host.querySelector('button') as HTMLButtonElement;
    // Identity: hydration adopted the server node instead of rebuilding it.
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

  /**
   * Hydrate PAYLOAD_SOURCE over markup rendered with `server`, on a client whose binding holds `client`.
   * Returns the attribute and the dispatched payload after hydration and after the client writes `next`; `clientLabel` is the client's button text (the server renders 'go').
   */
  async function hydratePayload(server: string, client: string, next: string, clientLabel = 'go') {
    const html = await renderOnTheServer(PAYLOAD_SOURCE, { act: 'cartAdd', pay: server, label: 'go' });
    expect(html).toContain(`data-vc-payload="${server.replace(/"/g, '&quot;')}"`);

    const v = (await import(/* @vite-ignore */ WITH_VAPOR)) as unknown as VaporApi;
    const payloads: unknown[] = [];
    getCommandBus().onAfter((cmd) => {
      payloads.push(cmd.payload);
    });
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a) => {
      warned.push(String(a[0]));
    });
    vi.spyOn(console, 'error').mockImplementation((...a) => {
      warned.push(String(a[0]));
    });

    const { render, code } = await compileVapor(v, PAYLOAD_SOURCE);
    expect(code).toContain('"data-vc-payload"');
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    const serverButton = host.querySelector('button');

    const ctx = v.reactive({ act: 'cartAdd', pay: client, label: clientLabel });
    const app = v.createVaporSSRApp(v.defineVaporComponent({ setup: () => render(ctx) }));
    app.directive('vc-command', vcCommandVapor);
    app.mount(host);

    const button = host.querySelector('button') as HTMLButtonElement;
    expect(button).toBe(serverButton);
    const attrAfterHydration = button.getAttribute('data-vc-payload');
    button.click();
    await settle();

    ctx.pay = next;
    await v.nextTick();
    const attrAfterUpdate = button.getAttribute('data-vc-payload');
    button.click();
    await settle();

    app.unmount();
    host.remove();
    return {
      attrAfterHydration,
      attrAfterUpdate,
      payloads,
      mismatches: warned.filter((w) => /hydrat|mismatch/i.test(w)).length,
    };
  }

  it('a bound :data-vc-payload equal on server and client: kept, dispatched, and a later write reaches the next click', async () => {
    expect(await hydratePayload('{"id":1}', '{"id":1}', '{"id":3}')).toEqual({
      attrAfterHydration: '{"id":1}',
      attrAfterUpdate: '{"id":3}',
      payloads: [{ id: 1 }, { id: 3 }],
      mismatches: 0,
    });
  });

  it('a bound :data-vc-payload that differs: the client value is written during hydration and is what dispatches', async () => {
    expect(await hydratePayload('{"id":1}', '{"id":2}', '{"id":3}')).toEqual({
      attrAfterHydration: '{"id":2}',
      attrAfterUpdate: '{"id":3}',
      payloads: [{ id: 2 }, { id: 3 }],
      mismatches: 0,
    });
  });

  it('control for the zero above: the same spy counts a text mismatch on the same element', async () => {
    const measured = await hydratePayload('{"id":1}', '{"id":1}', '{"id":3}', 'GO');
    expect(measured.mismatches).toBeGreaterThan(0);
  });
});
