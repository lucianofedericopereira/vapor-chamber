/**
 * src/dev.ts - the DEV constant's four resolution paths.
 *
 * DEV is a build-time answer with a runtime fallback, and the fallback is the
 * only path the rest of the suite ever exercises, because vitest supplies no
 * `__VC_DEV__` define. The whole thing is ONE expression, so a line- or
 * statement-based reading of this file can never distinguish its four
 * resolutions - only exercising them can.
 *
 * Each case re-imports the module after arranging globals, because DEV is
 * evaluated once at module scope.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

async function freshDEV(): Promise<boolean> {
  vi.resetModules();
  return (await import('../src/dev')).DEV;
}

describe('DEV - build define takes precedence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('__VC_DEV__ = true -> DEV is true, regardless of NODE_ENV', async () => {
    vi.stubGlobal('__VC_DEV__', true);
    vi.stubEnv('NODE_ENV', 'production'); // deliberately contradicts the define
    expect(await freshDEV()).toBe(true);
  });

  it('__VC_DEV__ = false -> DEV is false, regardless of NODE_ENV', async () => {
    // The production IIFE case: the define folds the branch away and takes the
    // warning strings with it. Here we only assert the value it folds to.
    vi.stubGlobal('__VC_DEV__', false);
    vi.stubEnv('NODE_ENV', 'development');
    expect(await freshDEV()).toBe(false);
  });
});

describe('DEV - runtime fallback when no define exists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('NODE_ENV=production -> false', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await freshDEV()).toBe(false);
  });

  it('NODE_ENV=development -> true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(await freshDEV()).toBe(true);
  });

  it('no `process` at all -> false, not a ReferenceError', async () => {
    // The no-bundler browser case the `typeof` guard exists for: a bare
    // `process.env` read here would throw, which is the whole point of
    // scripts/check-env-guards.mjs.
    vi.stubGlobal('process', undefined);
    expect(await freshDEV()).toBe(false);
  });
});

/**
 * THE ESM ARTIFACT'S DEV, and the reason it is not the same text as above.
 *
 * `src/dev.ts` keeps a build define plus a runtime fallback, and the six
 * branches of that expression are what the tests above cover. That shape is
 * also why the ESM build never folded: a consumer's bundler cannot evaluate
 * `typeof __VC_DEV__ !== 'undefined'`, so the ternary survived minification and
 * carried every dev-only diagnostic string into production. Measured on a real
 * Vite APP build consuming this package: 14,037 -> 12,764 raw, 4,453 -> 3,999
 * brotli, about 10%.
 *
 * `scripts/build.mjs` therefore emits a resolved expression into the ESM
 * artifact, once per importing module. That puts one line of behaviour in a
 * build script, where coverage cannot see it - so it is pinned here instead:
 * evaluated against the cases the module above is tested for, plus the two a
 * browser adds - a page under a bundler's dev server, which has
 * `import.meta.env.DEV` and a substituted NODE_ENV but no `process`, and a
 * no-bundler page, which has neither.
 */
describe('DEV - the expression the ESM build emits', () => {
  // Evaluated as a function body, so `import.meta` (module-only syntax) becomes
  // a parameter; a bundler's NODE_ENV define is applied as text, which is how
  // it reaches the code before anything runs.
  const evaluate = (source: string, processRef: unknown, meta: unknown, nodeEnvDefine?: string): boolean => {
    let body = source.replace(/^export const DEV = /, 'return ').trim();
    if (nodeEnvDefine !== undefined) body = body.split('process.env.NODE_ENV').join(JSON.stringify(nodeEnvDefine));
    return new Function('process', 'meta', body.split('import.meta').join('meta'))(processRef, meta) as boolean;
  };

  // First case in the file to import scripts/build.mjs, so it pays for pulling
  // esbuild through the coverage transform - seconds, and not a measure of
  // anything this asserts. The cases below reuse the module cache.
  it('is a bare, foldable expression - no `__VC_DEV__`, both arms false under a production define', async () => {
    const { DEV_ESM_SOURCE } = await import('../scripts/build.mjs');
    expect(DEV_ESM_SOURCE).not.toContain('__VC_DEV__');
    expect(DEV_ESM_SOURCE).toContain('process.env.NODE_ENV');
    // The guard that keeps a no-bundler page safe, and the arm a dev page passes on.
    expect(DEV_ESM_SOURCE).toContain('typeof process !== "undefined"');
    expect(DEV_ESM_SOURCE).toContain('import.meta.env?.DEV');
    // What a consumer's production define leaves: `cond ? false : false`.
    const folded = DEV_ESM_SOURCE.split('process.env.NODE_ENV').join('"production"');
    expect(folded).toMatch(/\? "production" !== "production" : false;\n$/);
  });

  it('agrees with src/dev.ts wherever `process` exists', async () => {
    const { DEV_ESM_SOURCE } = await import('../scripts/build.mjs');
    expect(evaluate(DEV_ESM_SOURCE, { env: { NODE_ENV: 'production' } }, {})).toBe(false);
    expect(evaluate(DEV_ESM_SOURCE, { env: { NODE_ENV: 'development' } }, {})).toBe(true);
    expect(evaluate(DEV_ESM_SOURCE, { env: {} }, {})).toBe(true);
  });

  it('a page with no `process`: false with no bundler, true under a dev server', async () => {
    const { DEV_ESM_SOURCE } = await import('../scripts/build.mjs');
    // No bundler: nothing substituted, no import.meta.env. False, and it must
    // not throw - the whole point of scripts/check-env-guards.mjs.
    expect(() => evaluate(DEV_ESM_SOURCE, undefined, {})).not.toThrow();
    expect(evaluate(DEV_ESM_SOURCE, undefined, {})).toBe(false);
    // Vite's dev server: import.meta.env.DEV true, NODE_ENV replaced in the served code.
    expect(evaluate(DEV_ESM_SOURCE, undefined, { env: { DEV: true } }, 'development')).toBe(true);
    // A production page: NODE_ENV replaced, DEV false.
    expect(evaluate(DEV_ESM_SOURCE, undefined, { env: { DEV: false } }, 'production')).toBe(false);
  });
});
