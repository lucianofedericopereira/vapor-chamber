/**
 * The Vapor outlet's DEPENDENCY SURFACE, enumerated - so an upstream rename
 * fails in this repo before it fails at a consumer.
 *
 * WHY THIS IS A FIXTURE AND NOT A PARAGRAPH. `vapor-chamber/router/vapor` is
 * the first place this library depends on Vue API that is compiler-output
 * rather than documented user-facing surface: these are the helpers a compiled
 * Vapor SFC calls. That was accepted as an explicit risk, on the condition
 * that the surface is pinned and small. This file is that pin, and it is
 * modelled on `tests/vue-bundler-vapor-exports.test.ts`, which exists because
 * the same question was previously answered by hand-quoting an export line and
 * got it wrong for two cycles.
 *
 * THE SURFACE IS NINE ITEMS, not "the compiler contract":
 *   - eight named imports reachable from bare `vue`, and
 *   - one property read: `instance.slots`, because Vapor's `setup` receives
 *     the component INSTANCE as its second argument and no public
 *     slot-existence helper exists. It is only a property read, but it is an
 *     internals-adjacent one, so it is counted and pinned like the rest.
 *
 * THE RESOLUTION QUALIFIER IS LOAD-BEARING. These names are reachable from
 * bare `vue` only under BUNDLER resolution, via the
 * `export * from "@vue/runtime-vapor"` in `vue.runtime.esm-bundler.js`. Under
 * raw Node ESM, bare `vue` resolves to an entry that re-exports none of them,
 * and grep cannot see through a star re-export in either direction. So the
 * enumeration goes through the bundler entry explicitly, exactly as the
 * sibling fixture does.
 *
 * Two Vue module instances are in play here on purpose and they never meet:
 * the bundler entry below is READ for its export names only, while the mount
 * in the second test uses the project-aliased with-vapor build. Nothing is
 * passed between them.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createComponent, createVaporApp, defineVaporComponent, setInsertionState, template } from 'vue';

// Read rather than imported: this project aliases bare `vue` to the with-vapor
// dist, and a `vue/package.json` subpath import does not resolve through that
// alias the way it does in the unaliased project.
const vueVersion = (
  JSON.parse(readFileSync(resolve(process.cwd(), 'node_modules', 'vue', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

/**
 * The eight named helpers. `defineVaporComponent`, `inject` and `provide` are
 * deliberately in the list too even though the first is already covered by the
 * sibling fixture and the last two are ordinary public API: what this file
 * pins is everything `src/router/vapor.ts` statically imports, so the list can
 * be checked against that file's import block by eye.
 */
const OUTLET_IMPORTS = [
  'createDynamicComponent',
  'createSlot',
  'defineVaporComponent',
  'inject',
  'provide',
] as const;

/**
 * The remaining helpers from the feasibility enumeration. The outlet does not
 * import these, but every fixture that mounts it does, and they are the same
 * compiler-output surface - a rename here breaks the fixtures rather than the
 * shipped module, which is still a break worth catching in this repo first.
 */
const FIXTURE_HELPERS = ['createComponent', 'template', 'insert', 'renderEffect', 'child', 'setInsertionState'] as const;

describe('Vapor outlet - dependency surface', () => {
  it('every helper it imports is statically exported by vue\'s bundler entry', async () => {
    // By absolute file URL, not by the `vue/dist/...` specifier the sibling
    // fixture uses: this project aliases bare `vue`, and the alias swallows
    // the deep specifier too. The file reached is identical either way - it is
    // the entry a consumer's bundler resolves bare `vue` to.
    const bundlerEntry = resolve(process.cwd(), 'node_modules', 'vue', 'dist', 'vue.runtime.esm-bundler.js');
    const mod = (await import(/* @vite-ignore */ pathToFileURL(bundlerEntry).href)) as Record<string, unknown>;
    const names = Object.keys(mod);

    // Guard the enumeration itself: a resolution failure must fail loudly
    // rather than vacuously reporting "nothing missing".
    expect(names.length).toBeGreaterThan(100);

    const missingOutlet = OUTLET_IMPORTS.filter((n) => !names.includes(n));
    const missingFixture = FIXTURE_HELPERS.filter((n) => !names.includes(n));

    console.log(
      `\n  vue@${vueVersion} bundler entry - outlet dependency surface:\n` +
        `    imported by src/router/vapor.ts : ${OUTLET_IMPORTS.join(', ')}\n` +
        `    used by the outlet fixtures     : ${FIXTURE_HELPERS.join(', ')}\n` +
        `    missing                         : ${[...missingOutlet, ...missingFixture].join(', ') || '(none)'}\n`,
    );

    // If this fails, an upstream rename has landed. The shipped module's
    // static imports mean a consumer would get a BUILD error rather than a
    // silent runtime null, but this is where it should be caught first.
    expect(missingOutlet).toEqual([]);
    expect(missingFixture).toEqual([]);
  });

  it("Vapor setup receives the instance as its second argument, with `slots` on it", () => {
    // The ninth item. `src/router/vapor.ts` destructures `{ slots }` out of
    // setup's second parameter to decide whether to build a `createSlot`
    // fallback at all - and that decision is what keeps the no-slot case a
    // literal null. If Vapor ever passes a narrower context object here, the
    // outlet's fallback gate silently stops seeing slots and every no-match
    // branch renders empty even where a fallback was provided.
    let secondArg: unknown;
    const Probe = defineVaporComponent({
      setup(_props: unknown, ctx: unknown) {
        secondArg = ctx;
        return (template('<span>probe</span>', 1) as () => Element)();
      },
    } as never);

    // Slots arrive through `createComponent`'s third argument, which is how
    // the outlet receives its own default slot in real use - `createVaporApp`
    // takes no slots, so mounting the probe as the root would prove nothing.
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
    // `slots` present and object-shaped is the whole contract the outlet
    // depends on; which slots it holds is the app's business, not ours.
    expect((secondArg as { slots?: unknown }).slots).toBeTypeOf('object');

    app.unmount();
    host.remove();
  });
});
