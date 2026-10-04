/**
 * Bind compiler-vapor's generated module source to a Vue runtime namespace.
 */

/**
 * @param v    the runtime namespace the helpers are resolved from
 * @param code a module as `compileTemplate({ vapor: true })` generates it
 */
export function bindVapor(v: any, code: string): (ctx?: unknown, ...rest: unknown[]) => unknown {
  const importLine = code.match(/^import\s*\{([\s\S]*?)\}\s*from\s*'vue';?$/m);
  if (!importLine) throw new Error(`bindVapor(): no vue import in generated code:\n${code}`);

  const names: string[] = [];
  const values: unknown[] = [];
  for (const part of importLine[1].split(',')) {
    const [orig, local] = part.trim().split(/\s+as\s+/);
    if (!orig) continue;
    if (!(orig in v)) throw new Error(`bindVapor(): the runtime has no "${orig}" (the template needed it)`);
    names.push(local ?? orig);
    values.push(v[orig]);
  }

  const body = code.replace(importLine[0], '').replace('export function render', 'return function render');
  return new Function(...names, body)(...values);
}

/*
 * WHY THIS IS ITS OWN FILE. It is the second half of `compileVapor`
 * (tests/compile-vapor.ts), split out for the fixtures that run twice: once
 * in-process, and once as an esbuild bundle built with production defines and
 * executed outside the runner. That bundle has no compiler in it and must not
 * get one: `compile-vapor.ts` imports `vue/compiler-sfc`, and a fixture that
 * imported it would drag the compiler into the production arm. So the test
 * file compiles, on the installed Vue, and hands the generated SOURCE to the
 * fixture; the fixture binds it here to whichever `vue` its own build
 * resolved. The names are parsed off the generated import line for the reason
 * `compile-vapor.ts` gives: which helpers a template needs depends on the
 * template and on the compiler release.
 */
