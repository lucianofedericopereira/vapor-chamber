/**
 * The dev warning when configureSignal() delivers a reactive backing after plain signals were created.
 * Why: a signal() created before the backing arrives stays a plain { value } for ever, so writes to it would never trigger reactivity with no sign of why.
 * Shows: creating a plain signal is silent, the late configureSignal() warns once with the "before a reactive backing" message, and a second configureSignal() does not warn again.
 * See: src/signal.ts
 */
// Imports src/signal directly, not chamber, so chamber's auto-probe cannot call configureSignal at an unpredictable moment.
// Module-level counters make the test order-sensitive, so it keeps its own file (vitest isolates per file).
import { describe, it, expect, vi } from 'vitest';

describe('signal() pre-detection race warning', () => {
  it('warns once when configureSignal arrives after plain signals were created', async () => {
    // With no Vue global the sync probe finds nothing, which forces the plain fallback.
    const hadVue = '__VUE__' in globalThis;
    const savedVue = (globalThis as any).__VUE__;
    delete (globalThis as any).__VUE__;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { signal, configureSignal } = await import('../src/signal');

      const early = signal(0);
      expect(early.value).toBe(0);
      expect(warn).not.toHaveBeenCalled();

      // The late backing, as chamber.ts delivers it after its async probe.
      const fakeRef = (<T>(v: T) => ({ value: v })) as import('../src/signal').CreateSignal;
      configureSignal(fakeRef);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain('before a reactive backing');

      configureSignal(fakeRef); // the warning fires once per module
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      if (hadVue) (globalThis as any).__VUE__ = savedVue;
    }
  });
});
