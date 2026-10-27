/**
 * DEV - is this a development build?
 *
 * Dev-only diagnostics (the `console.warn`s that explain a misuse) are worth
 * their bytes in development and worth none in production. A runtime guard
 * such as
 *
 *     typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
 *
 * reads correctly but does not *disappear* correctly: rolldown does not
 * const-fold `typeof process < "u" && !1`, so in the production IIFE bundles
 * the branch would be unreachable while every warning string still shipped -
 * ~1,140 bytes of message text in `full`, ~509 in `core`, measured.
 *
 * So this is answered by the build, as `__VC_IIFE__` is: whether a build is
 * for development is settled when the build runs. `scripts/build.mjs` answers
 * it per artifact:
 *
 *   - IIFE bundles      -> `__VC_DEV__` defined `false`, so `if (DEV)` folds
 *                         away and the strings go with it.
 *   - the ESM build     -> no define. The build emits a resolved expression in
 *                         place of this module, once per module importing it,
 *                         so the decision is deferred to the CONSUMER's
 *                         bundler - the only thing that knows whether *their*
 *                         build is a dev build - and folds in every chunk. The
 *                         build script's header says why each part is there.
 *
 * The `typeof` fallback keeps this honest everywhere the define does not exist
 * - vitest, plain `tsc`, or anyone importing `src/` directly - where it
 * evaluates the original expression and dev warnings stay on.
 */

declare const __VC_DEV__: boolean | undefined;

export const DEV: boolean =
  typeof __VC_DEV__ !== 'undefined'
    ? __VC_DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';
