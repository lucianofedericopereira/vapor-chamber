/**
 * deepSignal() before Vue has supplied a deep ref(): it falls back to the core shallow signal.
 * Why: a caller who creates a deepSignal before Vue is detected would otherwise get no signal at all; the value must still be readable, though not deeply reactive. Also the only file reaching deepSignal's shallow arm, so the 100% floor needs it.
 * Shows: with `getVueDeepRefFn()` returning null, the value reads through and its nested object is not a reactive proxy.
 * See: src/reactive.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('deepSignal - fallback when Vue has not (yet) supplied a deep ref()', () => {
  afterEach(() => {
    vi.doUnmock('../src/chamber');
    vi.resetModules();
  });

  it('falls back to the core (shallow) signal - nested values are NOT reactive proxies', async () => {
    // Mock the chamber module rather than race the real async Vue probe.
    vi.doMock('../src/chamber', async () => {
      const actual = await vi.importActual<typeof import('../src/chamber')>('../src/chamber');
      return { ...actual, getVueDeepRefFn: () => null };
    });
    vi.resetModules();

    const { deepSignal } = await import('../src/reactive');
    const { isReactive } = await import('vue');

    const s = deepSignal({ nested: { n: 1 } });
    expect(s.value.nested.n).toBe(1);
    // The deep path (ref()) would make this a reactive proxy; the shallow fallback never wraps nested values.
    expect(isReactive(s.value.nested)).toBe(false);
  });
});
