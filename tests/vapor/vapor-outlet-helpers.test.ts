/**
 * The Vue helpers and property reads the Vapor outlet (src/router/vapor.ts) depends on.
 * Why: the outlet calls compiler-output Vue API, so an upstream rename or a narrower setup context would break every consumer's build or silently empty the outlet's fallback.
 * Shows: each named import exists in vue's bundler entry and matches the outlet's import block; its createIf flags equal the installed compiler's; setup's second argument carries `slots`, and a conditional slot that is off shows as `rawSlots.$`.
 * See: tests/vue-bundler-vapor-exports.test.ts, tests/vapor/vapor-outlet-fixture.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createComponent, createVaporApp, defineVaporComponent, setInsertionState, template } from 'vue';
import { bundlerEntryExports } from '../bundler-entry';
import { compileVapor } from '../compile-vapor';

// Read, not imported: the bare-`vue` alias to the with-vapor dist blocks a `vue/package.json` subpath import.
const vueVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'node_modules', 'vue', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

// Everything src/router/vapor.ts statically imports from vue; a test below compares this list with its import block.
const OUTLET_IMPORTS = [
  'createDynamicComponent',
  'createIf',
  'createSlot',
  'defineVaporComponent',
  'inject',
  'provide',
] as const;

// Not imported by the outlet, but used by every fixture that mounts it.
const FIXTURE_HELPERS = ['createComponent', 'template', 'insert', 'renderEffect', 'child', 'setInsertionState'] as const;

describe('Vapor outlet - dependency surface', () => {
  it('every helper it imports is statically exported by vue\'s bundler entry', async () => {
    const names = await bundlerEntryExports();

    // A resolution failure must fail here, not report "nothing missing".
    expect(names.length).toBeGreaterThan(100);

    const missingOutlet = OUTLET_IMPORTS.filter((n) => !names.includes(n));
    const missingFixture = FIXTURE_HELPERS.filter((n) => !names.includes(n));

    console.log(
      `\n  vue@${vueVersion} bundler entry - outlet dependency surface:\n` +
        `    imported by src/router/vapor.ts : ${OUTLET_IMPORTS.join(', ')}\n` +
        `    used by the outlet fixtures     : ${FIXTURE_HELPERS.join(', ')}\n` +
        `    missing                         : ${[...missingOutlet, ...missingFixture].join(', ') || '(none)'}\n`,
    );

    expect(missingOutlet).toEqual([]);
    expect(missingFixture).toEqual([]);
  });

  it('the import list above is the import block of src/router/vapor.ts', () => {
    const source = readFileSync(resolve(process.cwd(), 'src', 'router', 'vapor.ts'), 'utf8');
    const block = source.match(/^import \{([^}]*)\} from 'vue';$/m);
    expect(block).not.toBeNull();
    const imported = (block as RegExpMatchArray)[1].split(',').map((n) => n.trim()).filter(Boolean);
    expect(imported.sort()).toEqual([...OUTLET_IMPORTS].sort());
  });

  it('its createIf call carries the flags compiler-vapor emits for the same template', async () => {
    // The outlet hand-writes the call that `<component :is="c" v-if="c" /><slot v-else />` compiles to; the installed compiler is the reference.
    const vue = await import('vue');
    const { code } = await compileVapor(vue, '<component :is="c" v-if="c" /><slot v-else />');
    expect(code).toContain('_createDynamicComponent(');
    expect(code).toContain('_createSlot(');
    const emitted = code.match(/_createIf\([\s\S]*?\},\s*(\d+)\s*(?:\/\*[^*]*\*\/)?\s*\)/);
    expect(emitted).not.toBeNull();

    const source = readFileSync(resolve(process.cwd(), 'src', 'router', 'vapor.ts'), 'utf8');
    const ours = source.match(/^const IF_ELSE_SLOT = (\d+);$/m);
    expect(ours).not.toBeNull();
    expect((ours as RegExpMatchArray)[1]).toBe((emitted as RegExpMatchArray)[1]);
  });

  it("Vapor setup receives the instance as its second argument, with `slots` on it", () => {
    // The outlet reads `{ slots }` from setup's second parameter to decide whether to build a `createSlot` fallback.
    let secondArg: unknown;
    const Probe = defineVaporComponent({
      setup(_props: unknown, ctx: unknown) {
        secondArg = ctx;
        return (template('<span>probe</span>', 1) as () => Element)();
      },
    } as never);

    // Slots arrive through `createComponent`'s third argument; `createVaporApp` takes none, so the probe cannot be the root.
    const Root = defineVaporComponent({
      setup() {
        const el = (template('<div></div>', 1) as () => Element)();
        setInsertionState(el);
        createComponent(Probe as never, null, {
          default: () => (template('<em>slotted</em>', 1) as () => Element)(),
        } as never);
        return el;
      },
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(Root as never);
    app.mount(host);

    expect(secondArg).toBeTypeOf('object');
    expect(secondArg).not.toBeNull();
    expect((secondArg as { slots?: unknown }).slots).toBeTypeOf('object');

    app.unmount();
    host.remove();
  });

  it('a conditional slot that is off arrives as a dynamic source: no `slots.default`, but `rawSlots.$`', async () => {
    // The outlet tells a conditional slot from "no slot" by `rawSlots.$`; the shape is compiler output, so it is compiled here.
    const vue = (await import('vue')) as any;
    const seen: Record<string, { hasDefault: boolean; sources: unknown }> = {};
    const probe = (name: string) =>
      defineVaporComponent({
        setup(_props: unknown, ctx: { slots: Record<string, unknown>; rawSlots?: { $?: unknown } }) {
          seen[name] = { hasDefault: !!ctx.slots.default, sources: ctx.rawSlots?.$ };
          return (template('<span>probe</span>', 1) as () => Element)();
        },
      } as never);

    const conditional = await compileVapor(vue, '<Late><template v-if="s.on" #default><em>x</em></template></Late>');
    const unconditional = await compileVapor(vue, '<Plain><template #default><em>x</em></template></Plain>');
    expect(conditional.code).toMatch(/\$: \[/);
    expect(conditional.code).toMatch(/name: "default"/);
    expect(conditional.code).toMatch(/\bfn: /);

    const s = vue.reactive({ on: false });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(
      defineVaporComponent({ setup: () => [conditional.render({ s }), unconditional.render({ s })] }) as never,
    ) as unknown as { component: (n: string, c: unknown) => void; mount: (el: Element) => void; unmount: () => void };
    app.component('Late', probe('late'));
    app.component('Plain', probe('plain'));
    app.mount(host);

    expect(seen.late.hasDefault).toBe(false);
    expect(Array.isArray(seen.late.sources)).toBe(true);
    expect((seen.late.sources as unknown[]).length).toBe(1);
    // Control: an unconditional slot has no dynamic source and is simply there.
    expect(seen.plain.hasDefault).toBe(true);
    expect(seen.plain.sources).toBeUndefined();

    app.unmount();
    host.remove();
  });
});
