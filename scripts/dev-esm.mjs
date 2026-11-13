/**
 * The DEV expression the ESM build writes into each module, in a module of its
 * own. scripts/build.mjs imports it and documents the expression in full.
 *
 * Apart from build.mjs because that file's top level IS the build: importing it
 * runs the library build and rewrites dist/. tests/dev-flag.test.ts imported
 * the constants from there, so every `test:run` rebuilt dist/ while other tests
 * were reading it, and a consumer build reading a half-written dist/ failed
 * with a missing export (log 36.F58). Importing this file builds nothing.
 */
export const DEV_ESM_EXPR =
  'typeof process !== "undefined" || import.meta.env?.DEV ? process.env.NODE_ENV !== "production" : false';
export const DEV_ESM_SOURCE = `export const DEV = ${DEV_ESM_EXPR};\n`;
