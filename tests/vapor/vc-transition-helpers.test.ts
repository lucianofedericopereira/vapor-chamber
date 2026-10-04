/** `VcTransition`'s dependency surface on Vue, enumerated: its imports and its two block reads. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createVaporApp, defineVaporComponent, template } from 'vue';
import { compileVapor } from '../compile-vapor';

const vueVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'node_modules', 'vue', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const SOURCE = readFileSync(resolve(process.cwd(), 'src', 'transitions', 'vapor.ts'), 'utf8');

/** Everything `src/transitions/vapor.ts` imports from `vue` as a value. */
const VC_TRANSITION_IMPORTS = ['createIf', 'defineVaporComponent', 'nextTick', 'onScopeDispose', 'shallowRef', 'watch'] as const;

describe('VcTransition - dependency surface', () => {
  it("every helper it imports is statically exported by vue's bundler entry", async () => {
    const bundlerEntry = resolve(process.cwd(), 'node_modules', 'vue', 'dist', 'vue.runtime.esm-bundler.js');
    const mod = (await import(/* @vite-ignore */ pathToFileURL(bundlerEntry).href)) as Record<string, unknown>;
    const names = Object.keys(mod);
    // A resolution failure must fail loudly, not report "nothing missing".
    expect(names.length).toBeGreaterThan(100);

    const missing = VC_TRANSITION_IMPORTS.filter((n) => !names.includes(n));
    console.log(
      `\n  vue@${vueVersion} bundler entry - VcTransition dependency surface:\n` +
        `    imported by src/transitions/vapor.ts : ${VC_TRANSITION_IMPORTS.join(', ')}\n` +
        `    missing                              : ${missing.join(', ') || '(none)'}\n`,
    );
    expect(missing).toEqual([]);
  });

  it('the list above is the value import block of src/transitions/vapor.ts', () => {
    const block = SOURCE.match(/^import \{([^}]*)\} from 'vue';$/m);
    expect(block).not.toBeNull();
    const imported = (block as RegExpMatchArray)[1]
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    expect(imported.sort()).toEqual([...VC_TRANSITION_IMPORTS].sort());
  });

  it("it imports nothing of Vue's transition", () => {
    const vueImports = [...SOURCE.matchAll(/^import (?:type )?\{([^}]*)\} from 'vue';$/gm)].flatMap((m) =>
      m[1].split(',').map((n) => n.trim()),
    );
    // Positive control: the scan sees this file's vue imports at all.
    expect(vueImports).toContain('createIf');
    expect(vueImports.filter((n) => /transition/i.test(n))).toEqual([]);
    // And no second route to it: every other import is a relative one.
    const specifiers = [...SOURCE.matchAll(/^import [^;]* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(specifiers.filter((s) => s !== 'vue' && !s.startsWith('../'))).toEqual([]);
  });

  it('a slot returns the four block shapes `elementOf` reads: node, array, `nodes`, `block`', async () => {
    const vue = (await import('vue')) as any;
    const seen: Record<string, string> = {};
    const shapeOf = (block: any): string => {
      if (block?.nodeType) return `node:${block.nodeType}`;
      if (Array.isArray(block)) return `array:${block.length}`;
      const keys = [];
      if (block && 'nodes' in block) keys.push('nodes');
      if (block && 'block' in block) keys.push('block');
      return `object:${keys.join('+') || 'neither'}`;
    };
    const probe = (name: string) =>
      defineVaporComponent({
        setup(_props: unknown, ctx: { slots: Record<string, () => unknown> }) {
          const block = ctx.slots.default();
          seen[name] = shapeOf(block);
          // What the two property reads lead to: a block again.
          const inner = (block as any)?.nodes ?? (block as any)?.block;
          if (inner !== undefined) seen[`${name} inner`] = shapeOf(inner);
          return block;
        },
      } as never);

    const source =
      '<One><section class="p">x</section></One>' +
      '<Many>text<i></i><b></b></Many>' +
      '<Cond><section v-if="s.on">in</section><aside v-else>else</aside></Cond>' +
      '<Comp><Panel /></Comp>';
    const compiled = await compileVapor(vue, source);
    const s = vue.reactive({ on: true });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createVaporApp(defineVaporComponent({ setup: () => compiled.render({ s }) } as never) as never) as unknown as {
      component: (n: string, c: unknown) => void;
      mount: (el: Element) => void;
      unmount: () => void;
    };
    for (const name of ['One', 'Many', 'Cond', 'Comp']) app.component(name, probe(name));
    app.component(
      'Panel',
      defineVaporComponent({ setup: () => (template('<article>panel</article>', 1) as () => Element)() }),
    );
    app.mount(host);

    expect(seen.One).toBe('node:1');
    expect(seen.Many).toBe('array:3');
    // A `v-if` root is a fragment: its current branch is on `nodes`.
    expect(seen.Cond).toBe('object:nodes');
    expect(seen['Cond inner']).toBe('node:1');
    // A component root is its instance: its root block is on `block`, and it
    // has no `nodes` that would be read first.
    expect(seen.Comp).toBe('object:block');
    expect(seen['Comp inner']).toBe('node:1');

    app.unmount();
    host.remove();
  });
});

/*
 * Modelled on tests/vapor/vapor-outlet-helpers.test.ts, which explains why a
 * surface like this is a fixture and not a paragraph, and why the enumeration
 * goes through the bundler entry (`vue.runtime.esm-bundler.js`, the file a
 * consumer's bundler resolves bare `vue` to) by absolute file URL.
 *
 * WHAT IS PINNED. `src/transitions/vapor.ts` depends on Vue in two ways:
 *   - six named imports, all reachable from bare `vue`. `createIf` and
 *     `defineVaporComponent` are compiler-output surface, the other four are
 *     ordinary public API; all six are listed, and the list is compared with
 *     the file's import block so it cannot go stale by eye.
 *   - two property reads, `nodes` on a fragment and `block` on a component
 *     instance, which is how it finds the element to hand to the command
 *     handlers. Neither is public API. The last test compiles four slots on
 *     the installed Vue and records what each slot function returns, so a
 *     rename of either property fails here. If it ever does, the component
 *     does not throw: `elementOf` returns null and the commands carry no
 *     target, which tests/vapor/vc-transition.test.ts pins for content with no
 *     element (arm k, `text`).
 *
 * "IMPORTS NOTHING OF VUE'S TRANSITION" is the premise of the component (log
 * s35.34: Vue's Vapor transition is 4.4 KB brotli, and no exported piece lets
 * a bundle take less of it). The third test is that claim, with a positive
 * control on the scan.
 */
