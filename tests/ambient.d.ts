/**
 * Ambient declarations for imports the suite makes that have no types of their
 * own. Needed only by `tsconfig.tests.json`; Vitest resolves all of these at
 * runtime without help, which is why nothing declared them until `tests/` was
 * typechecked at all.
 */

/**
 * Vue's prebuilt dist bundles. `tests/vue-bundler-vapor-exports.test.ts` and
 * `tests/vue-version-ab.test.ts` import them ON PURPOSE - the whole point is to
 * ask what a specific BUILD exports, which the package's own types cannot
 * answer because they describe the source. `any` is the honest shape here: a
 * test that asserts on `Object.keys()` of a bundle is not helped by a type.
 */
declare module 'vue/dist/vue.runtime.esm-bundler.js' {
  const mod: any;
  export = mod;
}
declare module 'vue/dist/vue.runtime-with-vapor.esm-browser.prod.js' {
  const mod: any;
  export = mod;
}

/**
 * A Vite query suffix that forces a SECOND, independent module instance of
 * command-bus. `tests/vitest-entry.test.ts` uses it to prove the package's
 * singleton is per-module-graph. The suffix is resolution, not a real file, so
 * it is declared rather than found.
 */
declare module '*?second-instance' {
  const mod: typeof import('../src/command-bus');
  export = mod;
}
