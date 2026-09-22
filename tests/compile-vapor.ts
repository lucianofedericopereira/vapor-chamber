/**
 * Compile a Vapor template on the INSTALLED Vue and bind it to the real runtime.
 *
 * WHY THIS EXISTS. Every fixture that needs Vapor codegen used to write the
 * compiler's output out by hand - `withVaporDirectives(n0, [[dir, () => v,
 * "command", mods]])` and the like. A literal records a COMPILER RELEASE, and
 * the suite then keeps agreeing with that release forever. Vue 3.6.0-rc.9
 * #15490 is the proof: it turned the directive argument into a getter,
 * `v-vc-command` stopped mounting in every compiled template, and 2,431 tests
 * stayed green because no test asked the compiler what it emits. Anything that
 * goes through here is held to whatever the installed Vue actually produces.
 *
 * `vue/compiler-sfc` is a `vue` export, so this costs no dependency, and it is
 * the same path a real SFC takes.
 *
 * THE IMPORTS ARE PARSED, not listed. The generated module imports whatever
 * helpers the template needs, and which ones those are depends on the template
 * AND on the compiler version: a `v-if` pulls in `createIf`, `setInsertionState`,
 * `child` and `next` that a plain element does not, and a `<KeepAlive>` pulls in
 * more again. A hard-coded parameter list would need editing every time a test
 * used a new construct, and would fail as `_createIf is not a function` inside
 * generated code nobody wrote. Resolving the names off the runtime namespace
 * turns that into a named error at the call site instead.
 */

/** The with-vapor browser build, untyped on purpose - these fixtures build trees by hand. */
export type VaporApi = any;

export type Compiled = {
  /** The generated render function, already bound to the runtime. */
  render: (ctx?: unknown, ...rest: unknown[]) => unknown;
  /** The generated source, for tests that assert on the emitted shape itself. */
  code: string;
};

export async function compileVapor(v: VaporApi, source: string): Promise<Compiled> {
  const { code, errors } = (await import('vue/compiler-sfc')).compileTemplate({
    source,
    filename: 'T.vue',
    id: 'vc-fixture',
    vapor: true,
  });
  if (errors.length > 0) {
    throw new Error(`compileVapor(): ${source}\n${errors.map(String).join('\n')}`);
  }

  const importLine = code.match(/^import\s*\{([\s\S]*?)\}\s*from\s*'vue';?$/m);
  if (!importLine) throw new Error(`compileVapor(): no vue import in generated code:\n${code}`);

  const names: string[] = [];
  const values: unknown[] = [];
  for (const part of importLine[1].split(',')) {
    const [orig, local] = part.trim().split(/\s+as\s+/);
    if (!orig) continue;
    if (!(orig in v)) throw new Error(`compileVapor(): the runtime has no "${orig}" (the template needed it)`);
    names.push(local ?? orig);
    values.push(v[orig]);
  }

  const body = code.replace(importLine[0], '').replace('export function render', 'return function render');
  return { render: new Function(...names, body)(...values) as Compiled['render'], code };
}

/**
 * The same thing for the vDOM renderer, and it exists for a defect this file's
 * own header describes from the other side.
 *
 * `compileVapor` was written because no test asked the compiler what it emits,
 * and #15490 killed `v-vc:command` with 2,431 tests green. The vDOM half had
 * the identical hole and it cost the identical kind of bug, quieter and
 * longer-lived: every vDOM directive test resolves BY NAME - `withDirs` calls
 * `resolveDirective('vc-payload')` - so no test ever compiled the NOTATION a
 * consumer writes. `v-vc:payload` was documented at four-plus sites including
 * the generated API reference, and it was inert the whole time: it compiled to
 * `[_directive_vc, _ctx.p, "payload"]`, the `vc` directive with an argument
 * whose `mounted` returned early. Resolving by name cannot see that, because
 * by the time you have a name you have already made the decision the notation
 * was going to get wrong.
 *
 * Anything that goes through here is held to what the installed compiler
 * produces from the text in a template, which is the only thing a consumer
 * actually types.
 */
export async function compileVdom(v: VaporApi, source: string): Promise<Compiled> {
  const { code, errors } = (await import('vue/compiler-sfc')).compileTemplate({
    source,
    filename: 'T.vue',
    id: 'vc-fixture',
  });
  if (errors.length > 0) {
    throw new Error(`compileVdom(): ${source}\n${errors.map(String).join('\n')}`);
  }

  // The vDOM codegen quotes its module specifier with double quotes where the
  // Vapor one uses single. Matching both rather than the one seen today is the
  // same lesson as the rest of this file.
  const importLine = code.match(/^import\s*\{([\s\S]*?)\}\s*from\s*["']vue["'];?$/m);
  if (!importLine) throw new Error(`compileVdom(): no vue import in generated code:\n${code}`);

  const names: string[] = [];
  const values: unknown[] = [];
  for (const part of importLine[1].split(',')) {
    const [orig, local] = part.trim().split(/\s+as\s+/);
    if (!orig) continue;
    if (!(orig in v)) throw new Error(`compileVdom(): the runtime has no "${orig}" (the template needed it)`);
    names.push(local ?? orig);
    values.push(v[orig]);
  }

  const body = code.replace(importLine[0], '').replace('export function render', 'return function render');
  return { render: new Function(...names, body)(...values) as Compiled['render'], code };
}
