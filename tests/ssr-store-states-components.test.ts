// @vitest-environment happy-dom
/**
 * SSR by the stores' states, with the stores the components create: the server flow src/ssr.ts and whitepaper 12.3 document.
 * Why: Vue 3.6's server renderer stops every component's scope when the render ends (cleanupContext), before the request reads storeStates; a store held only by that scope was disposed, and the page shipped without its state.
 * Shows: a store a compiled <script setup> creates during renderToString is in storeStates after it, for a vDOM template, a Vapor server build and a store made after an await; read at the end of a stream too; on the client the same component's store still leaves when the app unmounts.
 * See: log 36.F58, docs/store.md (Lifecycle), tests/ssr-store-states.test.ts
 */
import { describe, expect, it } from 'vitest';
import * as vue from 'vue';
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc';
import * as serverRenderer from 'vue/server-renderer';
import { createCommandBus } from '../src/command-bus';
import { liveStores, storeStates } from '../src/ssr';
import { defineChamberStore } from '../src/store';

const useCart = defineChamberStore('cart', {
  state: () => ({ items: [] as string[] }),
  reducers: { add: (s: { items: string[] }, name: string) => ({ items: [...s.items, name] }) },
});

const TEMPLATE = `<template><p>{{ cart.state.value.items.join(',') }}</p></template>`;
const SETUP = `import { inject } from 'vue';
import { useCart } from 'vc:store';
const cart = useCart(inject('bus'));
cart.add('tea');`;
const SYNC = `<script setup>\n${SETUP}\n</script>\n${TEMPLATE}`;
const VAPOR = `<script setup vapor>\n${SETUP}\n</script>\n${TEMPLATE}`;
const AFTER_AWAIT = `<script setup>\nimport { inject } from 'vue';\nimport { useCart } from 'vc:store';\nawait Promise.resolve();\nconst cart = useCart(inject('bus'));\ncart.add('tea');\n</script>\n${TEMPLATE}`;

/** Bind a compiled module's named imports to `modules`, and return what it exports as `exported`. */
function evaluate(code: string, modules: Record<string, object>, exported: RegExp): unknown {
  const body = code
    .replace(/^import \{([^}]*)\} from ['"]([^'"]+)['"];?[ \t]*$/gm, (_l, names: string, spec: string) => {
      if (!Object.hasOwn(modules, spec)) throw new Error(`unmapped import '${spec}'`);
      const b = names.split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/\s+as\s+/, ': ')).join(', ');
      return `const { ${b} } = __modules[${JSON.stringify(spec)}];`;
    })
    .replace(exported, 'return ');
  if (/^\s*(import|export)\b/m.test(body)) throw new Error('module syntax left after binding');
  return new Function('__modules', body)(modules);
}

/** A server component from an SFC, compiled by the installed Vue: its setup, and its ssrRender (Vapor's when the SFC says vapor). */
function serverComponent(sfc: string): object {
  const { descriptor } = parse(sfc, { filename: 'Shop.vue' });
  const script = compileScript(descriptor, { id: 'shop' });
  const template = compileTemplate({
    source: descriptor.template!.content, filename: 'Shop.vue', id: 'shop', ssr: true, vapor: descriptor.vapor,
    compilerOptions: { bindingMetadata: script.bindings },
  });
  if (template.errors.length > 0) throw new Error(template.errors.map(String).join('\n'));
  const modules = { vue, 'vue/server-renderer': serverRenderer, 'vc:store': { useCart } };
  const options = evaluate(script.content, modules, /^export default /m) as object;
  const ssrRender = evaluate(template.code, modules, /^export (?=function ssrRender)/m);
  return { ...options, ssrRender };
}

function serverApp(sfc: string) {
  const bus = createCommandBus();
  const app = vue.createSSRApp(serverComponent(sfc));
  app.provide('bus', bus);
  return { app, bus };
}

describe('storeStates after the render, with stores the components create', () => {
  for (const [name, sfc] of [['a vDOM template', SYNC], ['a Vapor server build', VAPOR], ['a store made after an await', AFTER_AWAIT]] as const) {
    it(`${name}: the page holds the state the render wrote`, async () => {
      const { app, bus } = serverApp(sfc);
      const html = await serverRenderer.renderToString(app);
      expect(html).toContain('tea');
      expect(storeStates(bus)).toEqual({ cart: { items: ['tea'] } });
      expect(liveStores(bus)).toHaveLength(1);
    });
  }

  it('read at the end of a stream: the page holds it too', async () => {
    const { app, bus } = serverApp(SYNC);
    let html = '';
    await new Promise<void>((done) => {
      serverRenderer.pipeToNodeWritable(app, {}, { write: (chunk: string) => { html += chunk; }, end: () => done() } as never);
    });
    expect(html).toContain('tea');
    expect(storeStates(bus)).toEqual({ cart: { items: ['tea'] } });
  });

  it('control: on the client the component still releases its store when the app unmounts', () => {
    const bus = createCommandBus();
    const app = vue.createApp(vue.defineComponent({
      setup() {
        const cart = useCart(bus);
        cart.add('tea');
        return () => vue.h('p', cart.state.value.items.join(','));
      },
    }));
    app.mount(document.createElement('div'));
    expect(liveStores(bus)).toHaveLength(1);
    app.unmount();
    expect(liveStores(bus)).toEqual([]);
  });
});
