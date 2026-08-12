/**
 * src/dev.ts — the DEV constant's four resolution paths.
 *
 * DEV is a build-time answer with a runtime fallback, and the fallback is the
 * only path the rest of the suite ever exercises (vitest supplies no
 * `__VC_DEV__` define), which is what held the file at 83.3% branch coverage
 * with 100% statements — the statement is one expression, so line coverage
 * could never see the gap.
 *
 * Each case re-imports the module after arranging globals, because DEV is
 * evaluated once at module scope.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

async function freshDEV(): Promise<boolean> {
  vi.resetModules();
  return (await import('../src/dev')).DEV;
}

describe('DEV — build define takes precedence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('__VC_DEV__ = true → DEV is true, regardless of NODE_ENV', async () => {
    vi.stubGlobal('__VC_DEV__', true);
    vi.stubEnv('NODE_ENV', 'production'); // deliberately contradicts the define
    expect(await freshDEV()).toBe(true);
  });

  it('__VC_DEV__ = false → DEV is false, regardless of NODE_ENV', async () => {
    // The production IIFE case: the define folds the branch away and takes the
    // warning strings with it. Here we only assert the value it folds to.
    vi.stubGlobal('__VC_DEV__', false);
    vi.stubEnv('NODE_ENV', 'development');
    expect(await freshDEV()).toBe(false);
  });
});

describe('DEV — runtime fallback when no define exists', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('NODE_ENV=production → false', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await freshDEV()).toBe(false);
  });

  it('NODE_ENV=development → true', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(await freshDEV()).toBe(true);
  });

  it('no `process` at all → false, not a ReferenceError', async () => {
    // The no-bundler browser case the `typeof` guard exists for: a bare
    // `process.env` read here would throw, which is the whole point of
    // scripts/check-env-guards.mjs.
    vi.stubGlobal('process', undefined);
    expect(await freshDEV()).toBe(false);
  });
});
