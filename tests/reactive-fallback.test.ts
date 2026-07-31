/**
 * Covers deepSignal()'s undocumented-but-real fallback branch (src/reactive.ts):
 * "if Vue is not yet available it falls back to the core signal() [shallow]".
 * Every other reactive.test.ts case calls `await waitForVueDetection()` first,
 * so this branch (getVueDeepRefFn() returning nothing) was never exercised.
 *
 * Mocks `../src/chamber` directly instead of racing the real async Vue probe —
 * deterministic, no timing dependency (see tests/devtools.test.ts's vi.waitFor
 * fix for why a real async race was worth avoiding here).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('deepSignal — fallback when Vue has not (yet) supplied a deep ref()', () => {
  afterEach(() => {
    vi.doUnmock('../src/chamber');
    vi.resetModules();
  });

  it('falls back to the core (shallow) signal — nested values are NOT reactive proxies', async () => {
    vi.doMock('../src/chamber', async () => {
      const actual = await vi.importActual<typeof import('../src/chamber')>('../src/chamber');
      return { ...actual, getVueDeepRefFn: () => null };
    });
    vi.resetModules();

    const { deepSignal } = await import('../src/reactive');
    const { isReactive } = await import('vue');

    const s = deepSignal({ nested: { n: 1 } });
    expect(s.value.nested.n).toBe(1);
    // The deep path (ref()) would make this a reactive proxy; the shallow
    // fallback never wraps nested values.
    expect(isReactive(s.value.nested)).toBe(false);
  });
});
